// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IEngine, IFeeRouter, IInsurance, IRiskParams, IVault} from "./interfaces/IKryon.sol";
import {Errors} from "./libraries/Errors.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";
import {RiskLib} from "./libraries/RiskLib.sol";
import {AccountHealth, MarketParams, Position} from "./libraries/Types.sol";

/// @title Liquidation
/// @notice Permissionless liquidation and auto-deleveraging.
/// @dev Liquidation moves the closed size to the insurance backstop at the
///      oracle index, so long and short open interest stay equal. The penalty
///      (liquidationFeeBps of the closed notional) pays a capped liquidator
///      reward; the remainder is split by the FeeRouter. Once an account has no
///      positions left, a negative balance is covered by insurance, and what
///      insurance cannot cover stays recorded as bad debt.
contract Liquidation is KryonUpgradeable {
    /// Soroban `initialize` cap on the reward.
    uint16 public constant MAX_REWARD_BPS_CAP = 1000;
    uint16 public constant MIN_PARTIAL_BPS = 1000;

    bytes32 public constant REASON_REWARD = "LIQUIDATION_REWARD";
    bytes32 public constant REASON_PENALTY = "LIQUIDATION_PENALTY";
    bytes32 public constant REASON_ADL_HAIRCUT = "ADL_HAIRCUT";

    /// @custom:storage-location erc7201:kryon.storage.Liquidation
    struct LiquidationStorage {
        IEngine engine;
        IVault vault;
        IRiskParams risk;
        IFeeRouter feeRouter;
        IInsurance insurance;
        /// Liquidator reward, in bps of the closed notional (<= the penalty).
        uint16 maxRewardBps;
        /// Largest share of a position one partial step may close.
        uint16 partialLiquidationBps;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.Liquidation")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xad5c3aff3b8483182b951ade73265a4cca008fe2ff0882b5f305f02ff94c1000;

    event Liquidated(
        address indexed trader,
        address indexed liquidator,
        uint32 indexed marketId,
        int256 closeSize,
        int256 price,
        int256 realizedPnl,
        int256 penalty,
        int256 reward,
        int256 equityBefore,
        int256 equityAfter
    );
    event Deleveraged(
        address indexed counterparty,
        address indexed keeper,
        uint32 indexed marketId,
        int256 closeSize,
        int256 price,
        int256 realizedPnl,
        int256 haircut
    );
    event ParamsSet(uint16 maxRewardBps, uint16 partialLiquidationBps);

    function _s() private pure returns (LiquidationStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(
        address admin,
        address engine_,
        address vault_,
        address risk_,
        address feeRouter_,
        address insurance_,
        uint16 maxRewardBps_,
        uint16 partialBps_
    ) external initializer {
        if (
            engine_ == address(0) || vault_ == address(0) || risk_ == address(0)
                || feeRouter_ == address(0) || insurance_ == address(0)
        ) revert Errors.ZeroAddress();
        __KryonUpgradeable_init(admin);
        LiquidationStorage storage $ = _s();
        $.engine = IEngine(engine_);
        $.vault = IVault(vault_);
        $.risk = IRiskParams(risk_);
        $.feeRouter = IFeeRouter(feeRouter_);
        $.insurance = IInsurance(insurance_);
        _setParams(maxRewardBps_, partialBps_);
    }

    /// @notice A reward of 0 disables liquidation economics (no rational keeper
    ///         runs at a loss), so it is rejected outright.
    function setParams(uint16 maxRewardBps_, uint16 partialBps_)
        external
        onlyRole(Roles.RISK_ADMIN_ROLE)
    {
        _setParams(maxRewardBps_, partialBps_);
    }

    function _setParams(uint16 maxRewardBps_, uint16 partialBps_) private {
        if (maxRewardBps_ == 0 || maxRewardBps_ > MAX_REWARD_BPS_CAP) revert Errors.InvalidConfig();
        if (partialBps_ < MIN_PARTIAL_BPS || partialBps_ > 10_000) revert Errors.InvalidConfig();
        _s().maxRewardBps = maxRewardBps_;
        _s().partialLiquidationBps = partialBps_;
        emit ParamsSet(maxRewardBps_, partialBps_);
    }

    // ------------------------------------------------------------ liquidation

    /// @notice Liquidate up to `maxSize` of `trader`'s position in `marketId`.
    /// @dev The close size comes from RiskLib.planLiquidation (the smallest
    ///      close that restores health, capped per step). An account with
    ///      non-positive equity is closed in full, up to `maxSize`.
    function liquidate(address trader, uint32 marketId, uint256 maxSize)
        external
        nonReentrant
        whenNotPaused
        returns (int256 closeSize)
    {
        LiquidationStorage storage $ = _s();
        if (trader == msg.sender) revert Errors.Unauthorized();
        if (trader == address($.insurance)) revert Errors.InsuranceAccount();
        if (maxSize == 0) revert Errors.InvalidAmount();
        IEngine engine_ = $.engine;

        Position memory pos = engine_.getPosition(trader, marketId);
        if (pos.size == 0) revert Errors.PositionNotFound();
        AccountHealth memory before;
        (closeSize, before) = engine_.planLiquidationSize(trader, marketId, $.partialLiquidationBps);
        if (before.equity <= 0) closeSize = M.abs(pos.size);
        closeSize = M.min(closeSize, M.toBoundedInt(maxSize));
        if (closeSize <= 0) revert Errors.InvalidAmount();

        int256 price = engine_.indexPrice(marketId);
        int256 realized =
            engine_.liquidationTransfer(trader, address($.insurance), marketId, closeSize, price);

        MarketParams memory m = $.risk.market(marketId);
        int256 closedNotional = RiskLib.notional(closeSize, price);
        int256 penalty = M.applyBps(closedNotional, m.liquidationFeeBps);
        int256 reward = M.min(penalty, M.applyBps(closedNotional, $.maxRewardBps));
        IVault vault_ = $.vault;
        vault_.transferInternal(trader, msg.sender, reward, REASON_REWARD);
        if (penalty > reward) {
            vault_.transferInternal(trader, address($.feeRouter), penalty - reward, REASON_PENALTY);
            $.feeRouter.accrueLiquidationFee(marketId, trader, penalty - reward);
        }

        AccountHealth memory afterH = engine_.accountHealth(trader);
        bool improved = before.equity > 0 && afterH.equity > 0
            ? afterH.marginRatio > before.marginRatio
            : afterH.maintenanceMarginRequired < before.maintenanceMarginRequired;
        if (!improved) revert Errors.LiquidationWouldNotImproveHealth();

        // Insurance is the last resort, and only once nothing is left to close.
        if (engine_.positionCount(trader) == 0 && vault_.balanceOf(trader) < 0) {
            $.insurance.settleBadDebt(trader);
        }

        emit Liquidated(
            trader,
            msg.sender,
            marketId,
            closeSize,
            price,
            realized,
            penalty,
            reward,
            before.equity,
            afterH.equity
        );
    }

    /// @notice Auto-deleveraging: close part of the insurance backstop's
    ///         position against an in-profit `counterparty`, and haircut that
    ///         counterparty's realized gain by the unfunded shortfall.
    /// @dev Refused while insurance can cover every recorded deficit. Two
    ///      checks make a wrong keeper target cheap: the counterparty must be
    ///      in profit at the index, and the close is capped so the haircut never
    ///      exceeds the shortfall (KRY-Q4).
    function adl(address counterparty, uint32 marketId, uint256 maxSize)
        external
        nonReentrant
        whenNotPaused
        returns (int256 closeSize)
    {
        LiquidationStorage storage $ = _s();
        IInsurance ins = $.insurance;
        if (counterparty == address(ins)) revert Errors.InsuranceAccount();
        if (maxSize == 0) revert Errors.InvalidAmount();
        int256 shortfall = ins.unfundedShortfall();
        if (shortfall <= 0) revert Errors.NoBadDebtToOffset();

        IEngine engine_ = $.engine;
        Position memory cp = engine_.getPosition(counterparty, marketId);
        Position memory bs = engine_.getPosition(address(ins), marketId);
        if (cp.size == 0 || bs.size == 0) revert Errors.PositionNotFound();
        if ((cp.size > 0) == (bs.size > 0)) revert Errors.DirectionMismatch();

        int256 price = engine_.indexPrice(marketId);
        int256 absCp = M.abs(cp.size);
        // Exact unrealized PnL from the stored cost basis.
        int256 upnl = (cp.size > 0 ? int256(1) : int256(-1)) * RiskLib.notional(absCp, price)
            - cp.openNotional;
        if (upnl <= 0) revert Errors.PositionNotInProfit();

        closeSize = M.min(M.toBoundedInt(maxSize), M.min(absCp, M.abs(bs.size)));
        // Never realise more gain than the shortfall it is meant to pay down.
        closeSize = M.min(closeSize, M.mulDiv(shortfall, absCp, upnl));
        if (closeSize <= 0) revert Errors.NoBadDebtToOffset();

        int256 realized = engine_.adlTransfer(address(ins), counterparty, marketId, closeSize, price);
        int256 haircut = M.min(M.max(realized, 0), shortfall);
        if (haircut > 0) {
            $.vault.transferInternal(counterparty, address(ins), haircut, REASON_ADL_HAIRCUT);
        }
        emit Deleveraged(counterparty, msg.sender, marketId, closeSize, price, realized, haircut);
    }

    // ------------------------------------------------------------------ views

    function params() external view returns (uint16 maxRewardBps, uint16 partialLiquidationBps) {
        return (_s().maxRewardBps, _s().partialLiquidationBps);
    }

    function wiring()
        external
        view
        returns (address engine_, address vault_, address risk_, address feeRouter_, address insurance_)
    {
        LiquidationStorage storage $ = _s();
        return (
            address($.engine),
            address($.vault),
            address($.risk),
            address($.feeRouter),
            address($.insurance)
        );
    }
}
