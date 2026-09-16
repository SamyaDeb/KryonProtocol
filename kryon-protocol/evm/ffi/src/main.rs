//! `kryon-ref <command> <args...>`: evaluates the Rust reference model and
//! prints `0x` + ABI-encoded `(uint256 err, int256[] values)` for the
//! Solidity differential tests. `err` is the `CoreError` discriminant, or 0.
//!
//! Every numeric argument is a decimal integer; booleans are 0 or 1. The
//! binary never panics on bad input: it reports `InvalidConfig` instead.

use protocol_core::{
    apply_bps, ceil_div, mul_div, AccountSnapshot, CollateralBalance, CoreError, MarginMode,
    MarketConfig, MarketSnapshot, Position,
};
use risk_engine::{
    account_health, plan_liquidation, premium_from_mark, update_from_premium, validate_withdrawal,
    AccountHealth, FundingConfig, FundingState, LiquidationMode,
};
use soroban_sdk::{testutils::Address as _, Address, Env, Map, Symbol, Vec};

struct Args<'a> {
    items: &'a [String],
    pos: usize,
}

impl<'a> Args<'a> {
    fn int(&mut self) -> Result<i128, CoreError> {
        let s = self.items.get(self.pos).ok_or(CoreError::InvalidConfig)?;
        self.pos += 1;
        s.parse::<i128>().map_err(|_| CoreError::InvalidConfig)
    }

    fn uint<T: TryFrom<i128>>(&mut self) -> Result<T, CoreError> {
        T::try_from(self.int()?).map_err(|_| CoreError::InvalidConfig)
    }

    fn flag(&mut self) -> Result<bool, CoreError> {
        Ok(self.int()? != 0)
    }
}

fn word(v: i128) -> [u8; 32] {
    let fill = if v < 0 { 0xff } else { 0x00 };
    let mut out = [fill; 32];
    out[16..].copy_from_slice(&v.to_be_bytes());
    out
}

fn emit(err: u32, values: &[i128]) {
    let mut buf: std::vec::Vec<u8> = std::vec::Vec::new();
    buf.extend_from_slice(&word(err as i128));
    buf.extend_from_slice(&word(0x40));
    buf.extend_from_slice(&word(values.len() as i128));
    for v in values {
        buf.extend_from_slice(&word(*v));
    }
    let hex: std::string::String = buf.iter().map(|b| format!("{b:02x}")).collect();
    println!("0x{hex}");
}

fn health_values(h: &AccountHealth) -> [i128; 8] {
    [
        h.collateral_value,
        h.unrealized_pnl,
        h.equity,
        h.initial_margin_required,
        h.maintenance_margin_required,
        h.free_collateral,
        h.margin_ratio,
        h.liquidatable as i128,
    ]
}

/// `col_value col_haircut npos [id market size entry is_long last_funding isolated margin]...
///  nmkt [market im mm fee active price funding_long funding_short]...`
fn read_account(
    env: &Env,
    a: &mut Args,
) -> Result<(AccountSnapshot, Map<u32, MarketSnapshot>), CoreError> {
    let owner = Address::generate(env);
    let asset = Address::generate(env);
    let value = a.int()?;
    let haircut_bps: u32 = a.uint()?;
    let collateral = Vec::from_array(
        env,
        [CollateralBalance {
            asset: asset.clone(),
            amount: value,
            value,
            haircut_bps,
        }],
    );
    let npos: u32 = a.uint()?;
    let mut positions = Vec::new(env);
    for _ in 0..npos {
        let position_id: u64 = a.uint()?;
        let market_id: u32 = a.uint()?;
        let size = a.int()?;
        let entry_price = a.int()?;
        let is_long = a.flag()?;
        let last_funding_index = a.int()?;
        let isolated = a.flag()?;
        let margin = a.int()?;
        positions.push_back(Position {
            position_id,
            owner: owner.clone(),
            market_id,
            size,
            entry_price,
            margin,
            is_long,
            last_funding_index,
            mode: if isolated {
                MarginMode::Isolated
            } else {
                MarginMode::Cross
            },
        });
    }
    let nmkt: u32 = a.uint()?;
    let mut markets = Map::new(env);
    for _ in 0..nmkt {
        let market_id: u32 = a.uint()?;
        let initial_margin_bps: u32 = a.uint()?;
        let maintenance_margin_bps: u32 = a.uint()?;
        let liquidation_fee_bps: u32 = a.uint()?;
        let active = a.flag()?;
        let oracle_price = a.int()?;
        let funding_index_long = a.int()?;
        let funding_index_short = a.int()?;
        markets.set(
            market_id,
            MarketSnapshot {
                config: MarketConfig {
                    market_id,
                    base_asset: Symbol::new(env, "X"),
                    settlement_asset: asset.clone(),
                    max_leverage_bps: 0,
                    initial_margin_bps,
                    maintenance_margin_bps,
                    liquidation_fee_bps,
                    max_open_interest: 1,
                    max_oracle_age_secs: 1,
                    max_oracle_confidence_bps: 0,
                    active,
                },
                oracle_price,
                funding_index_long,
                funding_index_short,
            },
        );
    }
    Ok((
        AccountSnapshot {
            owner,
            collateral,
            positions,
        },
        markets,
    ))
}

fn run(cmd: &str, a: &mut Args) -> Result<std::vec::Vec<i128>, CoreError> {
    let env = Env::default();
    match cmd {
        "muldiv" => Ok(vec![mul_div(a.int()?, a.int()?, a.int()?)?]),
        "applybps" => {
            let amount = a.int()?;
            Ok(vec![apply_bps(amount, a.uint()?)?])
        }
        "ceildiv" => Ok(vec![ceil_div(a.int()?, a.int()?)?]),
        "premium" => Ok(vec![premium_from_mark(a.int()?, a.int()?)?]),
        "funding" => {
            let cfg = FundingConfig {
                imbalance_coeff: a.int()?,
                max_rate_per_hour: a.int()?,
            };
            let state = FundingState {
                long_index: a.int()?,
                short_index: a.int()?,
                rate_per_hour: a.int()?,
                last_update: a.uint()?,
            };
            let premium = a.int()?;
            let now: u64 = a.uint()?;
            let next = update_from_premium(&cfg, &state, premium, now)?;
            Ok(vec![
                next.long_index,
                next.short_index,
                next.rate_per_hour,
                next.last_update as i128,
            ])
        }
        "health" => {
            let (account, markets) = read_account(&env, a)?;
            Ok(health_values(&account_health(&env, &account, &markets)?).to_vec())
        }
        "withdraw" => {
            let (account, markets) = read_account(&env, a)?;
            let w = a.int()?;
            Ok(health_values(&validate_withdrawal(&env, &account, &markets, w)?).to_vec())
        }
        "plan" => {
            let (account, markets) = read_account(&env, a)?;
            let target: u64 = a.uint()?;
            let bps: u32 = a.uint()?;
            let plan = plan_liquidation(&env, &account, &markets, target, bps)?;
            let mode = match plan.mode {
                LiquidationMode::None => 0,
                LiquidationMode::Partial => 1,
                LiquidationMode::Full => 2,
            };
            let mut out = vec![
                mode,
                plan.position_id as i128,
                plan.close_size,
                plan.penalty,
            ];
            out.extend_from_slice(&health_values(&plan.expected_health));
            Ok(out)
        }
        _ => Err(CoreError::InvalidConfig),
    }
}

fn main() {
    let argv: std::vec::Vec<String> = std::env::args().collect();
    let cmd = argv.get(1).cloned().unwrap_or_default();
    let mut args = Args {
        items: &argv[2.min(argv.len())..],
        pos: 0,
    };
    match run(&cmd, &mut args) {
        Ok(values) => emit(0, &values),
        Err(e) => emit(e as u32, &[]),
    }
}
