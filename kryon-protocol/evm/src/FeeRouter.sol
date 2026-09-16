// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IVault} from "./interfaces/IKryon.sol";
import {Decimals} from "./libraries/Decimals.sol";
import {Errors} from "./libraries/Errors.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";

/// @title FeeRouter
/// @notice Trading-fee schedule, tiers, split, accrual and claims.
/// @dev Rates are in millionths of notional (1 = 0.01 bps), so the launch
///      schedule of 3.5 / 0.5 bps is 350 / 50. Fees never leave the vault on a
///      fill: they move, inside the ledger, from the trader to this contract's
///      vault account (treasury + referral sub-ledgers) and to the insurance
///      account. `claim*` is the only path that turns them into tokens.
///
///      Sub-ledger identity, exact at 1e18:
///        vault.balanceOf(this) == treasuryAccrued + Σ referralAccrued
contract FeeRouter is KryonUpgradeable {
    int256 public constant RATE_DENOMINATOR = 1_000_000;
    /// Hard caps (millionths). Not even the timelock can exceed them.
    int256 public constant MAX_TAKER_RATE = 2500; // 25 bps
    int256 public constant MAX_MAKER_RATE = 2500; // 25 bps
    int256 public constant MIN_MAKER_RATE = -200; // -2 bps rebate
    int256 public constant MIN_NET_RATE_FLOOR = 100; // 1 bps
    int256 public constant MAX_NET_RATE_FLOOR = 2500;
    uint16 public constant MIN_INSURANCE_SHARE_BPS = 1000; // 10%
    uint16 public constant MAX_REFERRAL_SHARE_BPS = 2000; // 20%
    uint16 public constant MAX_LIQ_INSURANCE_SHARE_BPS = 10_000;
    uint8 public constant MAX_TIER = 16;

    bytes32 public constant REASON_FEE = "FEE";
    bytes32 public constant REASON_REBATE = "REBATE";
    bytes32 public constant REASON_FEE_INSURANCE = "FEE_INSURANCE";
    bytes32 public constant REASON_LIQ_FEE = "LIQUIDATION_FEE";

    struct Rates {
        int32 makerRate;
        int32 takerRate;
        bool set;
    }

    struct Split {
        uint16 treasuryBps;
        uint16 insuranceBps;
        uint16 referralBps;
    }

    /// @custom:storage-location erc7201:kryon.storage.FeeRouter
    struct FeeRouterStorage {
        IVault vault;
        address insurance;
        address treasury;
        mapping(uint32 => Rates) marketRates;
        mapping(uint8 => Rates) tiers;
        mapping(address => uint8) accountTier;
        int256 minNetRate;
        bool rebatesEnabled;
        bool referralsEnabled;
        Split split;
        /// Share of liquidation penalties (after the liquidator reward) sent to
        /// insurance; the rest accrues to treasury.
        uint16 liquidationInsuranceBps;
        int256 treasuryAccrued;
        mapping(address => int256) referralAccrued;
        int256 totalReferralAccrued;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.FeeRouter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xad3b2833285014fcfc2fca81382e992fb621b934f8bbb534435eb99a120fda00;

    event MarketFeesSet(uint32 indexed marketId, int32 makerRate, int32 takerRate);
    event FeeTierDefined(uint8 indexed tier, int32 makerRate, int32 takerRate);
    event FeeTierSet(address indexed account, uint8 tier);
    event MinNetRateSet(int256 rate);
    event RebatesEnabledSet(bool enabled);
    event ReferralsEnabledSet(bool enabled);
    event SplitSet(uint16 treasuryBps, uint16 insuranceBps, uint16 referralBps);
    event LiquidationSplitSet(uint16 insuranceBps);
    event RecipientsSet(address treasury, address insurance);
    event FeeAccrued(
        uint32 indexed marketId,
        address indexed payer,
        address indexed referrer,
        int256 amount,
        int256 toTreasury,
        int256 toInsurance,
        int256 toReferral
    );
    event FeeClaimed(
        bytes32 indexed bucket, address indexed recipient, uint256 amount, int256 internalAmount
    );

    function _s() private pure returns (FeeRouterStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(address admin, address vault_, address treasury_, address insurance_)
        external
        initializer
    {
        if (vault_ == address(0) || treasury_ == address(0) || insurance_ == address(0)) {
            revert Errors.ZeroAddress();
        }
        __KryonUpgradeable_init(admin);
        FeeRouterStorage storage $ = _s();
        $.vault = IVault(vault_);
        $.treasury = treasury_;
        $.insurance = insurance_;
        $.minNetRate = MIN_NET_RATE_FLOOR;
        $.split = Split({treasuryBps: 7000, insuranceBps: 2000, referralBps: 1000});
        $.liquidationInsuranceBps = 5000;
        emit RecipientsSet(treasury_, insurance_);
        emit SplitSet(7000, 2000, 1000);
        emit MinNetRateSet(MIN_NET_RATE_FLOOR);
        emit LiquidationSplitSet(5000);
    }

    // ---------------------------------------------------------------- config

    function setMarketFees(uint32 marketId, int32 makerRate, int32 takerRate)
        external
        onlyRole(Roles.FEE_ADMIN_ROLE)
    {
        if (marketId == 0) revert Errors.InvalidConfig();
        _checkRates(makerRate, takerRate);
        _s().marketRates[marketId] = Rates(makerRate, takerRate, true);
        emit MarketFeesSet(marketId, makerRate, takerRate);
    }

    /// @notice Define (or redefine) a volume tier. Tier 0 is the market schedule.
    function defineTier(uint8 tier, int32 makerRate, int32 takerRate)
        external
        onlyRole(Roles.FEE_ADMIN_ROLE)
    {
        if (tier == 0 || tier > MAX_TIER) revert Errors.UnknownFeeTier(tier);
        _checkRates(makerRate, takerRate);
        _s().tiers[tier] = Rates(makerRate, takerRate, true);
        emit FeeTierDefined(tier, makerRate, takerRate);
    }

    /// @notice Assign an account to an existing tier (0 = market schedule).
    function setAccountTier(address account, uint8 tier) external onlyRole(Roles.FEE_TIER_ROLE) {
        if (tier != 0 && !_s().tiers[tier].set) revert Errors.UnknownFeeTier(tier);
        _s().accountTier[account] = tier;
        emit FeeTierSet(account, tier);
    }

    function setMinNetRate(int256 rate) external onlyRole(Roles.FEE_ADMIN_ROLE) {
        if (rate < MIN_NET_RATE_FLOOR || rate > MAX_NET_RATE_FLOOR) revert Errors.FeeRateOutOfBounds();
        _s().minNetRate = rate;
        emit MinNetRateSet(rate);
    }

    function setRebatesEnabled(bool enabled) external onlyRole(Roles.FEE_ADMIN_ROLE) {
        _s().rebatesEnabled = enabled;
        emit RebatesEnabledSet(enabled);
    }

    function setReferralsEnabled(bool enabled) external onlyRole(Roles.FEE_ADMIN_ROLE) {
        _s().referralsEnabled = enabled;
        emit ReferralsEnabledSet(enabled);
    }

    function setSplit(uint16 treasuryBps, uint16 insuranceBps, uint16 referralBps)
        external
        onlyRole(Roles.FEE_ADMIN_ROLE)
    {
        if (uint256(treasuryBps) + insuranceBps + referralBps != 10_000) {
            revert Errors.InvalidConfig();
        }
        if (insuranceBps < MIN_INSURANCE_SHARE_BPS || referralBps > MAX_REFERRAL_SHARE_BPS) {
            revert Errors.InvalidConfig();
        }
        _s().split = Split(treasuryBps, insuranceBps, referralBps);
        emit SplitSet(treasuryBps, insuranceBps, referralBps);
    }

    function setLiquidationSplit(uint16 insuranceBps) external onlyRole(Roles.FEE_ADMIN_ROLE) {
        if (insuranceBps < MIN_INSURANCE_SHARE_BPS || insuranceBps > MAX_LIQ_INSURANCE_SHARE_BPS) {
            revert Errors.InvalidConfig();
        }
        _s().liquidationInsuranceBps = insuranceBps;
        emit LiquidationSplitSet(insuranceBps);
    }

    function setTreasury(address treasury_) external onlyRole(Roles.FEE_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert Errors.ZeroAddress();
        _s().treasury = treasury_;
        emit RecipientsSet(treasury_, _s().insurance);
    }

    function _checkRates(int32 makerRate, int32 takerRate) private view {
        FeeRouterStorage storage $ = _s();
        if (takerRate < 0 || takerRate > MAX_TAKER_RATE) revert Errors.FeeRateOutOfBounds();
        if (makerRate < MIN_MAKER_RATE || makerRate > MAX_MAKER_RATE) {
            revert Errors.FeeRateOutOfBounds();
        }
        if (makerRate < 0 && !$.rebatesEnabled) revert Errors.FeeRateOutOfBounds();
        if (int256(makerRate) + takerRate < $.minNetRate) revert Errors.NetFeeBelowFloor();
    }

    // ------------------------------------------------------------ fill fees

    /// @notice Fees for a fill, without moving anything.
    /// @return makerFee Signed: negative is a rebate. Debits round up, credits down.
    /// @return takerFee Always >= 0, rounded up.
    function quote(uint32 marketId, address maker, address taker, int256 fillNotional)
        public
        view
        returns (int256 makerFee, int256 takerFee, uint8 makerTier, uint8 takerTier)
    {
        if (fillNotional <= 0) revert Errors.InvalidAmount();
        FeeRouterStorage storage $ = _s();
        int256 makerRate;
        int256 takerRate;
        (makerRate, makerTier) = _rateFor(marketId, maker, true);
        (takerRate, takerTier) = _rateFor(marketId, taker, false);
        if (makerRate < 0 && !$.rebatesEnabled) makerRate = 0;
        // Tiers are validated one at a time; a pairing of two tiers could still
        // net below the floor, so clamp the maker side up to the floor here.
        if (makerRate + takerRate < $.minNetRate) makerRate = $.minNetRate - takerRate;

        takerFee = _ceilMul(fillNotional, takerRate);
        makerFee = makerRate >= 0
            ? _ceilMul(fillNotional, makerRate)
            : -M.mulDiv(fillNotional, -makerRate, RATE_DENOMINATOR);
    }

    /// @notice Charge both sides of a fill and split the net fee. Gateway only.
    function chargeFill(
        uint32 marketId,
        address maker,
        address taker,
        int256 fillNotional,
        address makerReferrer,
        address takerReferrer
    )
        external
        onlyRole(Roles.FEE_SOURCE_ROLE)
        returns (int256 makerFee, int256 takerFee, uint8 makerTier, uint8 takerTier)
    {
        (makerFee, takerFee, makerTier, takerTier) = quote(marketId, maker, taker, fillNotional);
        IVault vault_ = _s().vault;
        if (takerFee > 0) vault_.transferInternal(taker, address(this), takerFee, REASON_FEE);
        if (makerFee > 0) {
            vault_.transferInternal(maker, address(this), makerFee, REASON_FEE);
            _accrue(marketId, maker, makerFee, makerReferrer);
            _accrue(marketId, taker, takerFee, takerReferrer);
        } else {
            // A rebate is paid out of this same fill's taker fee; only the net
            // (never negative, by the floor) is split.
            if (makerFee < 0) vault_.transferInternal(address(this), maker, -makerFee, REASON_REBATE);
            _accrue(marketId, taker, takerFee + makerFee, takerReferrer);
        }
    }

    /// @notice Route a liquidation penalty (after the liquidator reward) that
    ///         the liquidation contract already moved into this account.
    function accrueLiquidationFee(uint32 marketId, address payer, int256 amount)
        external
        onlyRole(Roles.FEE_SOURCE_ROLE)
    {
        if (amount < 0) revert Errors.InvalidAmount();
        if (amount == 0) return;
        FeeRouterStorage storage $ = _s();
        int256 toInsurance = M.mulDiv(amount, int256(uint256($.liquidationInsuranceBps)), 10_000);
        int256 toTreasury = amount - toInsurance;
        $.treasuryAccrued += toTreasury;
        if (toInsurance > 0) {
            $.vault.transferInternal(address(this), $.insurance, toInsurance, REASON_LIQ_FEE);
        }
        emit FeeAccrued(marketId, payer, address(0), amount, toTreasury, toInsurance, 0);
    }

    function _accrue(uint32 marketId, address payer, int256 amount, address referrer) private {
        if (amount <= 0) return;
        FeeRouterStorage storage $ = _s();
        Split memory sp = $.split;
        int256 toInsurance = M.mulDiv(amount, int256(uint256(sp.insuranceBps)), 10_000);
        int256 toReferral = M.mulDiv(amount, int256(uint256(sp.referralBps)), 10_000);
        int256 toTreasury = amount - toInsurance - toReferral;

        address creditedReferrer = address(0);
        if ($.referralsEnabled && referrer != address(0) && referrer != payer) {
            creditedReferrer = referrer;
            $.referralAccrued[referrer] += toReferral;
            $.totalReferralAccrued += toReferral;
        } else {
            // Referral share accrues to treasury until the program is live.
            toTreasury += toReferral;
            toReferral = 0;
        }
        $.treasuryAccrued += toTreasury;
        if (toInsurance > 0) {
            $.vault.transferInternal(address(this), $.insurance, toInsurance, REASON_FEE_INSURANCE);
        }
        emit FeeAccrued(
            marketId, payer, creditedReferrer, amount, toTreasury, toInsurance, toReferral
        );
    }

    function _rateFor(uint32 marketId, address account, bool isMaker)
        private
        view
        returns (int256 rate, uint8 tier)
    {
        FeeRouterStorage storage $ = _s();
        tier = $.accountTier[account];
        Rates memory r = tier == 0 ? $.marketRates[marketId] : $.tiers[tier];
        if (!r.set) {
            // A tier that was removed falls back to the market schedule.
            tier = 0;
            r = $.marketRates[marketId];
        }
        if (!r.set) revert Errors.UnknownMarket(marketId);
        rate = isMaker ? int256(r.makerRate) : int256(r.takerRate);
    }

    function _ceilMul(int256 notional_, int256 rate) private pure returns (int256) {
        if (rate == 0) return 0;
        int256 p = M.bound128(notional_) * rate;
        return M.bound128((p - 1) / RATE_DENOMINATOR + 1);
    }

    // ------------------------------------------------------------------ claims

    /// @notice Pay accrued treasury fees to the treasury. Anyone may call;
    ///         funds only ever go to the configured treasury.
    /// @dev Pays whole USDC units (rounded down); the dust stays accrued.
    function claimTreasury() external nonReentrant returns (uint256 amount) {
        FeeRouterStorage storage $ = _s();
        amount = Decimals.toTokenDown($.treasuryAccrued);
        if (amount == 0) return 0;
        int256 internalAmount = Decimals.toInternal(amount);
        $.treasuryAccrued -= internalAmount;
        $.vault.withdrawTo($.treasury, amount);
        emit FeeClaimed("TREASURY", $.treasury, amount, internalAmount);
    }

    /// @notice Pay a referrer's accrued share to the referrer.
    function claimReferral(address referrer) external nonReentrant returns (uint256 amount) {
        FeeRouterStorage storage $ = _s();
        amount = Decimals.toTokenDown($.referralAccrued[referrer]);
        if (amount == 0) return 0;
        int256 internalAmount = Decimals.toInternal(amount);
        $.referralAccrued[referrer] -= internalAmount;
        $.totalReferralAccrued -= internalAmount;
        $.vault.withdrawTo(referrer, amount);
        emit FeeClaimed("REFERRAL", referrer, amount, internalAmount);
    }

    // ------------------------------------------------------------------ views

    function marketRates(uint32 marketId) external view returns (Rates memory) {
        return _s().marketRates[marketId];
    }

    function tierRates(uint8 tier) external view returns (Rates memory) {
        return _s().tiers[tier];
    }

    function accountTier(address account) external view returns (uint8) {
        return _s().accountTier[account];
    }

    function minNetRate() external view returns (int256) {
        return _s().minNetRate;
    }

    function rebatesEnabled() external view returns (bool) {
        return _s().rebatesEnabled;
    }

    function referralsEnabled() external view returns (bool) {
        return _s().referralsEnabled;
    }

    function split() external view returns (Split memory) {
        return _s().split;
    }

    function liquidationInsuranceBps() external view returns (uint16) {
        return _s().liquidationInsuranceBps;
    }

    function treasuryAccrued() external view returns (int256) {
        return _s().treasuryAccrued;
    }

    function referralAccrued(address referrer) external view returns (int256) {
        return _s().referralAccrued[referrer];
    }

    function totalReferralAccrued() external view returns (int256) {
        return _s().totalReferralAccrued;
    }

    function recipients() external view returns (address treasury_, address insurance_) {
        return (_s().treasury, _s().insurance);
    }

    function vault() external view returns (address) {
        return address(_s().vault);
    }
}
