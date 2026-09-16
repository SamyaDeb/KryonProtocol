// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonErrors as Errors} from "./Errors.sol";
import {KryonMath as M} from "./KryonMath.sol";
import {AccountHealth, RiskCollateral, RiskMarket, RiskPosition} from "./Types.sol";

/// @notice Account health and margin math. Port of `risk_engine::margin` and
///         the accounting helpers in `protocol_core::accounting`.
/// @dev Differentially fuzzed against the Rust crate (test/differential).
///      Keep the control flow identical to the reference, including the
///      error chosen on each failure path.
library RiskLib {
    /// risk-engine's fixed `pnl_buf` capacity.
    uint256 internal constant MAX_POSITIONS = 64;

    function collateralValueAfterHaircut(int256 value, uint256 haircutBps)
        internal
        pure
        returns (int256)
    {
        if (value < 0) return value;
        return M.sub(value, M.applyBps(value, haircutBps));
    }

    /// @notice Leverage cap implied by an initial-margin requirement, in bps.
    function impliedMaxLeverageBps(uint256 initialMarginBps) internal pure returns (uint256) {
        if (initialMarginBps == 0) revert Errors.InvalidConfig();
        return 100_000_000 / initialMarginBps;
    }

    function maxLeverageBps(uint256 initialMarginBps) internal pure returns (int256) {
        if (initialMarginBps == 0) revert Errors.InvalidConfig();
        return M.mulDiv(10_000, M.PRECISION, int256(initialMarginBps));
    }

    function notional(int256 size, int256 price) internal pure returns (int256) {
        if (size <= 0 || price <= 0) revert Errors.InvalidAmount();
        return M.mulPrecision(size, price);
    }

    function signedPositionPnl(RiskPosition memory p, int256 markPrice)
        internal
        pure
        returns (int256)
    {
        if (markPrice <= 0 || p.size <= 0 || p.entryPrice <= 0) revert Errors.InvalidPrice();
        int256 priceDelta =
            p.isLong ? M.sub(markPrice, p.entryPrice) : M.sub(p.entryPrice, markPrice);
        return M.mulPrecision(p.size, priceDelta);
    }

    function fundingPnl(RiskPosition memory p, int256 currentIndex)
        internal
        pure
        returns (int256)
    {
        int256 delta = M.sub(currentIndex, p.lastFundingIndex);
        return M.sub(0, M.mulPrecision(p.size, delta));
    }

    function findMarket(RiskMarket[] memory markets, uint32 marketId)
        internal
        pure
        returns (RiskMarket memory)
    {
        for (uint256 i = 0; i < markets.length; ++i) {
            if (markets[i].marketId == marketId) return markets[i];
        }
        revert Errors.InvalidConfig();
    }

    function accountHealth(
        RiskCollateral[] memory collateral,
        RiskPosition[] memory positions,
        RiskMarket[] memory markets
    ) internal pure returns (AccountHealth memory h) {
        int256 totalCollateral = 0;
        for (uint256 i = 0; i < collateral.length; ++i) {
            totalCollateral = M.add(
                totalCollateral,
                collateralValueAfterHaircut(collateral[i].value, collateral[i].haircutBps)
            );
        }
        int256[] memory upnls = new int256[](positions.length);
        int256 initial = 0;
        int256 maintenance = 0;
        int256 lockedIsolated = 0;
        int256 crossMaintenance = 0;
        bool anyIsolatedLiquidatable = false;

        for (uint256 i = 0; i < positions.length; ++i) {
            if (i >= MAX_POSITIONS) revert Errors.InvalidConfig();
            RiskPosition memory p = positions[i];
            RiskMarket memory m = findMarket(markets, p.marketId);
            if (!m.active) revert Errors.InvalidConfig();
            int256 currentFunding = p.isLong ? m.fundingIndexLong : m.fundingIndexShort;
            int256 tradePnl = signedPositionPnl(p, m.oraclePrice);
            int256 fPnl = fundingPnl(p, currentFunding);
            int256 upnl = M.add(tradePnl, fPnl);
            upnls[i] = upnl;

            int256 n = notional(p.size, m.oraclePrice);
            initial = M.add(initial, M.applyBps(n, m.initialMarginBps));
            maintenance = M.add(maintenance, M.applyBps(n, m.maintenanceMarginBps));

            if (p.isolated) {
                lockedIsolated = M.add(lockedIsolated, p.margin);
                int256 isoMaintenance = M.applyBps(n, m.maintenanceMarginBps);
                int256 isoEquity = M.add(p.margin, upnl);
                if (isoMaintenance > 0 && isoEquity < isoMaintenance) {
                    anyIsolatedLiquidatable = true;
                }
            }
        }

        // May be negative: that is the underwater signal, never clamp it.
        int256 crossCollateral = M.sub(totalCollateral, lockedIsolated);

        // KRY-Q5: isolated losses are counted in full, never floored at margin.
        int256 isolatedEquity = 0;
        int256 crossUnrealized = 0;
        for (uint256 i = 0; i < positions.length; ++i) {
            if (positions[i].isolated) {
                isolatedEquity = M.add(isolatedEquity, M.add(positions[i].margin, upnls[i]));
            } else {
                crossUnrealized = M.add(crossUnrealized, upnls[i]);
            }
        }
        int256 unrealized = 0;
        for (uint256 i = 0; i < upnls.length; ++i) {
            unrealized = M.add(unrealized, upnls[i]);
        }

        int256 equity = M.add(M.add(crossCollateral, crossUnrealized), isolatedEquity);
        int256 freeCollateral = M.sub(equity, initial);
        int256 marginRatio = maintenance > 0 ? M.divPrecision(equity, maintenance) : M.I128_MAX;

        for (uint256 i = 0; i < positions.length; ++i) {
            if (!positions[i].isolated) {
                RiskMarket memory m = findMarket(markets, positions[i].marketId);
                crossMaintenance = M.add(
                    crossMaintenance,
                    M.applyBps(notional(positions[i].size, m.oraclePrice), m.maintenanceMarginBps)
                );
            }
        }
        int256 crossEquity = M.add(crossCollateral, crossUnrealized);

        h.collateralValue = totalCollateral;
        h.unrealizedPnl = unrealized;
        h.equity = equity;
        h.initialMarginRequired = initial;
        h.maintenanceMarginRequired = maintenance;
        h.freeCollateral = freeCollateral;
        h.marginRatio = marginRatio;
        h.liquidatable =
            (crossMaintenance > 0 && crossEquity < crossMaintenance) || anyIsolatedLiquidatable;
    }

    function validateWithdrawal(
        RiskCollateral[] memory collateral,
        RiskPosition[] memory positions,
        RiskMarket[] memory markets,
        int256 withdrawalValue
    ) internal pure returns (AccountHealth memory h) {
        if (withdrawalValue < 0) revert Errors.InvalidAmount();
        h = accountHealth(collateral, positions, markets);
        h = applyWithdrawal(h, withdrawalValue);
        if (h.equity < h.initialMarginRequired) revert Errors.InsufficientCollateral();
    }

    /// @notice Re-derives the health fields after removing `withdrawalValue`.
    function applyWithdrawal(AccountHealth memory h, int256 withdrawalValue)
        internal
        pure
        returns (AccountHealth memory)
    {
        h.collateralValue = M.sub(h.collateralValue, withdrawalValue);
        h.equity = M.sub(h.equity, withdrawalValue);
        h.freeCollateral = M.sub(h.equity, h.initialMarginRequired);
        h.marginRatio = h.maintenanceMarginRequired > 0
            ? M.divPrecision(h.equity, h.maintenanceMarginRequired)
            : M.I128_MAX;
        h.liquidatable =
            h.maintenanceMarginRequired > 0 && h.equity < h.maintenanceMarginRequired;
        return h;
    }
}
