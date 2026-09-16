use crate::{apply_bps, checked_add, checked_sub, mul_precision, CoreError, Position};

pub fn collateral_value_after_haircut(value: i128, haircut_bps: u32) -> Result<i128, CoreError> {
    if value < 0 {
        return Ok(value);
    }
    let haircut = apply_bps(value, haircut_bps)?;
    checked_sub(value, haircut)
}

/// The maximum leverage, in bps, that an initial-margin requirement implies.
///
/// Initial margin and max leverage are two statements of one constraint:
/// posting `initial_margin_bps` of notional is exactly the same as capping
/// leverage at `1 / initial_margin_bps`. In bps on both sides that is
/// `10_000 * 10_000 / initial_margin_bps` — so a 1_000 bps (10%) requirement
/// implies 100_000 bps, or 10x.
pub fn implied_max_leverage_bps(initial_margin_bps: u32) -> Result<u32, CoreError> {
    if initial_margin_bps == 0 {
        return Err(CoreError::InvalidConfig);
    }
    Ok(100_000_000u32 / initial_margin_bps)
}

pub fn notional(size: i128, price: i128) -> Result<i128, CoreError> {
    if size <= 0 || price <= 0 {
        return Err(CoreError::InvalidAmount);
    }
    mul_precision(size, price)
}

pub fn signed_position_pnl(position: &Position, mark_price: i128) -> Result<i128, CoreError> {
    if mark_price <= 0 || position.size <= 0 || position.entry_price <= 0 {
        return Err(CoreError::InvalidPrice);
    }
    let price_delta = if position.is_long {
        checked_sub(mark_price, position.entry_price)?
    } else {
        checked_sub(position.entry_price, mark_price)?
    };
    mul_precision(position.size, price_delta)
}

pub fn funding_pnl(position: &Position, current_index: i128) -> Result<i128, CoreError> {
    let delta = checked_sub(current_index, position.last_funding_index)?;
    let raw = mul_precision(position.size, delta)?;
    checked_sub(0, raw)
}

pub fn add_signed(values: &[i128]) -> Result<i128, CoreError> {
    let mut out = 0i128;
    for value in values {
        out = checked_add(out, *value)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PRECISION;

    #[test]
    fn implied_leverage_is_the_inverse_of_initial_margin() {
        assert_eq!(implied_max_leverage_bps(1_000).unwrap(), 100_000); // 10%  -> 10x
        assert_eq!(implied_max_leverage_bps(500).unwrap(), 200_000); //  5%  -> 20x
        assert_eq!(implied_max_leverage_bps(10_000).unwrap(), 10_000); // 100% -> 1x
        assert!(implied_max_leverage_bps(0).is_err());
    }

    #[test]
    fn negative_collateral_is_debt_not_invalid_state() {
        assert_eq!(
            collateral_value_after_haircut(-100 * PRECISION, 500).unwrap(),
            -100 * PRECISION
        );
    }
}
