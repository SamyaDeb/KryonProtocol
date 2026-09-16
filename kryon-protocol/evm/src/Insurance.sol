// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IEngine, IVault} from "./interfaces/IKryon.sol";
import {Decimals} from "./libraries/Decimals.sol";
import {Errors} from "./libraries/Errors.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";

/// @title Insurance
/// @notice The protocol's backstop fund and the account that takes over
///         liquidated positions.
/// @dev All of the fund's USDC sits in the vault under this contract's
///      address. That one balance is split into:
///        - staked capital (`stakedBalance`), redeemable through share epochs;
///        - operating capital (`vault balance - stakedBalance`), which receives
///          fee shares, penalties, donations and backstop PnL, and which
///          covers deficits.
///      Staked capital only absorbs losses through an explicit, timelocked
///      `sweepToOperating`.
contract Insurance is KryonUpgradeable {
    using SafeERC20 for IERC20;

    uint64 public constant UNSTAKE_COOLDOWN = 7 days;
    bytes32 public constant REASON_COVER = "INSURANCE_COVER";

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
        int256 payout = total <= 0 ? int256(0) : M.min(M.mulDiv(shares, nav, total), nav);
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

    /// @notice Operating capital (may be negative after backstop losses).
    function operatingBalance() public view returns (int256) {
        InsuranceStorage storage $ = _s();
        return $.vault.balanceOf(address(this)) - $.stakedBalance;
    }

    /// @notice Capacity used by the OI policy: operating net of bad debt, >= 0.
    function effectiveBalance() external view returns (int256) {
        return M.max(0, operatingBalance() - _s().badDebt);
    }

    function badDebt() external view returns (int256) {
        return _s().badDebt;
    }

    function recordedDebt(address trader) external view returns (int256) {
        return _s().recordedDebt[trader];
    }

    /// @notice Recorded deficits that operating capital cannot pay today.
    ///         ADL may only socialise up to this amount.
    function unfundedShortfall() external view returns (int256) {
        return M.max(0, _s().badDebt - M.max(operatingBalance(), 0));
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
