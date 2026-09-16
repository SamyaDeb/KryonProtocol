// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonErrors as Errors} from "./Errors.sol";

/// @notice The single boundary between USDC token units (ERC-20 interface,
///         6 decimals) and the protocol's 1e18 internal ledger.
/// @dev Every token movement goes through here. Converting token -> internal is
///      exact. Converting internal -> token rounds in the protocol's favour:
///      a credit paid out rounds down, a debit pulled in rounds up. Arc's
///      native 18-decimal USDC interface is never used for accounting.
library Decimals {
    uint256 internal constant SCALE = 1e12;
    /// Largest token amount whose internal value still fits the i128 ledger bound.
    uint256 internal constant MAX_TOKEN_AMOUNT = uint256(uint128(type(int128).max)) / SCALE;

    function toInternal(uint256 amount6) internal pure returns (int256) {
        if (amount6 > MAX_TOKEN_AMOUNT) revert Errors.MathOverflow();
        return int256(amount6 * SCALE);
    }

    /// @notice Tokens that may be paid out for an internal credit (rounds down).
    function toTokenDown(int256 internal18) internal pure returns (uint256) {
        if (internal18 < 0) revert Errors.InvalidAmount();
        return uint256(internal18) / SCALE;
    }

    /// @notice Tokens that must be pulled in to settle an internal debit (rounds up).
    function toTokenUp(int256 internal18) internal pure returns (uint256) {
        if (internal18 < 0) revert Errors.InvalidAmount();
        uint256 v = uint256(internal18);
        return v == 0 ? 0 : (v - 1) / SCALE + 1;
    }
}
