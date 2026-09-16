// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LiquidationLib} from "./LiquidationLib.sol";
import {RiskLib} from "./RiskLib.sol";
import {
    AccountHealth,
    LiquidationPlan,
    RiskCollateral,
    RiskMarket,
    RiskPosition
} from "./Types.sol";

/// @notice Deployed (linked) entry points for the pure risk math.
/// @dev Keeps the RiskLib/LiquidationLib bytecode out of the Engine so the
///      Engine stays well under the 24KB limit. The logic lives in the
///      internal libraries, which are what the differential harness fuzzes.
library RiskCalc {
    function accountHealth(
        RiskCollateral[] memory collateral,
        RiskPosition[] memory positions,
        RiskMarket[] memory markets
    ) public pure returns (AccountHealth memory) {
        return RiskLib.accountHealth(collateral, positions, markets);
    }

    function validateWithdrawal(
        RiskCollateral[] memory collateral,
        RiskPosition[] memory positions,
        RiskMarket[] memory markets,
        int256 withdrawalValue
    ) public pure returns (AccountHealth memory) {
        return RiskLib.validateWithdrawal(collateral, positions, markets, withdrawalValue);
    }

    function planLiquidation(
        RiskCollateral[] memory collateral,
        RiskPosition[] memory positions,
        RiskMarket[] memory markets,
        uint256 targetPositionId,
        uint256 partialLiquidationBps
    ) public pure returns (LiquidationPlan memory) {
        return LiquidationLib.planLiquidation(
            collateral, positions, markets, targetPositionId, partialLiquidationBps
        );
    }
}
