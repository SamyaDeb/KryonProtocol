use crate::margin::{account_health, AccountHealth};
use protocol_core::{
    apply_bps, checked_add, checked_sub, notional, AccountSnapshot, CoreError, MarketSnapshot,
    Position,
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
    // Closing q at the mark lowers the maintenance requirement by
    // q * price * mm and lowers equity by the penalty q * price * fee, so the
    // smallest close that restores maintenance is
    //   q = size * shortfall / (notional * (mm - fee))
    // (+1 so rounding never leaves a dust-sized shortfall). The earlier form,
    // size * shortfall / notional, freed notional equal to the shortfall
    // rather than margin, under-closing by 1 / (mm - fee): an on-chain
    // liquidator capped at the plan needed dozens of dust steps.
    let margin_rate_bps = market.config.maintenance_margin_bps as i128
        - market.config.liquidation_fee_bps as i128;
    let min_size_to_cover = if margin_rate_bps <= 0 {
        position.size
    } else {
        let freed_per_size = protocol_core::mul_div(position_notional, margin_rate_bps, 10_000)?;
        if freed_per_size <= 0 {
            position.size
        } else {
            checked_add(
                protocol_core::mul_div(position.size, shortfall, freed_per_size)?,
                1,
            )?
        }
    };
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
        // 1_000 collateral, 100 BTC long at 100, mark 93.7:
        //   upnl = -630, equity = 370, MM = 5% of 9_370 = 468.5, shortfall = 98.5
        // Closing q frees q * 93.7 * (5% - 0.5%) of margin net of the penalty,
        // so the minimum is 98.5 / 4.2165 = 23.36 BTC, under the 50% cap.
        let env = Env::default();
        let user = Address::generate(&env);
        let token = Address::generate(&env);
        let collateral = Vec::from_array(
            &env,
            [CollateralBalance {
                asset: token,
                amount: 1_000 * PRECISION,
                value: 1_000 * PRECISION,
                haircut_bps: 0,
            }],
        );
        let positions = Vec::from_array(
            &env,
            [Position {
                position_id: 42,
                owner: user.clone(),
                market_id: 1,
                size: 100 * PRECISION,
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
        let mark = 937 * PRECISION / 10;
        markets.set(1, make_market(&env, 1, mark));

        let health = account_health(&env, &account, &markets).unwrap();
        assert!(health.liquidatable);
        let shortfall = checked_sub(health.maintenance_margin_required, health.equity).unwrap();
        assert!(shortfall > 0);

        let plan = plan_liquidation(&env, &account, &markets, 42, 5_000).unwrap();
        assert_eq!(plan.mode, LiquidationMode::Partial);
        assert!(plan.close_size < 50 * PRECISION, "within the per-step cap");

        let notional_total = 100 * mark;
        let freed = protocol_core::mul_div(notional_total, 450, 10_000).unwrap();
        let expected =
            protocol_core::mul_div(100 * PRECISION, shortfall, freed).unwrap() + 1;
        assert_eq!(plan.close_size, expected);

        // Closing exactly the plan restores maintenance: the new equity covers
        // the new requirement once the penalty is paid.
        let closed_notional = notional(plan.close_size, mark).unwrap();
        let equity_after = health.equity - plan.penalty;
        let mm_after = health.maintenance_margin_required
            - protocol_core::apply_bps(closed_notional, 500).unwrap();
        assert!(equity_after >= mm_after - 1);
    }

    #[test]
    fn a_deep_breach_is_a_full_close() {
        let env = Env::default();
        let user = Address::generate(&env);
        let token = Address::generate(&env);
        let account = AccountSnapshot {
            owner: user.clone(),
            collateral: Vec::from_array(
                &env,
                [CollateralBalance {
                    asset: token,
                    amount: 10 * PRECISION,
                    value: 10 * PRECISION,
                    haircut_bps: 0,
                }],
            ),
            positions: Vec::from_array(
                &env,
                [Position {
                    position_id: 7,
                    owner: user,
                    market_id: 1,
                    size: 10 * PRECISION,
                    entry_price: 100 * PRECISION,
                    margin: 0,
                    is_long: true,
                    last_funding_index: 0,
                    mode: MarginMode::Cross,
                }],
            ),
        };
        let mut markets = Map::new(&env);
        markets.set(1, make_market(&env, 1, 94 * PRECISION));
        let plan = plan_liquidation(&env, &account, &markets, 7, 5_000).unwrap();
        assert_eq!(plan.mode, LiquidationMode::Full);
        assert_eq!(plan.close_size, 10 * PRECISION);
    }
}
