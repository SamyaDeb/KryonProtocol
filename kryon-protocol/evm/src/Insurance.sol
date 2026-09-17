// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IEngine, IOrderHasher, IVault} from "./interfaces/IKryon.sol";
import {Decimals} from "./libraries/Decimals.sol";
import {KryonErrors as Errors} from "./libraries/Errors.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";
import {Order} from "./libraries/OrderLib.sol";

/// @title Insurance
/// @notice The protocol's backstop fund and the account that takes over
///         liquidated positions.
/// @dev All of the fund's USDC sits in the vault under this contract's
///      address. That one balance is split into:
///        - staked capital (`stakedBalance`), redeemable through share epochs;
///        - operating capital (`vault balance - stakedBalance`), which receives
///          fee shares, penalties, donations and backstop PnL, and which
///          covers deficits.
///      Staked capital only absorbs realized losses through an explicit,
///      timelocked `sweepToOperating`.
///
///      Two views of operating capital:
///        - `operatingBalance()` is cash: the ledger balance that can actually
///          move. `settleBadDebt` pays deficits from it.
///        - `markedOperatingBalance()` adds the unrealized PnL and pending
///          funding of the positions the backstop holds (Engine.accountValue).
///          Every capacity or loss decision uses it: the OI-policy capacity
///          (`effectiveBalance`), the ADL trigger (`unfundedShortfall`) and
///          unstake payouts, where a negative marked balance is absorbed by
///          stakers pro rata. If a held market can't be priced, capacity is 0
///          and the other two revert StaleOracle.
///
///      Backstop unwind (plan §4.4): the contract is an ERC-1271 signer, so
///      positions it took over in liquidations can be closed through the
///      normal order book. Orders must be reduce-only, short-lived and signed
///      by a BACKSTOP_SIGNER_ROLE key; the gateway then calls
///      `onBackstopFill`, which holds every fill to a price band around the
///      oracle index and to per-fill and daily notional caps.
contract Insurance is KryonUpgradeable, IERC1271 {
    using SafeERC20 for IERC20;

    uint64 public constant UNSTAKE_COOLDOWN = 7 days;
    bytes32 public constant REASON_COVER = "INSURANCE_COVER";
    /// Longest lifetime of a signed unwind order.
    uint64 public constant MAX_UNWIND_ORDER_TTL = 1 hours;
    uint16 public constant MAX_UNWIND_DEVIATION_BPS = 500;
    int256 public constant MAX_UNWIND_FILL_NOTIONAL = 1_000_000e18;
    int256 public constant MAX_UNWIND_DAILY_NOTIONAL = 10_000_000e18;

    struct ShareBalance {
        uint32 epoch;
        int256 shares;
    }

    struct PendingUnstake {
        int256 shares;
        uint64 unlockTime;
        uint32 epoch;
    }

    /// @custom:storage-location erc7201:kryon.storage.Insurance
    struct InsuranceStorage {
        IVault vault;
        IERC20 usdc;
        IEngine engine;
        address liquidation;
        int256 stakedBalance;
        int256 totalShares;
        uint32 epoch;
        mapping(address => ShareBalance) shares;
        mapping(address => PendingUnstake) pending;
        /// Uncovered deficit per account, and their sum.
        mapping(address => int256) recordedDebt;
        int256 badDebt;
        address gateway;
        /// Backstop unwind limits. All zero = unwinding disabled.
        uint16 maxUnwindDeviationBps;
        int256 maxUnwindFillNotional;
        int256 maxUnwindDailyNotional;
        /// day (unix / 1 days) => notional unwound that day.
        mapping(uint256 => int256) unwoundOnDay;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.Insurance")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x084b5cc2cfda87e51dc3ae285377713594f5f24f2f788655ba3c045ba8f2dc00;

    event Donated(address indexed from, uint256 amount);
    event Staked(address indexed staker, uint256 amount, int256 shares, uint32 epoch);
    event UnstakeRequested(address indexed staker, int256 shares, uint64 unlockTime, uint32 epoch);
    event Unstaked(address indexed staker, int256 shares, uint256 amount);
    event SweptToOperating(int256 amount, int256 stakedAfter);
    event EpochRetired(uint32 retired, int256 sharesWrittenOff);
    event DeficitCovered(address indexed trader, int256 covered, int256 remainingDebt);
    event BadDebtRecorded(address indexed trader, int256 debt, int256 totalBadDebt);
    event WiringSet(bytes32 indexed what, address indexed value);
    event UnwindLimitsSet(uint16 maxDeviationBps, int256 maxFillNotional, int256 maxDailyNotional);
    event BackstopUnwound(uint32 indexed marketId, uint256 size, uint256 price, int256 notional, int256 dayTotal);

    function _s() private pure returns (InsuranceStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(address admin, address vault_, address usdc_) external initializer {
        if (vault_ == address(0) || usdc_ == address(0)) revert Errors.ZeroAddress();
        __KryonUpgradeable_init(admin);
        _s().vault = IVault(vault_);
        _s().usdc = IERC20(usdc_);
        IERC20(usdc_).forceApprove(vault_, type(uint256).max);
    }

    function setEngine(address engine_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (engine_ == address(0)) revert Errors.ZeroAddress();
        _s().engine = IEngine(engine_);
        emit WiringSet("engine", engine_);
    }

    function setLiquidation(address liquidation_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (liquidation_ == address(0)) revert Errors.ZeroAddress();
        _s().liquidation = liquidation_;
        emit WiringSet("liquidation", liquidation_);
    }

    function setGateway(address gateway_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (gateway_ == address(0)) revert Errors.ZeroAddress();
        _s().gateway = gateway_;
        emit WiringSet("gateway", gateway_);
    }

    /// @notice Backstop unwind limits (plan §4.4). Zero deviation disables unwinds.
    function setUnwindLimits(uint16 maxDeviationBps, int256 maxFillNotional, int256 maxDailyNotional)
        external
        onlyRole(Roles.RISK_ADMIN_ROLE)
    {
        if (maxDeviationBps > MAX_UNWIND_DEVIATION_BPS) revert Errors.InvalidConfig();
        if (maxFillNotional < 0 || maxFillNotional > MAX_UNWIND_FILL_NOTIONAL) revert Errors.InvalidConfig();
        if (maxDailyNotional < maxFillNotional || maxDailyNotional > MAX_UNWIND_DAILY_NOTIONAL) {
            revert Errors.InvalidConfig();
        }
        InsuranceStorage storage $ = _s();
        $.maxUnwindDeviationBps = maxDeviationBps;
        $.maxUnwindFillNotional = maxFillNotional;
        $.maxUnwindDailyNotional = maxDailyNotional;
        emit UnwindLimitsSet(maxDeviationBps, maxFillNotional, maxDailyNotional);
    }

    // ---------------------------------------------------------------- backstop

    /// @notice ERC-1271. `signature` is `abi.encode(bytes orderAbi, bytes signerSignature)`
    ///         where `orderAbi = abi.encode(Order)`.
    /// @dev Valid only for a reduce-only order owned by this contract, expiring
    ///      within MAX_UNWIND_ORDER_TTL, whose EIP-712 digest is `hash`, signed
    ///      by a BACKSTOP_SIGNER_ROLE key. Never reverts on malformed input.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        InsuranceStorage storage $ = _s();
        if ($.maxUnwindDeviationBps == 0 || $.gateway == address(0)) return bytes4(0xffffffff);
        if (signature.length < 128) return bytes4(0xffffffff);
        (bytes memory orderAbi, bytes memory signerSig) = abi.decode(signature, (bytes, bytes));
        if (orderAbi.length != 9 * 32) return bytes4(0xffffffff);
        Order memory o = abi.decode(orderAbi, (Order));
        return _validUnwindOrder(hash, o, signerSig) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function _validUnwindOrder(bytes32 hash, Order memory o, bytes memory signerSig) private view returns (bool) {
        InsuranceStorage storage $ = _s();
        if (o.owner != address(this) || !o.reduceOnly) return false;
        if (o.expiry > block.timestamp + MAX_UNWIND_ORDER_TTL) return false;
        if (IOrderHasher($.gateway).hashOrder(o) != hash) return false;
        // slither-disable-next-line unused-return
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signerSig);
        return err == ECDSA.RecoverError.NoError && hasRole(Roles.BACKSTOP_SIGNER_ROLE, signer);
    }

    /// @notice Called by the gateway for every fill of a backstop order.
    ///         Reverts (rejecting the fill) outside the price band or caps.
    function onBackstopFill(uint32 marketId, uint256 size, uint256 price) external {
        InsuranceStorage storage $ = _s();
        if (msg.sender != $.gateway) revert Errors.Unauthorized();
        if ($.maxUnwindDeviationBps == 0) revert Errors.BackstopUnwindDisabled();
        int256 p = M.toInt(price);
        int256 index = $.engine.indexPrice(marketId);
        if (M.abs(p - index) > M.applyBps(index, $.maxUnwindDeviationBps)) revert Errors.PriceOutsideBand();
        int256 notional_ = M.mulPrecision(M.toInt(size), p);
        if (notional_ > $.maxUnwindFillNotional) revert Errors.BackstopLimitExceeded();
        uint256 day = block.timestamp / 1 days;
        int256 total = $.unwoundOnDay[day] + notional_;
        if (total > $.maxUnwindDailyNotional) revert Errors.BackstopLimitExceeded();
        $.unwoundOnDay[day] = total;
        emit BackstopUnwound(marketId, size, price, notional_, total);
    }

    // ---------------------------------------------------------------- funding

    /// @notice One-way contribution to operating capital. No claim back.
    function donate(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert Errors.InvalidAmount();
        _pullIntoVault(amount);
        emit Donated(msg.sender, amount);
    }

    /// @notice Stake into the redeemable pool. Shares are priced against staked
    ///         capital only, never operating capital, so a first staker can't
    ///         claim donations made before any shares existed.
    function stake(uint256 amount) external nonReentrant whenNotPaused returns (int256 minted) {
        if (amount == 0) revert Errors.InvalidAmount();
        InsuranceStorage storage $ = _s();
        int256 value = Decimals.toInternal(amount);
        int256 nav = $.stakedBalance;
        int256 total = $.totalShares;
        _pullIntoVault(amount);
        minted = (total <= 0 || nav <= 0) ? value : M.mulDiv(value, total, nav);
        if (minted <= 0) revert Errors.InvalidAmount();
        $.stakedBalance = M.add(nav, value);
        $.totalShares = M.add(total, minted);
        ShareBalance storage b = $.shares[msg.sender];
        int256 current = b.epoch == $.epoch ? b.shares : int256(0);
        $.shares[msg.sender] = ShareBalance({epoch: $.epoch, shares: M.add(current, minted)});
        emit Staked(msg.sender, amount, minted, $.epoch);
    }

    /// @notice Start the cooldown on redeeming `shares`. One request at a time.
    function requestUnstake(int256 shares) external whenNotPaused returns (uint64 unlockTime) {
        InsuranceStorage storage $ = _s();
        if (shares <= 0) revert Errors.InvalidAmount();
        if (shares > sharesOf(msg.sender)) revert Errors.InsufficientCollateral();
        if ($.pending[msg.sender].shares > 0 && $.pending[msg.sender].epoch == $.epoch) {
            revert Errors.UnstakePending();
        }
        unlockTime = uint64(block.timestamp) + UNSTAKE_COOLDOWN;
        $.pending[msg.sender] = PendingUnstake({shares: shares, unlockTime: unlockTime, epoch: $.epoch});
        emit UnstakeRequested(msg.sender, shares, unlockTime, $.epoch);
    }

    /// @notice Redeem a matured request at the CURRENT share price, so a sweep
    ///         during the cooldown is absorbed rather than dodged.
    function withdrawUnstaked() external nonReentrant whenNotPaused returns (uint256 amount) {
        InsuranceStorage storage $ = _s();
        PendingUnstake memory req = $.pending[msg.sender];
        if (req.shares <= 0) revert Errors.NoPendingUnstake();
        if (block.timestamp < req.unlockTime) revert Errors.CooldownActive();
        delete $.pending[msg.sender];

        // A request that outlived its epoch redeems shares a loss wrote off.
        if (req.epoch != $.epoch) {
            delete $.shares[msg.sender];
            emit Unstaked(msg.sender, req.shares, 0);
            return 0;
        }
        int256 held = $.shares[msg.sender].shares;
        int256 shares = M.min(req.shares, held);
        int256 total = $.totalShares;
        int256 nav = $.stakedBalance;
        // An under-water backstop is a loss stakers carry pro rata, even before
        // a sweep realises it, so nobody exits at full NAV ahead of it.
        int256 redeemable = redeemableStake();
        int256 payout = total <= 0 ? int256(0) : M.min(M.mulDiv(shares, redeemable, total), nav);
        amount = payout > 0 ? Decimals.toTokenDown(payout) : 0;
        int256 paid = Decimals.toInternal(amount);

        $.stakedBalance = nav - paid;
        $.totalShares = total - shares;
        $.shares[msg.sender].shares = held - shares;
        emit Unstaked(msg.sender, shares, amount);
        if (amount > 0) $.vault.withdrawTo(msg.sender, amount);
    }

    /// @notice Move staked capital into operating capital: the moment stakers
    ///         absorb a loss. Timelocked, so stakers get advance notice.
    function sweepToOperating(int256 amount)
        external
        onlyRole(Roles.DEFAULT_ADMIN_ROLE)
        returns (int256 swept)
    {
        if (amount <= 0) revert Errors.InvalidAmount();
        InsuranceStorage storage $ = _s();
        swept = M.min(amount, $.stakedBalance);
        if (swept <= 0) return 0;
        $.stakedBalance -= swept;
        emit SweptToOperating(swept, $.stakedBalance);
        // A sweep to zero NAV writes the stakers off: retire their shares so
        // they never dilute whoever recapitalises the pool.
        if ($.stakedBalance == 0 && $.totalShares > 0) {
            emit EpochRetired($.epoch, $.totalShares);
            $.epoch += 1;
            $.totalShares = 0;
        }
    }

    // ------------------------------------------------------------- bad debt

    /// @notice Cover `trader`'s negative balance from operating capital once
    ///         they have no open positions. Permissionless: it only ever moves
    ///         insurance funds to a real, closed-out deficit. What cannot be
    ///         covered is recorded as bad debt.
    function settleBadDebt(address trader) external nonReentrant whenNotPaused returns (int256 covered) {
        InsuranceStorage storage $ = _s();
        if (trader == address(this)) revert Errors.InsuranceAccount();
        if ($.engine.positionCount(trader) != 0) revert Errors.HasOpenPositions();
        int256 bal = $.vault.balanceOf(trader);
        int256 deficit = bal < 0 ? -bal : int256(0);
        int256 available = M.max(operatingBalance(), 0);
        covered = M.min(deficit, available);
        if (covered > 0) {
            $.vault.transferInternal(address(this), trader, covered, REASON_COVER);
        }
        int256 remaining = deficit - covered;
        int256 previous = $.recordedDebt[trader];
        if (remaining != previous) {
            $.recordedDebt[trader] = remaining;
            $.badDebt = $.badDebt - previous + remaining;
            emit BadDebtRecorded(trader, remaining, $.badDebt);
        }
        emit DeficitCovered(trader, covered, remaining);
    }

    /// @notice Shrink `trader`'s recorded debt to what they still owe. Called
    ///         by the vault when a deposit repays a negative balance; never
    ///         moves funds and never increases the record.
    function refreshDebt(address trader) external {
        InsuranceStorage storage $ = _s();
        if (msg.sender != address($.vault)) revert Errors.Unauthorized();
        int256 previous = $.recordedDebt[trader];
        if (previous == 0) return;
        int256 bal = $.vault.balanceOf(trader);
        int256 owed = bal < 0 ? -bal : int256(0);
        if (owed >= previous) return;
        $.recordedDebt[trader] = owed;
        $.badDebt = $.badDebt - previous + owed;
        emit BadDebtRecorded(trader, owed, $.badDebt);
    }

    // ------------------------------------------------------------------ views

    /// @notice Operating capital in cash: the ledger balance above staked
    ///         capital (may be negative after realized backstop losses). This is
    ///         what `settleBadDebt` can actually pay out. Ignores the PnL of
    ///         open backstop positions; see `markedOperatingBalance`.
    function operatingBalance() public view returns (int256) {
        InsuranceStorage storage $ = _s();
        return $.vault.balanceOf(address(this)) - $.stakedBalance;
    }

    /// @notice Operating capital marked to market: the backstop account's
    ///         equity (cash + unrealized PnL + pending funding) minus staked
    ///         capital. `priced` is false if a held market can't be priced.
    function markedOperatingBalance() public view returns (int256 marked, bool priced) {
        InsuranceStorage storage $ = _s();
        int256 equity;
        (equity, priced) = $.engine.accountValue(address(this));
        if (priced) marked = equity - $.stakedBalance;
    }

    /// @notice Capacity used by the OI policy: marked operating capital net of
    ///         bad debt, >= 0. Fails closed to 0 when the backstop can't be priced.
    function effectiveBalance() external view returns (int256) {
        (int256 marked, bool priced) = markedOperatingBalance();
        if (!priced) return 0;
        return M.max(0, marked - _s().badDebt);
    }

    /// @notice What all stakers could redeem together now: staked capital less
    ///         any negative marked operating balance, >= 0.
    function redeemableStake() public view returns (int256) {
        (int256 marked, bool priced) = markedOperatingBalance();
        if (!priced) revert Errors.StaleOracle();
        return M.max(0, _s().stakedBalance + M.min(0, marked));
    }

    function unwindLimits()
        external
        view
        returns (uint16 maxDeviationBps, int256 maxFillNotional, int256 maxDailyNotional, int256 usedToday)
    {
        InsuranceStorage storage $ = _s();
        return (
            $.maxUnwindDeviationBps,
            $.maxUnwindFillNotional,
            $.maxUnwindDailyNotional,
            $.unwoundOnDay[block.timestamp / 1 days]
        );
    }

    function gateway() external view returns (address) {
        return _s().gateway;
    }

    function badDebt() external view returns (int256) {
        return _s().badDebt;
    }

    function recordedDebt(address trader) external view returns (int256) {
        return _s().recordedDebt[trader];
    }

    /// @notice Recorded deficits that marked operating capital cannot pay.
    ///         ADL may only socialise up to this amount. Reverts StaleOracle
    ///         when the backstop can't be priced.
    function unfundedShortfall() external view returns (int256) {
        (int256 marked, bool priced) = markedOperatingBalance();
        if (!priced) revert Errors.StaleOracle();
        return M.max(0, _s().badDebt - M.max(marked, 0));
    }

    function stakedBalance() external view returns (int256) {
        return _s().stakedBalance;
    }

    function totalShares() external view returns (int256) {
        return _s().totalShares;
    }

    function epoch() external view returns (uint32) {
        return _s().epoch;
    }

    function sharesOf(address staker) public view returns (int256) {
        ShareBalance memory b = _s().shares[staker];
        return b.epoch == _s().epoch ? b.shares : int256(0);
    }

    function pendingUnstake(address staker) external view returns (PendingUnstake memory) {
        return _s().pending[staker];
    }

    /// @notice Redemption value of one share, 1e18 = 1:1.
    function sharePrice() external view returns (int256) {
        InsuranceStorage storage $ = _s();
        if ($.totalShares <= 0) return M.PRECISION;
        return M.mulDiv($.stakedBalance, M.PRECISION, $.totalShares);
    }

    // --------------------------------------------------------------- internal

    function _pullIntoVault(uint256 amount) private {
        InsuranceStorage storage $ = _s();
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        $.vault.depositFor(address(this), amount);
    }
}
