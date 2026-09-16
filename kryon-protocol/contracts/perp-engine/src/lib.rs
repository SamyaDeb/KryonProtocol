#![no_std]
#![deny(unsafe_code)]

use protocol_core::{
    apply_bps, checked_add, checked_sub, div_precision, funding_pnl, mul_div, mul_precision,
    notional, CoreError, MarginMode, MarketConfig, OracleGuard, OracleSnapshot, Position,
};
use risk_engine::{
    premium_from_mark, update_from_premium, AccountHealth, FundingConfig, FundingState,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

/// I2: per-user open-position cap. Must stay well below the risk engine's
/// 64-entry account_health buffer — hitting that buffer makes health
/// computation fail, which would block the user's own settlement and
/// liquidation (a self-DoS / liquidation-evasion vector).
pub const MAX_POSITIONS_PER_USER: u32 = 16;

/// Instance TTL keepalive bounds (ledgers, ~5s each).
const INSTANCE_TTL_THRESHOLD: u32 = 241_920; // ~14 days
                                             // ~30 days: extending instance TTL also extends the contract CODE entry, so
                                             // longer windows on large WASMs exceed the u32 transaction-fee cap (~429 XLM).
                                             // With a 14-day threshold this is a no-op most ticks and one paid bump every
                                             // ~2 weeks.
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Liquidation,
    Insurance,
    Oracle,
    Vault,
    SettlementAsset,
    FeeCollector,
    FeeRecipient,
    OrderGateway,
    NextPositionId,
    Market(u32),
    FeeConfig(u32),
    FundingConfig(u32),
    FundingState(u32),
    Positions(Address),
    OpenInterest(u32),
    /// Time-weighted mark accumulator per market — the mark the funding premium
    /// is measured against. Written only by gateway-routed trades.
    MarkState(u32),
    LongOpenInterest(u32),
    /// KRY-Q4: cap on a market's open-interest notional, expressed in bps of the
    /// insurance fund's effective balance. Absent = uncapped.
    OiPolicy(u32),
    ShortOpenInterest(u32),
    /// Running sum of every market's `OiPolicy` bps. Maintained incrementally
    /// in `set_oi_policy` so the aggregate ceiling below can be enforced
    /// without enumerating markets (there is no market registry to enumerate).
    TotalOiPolicyBps,
    /// KRY-Q11: ceiling on `TotalOiPolicyBps` — the sum of every market's cap,
    /// in bps of the (single, pooled) insurance fund. Without this, each
    /// market's cap is checked independently against the same undivided fund,
    /// so the fund's real aggregate commitment scales with the number of
    /// markets rather than being bounded by its own size. Absent = uncapped
    /// (matches `OiPolicy`'s own default, and preserves existing behaviour on
    /// a deployment that hasn't set it yet).
    MaxTotalOiPolicyBps,
    /// Set once a mainnet migration's position import is complete (KRY-Q10).
    /// `migrate_import_positions` refuses to run once this is set, so a
    /// redeployment's seed data cannot be replayed or extended after the
    /// deliberate governance action that closes the migration window.
    MigrationSealed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigratedPositions {
    pub user: Address,
    pub positions: Vec<Position>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineMarketConfig {
    pub market: MarketConfig,
    pub max_execution_deviation_bps: u32,
}

/// Running time-weighted-average-price accumulator for one market.
///
/// `cumulative` is the integral of price over time (price-seconds) since
/// `window_start`, brought up to date lazily: each write first credits the
/// price that has been standing since `last_ts`, then adopts the new one.
/// Reading the TWAP closes the window and starts a fresh one.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkState {
    /// Most recent executed fill price. 0 before the market has traded.
    pub last_price: i128,
    /// When `last_price` began standing.
    pub last_ts: u64,
    /// Price-seconds accumulated since `window_start`.
    pub cumulative: i128,
    /// Start of the current averaging window.
    pub window_start: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeConfig {
    pub maker_fee_bps: u32,
    pub taker_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeResult {
    pub position_id: u64,
    pub remaining_size: i128,
    pub entry_price: i128,
    pub realized_pnl: i128,
    pub funding_pnl: i128,
    pub execution_price: i128,
    pub account_equity: i128,
}

#[contract]
pub struct PerpEngineContract;

#[contractimpl]
impl PerpEngineContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        oracle: Address,
        vault: Address,
        settlement_asset: Address,
    ) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.storage()
            .instance()
            .set(&DataKey::SettlementAsset, &settlement_asset);
        env.storage().instance().set(&DataKey::FeeRecipient, &admin);
        env.storage()
            .instance()
            .set(&DataKey::NextPositionId, &1u64);
        Ok(())
    }

    pub fn set_market(env: Env, config: EngineMarketConfig) -> Result<(), CoreError> {
        require_admin(&env)?;
        validate_engine_market(&config)?;
        env.storage()
            .persistent()
            .set(&DataKey::Market(config.market.market_id), &config);
        vault_set_market_config(&env, &config.market)?;
        Ok(())
    }

    /// Replace this contract's WASM in place. Storage, the contract address and
    /// every wired peer address survive, so an upgrade needs no migration.
    ///
    /// Admin-gated, and that is the whole security model: in production the
    /// admin MUST be the governance timelock, which makes an upgrade inherit
    /// its delay and cancellation window. While a plain keypair holds admin,
    /// this function turns a key compromise into total protocol takeover.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn nominate_admin(env: Env, next_admin: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &next_admin);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), CoreError> {
        let next_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(CoreError::InvalidConfig)?;
        next_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &next_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    /// Who currently admins this contract.
    ///
    /// The protocol's whole security model is "the admin is the governance
    /// timelock" — and until this existed there was no way to CHECK that from
    /// outside for most contracts. An auditor, a user, or the handover script
    /// had to take it on faith. A claim nobody can verify is not a control.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// The nominated-but-not-yet-accepted admin, if a transfer is in flight.
    /// Makes a half-finished handover visible instead of silent.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// Permissionless instance-TTL keepalive — prevents the engine instance
    /// (markets, funding state keys, config) from being archived.
    pub fn extend_instance_ttl(env: Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    pub fn set_fee_config(env: Env, market_id: u32, config: FeeConfig) -> Result<(), CoreError> {
        require_admin(&env)?;
        if market_id == 0 || config.maker_fee_bps > 10_000 || config.taker_fee_bps > 10_000 {
            return Err(CoreError::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&DataKey::FeeConfig(market_id), &config);
        Ok(())
    }

    pub fn set_funding_config(
        env: Env,
        market_id: u32,
        config: FundingConfig,
    ) -> Result<(), CoreError> {
        require_admin(&env)?;
        if market_id == 0 || config.imbalance_coeff < 0 || config.max_rate_per_hour <= 0 {
            return Err(CoreError::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&DataKey::FundingConfig(market_id), &config);
        let state = funding_state(&env, market_id);
        env.storage().persistent().set(
            &DataKey::FundingState(market_id),
            &FundingState {
                last_update: env.ledger().timestamp(),
                ..state
            },
        );
        Ok(())
    }

    /// Cap a market's open-interest notional at a multiple of the insurance
    /// fund, in bps. `100_000` means "OI notional may not exceed 10x the fund".
    /// Passing 0 removes the cap.
    ///
    /// KRY-Q4. Liquidation closes a distressed position with no counterparty on
    /// the other side, so the insurance fund is the protocol's implicit
    /// counterparty of last resort — carrying directional risk it never chose,
    /// with no position limit. A full auto-deleveraging queue is the eventual
    /// answer; this is the bound that makes the exposure finite in the
    /// meantime. It cannot lose funds: it only ever refuses new risk.
    pub fn set_oi_policy(
        env: Env,
        market_id: u32,
        max_oi_per_insurance_bps: u32,
    ) -> Result<(), CoreError> {
        require_admin(&env)?;
        if market_id == 0 {
            return Err(CoreError::InvalidConfig);
        }
        let old_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::OiPolicy(market_id))
            .unwrap_or(0);

        // KRY-Q11: the fund is pooled across markets and each market's cap is
        // checked independently against it (see `require_insurance_headroom`),
        // so the sum of every market's bps — not any single market's — is what
        // bounds the fund's real aggregate commitment. Reject a change that
        // would push that sum past the configured ceiling, if one is set.
        let total_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalOiPolicyBps)
            .unwrap_or(0);
        let new_total_bps = total_bps
            .checked_sub(old_bps)
            .and_then(|t| t.checked_add(max_oi_per_insurance_bps))
            .ok_or(CoreError::MathOverflow)?;
        if let Some(max_total) = env
            .storage()
            .persistent()
            .get::<DataKey, u32>(&DataKey::MaxTotalOiPolicyBps)
        {
            if new_total_bps > max_total {
                return Err(CoreError::AggregateOiPolicyExceeded);
            }
        }

        if max_oi_per_insurance_bps == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::OiPolicy(market_id));
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::OiPolicy(market_id), &max_oi_per_insurance_bps);
        }
        if new_total_bps == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::TotalOiPolicyBps);
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::TotalOiPolicyBps, &new_total_bps);
        }
        Ok(())
    }

    pub fn oi_policy(env: Env, market_id: u32) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::OiPolicy(market_id))
    }

    /// Sum of every market's `OiPolicy` bps — the fund's real aggregate
    /// commitment, since the fund is pooled rather than partitioned per market.
    pub fn total_oi_policy_bps(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalOiPolicyBps)
            .unwrap_or(0)
    }

    /// Ceiling on `total_oi_policy_bps`. Absent = uncapped (the aggregate
    /// check is opt-in, matching `OiPolicy` itself defaulting to uncapped).
    /// `0` clears the ceiling.
    pub fn set_max_total_oi_policy_bps(env: Env, max_total_bps: u32) -> Result<(), CoreError> {
        require_admin(&env)?;
        if max_total_bps == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::MaxTotalOiPolicyBps);
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::MaxTotalOiPolicyBps, &max_total_bps);
        }
        Ok(())
    }

    pub fn max_total_oi_policy_bps(env: Env) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::MaxTotalOiPolicyBps)
    }

    /// How well the insurance fund currently covers this market's open
    /// interest, in bps: `effective_insurance * 10_000 / oi_notional`.
    ///
    /// Deliberately readable rather than only enforced, so the UI and keepers
    /// can warn as coverage thins instead of discovering it when an open is
    /// suddenly rejected. Returns `i128::MAX` for a market with no open
    /// interest — infinitely covered, not divide-by-zero.
    pub fn insurance_coverage_bps(env: Env, market_id: u32) -> Result<i128, CoreError> {
        let market = load_market(&env, market_id)?;
        let oi = open_interest(&env, market_id);
        if oi <= 0 {
            return Ok(i128::MAX);
        }
        let guard = OracleGuard {
            max_age_secs: market.market.max_oracle_age_secs,
            max_confidence_bps: market.market.max_oracle_confidence_bps,
        };
        let price = oracle_get_price(&env, &market.market.base_asset, Some(guard))?.price;
        let oi_notional = notional(oi, price)?;
        mul_div(effective_insurance(&env)?, 10_000, oi_notional)
    }

    pub fn set_fee_collector(env: Env, collector: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::FeeCollector, &collector);
        Ok(())
    }

    pub fn set_order_gateway(env: Env, gateway: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::OrderGateway, &gateway);
        Ok(())
    }

    pub fn set_fee_recipient(env: Env, recipient: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &recipient);
        Ok(())
    }

    /// Re-point the engine at a different vault.
    ///
    /// Without this the vault address was fixed at `initialize`, so replacing
    /// the vault forced replacing the engine too — and with it every position,
    /// order-gateway wiring and address baked into clients. Liquidation and
    /// insurance already had `set_vault`; the engine not having one is what made
    /// a vault swap cascade.
    ///
    /// Changing this mid-flight points the engine at a vault holding none of the
    /// existing balances, so it is a migration step, not a runtime knob.
    pub fn set_vault(env: Env, vault: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Vault, &vault);
        Ok(())
    }

    pub fn set_liquidation(env: Env, liquidation: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Liquidation, &liquidation);
        Ok(())
    }

    pub fn set_insurance(env: Env, insurance: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Insurance, &insurance);
        Ok(())
    }

    /// Seed a freshly deployed engine's positions and open interest from an
    /// export of a frozen, unupgradeable deployment (KRY-Q10). Every mainnet
    /// contract predates `upgrade()` and can never be given it, so a real
    /// migration means new contracts plus a one-time import of old state —
    /// this is that import, for positions.
    ///
    /// Callable repeatedly, in batches, until `seal_migration` closes the
    /// window: an export of every account can rarely fit in one transaction,
    /// and re-running with a corrected batch should not require a redeploy.
    /// Advances `NextPositionId` past every imported id so a position opened
    /// after migration can never collide with an imported one.
    ///
    /// Also mirrors each imported user's positions into the vault via
    /// `sync_positions` — the vault keeps its own copy for `account_health`,
    /// normally kept current by every trade calling back into it, which a
    /// direct storage seed here would otherwise leave stale. Collateral
    /// balances themselves are seeded separately, by
    /// `perp-vault::migrate_import_balances` — a balance and a position are
    /// exported from different contracts and don't need to travel together.
    pub fn migrate_import_positions(
        env: Env,
        entries: Vec<MigratedPositions>,
    ) -> Result<u32, CoreError> {
        require_admin(&env)?;
        if env.storage().instance().has(&DataKey::MigrationSealed) {
            return Err(CoreError::AlreadyInitialized);
        }
        let mut next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextPositionId)
            .unwrap_or(1);
        let mut imported = 0u32;
        for entry in entries.iter() {
            store_positions(&env, &entry.user, &entry.positions);
            vault_sync_positions(&env, &entry.user, &entry.positions)?;
            for position in entry.positions.iter() {
                let oi = checked_add(open_interest(&env, position.market_id), position.size)?;
                store_open_interest(&env, position.market_id, oi);
                let side_oi = checked_add(
                    side_open_interest(&env, position.market_id, position.is_long),
                    position.size,
                )?;
                store_side_open_interest(&env, position.market_id, position.is_long, side_oi);
                if position.position_id >= next_id {
                    next_id = position.position_id + 1;
                }
            }
            imported += 1;
        }
        env.storage()
            .instance()
            .set(&DataKey::NextPositionId, &next_id);
        Ok(imported)
    }

    /// Close the migration import window for good. Admin-gated like every
    /// other configuration entrypoint — in production that means the
    /// governance timelock, so sealing (like everything else admin-gated)
    /// inherits its delay and cancellation window rather than being an
    /// instant, unreviewable action.
    pub fn seal_migration(env: Env) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::MigrationSealed, &true);
        Ok(())
    }

    pub fn migration_sealed(env: Env) -> bool {
        env.storage().instance().has(&DataKey::MigrationSealed)
    }

    /// Advance funding for a market from the mark-vs-index premium.
    ///
    /// Permissionless: anyone may poke it, and doing so is how the market stays
    /// tethered to spot. The rate is clamped by config and the charged window is
    /// capped by `risk_engine::MAX_FUNDING_ELAPSED_SECS`, so a frequent caller
    /// gains nothing and an infrequent one under-charges rather than over-charges.
    ///
    /// Fails closed on a stale or wide oracle: accruing funding against a price
    /// the market itself would refuse to trade on is worse than not accruing.
    pub fn update_funding(env: Env, market_id: u32) -> Result<FundingState, CoreError> {
        let cfg: FundingConfig = env
            .storage()
            .persistent()
            .get(&DataKey::FundingConfig(market_id))
            .ok_or(CoreError::InvalidConfig)?;
        let market = load_market(&env, market_id)?;
        let current = funding_state(&env, market_id);

        // Premium is zero until the market has actually traded — a market with
        // no mark has nothing to say about where it is relative to spot.
        // Consuming the TWAP also closes the averaging window, so each funding
        // period is priced on the time since the previous one.
        let mark = consume_mark_twap(&env, market_id)?;
        let premium = if mark > 0 {
            let guard = OracleGuard {
                max_age_secs: market.market.max_oracle_age_secs,
                max_confidence_bps: market.market.max_oracle_confidence_bps,
            };
            let index = oracle_get_price(&env, &market.market.base_asset, Some(guard))?.price;
            premium_from_mark(mark, index)?
        } else {
            0
        };

        let next = update_from_premium(&cfg, &current, premium, env.ledger().timestamp())?;
        env.storage()
            .persistent()
            .set(&DataKey::FundingState(market_id), &next);
        vault_set_funding_indexes(&env, market_id, next.long_index, next.short_index)?;

        // Longs pay `delta * oi_long` and shorts receive `delta * oi_short`. In a
        // matched book those are equal and this nets to zero; they diverge only
        // after a liquidation closes one side without a counterparty. Route the
        // difference to insurance so no value leaks out of the protocol.
        let delta = checked_sub(next.long_index, current.long_index)?;
        if delta != 0 {
            let oi_imbalance = checked_sub(
                side_open_interest(&env, market_id, true),
                side_open_interest(&env, market_id, false),
            )?;
            if oi_imbalance != 0 {
                let net_surplus = mul_div(delta, oi_imbalance, protocol_core::PRECISION)?;
                if net_surplus != 0 {
                    if let Some(insurance) = insurance_address(&env) {
                        let asset = settlement_asset(&env)?;
                        vault_apply_pnl(&env, &insurance, &asset, net_surplus)?;
                    }
                }
            }
        }

        Ok(next)
    }

    /// The market's standing mark — the last executed fill price, or 0 before
    /// the market has traded. Read-only: it does not disturb the TWAP window
    /// that `update_funding` averages over.
    pub fn mark_price(env: Env, market_id: u32) -> i128 {
        last_mark(&env, market_id)
    }

    /// The full time-weighted mark accumulator, for keepers and dashboards that
    /// want to see how much time the current funding window has accrued.
    pub fn mark_state(env: Env, market_id: u32) -> MarkState {
        mark_state(&env, market_id)
    }

    pub fn charge_trade_fee(
        env: Env,
        user: Address,
        market_id: u32,
        size: i128,
        execution_price: i128,
        is_maker: bool,
    ) -> Result<i128, CoreError> {
        if size <= 0 || execution_price <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let config = fee_config(&env, market_id);
        let fee_bps = if is_maker {
            config.maker_fee_bps
        } else {
            config.taker_fee_bps
        };
        if fee_bps == 0 {
            return Ok(0);
        }
        require_fee_collector(&env)?;
        let fee = apply_bps(notional(size, execution_price)?, fee_bps)?;
        let asset = settlement_asset(&env)?;
        let recipient = fee_recipient(&env)?;
        vault_apply_pnl(&env, &user, &asset, checked_sub(0, fee)?)?;
        require_account_above_initial_margin(&env, &user)?;
        vault_apply_pnl(&env, &recipient, &asset, fee)?;
        Ok(fee)
    }

    pub fn open_position(
        env: Env,
        user: Address,
        market_id: u32,
        size: i128,
        is_long: bool,
        execution_price: i128,
        mode: MarginMode,
    ) -> Result<TradeResult, CoreError> {
        require_order_gateway(&env)?;
        if size <= 0 || execution_price <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        // KRY-Q5-F: the vault has no separate balance bucket for isolated
        // margin — a realised isolated loss draws down the same collateral
        // as a cross position, so "isolated" currently promises a capped
        // downside it cannot deliver. No live caller requests this mode (the
        // order gateway always passes Cross), but reject it here too so a
        // future integration can't silently rely on a guarantee that isn't
        // implemented.
        if mode == MarginMode::Isolated {
            return Err(CoreError::IsolatedMarginDisabled);
        }
        let market = load_market(&env, market_id)?;
        validate_execution_price(&env, &market, execution_price)?;
        record_mark(&env, market_id, execution_price)?;
        let current_oi = open_interest(&env, market_id);
        let next_oi = checked_add(current_oi, size)?;
        if next_oi > market.market.max_open_interest {
            return Err(CoreError::OpenInterestExceeded);
        }
        require_insurance_headroom(&env, market_id, next_oi, execution_price)?;

        let mut positions = load_positions(&env, &user);
        // I2: hard cap well below the risk-engine's 64-entry account_health
        // buffer, so a user can never brick their own health check (which
        // gates settlement and liquidation) by accumulating positions.
        if positions.len() >= MAX_POSITIONS_PER_USER {
            return Err(CoreError::TooManyPositions);
        }
        let funding = funding_state(&env, market_id);
        // For isolated positions, lock initial margin proportional to the position notional
        let position_notional = mul_precision(size, execution_price)?;
        let position_margin = if mode == MarginMode::Isolated {
            apply_bps(position_notional, market.market.initial_margin_bps)?
        } else {
            0
        };
        let position = Position {
            position_id: next_position_id(&env)?,
            owner: user.clone(),
            market_id,
            size,
            entry_price: execution_price,
            margin: position_margin,
            is_long,
            last_funding_index: if is_long {
                funding.long_index
            } else {
                funding.short_index
            },
            mode,
        };
        positions.push_back(position.clone());
        store_positions(&env, &user, &positions);
        store_open_interest(&env, market_id, next_oi);
        store_side_open_interest(
            &env,
            market_id,
            is_long,
            checked_add(side_open_interest(&env, market_id, is_long), size)?,
        );
        sync_and_require_initial_margin(&env, &user, &positions)?;
        let equity = vault_health(&env, &user)?.equity;
        Ok(TradeResult {
            position_id: position.position_id,
            remaining_size: position.size,
            entry_price: position.entry_price,
            realized_pnl: 0,
            funding_pnl: 0,
            execution_price,
            account_equity: equity,
        })
    }

    pub fn increase_position(
        env: Env,
        user: Address,
        position_id: u64,
        size_delta: i128,
        execution_price: i128,
    ) -> Result<TradeResult, CoreError> {
        require_order_gateway(&env)?;
        if size_delta <= 0 || execution_price <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let mut positions = load_positions(&env, &user);
        let index = find_position_index(&positions, position_id)?;
        let mut position = positions.get(index).ok_or(CoreError::PositionNotFound)?;
        let market = load_market(&env, position.market_id)?;
        validate_execution_price(&env, &market, execution_price)?;
        record_mark(&env, position.market_id, execution_price)?;
        let settled_funding = settle_position_funding(&env, &user, &mut position)?;

        let next_oi = checked_add(open_interest(&env, position.market_id), size_delta)?;
        if next_oi > market.market.max_open_interest {
            return Err(CoreError::OpenInterestExceeded);
        }
        require_insurance_headroom(&env, position.market_id, next_oi, execution_price)?;
        let old_notional = mul_precision(position.size, position.entry_price)?;
        let added_notional = mul_precision(size_delta, execution_price)?;
        let new_size = checked_add(position.size, size_delta)?;
        position.entry_price = div_precision(checked_add(old_notional, added_notional)?, new_size)?;
        position.size = new_size;
        positions.set(index, position.clone());
        store_positions(&env, &user, &positions);
        store_open_interest(&env, position.market_id, next_oi);
        store_side_open_interest(
            &env,
            position.market_id,
            position.is_long,
            checked_add(
                side_open_interest(&env, position.market_id, position.is_long),
                size_delta,
            )?,
        );
        sync_and_require_initial_margin(&env, &user, &positions)?;
        let equity = vault_health(&env, &user)?.equity;
        Ok(TradeResult {
            position_id: position.position_id,
            remaining_size: position.size,
            entry_price: position.entry_price,
            realized_pnl: 0,
            funding_pnl: settled_funding,
            execution_price,
            account_equity: equity,
        })
    }

    pub fn reduce_position(
        env: Env,
        user: Address,
        position_id: u64,
        size_delta: i128,
        execution_price: i128,
    ) -> Result<TradeResult, CoreError> {
        require_order_gateway(&env)?;
        reduce_position_internal(env, user, position_id, size_delta, execution_price, true)
    }

    pub fn liquidate_reduce(
        env: Env,
        user: Address,
        position_id: u64,
        size_delta: i128,
        execution_price: i128,
    ) -> Result<TradeResult, CoreError> {
        require_liquidation(&env)?;
        reduce_position_internal(env, user, position_id, size_delta, execution_price, false)
    }

    pub fn close_position(
        env: Env,
        user: Address,
        position_id: u64,
        execution_price: i128,
    ) -> Result<TradeResult, CoreError> {
        let positions = load_positions(&env, &user);
        let index = find_position_index(&positions, position_id)?;
        let position = positions.get(index).ok_or(CoreError::PositionNotFound)?;
        Self::reduce_position(env, user, position_id, position.size, execution_price)
    }

    pub fn positions(env: Env, user: Address) -> Vec<Position> {
        load_positions(&env, &user)
    }

    pub fn open_interest(env: Env, market_id: u32) -> i128 {
        open_interest(&env, market_id)
    }

    pub fn long_open_interest(env: Env, market_id: u32) -> i128 {
        side_open_interest(&env, market_id, true)
    }

    pub fn short_open_interest(env: Env, market_id: u32) -> i128 {
        side_open_interest(&env, market_id, false)
    }

    pub fn funding_state(env: Env, market_id: u32) -> FundingState {
        funding_state(&env, market_id)
    }
}

fn require_admin(env: &Env) -> Result<Address, CoreError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(CoreError::InvalidConfig)?;
    admin.require_auth();
    Ok(admin)
}

fn require_liquidation(env: &Env) -> Result<Address, CoreError> {
    let liquidation: Address = env
        .storage()
        .instance()
        .get(&DataKey::Liquidation)
        .ok_or(CoreError::InvalidConfig)?;
    liquidation.require_auth();
    Ok(liquidation)
}

fn require_fee_collector(env: &Env) -> Result<Address, CoreError> {
    let collector: Address = env
        .storage()
        .instance()
        .get(&DataKey::FeeCollector)
        .ok_or(CoreError::InvalidConfig)?;
    collector.require_auth();
    Ok(collector)
}

fn require_order_gateway(env: &Env) -> Result<Address, CoreError> {
    let gateway: Address = env
        .storage()
        .instance()
        .get(&DataKey::OrderGateway)
        .ok_or(CoreError::InvalidConfig)?;
    gateway.require_auth();
    Ok(gateway)
}

fn fee_recipient(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::FeeRecipient)
        .ok_or(CoreError::InvalidConfig)
}

fn validate_engine_market(config: &EngineMarketConfig) -> Result<(), CoreError> {
    if config.market.market_id == 0
        || !config.market.active
        || config.market.initial_margin_bps == 0
        || config.market.maintenance_margin_bps == 0
        || config.market.maintenance_margin_bps > config.market.initial_margin_bps
        || config.market.max_open_interest <= 0
        || config.market.max_oracle_age_secs == 0
        || config.market.max_oracle_confidence_bps > 10_000
        || config.max_execution_deviation_bps > 10_000
    {
        return Err(CoreError::InvalidConfig);
    }
    // KRY-Q8: keep the declared leverage cap consistent with the margin
    // requirement that actually enforces it. See the same check in the vault.
    if config.market.max_leverage_bps
        > protocol_core::implied_max_leverage_bps(config.market.initial_margin_bps)?
    {
        return Err(CoreError::InvalidConfig);
    }
    Ok(())
}

fn load_market(env: &Env, market_id: u32) -> Result<EngineMarketConfig, CoreError> {
    env.storage()
        .persistent()
        .get(&DataKey::Market(market_id))
        .ok_or(CoreError::InvalidConfig)
}

fn oracle_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Oracle)
        .ok_or(CoreError::InvalidConfig)
}

fn vault_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Vault)
        .ok_or(CoreError::InvalidConfig)
}

fn oracle_get_price(
    env: &Env,
    asset: &Symbol,
    guard: Option<OracleGuard>,
) -> Result<OracleSnapshot, CoreError> {
    env.invoke_contract::<Result<OracleSnapshot, CoreError>>(
        &oracle_address(env)?,
        &Symbol::new(env, "get_price"),
        vec![env, asset.into_val(env), guard.into_val(env)],
    )
}

fn vault_set_market_config(env: &Env, market: &MarketConfig) -> Result<(), CoreError> {
    env.invoke_contract::<Result<(), CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "set_market_config"),
        vec![env, market.into_val(env)],
    )
}

fn vault_set_funding_indexes(
    env: &Env,
    market_id: u32,
    long_index: i128,
    short_index: i128,
) -> Result<(), CoreError> {
    env.invoke_contract::<Result<(), CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "set_funding_indexes"),
        vec![
            env,
            market_id.into_val(env),
            long_index.into_val(env),
            short_index.into_val(env),
        ],
    )
}

fn vault_sync_positions(
    env: &Env,
    user: &Address,
    positions: &Vec<Position>,
) -> Result<(), CoreError> {
    env.invoke_contract::<Result<(), CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "sync_positions"),
        vec![env, user.into_val(env), positions.into_val(env)],
    )
}

fn vault_apply_pnl(
    env: &Env,
    user: &Address,
    asset: &Address,
    pnl: i128,
) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "apply_pnl"),
        vec![
            env,
            user.into_val(env),
            asset.into_val(env),
            pnl.into_val(env),
        ],
    )
}

fn vault_account_health(
    env: &Env,
    user: &Address,
    asset: &Address,
) -> Result<AccountHealth, CoreError> {
    env.invoke_contract::<Result<AccountHealth, CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "account_health"),
        vec![env, user.into_val(env), asset.into_val(env)],
    )
}

fn settlement_asset(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::SettlementAsset)
        .ok_or(CoreError::InvalidConfig)
}

fn insurance_address(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Insurance)
}

fn next_position_id(env: &Env) -> Result<u64, CoreError> {
    let current: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextPositionId)
        .ok_or(CoreError::InvalidConfig)?;
    let next = current.checked_add(1).ok_or(CoreError::MathOverflow)?;
    env.storage()
        .instance()
        .set(&DataKey::NextPositionId, &next);
    Ok(current)
}

fn validate_execution_price(
    env: &Env,
    market: &EngineMarketConfig,
    execution_price: i128,
) -> Result<(), CoreError> {
    let guard = OracleGuard {
        max_age_secs: market.market.max_oracle_age_secs,
        max_confidence_bps: market.market.max_oracle_confidence_bps,
    };
    let oracle = oracle_get_price(env, &market.market.base_asset, Some(guard))?.price;
    let max_delta = apply_bps(oracle, market.max_execution_deviation_bps)?;
    let lower = checked_sub(oracle, max_delta)?;
    let upper = checked_add(oracle, max_delta)?;
    if execution_price < lower || execution_price > upper {
        return Err(CoreError::PriceOutsideBand);
    }
    Ok(())
}

fn load_positions(env: &Env, user: &Address) -> Vec<Position> {
    env.storage()
        .persistent()
        .get(&DataKey::Positions(user.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

fn store_positions(env: &Env, user: &Address, positions: &Vec<Position>) {
    env.storage()
        .persistent()
        .set(&DataKey::Positions(user.clone()), positions);
}

fn find_position_index(positions: &Vec<Position>, position_id: u64) -> Result<u32, CoreError> {
    for i in 0..positions.len() {
        if positions
            .get(i)
            .ok_or(CoreError::PositionNotFound)?
            .position_id
            == position_id
        {
            return Ok(i);
        }
    }
    Err(CoreError::PositionNotFound)
}

fn open_interest(env: &Env, market_id: u32) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::OpenInterest(market_id))
        .unwrap_or(0)
}

fn store_open_interest(env: &Env, market_id: u32, value: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::OpenInterest(market_id), &value);
}

fn side_open_interest(env: &Env, market_id: u32, is_long: bool) -> i128 {
    let key = if is_long {
        DataKey::LongOpenInterest(market_id)
    } else {
        DataKey::ShortOpenInterest(market_id)
    };
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn store_side_open_interest(env: &Env, market_id: u32, is_long: bool, value: i128) {
    let key = if is_long {
        DataKey::LongOpenInterest(market_id)
    } else {
        DataKey::ShortOpenInterest(market_id)
    };
    env.storage().persistent().set(&key, &value);
}

fn funding_state(env: &Env, market_id: u32) -> FundingState {
    env.storage()
        .persistent()
        .get(&DataKey::FundingState(market_id))
        .unwrap_or(FundingState {
            long_index: 0,
            short_index: 0,
            rate_per_hour: 0,
            last_update: env.ledger().timestamp(),
        })
}

/// The insurance fund's balance net of bad debt it has already recorded, in the
/// settlement asset. Never negative.
///
/// Netting matters: a fund holding 1,000 against 900 of recorded bad debt has
/// 100 of real capacity, and treating the gross balance as capacity is exactly
/// how a fund that is already underwater keeps underwriting new risk.
fn effective_insurance(env: &Env) -> Result<i128, CoreError> {
    let Some(insurance) = insurance_address(env) else {
        return Ok(0);
    };
    let asset = settlement_asset(env)?;
    let balance = env.invoke_contract::<i128>(
        &insurance,
        &Symbol::new(env, "balance_of"),
        vec![env, asset.into_val(env)],
    );
    let bad_debt = env.invoke_contract::<i128>(
        &insurance,
        &Symbol::new(env, "bad_debt_of"),
        vec![env, asset.into_val(env)],
    );
    Ok(core::cmp::max(0, checked_sub(balance, bad_debt)?))
}

/// Refuse new exposure a depleted insurance fund could not stand behind.
///
/// Applies only to opening and increasing. Reducing and closing are always
/// allowed — a cap that blocked exits would turn a thin insurance fund into a
/// trap, which is the opposite of the intent.
fn require_insurance_headroom(
    env: &Env,
    market_id: u32,
    next_oi: i128,
    price: i128,
) -> Result<(), CoreError> {
    let Some(max_bps) = env
        .storage()
        .persistent()
        .get::<DataKey, u32>(&DataKey::OiPolicy(market_id))
    else {
        return Ok(());
    };
    let cap = mul_div(effective_insurance(env)?, max_bps as i128, 10_000)?;
    if notional(next_oi, price)? > cap {
        return Err(CoreError::InsuranceFundInsufficient);
    }
    Ok(())
}

fn mark_state(env: &Env, market_id: u32) -> MarkState {
    env.storage()
        .persistent()
        .get(&DataKey::MarkState(market_id))
        .unwrap_or(MarkState {
            last_price: 0,
            last_ts: env.ledger().timestamp(),
            cumulative: 0,
            window_start: env.ledger().timestamp(),
        })
}

/// Credit the price that has been standing since `last_ts` into `cumulative`,
/// then move `last_ts` to `now`. Idempotent within a ledger.
fn accrue_mark(state: &mut MarkState, now: u64) -> Result<(), CoreError> {
    if now > state.last_ts && state.last_price > 0 {
        let held = (now - state.last_ts) as i128;
        state.cumulative = checked_add(state.cumulative, mul_div(state.last_price, held, 1)?)?;
    }
    state.last_ts = now;
    Ok(())
}

/// Record an executed fill price into the market's time-weighted mark.
///
/// Called only for gateway-routed trades. Liquidation fills are deliberately
/// excluded: they execute at a keeper-chosen price against a distressed
/// account, so letting them set the mark would let a liquidator move funding.
///
/// Time-weighted rather than fill-weighted (KRY-Q6). Under a fill-count EMA the
/// cost of moving the mark was N trades, which a manipulator can produce in a
/// single ledger for the price of the spread. Weighting by time instead means
/// the mark reflects how LONG a price was held, so pushing the premium requires
/// holding the book away from the index for a real fraction of the funding
/// window — against everyone willing to trade back.
fn record_mark(env: &Env, market_id: u32, execution_price: i128) -> Result<(), CoreError> {
    let now = env.ledger().timestamp();
    let mut state = mark_state(env, market_id);
    accrue_mark(&mut state, now)?;
    if state.last_price == 0 {
        // First ever trade: start the window here rather than averaging in the
        // dead time before the market existed.
        state.window_start = now;
        state.cumulative = 0;
    }
    state.last_price = execution_price;
    env.storage()
        .persistent()
        .set(&DataKey::MarkState(market_id), &state);
    Ok(())
}

/// The market's time-weighted mark over the window since the last read, and the
/// side effect of closing that window so the next read averages fresh time.
///
/// Returns 0 for a market that has never traded — the caller treats that as
/// "no opinion", not as a price of zero.
fn consume_mark_twap(env: &Env, market_id: u32) -> Result<i128, CoreError> {
    let now = env.ledger().timestamp();
    let mut state = mark_state(env, market_id);
    if state.last_price <= 0 {
        return Ok(0);
    }
    accrue_mark(&mut state, now)?;

    let elapsed = now.saturating_sub(state.window_start) as i128;
    // A zero-length window (funding poked in the same ledger as the last read)
    // has no time to average over; the standing price is the best estimate.
    let twap = if elapsed > 0 {
        mul_div(state.cumulative, 1, elapsed)?
    } else {
        state.last_price
    };

    // Close the window: the next read averages only time from here forward.
    state.cumulative = 0;
    state.window_start = now;
    env.storage()
        .persistent()
        .set(&DataKey::MarkState(market_id), &state);
    Ok(twap)
}

/// Read-only view of the market's current standing mark (the last executed fill
/// price), without disturbing the TWAP window.
fn last_mark(env: &Env, market_id: u32) -> i128 {
    mark_state(env, market_id).last_price
}

fn fee_config(env: &Env, market_id: u32) -> FeeConfig {
    env.storage()
        .persistent()
        .get(&DataKey::FeeConfig(market_id))
        .unwrap_or(FeeConfig {
            maker_fee_bps: 0,
            taker_fee_bps: 0,
        })
}

fn sync_and_require_initial_margin(
    env: &Env,
    user: &Address,
    positions: &Vec<Position>,
) -> Result<(), CoreError> {
    vault_sync_positions(env, user, positions)?;
    let health = vault_health(env, user)?;
    if health.equity < health.initial_margin_required {
        return Err(CoreError::InsufficientCollateral);
    }
    Ok(())
}

fn vault_health(env: &Env, user: &Address) -> Result<AccountHealth, CoreError> {
    vault_account_health(env, user, &settlement_asset(env)?)
}

fn require_account_above_initial_margin(env: &Env, user: &Address) -> Result<(), CoreError> {
    let health = vault_health(env, user)?;
    if health.equity < health.initial_margin_required {
        return Err(CoreError::InsufficientCollateral);
    }
    Ok(())
}

fn realized_pnl(
    position: &Position,
    size_delta: i128,
    execution_price: i128,
) -> Result<i128, CoreError> {
    let price_delta = if position.is_long {
        checked_sub(execution_price, position.entry_price)?
    } else {
        checked_sub(position.entry_price, execution_price)?
    };
    mul_precision(size_delta, price_delta)
}

fn current_funding_index(env: &Env, position: &Position) -> i128 {
    let state = funding_state(env, position.market_id);
    if position.is_long {
        state.long_index
    } else {
        state.short_index
    }
}

fn settle_position_funding(
    env: &Env,
    user: &Address,
    position: &mut Position,
) -> Result<i128, CoreError> {
    let index = current_funding_index(env, position);
    let pnl = funding_pnl(position, index)?;
    if pnl != 0 {
        vault_apply_pnl(env, user, &settlement_asset(env)?, pnl)?;
    }
    position.last_funding_index = index;
    Ok(pnl)
}

fn reduce_position_internal(
    env: Env,
    user: Address,
    position_id: u64,
    size_delta: i128,
    execution_price: i128,
    require_initial_margin: bool,
) -> Result<TradeResult, CoreError> {
    if size_delta <= 0 || execution_price <= 0 {
        return Err(CoreError::InvalidAmount);
    }
    let mut positions = load_positions(&env, &user);
    let index = find_position_index(&positions, position_id)?;
    let mut position = positions.get(index).ok_or(CoreError::PositionNotFound)?;
    if size_delta > position.size {
        return Err(CoreError::InvalidAmount);
    }
    let market = load_market(&env, position.market_id)?;
    validate_execution_price(&env, &market, execution_price)?;
    // Liquidation fills (require_initial_margin == false) must not move the mark.
    if require_initial_margin {
        record_mark(&env, position.market_id, execution_price)?;
    }
    let settled_funding = settle_position_funding(&env, &user, &mut position)?;
    let realized_pnl = realized_pnl(&position, size_delta, execution_price)?;

    // For isolated positions, release margin proportional to the fraction being closed
    if position.mode == MarginMode::Isolated && position.margin > 0 {
        let margin_release = protocol_core::mul_div(position.margin, size_delta, position.size)?;
        position.margin = checked_sub(position.margin, margin_release)?;
    }

    position.size = checked_sub(position.size, size_delta)?;
    if position.size == 0 {
        positions.remove(index);
    } else {
        positions.set(index, position.clone());
    }
    store_positions(&env, &user, &positions);
    store_open_interest(
        &env,
        market.market.market_id,
        checked_sub(open_interest(&env, market.market.market_id), size_delta)?,
    );
    store_side_open_interest(
        &env,
        market.market.market_id,
        position.is_long,
        checked_sub(
            side_open_interest(&env, market.market.market_id, position.is_long),
            size_delta,
        )?,
    );
    vault_apply_pnl(&env, &user, &settlement_asset(&env)?, realized_pnl)?;
    if require_initial_margin {
        sync_and_require_initial_margin(&env, &user, &positions)?;
    } else {
        vault_sync_positions(&env, &user, &positions)?;
    }
    let equity = vault_health(&env, &user)?.equity;
    Ok(TradeResult {
        position_id,
        remaining_size: position.size,
        entry_price: position.entry_price,
        realized_pnl,
        funding_pnl: settled_funding,
        execution_price,
        account_equity: equity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use perp_insurance::{PerpInsuranceContract, PerpInsuranceContractClient};
    use perp_oracle_adapter::{OracleAdapterContract, OracleAdapterContractClient};
    use perp_vault::{PerpVaultContract, PerpVaultContractClient};
    use protocol_core::{OracleSource, PRECISION};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, Env, Symbol,
    };

    struct Setup<'a> {
        env: Env,
        admin: Address,
        user: Address,
        settlement_asset: Address,
        vault: PerpVaultContractClient<'a>,
        engine: PerpEngineContractClient<'a>,
    }

    fn setup() -> Setup<'static> {
        setup_with_gateway(true)
    }

    fn setup_with_gateway(configure_gateway: bool) -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let publisher = Address::generate(&env);
        let settlement_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(settlement_admin.clone());
        let settlement_asset = token_contract.address();
        token::StellarAssetClient::new(&env, &settlement_asset).mint(&user, &(10_000 * PRECISION));

        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);
        oracle.initialize(&admin);
        oracle.set_feed(
            &Symbol::new(&env, "USDC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 10_000,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.set_feed(
            &Symbol::new(&env, "BTC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 10_000,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.write_price(
            &Symbol::new(&env, "USDC"),
            &publisher,
            &PRECISION,
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );
        oracle.write_price(
            &Symbol::new(&env, "BTC"),
            &publisher,
            &(100 * PRECISION),
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );

        let engine_id = env.register(PerpEngineContract, ());
        let vault_id = env.register(PerpVaultContract, ());
        let vault = PerpVaultContractClient::new(&env, &vault_id);
        vault.initialize(&admin, &oracle_id, &engine_id);
        vault.set_collateral(&settlement_asset, &Symbol::new(&env, "USDC"), &0, &true);

        let engine = PerpEngineContractClient::new(&env, &engine_id);
        engine.initialize(&admin, &oracle_id, &vault_id, &settlement_asset);
        if configure_gateway {
            engine.set_order_gateway(&admin);
        }
        engine.set_market(&EngineMarketConfig {
            market: MarketConfig {
                market_id: 1,
                base_asset: Symbol::new(&env, "BTC"),
                settlement_asset: settlement_asset.clone(),
                max_leverage_bps: 100_000,
                initial_margin_bps: 1_000,
                maintenance_margin_bps: 500,
                liquidation_fee_bps: 50,
                max_open_interest: 1_000 * PRECISION,
                max_oracle_age_secs: 10_000,
                max_oracle_confidence_bps: 100,
                active: true,
            },
            max_execution_deviation_bps: 100,
        });
        vault.deposit(&user, &settlement_asset, &(1_000 * PRECISION));

        Setup {
            env,
            admin,
            user,
            settlement_asset,
            vault,
            engine,
        }
    }

    #[test]
    fn open_position_enforces_per_user_cap() {
        let s = setup();
        // Tiny positions so margin never binds: 0.01 BTC @ $100 = $1 notional.
        let size = PRECISION / 100;
        for _ in 0..MAX_POSITIONS_PER_USER {
            s.engine.open_position(
                &s.user,
                &1,
                &size,
                &true,
                &(100 * PRECISION),
                &MarginMode::Cross,
            );
        }
        assert_eq!(s.engine.positions(&s.user).len(), MAX_POSITIONS_PER_USER);
        let err = s
            .engine
            .try_open_position(
                &s.user,
                &1,
                &size,
                &true,
                &(100 * PRECISION),
                &MarginMode::Cross,
            )
            .expect_err("17th position must be rejected");
        assert_eq!(err, Ok(CoreError::TooManyPositions));
    }

    #[test]
    fn opens_position_and_syncs_vault_health() {
        let s = setup();
        let result = s.engine.open_position(
            &s.user,
            &1,
            &(5 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        assert_eq!(result.remaining_size, 5 * PRECISION);
        assert_eq!(s.engine.positions(&s.user).len(), 1);
        assert_eq!(s.engine.open_interest(&1), 5 * PRECISION);
        assert!(s.vault.account_health(&s.user, &s.settlement_asset).equity > 0);
    }

    #[test]
    fn rejects_direct_position_mutation_without_order_gateway() {
        let s = setup_with_gateway(false);
        let result = s.engine.try_open_position(
            &s.user,
            &1,
            &PRECISION,
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        assert!(result.is_err());
        assert_eq!(s.engine.positions(&s.user).len(), 0);
    }

    #[test]
    fn rejects_execution_outside_oracle_band() {
        let s = setup();
        let result = s.engine.try_open_position(
            &s.user,
            &1,
            &(PRECISION),
            &true,
            &(150 * PRECISION),
            &MarginMode::Cross,
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_open_that_breaks_initial_margin() {
        let s = setup();
        let result = s.engine.try_open_position(
            &s.user,
            &1,
            &(200 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        assert!(result.is_err());
    }

    #[test]
    fn close_realizes_profit_to_vault_balance() {
        let s = setup();
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        let position_id = opened.position_id;
        s.engine
            .close_position(&s.user, &position_id, &(101 * PRECISION));
        assert_eq!(
            s.vault.balance_of(&s.user, &s.settlement_asset),
            1_001 * PRECISION
        );
        assert_eq!(s.engine.positions(&s.user).len(), 0);
    }

    #[test]
    fn charge_trade_fee_debits_user_and_credits_recipient() {
        let s = setup();
        let collector = Address::generate(&s.env);
        s.engine.set_fee_collector(&collector);
        s.engine.set_fee_config(
            &1,
            &FeeConfig {
                maker_fee_bps: 1,
                taker_fee_bps: 5,
            },
        );

        let fee = s
            .engine
            .charge_trade_fee(&s.user, &1, &PRECISION, &(100 * PRECISION), &false);

        assert_eq!(fee, PRECISION / 20);
        assert_eq!(
            s.vault.balance_of(&s.user, &s.settlement_asset),
            (1_000 * PRECISION) - (PRECISION / 20)
        );
        assert_eq!(
            s.vault.balance_of(&s.admin, &s.settlement_asset),
            PRECISION / 20
        );
    }

    #[test]
    fn charge_trade_fee_cannot_push_account_below_initial_margin() {
        let s = setup();
        let collector = Address::generate(&s.env);
        s.engine.set_fee_collector(&collector);
        s.engine.set_fee_config(
            &1,
            &FeeConfig {
                maker_fee_bps: 0,
                taker_fee_bps: 10_000,
            },
        );
        s.engine.open_position(
            &s.user,
            &1,
            &(10 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );

        let result = s.engine.try_charge_trade_fee(
            &s.user,
            &1,
            &(10 * PRECISION),
            &(100 * PRECISION),
            &false,
        );

        assert!(result.is_err());
        assert_eq!(
            s.vault.balance_of(&s.user, &s.settlement_asset),
            1_000 * PRECISION
        );
        assert_eq!(s.vault.balance_of(&s.admin, &s.settlement_asset), 0);
    }

    /// KRY-Q4: a market may not carry more open interest than the insurance
    /// fund can stand behind.
    ///
    /// Liquidation closes a distressed position with no counterparty, so the
    /// fund is the protocol's implicit other side. Before this cap that
    /// exposure was unbounded — the fund could be a rounding error against the
    /// open interest it was underwriting and nothing said so.
    #[test]
    fn open_interest_is_capped_against_the_insurance_fund() {
        let s = setup();

        // Fund insurance with 100 units of the settlement asset and allow OI
        // notional up to 2x that — a 200 notional ceiling.
        let insurance_id = s.env.register(PerpInsuranceContract, ());
        let insurance = PerpInsuranceContractClient::new(&s.env, &insurance_id);
        insurance.initialize(&s.admin, &s.admin);
        token::StellarAssetClient::new(&s.env, &s.settlement_asset)
            .mint(&s.admin, &(100 * PRECISION));
        insurance.deposit(&s.admin, &s.settlement_asset, &(100 * PRECISION));
        s.engine.set_insurance(&insurance_id);
        s.engine.set_oi_policy(&1, &20_000); // 2x, in bps

        // 1 unit at price 100 = 100 notional. Inside the 200 ceiling.
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &PRECISION,
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        assert_eq!(s.engine.open_interest(&1), PRECISION);

        // Coverage is now 100 insurance against 100 notional = 10_000 bps.
        assert_eq!(s.engine.insurance_coverage_bps(&1), 10_000);

        // A second unit would take OI notional to 200... still exactly at the
        // ceiling, so it is allowed.
        s.engine.open_position(
            &s.user,
            &1,
            &PRECISION,
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );

        // A third crosses it and must be refused.
        assert!(
            s.engine
                .try_open_position(
                    &s.user,
                    &1,
                    &PRECISION,
                    &true,
                    &(100 * PRECISION),
                    &MarginMode::Cross,
                )
                .is_err(),
            "opening past the insurance-backed ceiling must be refused",
        );

        // Increasing an existing position is the same new risk by another name.
        assert!(
            s.engine
                .try_increase_position(&s.user, &opened.position_id, &PRECISION, &(100 * PRECISION))
                .is_err(),
            "increase must be capped too, or the cap is trivially bypassed",
        );

        // EXITING is always allowed. A cap that blocked closes would turn a
        // thin insurance fund into a trap — the opposite of the intent.
        let closed = s
            .engine
            .close_position(&s.user, &opened.position_id, &(100 * PRECISION));
        assert_eq!(closed.remaining_size, 0);
    }

    /// With no policy configured the cap is inert, so existing deployments are
    /// unaffected until governance opts in.
    #[test]
    fn markets_without_an_oi_policy_are_uncapped() {
        let s = setup();
        assert_eq!(s.engine.oi_policy(&1), None);
        s.engine.open_position(
            &s.user,
            &1,
            &(5 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        assert_eq!(s.engine.open_interest(&1), 5 * PRECISION);
    }

    #[test]
    fn oi_policy_tracks_the_aggregate_across_markets() {
        // KRY-Q11: the fund is pooled, so the sum of every market's OiPolicy
        // bps — not any single market's — is what the fund is really on the
        // hook for. total_oi_policy_bps must track that sum as markets are
        // added, updated, and removed.
        let s = setup();
        assert_eq!(s.engine.total_oi_policy_bps(), 0);

        s.engine.set_oi_policy(&1, &20_000); // 2x
        assert_eq!(s.engine.total_oi_policy_bps(), 20_000);

        s.engine.set_oi_policy(&2, &50_000); // 5x
        assert_eq!(s.engine.total_oi_policy_bps(), 70_000);

        s.engine.set_oi_policy(&1, &10_000); // lowering market 1 to 1x
        assert_eq!(s.engine.total_oi_policy_bps(), 60_000);

        s.engine.set_oi_policy(&2, &0); // removing market 2 entirely
        assert_eq!(s.engine.total_oi_policy_bps(), 10_000);
        assert_eq!(s.engine.oi_policy(&2), None);
    }

    #[test]
    fn aggregate_oi_policy_ceiling_rejects_overcommitment() {
        // Without a ceiling, N markets can each independently claim up to
        // their own multiple of the SAME pooled fund — the fund's real
        // aggregate exposure is unbounded even though each market looks
        // individually capped. set_max_total_oi_policy_bps closes that.
        let s = setup();
        s.engine.set_max_total_oi_policy_bps(&30_000); // markets may claim at most 3x the fund, combined

        s.engine.set_oi_policy(&1, &20_000); // 2x — fits under the 3x ceiling
        assert_eq!(s.engine.total_oi_policy_bps(), 20_000);

        // Market 2 at another 2x would bring the aggregate to 4x, over the
        // 3x ceiling — must be refused, and must not mutate any state.
        let result = s.engine.try_set_oi_policy(&2, &20_000);
        assert_eq!(result, Err(Ok(CoreError::AggregateOiPolicyExceeded)));
        assert_eq!(s.engine.total_oi_policy_bps(), 20_000);
        assert_eq!(s.engine.oi_policy(&2), None);

        // Exactly at the ceiling is allowed.
        s.engine.set_oi_policy(&2, &10_000); // +1x = 3x total, exactly the ceiling
        assert_eq!(s.engine.total_oi_policy_bps(), 30_000);
    }

    #[test]
    fn funding_update_is_settled_before_close() {
        let s = setup();
        // Trade 1% rich against the 100 index so there is a premium to fund on.
        // (Under the old open-interest-imbalance formula this test passed only
        // because `open_position` is called directly here, creating a one-sided
        // book that a matched gateway fill can never produce — see KRY-Q1.)
        let mark = 101 * PRECISION;
        let opened =
            s.engine
                .open_position(&s.user, &1, &PRECISION, &true, &mark, &MarginMode::Cross);
        s.engine.set_funding_config(
            &1,
            &FundingConfig {
                imbalance_coeff: PRECISION,
                max_rate_per_hour: PRECISION / 100,
            },
        );
        s.env.ledger().with_mut(|ledger| {
            ledger.timestamp += 3_600;
        });

        let funding = s.engine.update_funding(&1);
        let closed = s.engine.close_position(&s.user, &opened.position_id, &mark);

        assert_eq!(funding.long_index, PRECISION / 100);
        assert_eq!(closed.realized_pnl, 0);
        assert_eq!(closed.funding_pnl, -(PRECISION / 100));
        assert_eq!(
            s.vault.balance_of(&s.user, &s.settlement_asset),
            (1_000 * PRECISION) - (PRECISION / 100)
        );
    }

    #[test]
    fn isolated_margin_is_rejected_at_open() {
        // KRY-Q5-F: isolated margin has no separate collateral bucket in the
        // vault, so a realised isolated loss would draw down the same balance
        // as a cross position — the isolation the mode promises is not real.
        // The engine refuses to open one at all rather than let a caller rely
        // on a guarantee it can't deliver.
        let s = setup();
        let result = s.engine.try_open_position(
            &s.user,
            &1,
            &(5 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Isolated,
        );
        assert_eq!(result, Err(Ok(CoreError::IsolatedMarginDisabled)));
        assert_eq!(s.engine.positions(&s.user).len(), 0);
    }

    mod migration {
        use super::*;

        #[test]
        fn migrate_import_positions_seeds_state_and_advances_next_position_id() {
            let s = setup();
            let migrated_user = Address::generate(&s.env);
            let position = Position {
                position_id: 4_242,
                owner: migrated_user.clone(),
                market_id: 1,
                size: 5 * PRECISION,
                entry_price: 100 * PRECISION,
                margin: 0,
                is_long: true,
                last_funding_index: 0,
                mode: MarginMode::Cross,
            };

            let imported = s.engine.migrate_import_positions(&Vec::from_array(
                &s.env,
                [MigratedPositions {
                    user: migrated_user.clone(),
                    positions: Vec::from_array(&s.env, [position.clone()]),
                }],
            ));

            assert_eq!(imported, 1);
            assert_eq!(s.engine.positions(&migrated_user).get(0).unwrap(), position);
            assert_eq!(s.engine.open_interest(&1), 5 * PRECISION);
            assert_eq!(s.engine.long_open_interest(&1), 5 * PRECISION);

            // The next position opened anywhere must not collide with the
            // imported id, even though this engine has otherwise issued none.
            let opened = s.engine.open_position(
                &s.user,
                &1,
                &PRECISION,
                &true,
                &(100 * PRECISION),
                &MarginMode::Cross,
            );
            assert!(opened.position_id > 4_242);

            // The vault's own mirror was updated too, not just the engine's —
            // otherwise account_health would not see the imported position.
            let health = s.vault.account_health(&migrated_user, &s.settlement_asset);
            assert_eq!(health.maintenance_margin_required, 25 * PRECISION); // 5 * 100 * 5%
        }

        #[test]
        fn migration_cannot_run_again_once_sealed() {
            let s = setup();
            let migrated_user = Address::generate(&s.env);
            s.engine
                .migrate_import_positions(&Vec::from_array(&s.env, []));
            assert!(!s.engine.migration_sealed());
            s.engine.seal_migration();
            assert!(s.engine.migration_sealed());

            let result = s.engine.try_migrate_import_positions(&Vec::from_array(
                &s.env,
                [MigratedPositions {
                    user: migrated_user,
                    positions: Vec::new(&s.env),
                }],
            ));
            assert_eq!(result, Err(Ok(CoreError::AlreadyInitialized)));
        }
    }
}
