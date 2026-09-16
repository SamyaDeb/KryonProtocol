// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonErrors as Errors} from "./Errors.sol";

/// @notice 1e18 fixed-point math, a line-for-line port of `protocol_core::fixed`.
/// @dev Values are carried as int256 but bounded to the i128 range the Rust
///      reference uses, so the two implementations overflow on the same inputs.
///      i128 * i128 always fits in int256, so `mulDiv` needs no 512-bit path.
///      Division truncates toward zero in both languages.
library KryonMath {
    int256 internal constant PRECISION = 1e18;
    int256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant SECS_PER_HOUR = 3600;
    int256 internal constant I128_MAX = type(int128).max;
    int256 internal constant I128_MIN = type(int128).min;

    function bound128(int256 v) internal pure returns (int256) {
        if (v > I128_MAX || v < I128_MIN) revert Errors.MathOverflow();
        return v;
    }

    /// @notice uint256 -> int256, saturating at the i128 bound (for "max" args).
    function toBoundedInt(uint256 v) internal pure returns (int256) {
        return v > uint256(I128_MAX) ? I128_MAX : int256(v);
    }

    /// @notice uint256 -> int256, reverting above the i128 bound.
    function toInt(uint256 v) internal pure returns (int256) {
        if (v > uint256(I128_MAX)) revert Errors.MathOverflow();
        return int256(v);
    }

    function add(int256 a, int256 b) internal pure returns (int256) {
        return bound128(bound128(a) + bound128(b));
    }

    function sub(int256 a, int256 b) internal pure returns (int256) {
        return bound128(bound128(a) - bound128(b));
    }

    function mul(int256 a, int256 b) internal pure returns (int256) {
        return bound128(bound128(a) * bound128(b));
    }

    function div(int256 a, int256 b) internal pure returns (int256) {
        if (b == 0) revert Errors.DivisionByZero();
        return bound128(bound128(a) / bound128(b));
    }

    function mulDiv(int256 a, int256 b, int256 denominator) internal pure returns (int256) {
        if (denominator == 0) revert Errors.DivisionByZero();
        // The Rust side widens to I256 before multiplying; int256 is that width.
        return bound128((bound128(a) * bound128(b)) / bound128(denominator));
    }

    function mulPrecision(int256 a, int256 b) internal pure returns (int256) {
        return mulDiv(a, b, PRECISION);
    }

    function divPrecision(int256 a, int256 b) internal pure returns (int256) {
        return mulDiv(a, PRECISION, b);
    }

    function applyBps(int256 amount, uint256 bps) internal pure returns (int256) {
        if (bps > uint256(BPS_DENOMINATOR)) revert Errors.InvalidConfig();
        return mulDiv(amount, int256(bps), BPS_DENOMINATOR);
    }

    function ceilDiv(int256 a, int256 b) internal pure returns (int256) {
        if (b <= 0 || a < 0) revert Errors.InvalidAmount();
        if (a == 0) return 0;
        return add(div(sub(a, 1), b), 1);
    }

    /// @dev Magnitude of `a * b / PRECISION`, rounded up. Used where the
    ///      protocol is the counterparty to rounding (funding payments).
    function mulPrecisionUp(int256 a, int256 b) internal pure returns (int256) {
        int256 p = bound128(a) * bound128(b);
        if (p <= 0) revert Errors.InvalidAmount();
        return bound128((p - 1) / PRECISION + 1);
    }

    function abs(int256 a) internal pure returns (int256) {
        return a < 0 ? -a : a;
    }

    function min(int256 a, int256 b) internal pure returns (int256) {
        return a < b ? a : b;
    }

    function max(int256 a, int256 b) internal pure returns (int256) {
        return a > b ? a : b;
    }

    function clamp(int256 value, int256 lo, int256 hi) internal pure returns (int256) {
        if (value < lo) return lo;
        if (value > hi) return hi;
        return value;
    }
}
