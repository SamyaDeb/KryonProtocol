// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712Upgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IEngine, IFeeRouter, IRiskParams} from "./interfaces/IKryon.sol";
import {Errors} from "./libraries/Errors.sol";
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
///      `FillRejected` and the rest of the batch settles.
contract OrderGateway is KryonUpgradeable, EIP712Upgradeable {
    /// Longest lifetime of a signed order, matching the off-chain intake.
    uint64 public constant MAX_ORDER_TTL = 7 days;
    uint256 public constant MAX_BATCH = 64;
    /// Gas held back per remaining fill so the operator cannot starve one
    /// fill into a spurious rejection.
    uint256 public constant MIN_GAS_PER_FILL = 250_000;

    /// @custom:storage-location erc7201:kryon.storage.OrderGateway
    struct GatewayStorage {
        IEngine engine;
        IRiskParams risk;
        IFeeRouter feeRouter;
        mapping(bytes32 => uint256) filled;
        /// owner => nonce => order hash first settled under it.
        mapping(address => mapping(uint256 => bytes32)) nonceOrder;
        mapping(address => mapping(uint256 => bool)) cancelled;
        /// Orders with nonce < minNonce are void (`cancelUpTo`).
        mapping(address => uint256) minNonce;
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
        assembly {
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
            if (gasleft() < MIN_GAS_PER_FILL * (fills.length - i)) revert Errors.InvalidConfig();
            try this.settleOne(fills[i]) {
                ++settled;
            } catch (bytes memory reason) {
                emit FillRejected(fills[i].fillId, reason);
            }
        }
    }

    /// @notice Settle a single fill. Only callable by this contract, so a
    ///         failure stays isolated to the one fill.
    function settleOne(Fill calldata f) external {
        if (msg.sender != address(this)) revert Errors.OnlySelf();
        GatewayStorage storage $ = _s();

        bytes32 makerHash = hashOrder(f.maker);
        bytes32 takerHash = hashOrder(f.taker);
        _validateFill(f);
        _consume(f.maker, makerHash, f.makerSignature, f.size, f.price);
        _consume(f.taker, takerHash, f.takerSignature, f.size, f.price);

        int256 size = M.toInt(f.size);
        int256 price = M.toInt(f.price);
        int256 notional_ = M.mulPrecision(size, price);
        MarketParams memory m = $.risk.market(f.maker.marketId);
        if (notional_ < m.minFillNotional) revert Errors.FillBelowMinNotional();

        IEngine engine_ = $.engine;
        bool makerIncreased = engine_.applyFill(
            f.maker.owner, f.maker.marketId, f.maker.isLong, size, price, notional_, f.maker.reduceOnly
        );
        bool takerIncreased = engine_.applyFill(
            f.taker.owner, f.taker.marketId, f.taker.isLong, size, price, notional_, f.taker.reduceOnly
        );

        (int256 makerFee, int256 takerFee, uint8 makerTier, uint8 takerTier) = $.feeRouter.chargeFill(
            f.maker.marketId, f.maker.owner, f.taker.owner, notional_, f.maker.referrer, f.taker.referrer
        );

        engine_.requireMargin(f.maker.owner, makerIncreased);
        engine_.requireMargin(f.taker.owner, takerIncreased);

        emit FillSettled(
            f.fillId,
            makerHash,
            takerHash,
            f.maker.marketId,
            f.maker.owner,
            f.taker.owner,
            f.taker.isLong,
            f.size,
            f.price,
            makerFee,
            takerFee,
            makerTier,
            takerTier
        );
    }

    function _validateFill(Fill calldata f) private pure {
        if (f.size == 0 || f.price == 0) revert Errors.InvalidAmount();
        if (f.maker.owner == f.taker.owner) revert Errors.SelfTrade();
        if (f.maker.marketId == 0 || f.maker.marketId != f.taker.marketId) {
            revert Errors.InvalidConfig();
        }
        if (f.maker.isLong == f.taker.isLong) revert Errors.DirectionMismatch();
    }

    function _consume(
        Order calldata o,
        bytes32 orderHash,
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
        bytes32 bound = $.nonceOrder[o.owner][o.nonce];
        if (bound == bytes32(0)) {
            $.nonceOrder[o.owner][o.nonce] = orderHash;
        } else if (bound != orderHash) {
            // One nonce, one order: a second order signed under a used nonce
            // must not open a second fill budget.
            revert Errors.NonceReused();
        }
        uint256 next = $.filled[orderHash] + fillSize;
        if (next > o.size) revert Errors.OrderOverfilled();
        if (o.isLong ? fillPrice > o.limitPrice : fillPrice < o.limitPrice) {
            revert Errors.PriceOutsideBand();
        }
        if (!OrderLib.isValidSignature(o.owner, _hashTypedDataV4(orderHash), signature)) {
            revert Errors.InvalidSignature();
        }
        $.filled[orderHash] = next;
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

    /// @notice Filled amount for an order, keyed by its EIP-712 digest.
    function filled(bytes32 orderDigest) external view returns (uint256) {
        return _s().filled[orderDigest];
    }

    function isCancelled(address owner, uint256 nonce) external view returns (bool) {
        GatewayStorage storage $ = _s();
        return nonce < $.minNonce[owner] || $.cancelled[owner][nonce];
    }

    function minNonce(address owner) external view returns (uint256) {
        return _s().minNonce[owner];
    }

    function orderForNonce(address owner, uint256 nonce) external view returns (bytes32) {
        return _s().nonceOrder[owner][nonce];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function wiring() external view returns (address engine_, address risk_, address feeRouter_) {
        GatewayStorage storage $ = _s();
        return (address($.engine), address($.risk), address($.feeRouter));
    }
}
