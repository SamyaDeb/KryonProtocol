// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712Upgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IEngine, IFeeRouter, IInsurance, IRiskParams} from "./interfaces/IKryon.sol";
import {KryonErrors as Errors} from "./libraries/Errors.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";
import {Cancel, Fill, Order, OrderLib} from "./libraries/OrderLib.sol";
import {MarketParams} from "./libraries/Types.sol";

/// @title OrderGateway
/// @notice Verifies signed orders and settles operator-matched fills.
/// @dev Trust model: the operator can only settle fills consistent with what
///      both traders signed. Each fill is checked against the signed market,
///      side, size, limit price, nonce and expiry, and a signed order can
///      never be filled past its size, after its expiry, or after a cancel.
///
///      `settleFillsSigned` isolates each fill: a fill that reverts (bad
///      signature, blocklisted trader, insufficient margin...) emits
///      `FillRejected` and the rest of the batch settles. Running short of
///      gas is not a rejection: the whole batch reverts `InsufficientBatchGas`.
contract OrderGateway is KryonUpgradeable, EIP712Upgradeable {
    /// Longest lifetime of a signed order, matching the off-chain intake.
    uint64 public constant MAX_ORDER_TTL = 7 days;
    /// Plan §5.6: 40 fills measured at ~15.2M gas, well inside Arc's fixed 30M block.
    uint256 public constant MAX_BATCH = 40;
    /// Gas every fill must be able to start with, so the operator cannot
    /// starve a fill into a spurious rejection. Derivation: the worst fill
    /// measured by test/gas (`test_gas_worst_single_fill`: first trade in a
    /// market, two brand-new smart wallets whose ERC-1271 checks use ~97k of
    /// ERC1271_GAS_LIMIT each, OI policy on so the backstop is marked to
    /// market) is 729,201 gas; x1.2 = 875k, rounded up to 900k.
    uint256 public constant MIN_GAS_PER_FILL = 900_000;
    /// Slack over the 1/64 an out-of-gas call leaves behind (EIP-150).
    uint256 private constant OOG_SLACK = 10_000;

    /// @custom:storage-location erc7201:kryon.storage.OrderGateway
    struct GatewayStorage {
        IEngine engine;
        IRiskParams risk;
        IFeeRouter feeRouter;
        /// owner => nonce => (high 128 bits of the bound order digest,
        ///                    low 128 bits: amount filled). One slot per order.
        mapping(address => mapping(uint256 => uint256)) orderState;
        mapping(address => mapping(uint256 => bool)) cancelled;
        /// Orders with nonce < minNonce are void (`cancelUpTo`).
        mapping(address => uint256) minNonce;
        /// Insurance backstop: its fills go through `onBackstopFill`.
        address backstop;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.OrderGateway")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xd4d9bb7d2ea672fc702a972994b6cbe44f48b8ab52d7a9a96c4323a2a31e8c00;

    event FillSettled(
        bytes32 indexed fillId,
        bytes32 indexed makerOrderHash,
        bytes32 indexed takerOrderHash,
        uint32 marketId,
        address maker,
        address taker,
        bool takerIsBuy,
        uint256 size,
        uint256 price,
        int256 makerFee,
        int256 takerFee,
        uint8 makerTier,
        uint8 takerTier
    );
    event FillRejected(bytes32 indexed fillId, bytes reason);
    event OrderCancelled(address indexed owner, uint256 indexed nonce);
    event NoncesCancelledUpTo(address indexed owner, uint256 minNonce);
    event WiringSet(bytes32 indexed what, address indexed value);

    function _s() private pure returns (GatewayStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(address admin, address engine_, address risk_, address feeRouter_)
        external
        initializer
    {
        if (engine_ == address(0) || risk_ == address(0) || feeRouter_ == address(0)) {
            revert Errors.ZeroAddress();
        }
        __KryonUpgradeable_init(admin);
        __EIP712_init("Kryon", "1");
        GatewayStorage storage $ = _s();
        $.engine = IEngine(engine_);
        $.risk = IRiskParams(risk_);
        $.feeRouter = IFeeRouter(feeRouter_);
    }

    // ------------------------------------------------------------- settlement

    function settleFillsSigned(Fill[] calldata fills)
        external
        onlyRole(Roles.OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 settled)
    {
        if (fills.length == 0 || fills.length > MAX_BATCH) revert Errors.BatchTooLarge();
        for (uint256 i = 0; i < fills.length; ++i) {
            // An operator gas shortfall reverts the whole batch (resize and
            // resubmit); it is never recorded as a trader's rejection.
            uint256 before = gasleft();
            if (before < MIN_GAS_PER_FILL) revert Errors.InsufficientBatchGas();
            try this.settleOne(fills[i]) {
                ++settled;
            } catch (bytes memory reason) {
                // The fill ran out of gas if it used all it was forwarded
                // (63/64 of `before`). No trader-controlled code can burn that
                // much: ERC-1271 checks are capped.
                if (gasleft() < before / 64 + OOG_SLACK) revert Errors.InsufficientBatchGas();
                emit FillRejected(fills[i].fillId, reason);
            }
        }
    }

    /// @dev Results of one settled fill, gathered for the event.
    struct Settlement {
        bytes32 makerHash;
        bytes32 takerHash;
        int256 makerFee;
        int256 takerFee;
        uint8 makerTier;
        uint8 takerTier;
    }

    /// @notice Settle a single fill. Only callable by this contract, so a
    ///         failure stays isolated to the one fill.
    /// @dev Runs inside the nonReentrant `settleFillsSigned`; external calls go
    ///      only to protocol contracts (Insurance, Engine, FeeRouter).
    // slither-disable-next-line reentrancy-no-eth
    function settleOne(Fill calldata f) external {
        if (msg.sender != address(this)) revert Errors.OnlySelf();
        Settlement memory st = Settlement({
            makerHash: hashOrder(f.maker),
            takerHash: hashOrder(f.taker),
            makerFee: 0,
            takerFee: 0,
            makerTier: 0,
            takerTier: 0
        });
        _validateFill(f);
        _consume(f.maker, st.makerHash, f.makerSignature, f.size, f.price);
        _consume(f.taker, st.takerHash, f.takerSignature, f.size, f.price);
        int256 notional_ = _checkNotional(f);
        _backstopHook(f);
        _apply(f, notional_, st);
        _emitSettled(f, st);
    }

    function _checkNotional(Fill calldata f) private view returns (int256 notional_) {
        notional_ = M.mulPrecision(M.toInt(f.size), M.toInt(f.price));
        MarketParams memory m = _s().risk.market(f.maker.marketId);
        if (notional_ < m.minFillNotional) revert Errors.FillBelowMinNotional();
    }

    /// @dev Positions, then fees, then margin: the margin check sees the fees.
    function _apply(Fill calldata f, int256 notional_, Settlement memory st) private {
        GatewayStorage storage $ = _s();
        int256 size = M.toInt(f.size);
        int256 price = M.toInt(f.price);
        bool makerIncreased = $.engine.applyFill(
            f.maker.owner, f.maker.marketId, f.maker.isLong, size, price, notional_, f.maker.reduceOnly
        );
        bool takerIncreased = $.engine.applyFill(
            f.taker.owner, f.taker.marketId, f.taker.isLong, size, price, notional_, f.taker.reduceOnly
        );
        (st.makerFee, st.takerFee, st.makerTier, st.takerTier) = $.feeRouter.chargeFill(
            f.maker.marketId, f.maker.owner, f.taker.owner, notional_, f.maker.referrer, f.taker.referrer
        );
        $.engine.requireMargin(f.maker.owner, makerIncreased);
        $.engine.requireMargin(f.taker.owner, takerIncreased);
    }

    function _emitSettled(Fill calldata f, Settlement memory st) private {
        emit FillSettled(
            f.fillId,
            st.makerHash,
            st.takerHash,
            f.maker.marketId,
            f.maker.owner,
            f.taker.owner,
            f.taker.isLong,
            f.size,
            f.price,
            st.makerFee,
            st.takerFee,
            st.makerTier,
            st.takerTier
        );
    }

    /// @dev Holds a backstop fill to Insurance's unwind limits (plan §4.4).
    function _backstopHook(Fill calldata f) private {
        address backstop_ = _s().backstop;
        if (backstop_ != address(0) && (f.maker.owner == backstop_ || f.taker.owner == backstop_)) {
            IInsurance(backstop_).onBackstopFill(f.maker.marketId, f.size, f.price);
        }
    }

    function _validateFill(Fill calldata f) private pure {
        if (f.size == 0 || f.price == 0) revert Errors.InvalidAmount();
        if (f.maker.owner == f.taker.owner) revert Errors.SelfTrade();
        if (f.maker.marketId == 0 || f.maker.marketId != f.taker.marketId) {
            revert Errors.InvalidConfig();
        }
        if (f.maker.isLong == f.taker.isLong) revert Errors.DirectionMismatch();
    }

    /// @param digest The order's EIP-712 digest (`hashOrder`).
    function _consume(
        Order calldata o,
        bytes32 digest,
        bytes calldata signature,
        uint256 fillSize,
        uint256 fillPrice
    ) private {
        GatewayStorage storage $ = _s();
        if (o.owner == address(0)) revert Errors.ZeroAddress();
        if (o.size == 0 || o.limitPrice == 0) revert Errors.InvalidAmount();
        if (block.timestamp > o.expiry) revert Errors.OrderExpired();
        if (o.expiry > block.timestamp + MAX_ORDER_TTL) revert Errors.OrderExpired();
        if (o.nonce < $.minNonce[o.owner] || $.cancelled[o.owner][o.nonce]) {
            revert Errors.OrderCancelled();
        }
        // One nonce, one order: the first fill binds the nonce to this digest,
        // so a second order signed under a used nonce can't open a second fill
        // budget. The 128-bit prefix makes a forged match infeasible.
        uint256 state = $.orderState[o.owner][o.nonce];
        uint256 prefix = uint256(digest) >> 128;
        uint256 filledSoFar = uint128(state);
        if (state != 0 && state >> 128 != prefix) revert Errors.NonceReused();
        uint256 next = filledSoFar + fillSize;
        if (next > o.size) revert Errors.OrderOverfilled();
        if (next > type(uint128).max) revert Errors.MathOverflow();
        if (o.isLong ? fillPrice > o.limitPrice : fillPrice < o.limitPrice) {
            revert Errors.PriceOutsideBand();
        }
        if (!OrderLib.isValidSignature(o.owner, digest, signature)) revert Errors.InvalidSignature();
        $.orderState[o.owner][o.nonce] = (prefix << 128) | next;
    }

    /// @notice The Insurance backstop whose fills are held to its unwind limits.
    function setBackstop(address backstop_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (backstop_ == address(0)) revert Errors.ZeroAddress();
        _s().backstop = backstop_;
        emit WiringSet("backstop", backstop_);
    }

    function backstop() external view returns (address) {
        return _s().backstop;
    }

    // ---------------------------------------------------------------- cancels

    function cancelOrder(uint256 nonce) external {
        _cancel(msg.sender, nonce);
    }

    function cancelOrders(uint256[] calldata nonces) external {
        for (uint256 i = 0; i < nonces.length; ++i) {
            _cancel(msg.sender, nonces[i]);
        }
    }

    /// @notice Void every order with a nonce below `minNonce`. Can only move up.
    function cancelUpTo(uint256 newMinNonce) external {
        GatewayStorage storage $ = _s();
        if (newMinNonce <= $.minNonce[msg.sender]) revert Errors.InvalidConfig();
        $.minNonce[msg.sender] = newMinNonce;
        emit NoncesCancelledUpTo(msg.sender, newMinNonce);
    }

    /// @notice Make a signed off-chain cancel final on-chain. Anyone may submit.
    function cancelSigned(Cancel calldata c, bytes calldata signature) external {
        if (block.timestamp > c.deadline) revert Errors.OrderExpired();
        bytes32 digest = _hashTypedDataV4(OrderLib.hashStruct(c));
        if (!OrderLib.isValidSignature(c.owner, digest, signature)) revert Errors.InvalidSignature();
        _cancel(c.owner, c.nonce);
    }

    function _cancel(address owner, uint256 nonce) private {
        _s().cancelled[owner][nonce] = true;
        emit OrderCancelled(owner, nonce);
    }

    // ------------------------------------------------------------------ views

    /// @notice EIP-712 digest a wallet signs for `o`.
    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(OrderLib.hashStruct(o));
    }

    function hashCancel(Cancel calldata c) external view returns (bytes32) {
        return _hashTypedDataV4(OrderLib.hashStruct(c));
    }

    /// @notice Amount filled so far for `owner`'s order under `nonce`.
    function filled(address owner, uint256 nonce) external view returns (uint256) {
        return uint128(_s().orderState[owner][nonce]);
    }

    function isCancelled(address owner, uint256 nonce) external view returns (bool) {
        GatewayStorage storage $ = _s();
        return nonce < $.minNonce[owner] || $.cancelled[owner][nonce];
    }

    function minNonce(address owner) external view returns (uint256) {
        return _s().minNonce[owner];
    }

    /// @notice High 128 bits of the digest bound to `owner`'s `nonce` (0 if unused).
    function orderPrefixForNonce(address owner, uint256 nonce) external view returns (bytes16) {
        return bytes16(uint128(_s().orderState[owner][nonce] >> 128));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function wiring() external view returns (address engine_, address risk_, address feeRouter_) {
        GatewayStorage storage $ = _s();
        return (address($.engine), address($.risk), address($.feeRouter));
    }
}
