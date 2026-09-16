// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Errors} from "./Errors.sol";
import {KryonMath as M} from "./KryonMath.sol";
import {RiskLib} from "./RiskLib.sol";
import {
    AccountHealth,
    LiquidationMode,
    LiquidationPlan,
    RiskCollateral,
    RiskMarket,
    RiskPosition
} from "./Types.sol";

/// @notice Partial-liquidation sizing. Port of `risk_engine::liquidation`.
library LiquidationLib {
    /// @notice Size the smallest close that covers the maintenance shortfall,
    ///         capped at `partialLiquidationBps` of the position per step.
    function planLiquidation(
        RiskCollateral[] memory collateral,
        RiskPosition[] memory positions,
        RiskMarket[] memory markets,
        uint256 targetPositionId,
        uint256 partialLiquidationBps
    ) internal pure returns (LiquidationPlan memory plan) {
        AccountHealth memory health = RiskLib.accountHealth(collateral, positions, markets);
        if (!health.liquidatable) revert Errors.NotLiquidatable();
        if (partialLiquidationBps == 0 || partialLiquidationBps > 10_000) {
            revert Errors.InvalidConfig();
        }

        RiskPosition memory position = _find(positions, targetPositionId);
        RiskMarket memory market = RiskLib.findMarket(markets, position.marketId);

        int256 shortfall = M.sub(health.maintenanceMarginRequired, health.equity);
        int256 positionNotional = RiskLib.notional(position.size, market.oraclePrice);
        int256 maxPartial = M.mulDiv(position.size, int256(partialLiquidationBps), 10_000);
        int256 minToCover = M.mulDiv(position.size, shortfall, positionNotional);

        int256 closeSize;
        if (minToCover >= position.size) {
            closeSize = position.size;
        } else if (minToCover <= maxPartial) {
            closeSize = minToCover;
        } else {
            closeSize = maxPartial;
        }

        plan.mode = closeSize >= position.size ? LiquidationMode.Full : LiquidationMode.Partial;
        plan.positionId = targetPositionId;
        plan.closeSize = closeSize;
        plan.penalty = M.applyBps(
            RiskLib.notional(closeSize, market.oraclePrice), market.liquidationFeeBps
        );
        plan.expectedHealth = health;
    }

    function _find(RiskPosition[] memory positions, uint256 positionId)
        private
        pure
        returns (RiskPosition memory)
    {
        for (uint256 i = 0; i < positions.length; ++i) {
            if (positions[i].positionId == positionId) return positions[i];
        }
        revert Errors.InvalidConfig();
    }
}
