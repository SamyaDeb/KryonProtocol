use crate::margin::{account_health, AccountHealth};
use protocol_core::{
    apply_bps, checked_sub, notional, AccountSnapshot, CoreError, MarketSnapshot, Position,
};
use soroban_sdk::{contracttype, Env, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiquidationMode {
    None,
    Partial,
    Full,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationPlan {
    pub mode: LiquidationMode,
    pub position_id: u64,
    pub close_size: i128,
    pub penalty: i128,
    pub expected_health: AccountHealth,
}

pub fn plan_liquidation(
    env: &Env,
    account: &AccountSnapshot,
    markets: &Map<u32, MarketSnapshot>,
    target_position_id: u64,
    partial_liquidation_bps: u32,
) -> Result<LiquidationPlan, CoreError> {
    let health = account_health(env, account, markets)?;
    if !health.liquidatable {
        return Err(CoreError::NotLiquidatable);
    }
    if partial_liquidation_bps == 0 || partial_liquidation_bps > 10_000 {
        return Err(CoreError::InvalidConfig);
    }

    let position = find_position(account, target_position_id)?;
    let market = markets
        .get(position.market_id)
        .ok_or(CoreError::InvalidConfig)?;

    let shortfall = checked_sub(health.maintenance_margin_required, health.equity)?;
    let position_notional = notional(position.size, market.oracle_price)?;
    let max_partial_size =
        protocol_core::mul_div(position.size, partial_liquidation_bps as i128, 10_000)?;
    let min_size_to_cover = protocol_core::mul_div(position.size, shortfall, position_notional)?;
    let close_size = if min_size_to_cover >= position.size {
        // Position must be fully liquidated
        position.size
    } else if min_size_to_cover <= max_partial_size {
        // Liquidating the minimum needed is enough AND within the per-step cap
        min_size_to_cover
    } else {
        // Need more than one step; do the maximum allowed per step
        max_partial_size
    };
    let mode = if close_size >= position.size {
        LiquidationMode::Full
    } else {
        LiquidationMode::Partial
    };
    let penalty = apply_bps(
        notional(close_size, market.oracle_price)?,
        market.config.liquidation_fee_bps,
    )?;

    Ok(LiquidationPlan {
        mode,
        position_id: target_position_id,
        close_size,
        penalty,
        expected_health: health,
    })
}

fn find_position(account: &AccountSnapshot, position_id: u64) -> Result<Position, CoreError> {
    for p in account.positions.iter() {
        if p.position_id == position_id {
            return Ok(p);
        }
    }
    Err(CoreError::InvalidConfig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::{
        CollateralBalance, MarginMode, MarketConfig, MarketSnapshot, Position, PRECISION,
    };
    use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, Vec};

    fn make_market(env: &Env, market_id: u32, oracle_price: i128) -> MarketSnapshot {
        let market_token = Address::generate(env);
        MarketSnapshot {
            config: MarketConfig {
                market_id,
                base_asset: Symbol::new(env, "BTC"),
                settlement_asset: market_token,
                max_leverage_bps: 100_000,
                initial_margin_bps: 1_000,
                maintenance_margin_bps: 500,
                liquidation_fee_bps: 50,
                max_open_interest: 10_000 * PRECISION,
                max_oracle_age_secs: 10,
                max_oracle_confidence_bps: 50,
                active: true,
            },
            oracle_price,
            funding_index_long: 0,
            funding_index_short: 0,
        }
    }

    #[test]
    fn partial_liquidation_does_not_over_liquidate() {
        // Account: 1000 collateral, 10 BTC long at entry=100, price drops to 94.
        // Notional = 10 * 94 = 940
        // maintenance_margin_required = 940 * 500/10000 = 47
        // unrealized_pnl = (94 - 100) * 10 = -60
        // equity = 1000 - 60 = 940
        // shortfall = 47 - 940 = negative (not liquidatable at 94)
        //
        // Try price = 93.5: notional = 935, maint = 46.75, pnl = -65, equity = 935
        // equity (935) > maintenance (46.75) → still not liquidatable
        //
        // The account needs equity < maintenance to be liquidatable.
        // With maint_bps=500 (5%), at price=94:
        //   notional = 940, maintenance = 47, pnl = -60, equity = 940
        //   equity(940) > maintenance(47) → NOT liquidatable
        //
        // We need equity < maintenance. With maint_bps = 5000 (50%):
        //   At price=94: notional=940, maint=470, pnl=-60, equity=940
        //   equity(940) > maint(470) → NOT liquidatable
        //
        // Let's use: 1000 collateral, 10 BTC at entry=100, price=94, maint_bps=9000
        //   notional = 940, maintenance = 846, pnl = -60, equity = 940
        //   equity(940) > maint(846) → slightly above maintenance
        //
        // price=93: notional=930, maintenance=837, pnl=-70, equity=930 vs 837 → not liquidatable
        //
        // For liquidation with 50% partial cap: we want shortfall small relative to position size.
        // Use collateral=50, 1 BTC at entry=100, maint_bps=500:
        //   At price=94: notional=94, maint=4.7, pnl=-6, equity=44
        //   equity(44) > maint(4.7) → not liquidatable
        //
        // Need price where equity < maintenance. With initial_bps=1000, maint_bps=500:
        //   equity = collateral + pnl = 1000 + (price-100)*10
        //   maintenance = price * 10 * 500/10000 = price * 0.5
        //   liquidatable when: 1000 + (price-100)*10 < price * 0.5
        //   1000 + 10*price - 1000 < 0.5*price
        //   9.5*price < 0 → never for positive price
        //
        // With collateral=10 (small), 10 BTC at entry=100, maint_bps=500:
        //   equity = 10 + (price-100)*10
        //   maintenance = price * 10 * 0.05 = 0.5 * price
        //   10 + 10*price - 1000 < 0.5*price
        //   9.5*price < 990
        //   price < 104.2 → liquidatable below ~104 BTC
        //
        // At price=94: equity = 10 + (94-100)*10 = 10-60 = -50 → liquidatable
        // maintenance = 94*10*0.05 = 47
        // shortfall = 47 - (-50) = 97
        // position_notional = 940
        // min_size_to_cover = 10 * 97 / 940 ≈ 1.03 BTC
        // max_partial_size (50%) = 5 BTC
        // Before fix: close_size = max(1.03, 5) = 5 BTC (WRONG)
        // After fix: min(1.03, 5) → close_size = 1.03 BTC (correct)

        let env = Env::default();
        let user = Address::generate(&env);
        let token = Address::generate(&env);
        let collateral = Vec::from_array(
            &env,
            [CollateralBalance {
                asset: token,
                amount: 10 * PRECISION,
                value: 10 * PRECISION,
                haircut_bps: 0,
            }],
        );
        let positions = Vec::from_array(
            &env,
            [Position {
                position_id: 42,
                owner: user.clone(),
                market_id: 1,
                size: 10 * PRECISION,
                entry_price: 100 * PRECISION,
                margin: 0,
                is_long: true,
                last_funding_index: 0,
                mode: MarginMode::Cross,
            }],
        );
        let account = AccountSnapshot {
            owner: user,
            collateral,
            positions,
        };
        let mut markets = Map::new(&env);
        markets.set(1, make_market(&env, 1, 94 * PRECISION));

        // Verify account is actually liquidatable
        let health = account_health(&env, &account, &markets).unwrap();
        assert!(
            health.liquidatable,
            "account should be liquidatable at price=94"
        );

        let shortfall = checked_sub(health.maintenance_margin_required, health.equity).unwrap();
        assert!(shortfall > 0, "shortfall should be positive");

        // partial_liquidation_bps=5000 means max 50% per step
        let plan = plan_liquidation(&env, &account, &markets, 42, 5_000).unwrap();

        assert_eq!(plan.mode, LiquidationMode::Partial);
        // close_size should be min_size_to_cover, NOT max_partial_size (50% = 5 BTC)
        assert!(
            plan.close_size < 5 * PRECISION,
            "should not over-liquidate to 50%: close_size={} expected < {}",
            plan.close_size,
            5 * PRECISION
        );
        // close_size should be the minimum needed to cover shortfall
        // min_size_to_cover = size * shortfall / notional
        let position_notional = 94 * 10 * PRECISION; // 940 * PRECISION
        let expected_min =
            protocol_core::mul_div(10 * PRECISION, shortfall, position_notional).unwrap();
        assert_eq!(plan.close_size, expected_min);
    }
}
