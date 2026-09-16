use crate::CoreError;
use ethnum::I256;

pub const PRECISION: i128 = 1_000_000_000_000_000_000;
pub const BPS_DENOMINATOR: i128 = 10_000;
pub const SECS_PER_HOUR: u64 = 3_600;

#[inline]
pub fn checked_add(a: i128, b: i128) -> Result<i128, CoreError> {
    a.checked_add(b).ok_or(CoreError::MathOverflow)
}

#[inline]
pub fn checked_sub(a: i128, b: i128) -> Result<i128, CoreError> {
    a.checked_sub(b).ok_or(CoreError::MathOverflow)
}

#[inline]
pub fn checked_mul(a: i128, b: i128) -> Result<i128, CoreError> {
    a.checked_mul(b).ok_or(CoreError::MathOverflow)
}

#[inline]
pub fn checked_div(a: i128, b: i128) -> Result<i128, CoreError> {
    if b == 0 {
        return Err(CoreError::DivisionByZero);
    }
    a.checked_div(b).ok_or(CoreError::MathOverflow)
}

// inline(never): the I256 widening mul/div body is ~1.3KB of wasm; inlining it
// at every call site tripled its footprint. One shared copy per contract.
#[inline(never)]
pub fn mul_div(a: i128, b: i128, denominator: i128) -> Result<i128, CoreError> {
    if denominator == 0 {
        return Err(CoreError::DivisionByZero);
    }
    let value = I256::from(a)
        .checked_mul(I256::from(b))
        .and_then(|v| v.checked_div(I256::from(denominator)))
        .ok_or(CoreError::MathOverflow)?;
    i128::try_from(value).map_err(|_| CoreError::MathOverflow)
}

#[inline]
pub fn mul_precision(a: i128, b: i128) -> Result<i128, CoreError> {
    mul_div(a, b, PRECISION)
}

#[inline]
pub fn div_precision(a: i128, b: i128) -> Result<i128, CoreError> {
    mul_div(a, PRECISION, b)
}

#[inline]
pub fn apply_bps(amount: i128, bps: u32) -> Result<i128, CoreError> {
    if bps as i128 > BPS_DENOMINATOR {
        return Err(CoreError::InvalidConfig);
    }
    mul_div(amount, bps as i128, BPS_DENOMINATOR)
}

#[inline]
pub fn ceil_div(a: i128, b: i128) -> Result<i128, CoreError> {
    if b <= 0 || a < 0 {
        return Err(CoreError::InvalidAmount);
    }
    if a == 0 {
        return Ok(0);
    }
    checked_add(checked_div(checked_sub(a, 1)?, b)?, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_precision_scales_down() {
        assert_eq!(
            mul_precision(2 * PRECISION, 3 * PRECISION).unwrap(),
            6 * PRECISION
        );
    }

    #[test]
    fn signed_mul_precision_does_not_overflow_before_division() {
        assert_eq!(
            mul_precision(-90 * PRECISION, PRECISION).unwrap(),
            -90 * PRECISION
        );
    }

    #[test]
    fn apply_bps_rejects_above_100_percent() {
        assert_eq!(apply_bps(PRECISION, 10_001), Err(CoreError::InvalidConfig));
    }

    #[test]
    fn ceil_div_rounds_up() {
        assert_eq!(ceil_div(101, 10).unwrap(), 11);
    }
}
