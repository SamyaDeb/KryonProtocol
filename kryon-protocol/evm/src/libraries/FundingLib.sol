// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonErrors as Errors} from "./Errors.sol";
import {KryonMath as M} from "./KryonMath.sol";
import {FundingConfig, FundingState} from "./Types.sol";

/// @notice Premium-based funding. Port of `risk_engine::funding`.
library FundingLib {
    /// Hard cap on how much elapsed time one update may charge for. A missed
    /// update is under-charged, never retroactively over-charged.
    uint64 internal constant MAX_FUNDING_ELAPSED_SECS = 3600;

    /// @notice Advance the funding indexes from the mark-vs-index premium.
    /// @dev `now_ <= lastUpdate` returns the state unchanged. Arc block
    ///      timestamps are non-decreasing, not strictly increasing, so several
    ///      updates may land on the same second; that must not revert.
    function updateFromPremium(
        FundingConfig memory cfg,
        FundingState memory state,
        int256 premium,
        uint64 now_
    ) internal pure returns (FundingState memory) {
        if (cfg.premiumCoeff < 0 || cfg.maxRatePerHour <= 0) revert Errors.InvalidConfig();
        if (now_ <= state.lastUpdate) return state;
        int256 rawRate = M.mulPrecision(premium, cfg.premiumCoeff);
        int256 rate = M.clamp(rawRate, -cfg.maxRatePerHour, cfg.maxRatePerHour);
        uint64 elapsed = now_ - state.lastUpdate;
        if (elapsed > MAX_FUNDING_ELAPSED_SECS) elapsed = MAX_FUNDING_ELAPSED_SECS;
        int256 delta = M.mulDiv(rate, int256(uint256(elapsed)), int256(M.SECS_PER_HOUR));
        return FundingState({
            longIndex: M.add(state.longIndex, delta),
            shortIndex: M.sub(state.shortIndex, delta),
            ratePerHour: rate,
            lastUpdate: now_
        });
    }

    /// @notice PRECISION-scaled `(mark - index) / index`.
    function premiumFromMark(int256 mark, int256 index) internal pure returns (int256) {
        if (index <= 0) revert Errors.InvalidPrice();
        return M.divPrecision(M.sub(mark, index), index);
    }
}
