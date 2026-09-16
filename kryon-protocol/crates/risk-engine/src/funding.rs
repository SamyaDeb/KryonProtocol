use protocol_core::{
    checked_add, checked_sub, div_precision, mul_div, mul_precision, CoreError, SECS_PER_HOUR,
};
use soroban_sdk::contracttype;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingConfig {
    pub imbalance_coeff: i128,
    pub max_rate_per_hour: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingState {
    pub long_index: i128,
    pub short_index: i128,
    pub rate_per_hour: i128,
    pub last_update: u64,
}

/// Hard cap on how much elapsed time a single funding update may charge for.
///
/// The rate is computed from the *instantaneous* premium but applied across the
/// whole gap since `last_update`. Without a cap, a market whose funding keeper
/// has been down for eight hours lets anyone who can move the mark for a single
/// ledger collect eight hours of funding at a rate they just set. Capping the
/// charged window means a missed update is under-charged, never retroactively
/// over-charged — the safe direction.
pub const MAX_FUNDING_ELAPSED_SECS: u64 = 3_600;

/// Advance the funding indexes from the mark-vs-index premium.
///
/// `premium` is PRECISION-scaled `(mark - index) / index`: positive when the
/// perp trades above spot, which is exactly when longs should pay shorts.
///
/// This replaces the previous open-interest-imbalance formulation, which was
/// structurally incapable of producing a non-zero rate: every fill moves one
/// account long-ward and one short-ward by the same size, so `oi_long -
/// oi_short` is invariant at zero for any matched book. See the regression test
/// `open_interest_imbalance_is_invariantly_zero_so_funding_never_accrues` in
/// the order gateway.
///
/// `cfg.imbalance_coeff` is reused as the premium sensitivity — the field shape
/// is unchanged so already-persisted `FundingConfig` entries still decode, but
/// its MEANING changed and every market's value must be re-tuned by governance
/// before this is relied on.
pub fn update_from_premium(
    cfg: &FundingConfig,
    state: &FundingState,
    premium: i128,
    now: u64,
) -> Result<FundingState, CoreError> {
    if cfg.imbalance_coeff < 0 || cfg.max_rate_per_hour <= 0 {
        return Err(CoreError::InvalidConfig);
    }
    if now <= state.last_update {
        return Ok(state.clone());
    }
    let raw_rate = mul_precision(premium, cfg.imbalance_coeff)?;
    let rate = clamp(raw_rate, -cfg.max_rate_per_hour, cfg.max_rate_per_hour);
    let elapsed = core::cmp::min(now - state.last_update, MAX_FUNDING_ELAPSED_SECS);
    let delta = mul_div(rate, elapsed as i128, SECS_PER_HOUR as i128)?;
    Ok(FundingState {
        long_index: checked_add(state.long_index, delta)?,
        short_index: checked_sub(state.short_index, delta)?,
        rate_per_hour: rate,
        last_update: now,
    })
}

/// PRECISION-scaled `(mark - index) / index`, the premium `update_from_premium`
/// consumes. Errors on a non-positive index rather than dividing by zero.
pub fn premium_from_mark(mark: i128, index: i128) -> Result<i128, CoreError> {
    if index <= 0 {
        return Err(CoreError::InvalidPrice);
    }
    div_precision(checked_sub(mark, index)?, index)
}

fn clamp(value: i128, min: i128, max: i128) -> i128 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::PRECISION;

    fn cfg() -> FundingConfig {
        FundingConfig {
            imbalance_coeff: PRECISION,
            max_rate_per_hour: PRECISION / 1_000,
        }
    }

    fn zero_state() -> FundingState {
        FundingState {
            long_index: 0,
            short_index: 0,
            rate_per_hour: 0,
            last_update: 0,
        }
    }

    #[test]
    fn premium_above_index_makes_longs_pay() {
        // Mark 1% above index.
        let premium = premium_from_mark(101 * PRECISION, 100 * PRECISION).unwrap();
        assert!(premium > 0);
        let next = update_from_premium(&cfg(), &zero_state(), premium, 3_600).unwrap();
        assert!(next.rate_per_hour > 0);
        assert!(next.long_index > 0, "longs pay when the perp trades rich");
        assert!(next.short_index < 0, "shorts receive the same amount");
    }

    #[test]
    fn premium_below_index_flips_the_sign() {
        let premium = premium_from_mark(99 * PRECISION, 100 * PRECISION).unwrap();
        assert!(premium < 0);
        let next = update_from_premium(&cfg(), &zero_state(), premium, 3_600).unwrap();
        assert!(
            next.long_index < 0,
            "longs receive when the perp trades cheap"
        );
        assert!(next.short_index > 0);
    }

    #[test]
    fn rate_is_clamped_to_the_configured_maximum() {
        // 50% premium would imply a 50%/h rate without the clamp.
        let premium = premium_from_mark(150 * PRECISION, 100 * PRECISION).unwrap();
        let next = update_from_premium(&cfg(), &zero_state(), premium, 3_600).unwrap();
        assert_eq!(next.rate_per_hour, cfg().max_rate_per_hour);
    }

    #[test]
    fn a_single_update_never_charges_more_than_the_elapsed_cap() {
        let premium = premium_from_mark(101 * PRECISION, 100 * PRECISION).unwrap();
        let one_hour = update_from_premium(&cfg(), &zero_state(), premium, 3_600).unwrap();
        // Keeper down for a full day, then one update.
        let one_day = update_from_premium(&cfg(), &zero_state(), premium, 86_400).unwrap();
        assert_eq!(
            one_day.long_index, one_hour.long_index,
            "a 24h gap must not let one update charge 24h of funding",
        );
        assert_eq!(
            one_day.last_update, 86_400,
            "the clock still advances fully"
        );
    }

    #[test]
    fn zero_premium_accrues_nothing() {
        let premium = premium_from_mark(100 * PRECISION, 100 * PRECISION).unwrap();
        assert_eq!(premium, 0);
        let next = update_from_premium(&cfg(), &zero_state(), premium, 3_600).unwrap();
        assert_eq!(next.rate_per_hour, 0);
        assert_eq!(next.long_index, 0);
    }

    #[test]
    fn premium_rejects_a_non_positive_index() {
        assert!(premium_from_mark(PRECISION, 0).is_err());
    }
}
