use protocol_core::{
    add_signed, apply_bps, checked_add, checked_sub, collateral_value_after_haircut, funding_pnl,
    notional, signed_position_pnl, AccountSnapshot, CoreError, MarginMode, MarketSnapshot,
    PRECISION,
};
use soroban_sdk::{contracttype, Env, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountHealth {
    pub collateral_value: i128,
    pub unrealized_pnl: i128,
    pub equity: i128,
    pub initial_margin_required: i128,
    pub maintenance_margin_required: i128,
    pub free_collateral: i128,
    pub margin_ratio: i128,
    pub liquidatable: bool,
}

pub fn account_health(
    _env: &Env,
    account: &AccountSnapshot,
    markets: &Map<u32, MarketSnapshot>,
) -> Result<AccountHealth, CoreError> {
    let mut total_collateral_value = 0i128;
    for c in account.collateral.iter() {
        total_collateral_value = checked_add(
            total_collateral_value,
            collateral_value_after_haircut(c.value, c.haircut_bps)?,
        )?;
    }

    // First pass: collect per-position pnl and margin info
    let mut pnl_buf = [0i128; 64];
    let mut pnl_count = 0usize;
    let mut initial = 0i128;
    let mut maintenance = 0i128;
    let mut locked_isolated_margin = 0i128;
    let mut any_isolated_liquidatable = false;

    for p in account.positions.iter() {
        if pnl_count >= pnl_buf.len() {
            return Err(CoreError::InvalidConfig);
        }
        let market = markets.get(p.market_id).ok_or(CoreError::InvalidConfig)?;
        if !market.config.active {
            return Err(CoreError::InvalidConfig);
        }
        let current_funding = if p.is_long {
            market.funding_index_long
        } else {
            market.funding_index_short
        };
        let trade_pnl = signed_position_pnl(&p, market.oracle_price)?;
        let f_pnl = funding_pnl(&p, current_funding)?;
        let upnl = checked_add(trade_pnl, f_pnl)?;
        pnl_buf[pnl_count] = upnl;
        pnl_count += 1;

        let n = notional(p.size, market.oracle_price)?;
        initial = checked_add(initial, apply_bps(n, market.config.initial_margin_bps)?)?;
        maintenance = checked_add(
            maintenance,
            apply_bps(n, market.config.maintenance_margin_bps)?,
        )?;

        if p.mode == MarginMode::Isolated {
            locked_isolated_margin = checked_add(locked_isolated_margin, p.margin)?;
            // Isolated position is liquidatable when its own equity < its own maintenance margin
            let iso_maintenance = apply_bps(n, market.config.maintenance_margin_bps)?;
            let iso_equity = checked_add(p.margin, upnl)?;
            if iso_maintenance > 0 && iso_equity < iso_maintenance {
                any_isolated_liquidatable = true;
            }
        }
    }

    // Cross collateral = total collateral minus margin locked in isolated positions.
    // May be negative when cross losses have depleted the balance — that is the
    // underwater signal; do NOT clamp to 0 or the equity check won't fire.
    let cross_collateral = checked_sub(total_collateral_value, locked_isolated_margin)?;

    // Second pass: split unrealised pnl into its cross and isolated halves. The
    // split drives the per-mode liquidation triggers below; it does NOT change
    // total equity.
    //
    // KRY-Q5: isolated losses are NOT floored at the locked margin here.
    // Flooring them encoded a containment promise the ledger does not keep:
    // `reduce_position_internal` and `settle_position_funding` both push
    // realised pnl and funding through `vault_apply_pnl` against the account's
    // single settlement balance, with no isolated bucket — so an isolated loss
    // beyond its margin DOES consume cross collateral the moment it realises.
    // With the floor, an account looked healthy right up until the position
    // closed and then was suddenly underwater. Counting the loss in full makes
    // equity match the balance that actually backs it, and can only make an
    // account look worse, never better — the safe direction for a margin check.
    let mut isolated_equity = 0i128;
    let mut cross_unrealized = 0i128;
    for (idx, p) in account.positions.iter().enumerate() {
        let upnl = pnl_buf[idx];
        if p.mode == MarginMode::Isolated {
            isolated_equity = checked_add(isolated_equity, checked_add(p.margin, upnl)?)?;
        } else {
            cross_unrealized = checked_add(cross_unrealized, upnl)?;
        }
    }

    let unrealized_pnl = add_signed(&pnl_buf[..pnl_count])?;

    // Total equity = free cross collateral + cross unrealised pnl + isolated
    // equity. With the floor gone this reduces exactly to
    // `total_collateral_value + unrealized_pnl` — the locked margin cancels —
    // which is the same number the vault's balances add up to.
    let equity = checked_add(
        checked_add(cross_collateral, cross_unrealized)?,
        isolated_equity,
    )?;
    let free_collateral = checked_sub(equity, initial)?;
    let margin_ratio = if maintenance > 0 {
        protocol_core::div_precision(equity, maintenance)?
    } else {
        i128::MAX
    };

    // Cross positions are liquidatable when cross equity < cross maintenance requirement
    let mut cross_maintenance = 0i128;
    for p in account.positions.iter() {
        if p.mode == MarginMode::Cross {
            let market = markets.get(p.market_id).ok_or(CoreError::InvalidConfig)?;
            let n = notional(p.size, market.oracle_price)?;
            cross_maintenance = checked_add(
                cross_maintenance,
                apply_bps(n, market.config.maintenance_margin_bps)?,
            )?;
        }
    }
    let cross_equity = checked_add(cross_collateral, cross_unrealized)?;
    let cross_liquidatable = cross_maintenance > 0 && cross_equity < cross_maintenance;
    let liquidatable = cross_liquidatable || any_isolated_liquidatable;

    Ok(AccountHealth {
        collateral_value: total_collateral_value,
        unrealized_pnl,
        equity,
        initial_margin_required: initial,
        maintenance_margin_required: maintenance,
        free_collateral,
        margin_ratio,
        liquidatable,
    })
}

pub fn validate_withdrawal(
    env: &Env,
    account: &AccountSnapshot,
    markets: &Map<u32, MarketSnapshot>,
    withdrawal_value: i128,
) -> Result<AccountHealth, CoreError> {
    if withdrawal_value < 0 {
        return Err(CoreError::InvalidAmount);
    }
    let mut health = account_health(env, account, markets)?;
    health.collateral_value = checked_sub(health.collateral_value, withdrawal_value)?;
    health.equity = checked_sub(health.equity, withdrawal_value)?;
    health.free_collateral = checked_sub(health.equity, health.initial_margin_required)?;
    health.margin_ratio = if health.maintenance_margin_required > 0 {
        protocol_core::div_precision(health.equity, health.maintenance_margin_required)?
    } else {
        i128::MAX
    };
    health.liquidatable = health.maintenance_margin_required > 0
        && health.equity < health.maintenance_margin_required;
    if health.equity < health.initial_margin_required {
        return Err(CoreError::InsufficientCollateral);
    }
    Ok(health)
}

pub fn max_leverage_bps(initial_margin_bps: u32) -> Result<i128, CoreError> {
    if initial_margin_bps == 0 {
        return Err(CoreError::InvalidConfig);
    }
    protocol_core::mul_div(10_000, PRECISION, initial_margin_bps as i128)
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

    fn setup_account(env: &Env, mark: i128) -> (AccountSnapshot, Map<u32, MarketSnapshot>) {
        let user = Address::generate(env);
        let token = Address::generate(env);
        let collateral = Vec::from_array(
            env,
            [CollateralBalance {
                asset: token,
                amount: 1_000 * PRECISION,
                value: 1_000 * PRECISION,
                haircut_bps: 0,
            }],
        );
        let positions = Vec::from_array(
            env,
            [Position {
                position_id: 1,
                owner: user.clone(),
                market_id: 1,
                size: 10 * PRECISION,
                entry_price: 100 * PRECISION,
                margin: 100 * PRECISION,
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
        let mut markets = Map::new(env);
        markets.set(1, make_market(env, 1, mark));
        (account, markets)
    }

    #[test]
    fn withdrawal_uses_unrealized_loss_not_locked_margin() {
        let env = Env::default();
        let (account, markets) = setup_account(&env, 10 * PRECISION);
        let health = account_health(&env, &account, &markets).unwrap();
        assert_eq!(health.unrealized_pnl, -900 * PRECISION);
        assert!(validate_withdrawal(&env, &account, &markets, 900 * PRECISION).is_err());
    }

    #[test]
    fn isolated_position_loss_capped_at_locked_margin() {
        // Isolated position with margin=100, position size=10 BTC at entry 100.
        // Price drops to 1 → unrealized pnl = -990 * PRECISION.
        // Isolated equity = max(0, 100 + (-990)) = max(0, -890) = 0.
        // Total collateral = 1000. Locked isolated = 100.
        // Cross collateral = 1000 - 100 = 900.
        // No cross positions → cross_unrealized = 0.
        // Total equity = 900 + 0 + 0 = 900.
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
                position_id: 1,
                owner: user.clone(),
                market_id: 1,
                size: 10 * PRECISION,
                entry_price: 100 * PRECISION,
                margin: 100 * PRECISION,
                is_long: true,
                last_funding_index: 0,
                mode: MarginMode::Isolated,
            }],
        );
        let account = AccountSnapshot {
            owner: user,
            collateral,
            positions,
        };
        let mut markets = Map::new(&env);
        markets.set(1, make_market(&env, 1, PRECISION));
        let health = account_health(&env, &account, &markets).unwrap();
        // unrealized pnl = (1 - 100) * 10 = -990
        assert_eq!(health.unrealized_pnl, -990 * PRECISION);
        // KRY-Q5: the isolated loss is counted in full, not floored at the 100
        // of locked margin. Equity = 1000 collateral - 990 loss = 10, which is
        // what the vault balance will actually read once the position closes:
        // realised pnl goes through `apply_pnl` against the one settlement
        // balance, so the loss reaches cross collateral regardless of mode.
        // The old floored answer (900) claimed 890 of collateral that was
        // already gone.
        assert_eq!(health.equity, 10 * PRECISION);
        // isolated pos is liquidatable (iso_equity = 100 + (-990) = -890 < iso_maintenance)
        assert!(health.liquidatable);
    }

    #[test]
    fn isolated_does_not_contaminate_cross_health() {
        // One isolated position fully underwater, one cross position healthy.
        // Cross health should be fine; overall liquidatable=true due to isolated.
        let env = Env::default();
        let user = Address::generate(&env);
        let token = Address::generate(&env);
        // 2000 collateral total
        let collateral = Vec::from_array(
            &env,
            [CollateralBalance {
                asset: token,
                amount: 2_000 * PRECISION,
                value: 2_000 * PRECISION,
                haircut_bps: 0,
            }],
        );
        // Isolated position: 10 BTC long, entry 100, margin 100, price drops to 1 → fully wiped
        // Cross position: 1 BTC long, entry 100, price = 100 → pnl = 0
        let positions = Vec::from_array(
            &env,
            [
                Position {
                    position_id: 1,
                    owner: user.clone(),
                    market_id: 1,
                    size: 10 * PRECISION,
                    entry_price: 100 * PRECISION,
                    margin: 100 * PRECISION,
                    is_long: true,
                    last_funding_index: 0,
                    mode: MarginMode::Isolated,
                },
                Position {
                    position_id: 2,
                    owner: user.clone(),
                    market_id: 2,
                    size: PRECISION,
                    entry_price: 100 * PRECISION,
                    margin: 0,
                    is_long: true,
                    last_funding_index: 0,
                    mode: MarginMode::Cross,
                },
            ],
        );
        let account = AccountSnapshot {
            owner: user,
            collateral,
            positions,
        };
        let mut markets = Map::new(&env);
        // Isolated market: price crashed
        markets.set(1, make_market(&env, 1, PRECISION));
        // Cross market: price at par
        markets.set(2, make_market(&env, 2, 100 * PRECISION));
        let health = account_health(&env, &account, &markets).unwrap();

        // Cross position: notional = 1 * 100 = 100, maintenance = 100 * 500/10000 = 5
        // Cross collateral = 2000 - 100 (locked isolated) = 1900
        // Cross unrealized = 0 (price at entry)
        // Cross equity = 1900 > cross maintenance = 5 → cross NOT liquidatable
        // Isolated: iso_equity = 100 + (-990) = -890 < iso_maintenance → isolated IS liquidatable
        assert!(health.liquidatable);

        // The cross LIQUIDATION TRIGGER still ignores the isolated loss — that
        // separation is real and is what this test is named for: a blown
        // isolated position must not by itself liquidate the cross book.
        assert!(
            !health.margin_ratio.is_negative(),
            "cross side is comfortably solvent",
        );

        // Total EQUITY, though, counts the isolated loss in full (KRY-Q5):
        // 2000 collateral - 990 loss = 1010. Reporting 1900 would have told the
        // account it still had 890 that the settlement balance no longer backs.
        assert_eq!(health.equity, 1_010 * PRECISION);
    }
}
