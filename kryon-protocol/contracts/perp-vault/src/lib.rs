#![no_std]
#![deny(unsafe_code)]

use protocol_core::{
    checked_add, checked_sub, CollateralBalance, CollateralConfig, CoreError, MarketConfig,
    MarketSnapshot, OracleGuard, OracleSnapshot, Position,
};
use risk_engine::{account_health, validate_withdrawal, AccountHealth};
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, token, vec, Address, BytesN, Env, IntoVal,
    Map, Symbol, Vec,
};

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
    /// Fast-path pause authority. Once governance (48h timelock) is the
    /// admin, an admin-gated emergency_pause is useless in an emergency —
    /// the guardian can PAUSE instantly, but only the admin can unpause.
    Guardian,
    Engine,
    Oracle,
    Insurance,
    Liquidation,
    Collateral(Address),
    Balance(Address, Address),
    Positions(Address),
    MarketConfig(u32),
    FundingLong(u32),
    FundingShort(u32),
    UserAssets(Address),
    Paused,
    /// Per-asset gross-deposit cap for staged launches (0 / absent = uncapped).
    DepositCap(Address),
    /// Running sum of deposits minus withdrawals per asset (backs the cap).
    TotalDeposited(Address),
    /// Keeper permitted to settle settlement-asset debits outside liquidation.
    Operator,
    /// Set once a mainnet migration's balance import is complete (KRY-Q10).
    /// `migrate_import_balances` refuses to run once this is set.
    MigrationSealed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigratedBalance {
    pub user: Address,
    pub asset: Address,
    pub amount: i128,
}

/// Emitted whenever liquidation reassigns collateral to cover a settlement
/// deficit. `uncovered_value` is the shortfall insurance must absorb.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralSeized {
    #[topic]
    pub user: Address,
    #[topic]
    pub deficit_asset: Address,
    pub credited: i128,
    pub uncovered_value: i128,
}

#[contract]
pub struct PerpVaultContract;

#[contractimpl]
impl PerpVaultContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        oracle: Address,
        engine: Address,
    ) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    pub fn set_oracle(env: Env, oracle: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Oracle, &oracle);
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

    /// The nominated-but-not-yet-accepted admin, if a transfer is in flight.
    /// Makes a half-finished handover visible instead of silent.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// Permissionless instance-TTL keepalive — prevents the vault instance
    /// (collateral configs, balances keys) from being archived.
    pub fn extend_instance_ttl(env: Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    pub fn set_engine(env: Env, engine: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn set_guardian(env: Env, guardian: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        Ok(())
    }

    pub fn guardian(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Guardian)
    }

    /// Per-asset gross-deposit cap for staged rollouts. cap <= 0 removes it.
    pub fn set_deposit_cap(env: Env, asset: Address, cap: i128) -> Result<(), CoreError> {
        require_admin(&env)?;
        if cap <= 0 {
            env.storage().instance().remove(&DataKey::DepositCap(asset));
        } else {
            env.storage()
                .instance()
                .set(&DataKey::DepositCap(asset), &cap);
        }
        Ok(())
    }

    pub fn deposit_cap(env: Env, asset: Address) -> Option<i128> {
        env.storage().instance().get(&DataKey::DepositCap(asset))
    }

    pub fn total_deposited(env: Env, asset: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalDeposited(asset))
            .unwrap_or(0)
    }

    pub fn set_insurance(env: Env, insurance: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Insurance, &insurance);
        Ok(())
    }

    pub fn set_liquidation(env: Env, liquidation: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Liquidation, &liquidation);
        Ok(())
    }

    /// Absorb an underwater account's bad debt after liquidation. The vault pulls
    /// real tokens from the insurance fund into reserves and credits the user back
    /// toward zero. Any uncovered remainder is recorded as protocol bad debt.
    /// Returns the amount covered. Idempotent for non-negative balances (returns 0).
    /// Only the liquidation contract may call.
    pub fn absorb_bad_debt(env: Env, user: Address, asset: Address) -> Result<i128, CoreError> {
        require_liquidation(&env)?;
        let balance = balance_of(env.clone(), user.clone(), asset.clone());
        if balance >= 0 {
            return Ok(0);
        }
        let deficit = checked_sub(0, balance)?;
        let covered = insurance_cover_deficit(&env, &asset, deficit)?;
        if covered > 0 {
            increase_balance(&env, &user, &asset, covered)?;
        }
        let remaining = checked_sub(deficit, covered)?;
        if remaining > 0 {
            insurance_record_bad_debt(&env, &asset, remaining)?;
        }
        Ok(covered)
    }

    /// Cover a negative balance in `deficit_asset` by seizing the account's other
    /// collateral, valued at oracle price *after* that asset's haircut.
    ///
    /// This is the step that makes non-settlement collateral actually liable for
    /// losses. Without it, a trader who posts only non-settlement collateral drives
    /// their settlement balance negative, and `absorb_bad_debt` socialises a loss to
    /// the insurance fund while their real collateral sits untouched in the vault.
    /// Liquidation MUST call this before `absorb_bad_debt` so insurance only ever
    /// covers a genuinely uncollateralised shortfall.
    ///
    /// Seizure order is deterministic: lowest haircut first. The haircut is the
    /// protocol's standing estimate of how hard an asset is to convert, so taking
    /// the most liquid collateral first maximises the chance the seizure can be
    /// unwound into the settlement asset near the value credited here.
    ///
    /// Tokens do not move: the vault already custodies them. This reassigns the
    /// user's internal claim, leaving the vault holding surplus `asset` against a
    /// `deficit_asset` credit — the treasury leg converts that surplus separately.
    ///
    /// Returns the amount credited to `deficit_asset` (never more than the
    /// deficit, never more than the collateral actually taken). Idempotent for
    /// non-negative balances. Only the liquidation contract may call.
    pub fn seize_for_deficit(
        env: Env,
        user: Address,
        deficit_asset: Address,
    ) -> Result<i128, CoreError> {
        require_liquidation(&env)?;
        seize_for_deficit_inner(&env, user, deficit_asset)
    }

    /// Settle a settlement-asset debit outside liquidation.
    ///
    /// Losses debit the settlement asset on every fill and funding application,
    /// so an account margined in another collateral accrues a negative
    /// settlement balance between liquidations. That balance is real reserves
    /// the vault has already paid to the winning side, so leaving it
    /// outstanding until the account happens to become liquidatable understates
    /// what the vault owes in the settlement asset.
    ///
    /// Callable by the operator (keeper) or by the account owner. Deliberately
    /// NOT permissionless: seizure converts collateral at a haircut, so an open
    /// entry point would let anyone force that conversion on a trader who would
    /// rather clear the debit by depositing the settlement asset.
    pub fn settle_deficit(
        env: Env,
        caller: Address,
        user: Address,
        asset: Address,
    ) -> Result<i128, CoreError> {
        caller.require_auth();
        if caller != user {
            let operator: Address = env
                .storage()
                .instance()
                .get(&DataKey::Operator)
                .ok_or(CoreError::InvalidConfig)?;
            if caller != operator {
                return Err(CoreError::Unauthorized);
            }
        }
        require_not_paused(&env)?;
        seize_for_deficit_inner(&env, user, asset)
    }

    /// Keeper permitted to call `settle_deficit` for any account.
    pub fn set_operator(env: Env, operator: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Operator, &operator);
        Ok(())
    }

    pub fn operator(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Operator)
    }

    pub fn set_collateral(
        env: Env,
        asset: Address,
        oracle_asset: Symbol,
        haircut_bps: u32,
        active: bool,
    ) -> Result<(), CoreError> {
        require_admin(&env)?;
        if haircut_bps > 10_000 {
            return Err(CoreError::InvalidConfig);
        }
        let config = CollateralConfig {
            asset: asset.clone(),
            oracle_asset,
            haircut_bps,
            active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Collateral(asset), &config);
        Ok(())
    }

    /// The listed configuration for a collateral asset, or None if it was never
    /// listed. Clients read this to discover which assets the vault actually
    /// accepts, rather than hardcoding a list that can drift from the chain.
    pub fn collateral(env: Env, asset: Address) -> Option<CollateralConfig> {
        env.storage().persistent().get(&DataKey::Collateral(asset))
    }

    /// Seed a freshly deployed vault's collateral balances from an export of
    /// a frozen, unupgradeable deployment (KRY-Q10). Every mainnet contract
    /// predates `upgrade()` and can never be given it, so a real migration
    /// means new contracts plus a one-time import of old balances — this is
    /// that import.
    ///
    /// Credits the internal ledger only — it does not move tokens. The real
    /// tokens backing every imported balance must be deposited into this
    /// vault's custody as its own step in the migration runbook (e.g. a
    /// treasury transfer sized to the sum of every export before, or as part
    /// of, running this), or the internal ledger promises more than the
    /// vault actually holds the moment this call succeeds. Also updates
    /// `TotalDeposited` so a per-asset deposit cap set after migration is
    /// judged against the real starting balance, not zero.
    ///
    /// Callable repeatedly, in batches, until `seal_migration` closes the
    /// window — a full account export rarely fits one transaction.
    pub fn migrate_import_balances(
        env: Env,
        entries: Vec<MigratedBalance>,
    ) -> Result<u32, CoreError> {
        require_admin(&env)?;
        if env.storage().instance().has(&DataKey::MigrationSealed) {
            return Err(CoreError::AlreadyInitialized);
        }
        let mut imported = 0u32;
        for entry in entries.iter() {
            if entry.amount == 0 {
                continue;
            }
            increase_balance(&env, &entry.user, &entry.asset, entry.amount)?;
            record_user_asset(&env, &entry.user, &entry.asset);
            let total = Self::total_deposited(env.clone(), entry.asset.clone());
            env.storage().instance().set(
                &DataKey::TotalDeposited(entry.asset.clone()),
                &checked_add(total, entry.amount)?,
            );
            imported += 1;
        }
        Ok(imported)
    }

    /// Close the balance-import window for good. Admin-gated like every
    /// other configuration entrypoint — in production that means the
    /// governance timelock, so sealing inherits its delay and cancellation
    /// window rather than being an instant, unreviewable action.
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

    pub fn set_market_config(env: Env, config: MarketConfig) -> Result<(), CoreError> {
        require_admin(&env)?;
        validate_market_config(&config)?;
        env.storage()
            .persistent()
            .set(&DataKey::MarketConfig(config.market_id), &config);
        Ok(())
    }

    pub fn set_funding_indexes(
        env: Env,
        market_id: u32,
        funding_index_long: i128,
        funding_index_short: i128,
    ) -> Result<(), CoreError> {
        require_engine(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::FundingLong(market_id), &funding_index_long);
        env.storage()
            .persistent()
            .set(&DataKey::FundingShort(market_id), &funding_index_short);
        Ok(())
    }

    pub fn sync_positions(
        env: Env,
        user: Address,
        positions: Vec<Position>,
    ) -> Result<(), CoreError> {
        require_engine(&env)?;
        for position in positions.iter() {
            if position.owner != user {
                return Err(CoreError::Unauthorized);
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::Positions(user), &positions);
        Ok(())
    }

    pub fn apply_pnl(
        env: Env,
        user: Address,
        asset: Address,
        pnl: i128,
    ) -> Result<i128, CoreError> {
        require_engine(&env)?;
        require_not_paused(&env)?;
        if pnl >= 0 {
            increase_balance(&env, &user, &asset, pnl)
        } else {
            decrease_balance(&env, &user, &asset, checked_sub(0, pnl)?)
        }
    }

    pub fn deposit(
        env: Env,
        user: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, CoreError> {
        require_not_paused(&env)?;
        user.require_auth();
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let config = load_collateral(&env, &asset)?;
        if !config.active {
            return Err(CoreError::AssetDisabled);
        }
        // Staged-launch TVL cap: gross deposits (net of withdrawals) per asset.
        let total = Self::total_deposited(env.clone(), asset.clone());
        let next_total = checked_add(total, amount)?;
        if let Some(cap) = Self::deposit_cap(env.clone(), asset.clone()) {
            if next_total > cap {
                return Err(CoreError::DepositCapExceeded);
            }
        }
        let vault = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&user, &vault, &amount);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited(asset.clone()), &next_total);
        let new_balance = increase_balance(&env, &user, &asset, amount)?;
        record_user_asset(&env, &user, &asset);
        Ok(new_balance)
    }

    pub fn withdraw(
        env: Env,
        user: Address,
        asset: Address,
        amount: i128,
    ) -> Result<AccountHealth, CoreError> {
        require_not_paused(&env)?;
        user.require_auth();
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let config = load_collateral(&env, &asset)?;
        if !config.active {
            return Err(CoreError::AssetDisabled);
        }
        let balance = balance_of(env.clone(), user.clone(), asset.clone());
        if balance < amount {
            return Err(CoreError::InsufficientCollateral);
        }

        let positions = load_positions(&env, &user);
        let user_assets_key = DataKey::UserAssets(user.clone());
        let account = if env.storage().persistent().has(&user_assets_key) {
            account_snapshot_all_assets(&env, user.clone(), positions)?
        } else {
            account_snapshot_for_asset(
                &env,
                user.clone(),
                asset.clone(),
                balance,
                config,
                positions,
            )?
        };
        let markets = load_markets_for_positions(&env, &account.positions)?;
        let price = collateral_price(&env, &asset)?;
        let withdrawal_value = protocol_core::mul_precision(amount, price.price)?;
        let health = validate_withdrawal(&env, &account, &markets, withdrawal_value)?;

        decrease_balance(&env, &user, &asset, amount)?;
        // Free cap headroom (saturating: pre-upgrade deposits were never counted).
        let total = Self::total_deposited(env.clone(), asset.clone());
        env.storage().instance().set(
            &DataKey::TotalDeposited(asset.clone()),
            &core::cmp::max(0, total - amount),
        );
        let vault = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&vault, &user, &amount);
        Ok(health)
    }

    pub fn account_health(
        env: Env,
        user: Address,
        asset: Address,
    ) -> Result<AccountHealth, CoreError> {
        let positions = load_positions(&env, &user);
        let user_assets_key = DataKey::UserAssets(user.clone());
        let account = if env.storage().persistent().has(&user_assets_key) {
            account_snapshot_all_assets(&env, user, positions)?
        } else {
            let config = load_collateral(&env, &asset)?;
            let balance = balance_of(env.clone(), user.clone(), asset.clone());
            account_snapshot_for_asset(&env, user, asset, balance, config, positions)?
        };
        let markets = load_markets_for_positions(&env, &account.positions)?;
        account_health(&env, &account, &markets)
    }

    pub fn balance_of(env: Env, user: Address, asset: Address) -> i128 {
        balance_of(env, user, asset)
    }

    // --- H4: Emergency pause ---

    /// Pause deposits/withdrawals/PnL. Callable by the admin OR the guardian —
    /// the guardian is the fast path once admin sits behind the governance
    /// timelock. Unpause remains admin-only, so a compromised guardian can
    /// halt the system but never restart it.
    pub fn emergency_pause(env: Env, caller: Address) -> Result<(), CoreError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(CoreError::InvalidConfig)?;
        let guardian: Option<Address> = env.storage().instance().get(&DataKey::Guardian);
        if caller != admin && Some(caller) != guardian {
            return Err(CoreError::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().remove(&DataKey::Paused);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
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

fn require_engine(env: &Env) -> Result<Address, CoreError> {
    let engine: Address = env
        .storage()
        .instance()
        .get(&DataKey::Engine)
        .ok_or(CoreError::InvalidConfig)?;
    engine.require_auth();
    Ok(engine)
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

fn insurance_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Insurance)
        .ok_or(CoreError::InvalidConfig)
}

fn insurance_cover_deficit(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &insurance_address(env)?,
        &Symbol::new(env, "cover_deficit"),
        vec![env, asset.into_val(env), amount.into_val(env)],
    )
}

fn insurance_record_bad_debt(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &insurance_address(env)?,
        &Symbol::new(env, "record_bad_debt"),
        vec![env, asset.into_val(env), amount.into_val(env)],
    )
}

fn require_not_paused(env: &Env) -> Result<(), CoreError> {
    if env
        .storage()
        .instance()
        .get::<DataKey, bool>(&DataKey::Paused)
        .unwrap_or(false)
    {
        return Err(CoreError::Unauthorized);
    }
    Ok(())
}

fn validate_market_config(config: &MarketConfig) -> Result<(), CoreError> {
    if config.market_id == 0
        || config.initial_margin_bps == 0
        || config.maintenance_margin_bps == 0
        || config.maintenance_margin_bps > config.initial_margin_bps
        || config.max_leverage_bps == 0
        || config.max_oracle_age_secs == 0
        || config.max_oracle_confidence_bps > 10_000
        || config.max_open_interest <= 0
    {
        return Err(CoreError::InvalidConfig);
    }
    // KRY-Q8: `max_leverage_bps` used to be checked for non-zero and then never
    // read by anything, which advertised a second, independent leverage limit
    // that did not exist — the only real cap is the initial-margin requirement.
    // Rather than leave a field that can silently contradict the constraint it
    // describes, require the two to agree. A market may declare a TIGHTER cap
    // than its margin implies (that is a deliberate policy choice), but never a
    // looser one, which would be a published limit the protocol does not honour.
    if config.max_leverage_bps > protocol_core::implied_max_leverage_bps(config.initial_margin_bps)?
    {
        return Err(CoreError::InvalidConfig);
    }
    Ok(())
}

fn load_collateral(env: &Env, asset: &Address) -> Result<CollateralConfig, CoreError> {
    env.storage()
        .persistent()
        .get(&DataKey::Collateral(asset.clone()))
        .ok_or(CoreError::InvalidConfig)
}

fn balance_of(env: Env, user: Address, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(user, asset))
        .unwrap_or(0)
}

fn load_positions(env: &Env, user: &Address) -> Vec<Position> {
    env.storage()
        .persistent()
        .get(&DataKey::Positions(user.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

fn increase_balance(
    env: &Env,
    user: &Address,
    asset: &Address,
    amount: i128,
) -> Result<i128, CoreError> {
    let current = balance_of(env.clone(), user.clone(), asset.clone());
    let next = checked_add(current, amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(user.clone(), asset.clone()), &next);
    Ok(next)
}

fn decrease_balance(
    env: &Env,
    user: &Address,
    asset: &Address,
    amount: i128,
) -> Result<i128, CoreError> {
    let current = balance_of(env.clone(), user.clone(), asset.clone());
    let next = checked_sub(current, amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(user.clone(), asset.clone()), &next);
    Ok(next)
}

fn oracle_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Oracle)
        .ok_or(CoreError::InvalidConfig)
}

fn oracle_get_price(
    env: &Env,
    oracle: &Address,
    asset: &Symbol,
    guard: Option<OracleGuard>,
) -> Result<OracleSnapshot, CoreError> {
    env.invoke_contract::<Result<OracleSnapshot, CoreError>>(
        oracle,
        &Symbol::new(env, "get_price"),
        vec![env, asset.into_val(env), guard.into_val(env)],
    )
}

fn collateral_price(
    env: &Env,
    asset: &Address,
) -> Result<protocol_core::OracleSnapshot, CoreError> {
    let config = load_collateral(env, asset)?;
    oracle_get_price(env, &oracle_address(env)?, &config.oracle_asset, None)
}

fn account_snapshot_for_asset(
    env: &Env,
    user: Address,
    asset: Address,
    amount: i128,
    config: CollateralConfig,
    positions: Vec<Position>,
) -> Result<protocol_core::AccountSnapshot, CoreError> {
    let price = oracle_get_price(env, &oracle_address(env)?, &config.oracle_asset, None)?;
    let value = protocol_core::mul_precision(amount, price.price)?;
    let collateral = Vec::from_array(
        env,
        [CollateralBalance {
            asset,
            amount,
            value,
            haircut_bps: config.haircut_bps,
        }],
    );
    for position in positions.iter() {
        if position.owner != user {
            return Err(CoreError::Unauthorized);
        }
    }
    Ok(protocol_core::AccountSnapshot {
        owner: user,
        collateral,
        positions,
    })
}

// --- H6: Multi-collateral helpers ---

fn record_user_asset(env: &Env, user: &Address, asset: &Address) {
    let key = DataKey::UserAssets(user.clone());
    let mut assets: Vec<Address> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    for a in assets.iter() {
        if a == *asset {
            return;
        }
    }
    assets.push_back(asset.clone());
    env.storage().persistent().set(&key, &assets);
}

fn seize_for_deficit_inner(
    env: &Env,
    user: Address,
    deficit_asset: Address,
) -> Result<i128, CoreError> {
    let balance = balance_of(env.clone(), user.clone(), deficit_asset.clone());
    if balance >= 0 {
        return Ok(0);
    }
    let deficit_amount = checked_sub(0, balance)?;
    let deficit_price = collateral_price(env, &deficit_asset)?.price;
    if deficit_price <= 0 {
        return Err(CoreError::InvalidPrice);
    }
    // Oracle-denominated value still owed to the vault.
    let mut remaining_value = protocol_core::mul_precision(deficit_amount, deficit_price)?;

    let oracle = oracle_address(env)?;
    let mut credited: i128 = 0;

    for asset in seizure_order(env, &user, &deficit_asset).iter() {
        if remaining_value <= 0 {
            break;
        }
        let amount = balance_of(env.clone(), user.clone(), asset.clone());
        if amount <= 0 {
            continue;
        }
        let config = match load_collateral(env, &asset) {
            Ok(config) => config,
            Err(_) => continue,
        };
        let price = oracle_get_price(env, &oracle, &config.oracle_asset, None)?.price;
        let gross_value = protocol_core::mul_precision(amount, price)?;
        let net_value =
            protocol_core::collateral_value_after_haircut(gross_value, config.haircut_bps)?;
        // A fully haircut asset contributes no equity, so it can settle no debt.
        if net_value <= 0 {
            continue;
        }

        let seize_amount = if net_value <= remaining_value {
            amount
        } else {
            // Partial take, rounded down: seizing less than the exact share is
            // the protocol-safe direction (the residue stays with the user).
            protocol_core::mul_div(amount, remaining_value, net_value)?
        };
        if seize_amount <= 0 {
            continue;
        }

        // Re-derive the value taken from the *rounded* amount so the credit can
        // never exceed the collateral actually seized.
        let seized_value = protocol_core::collateral_value_after_haircut(
            protocol_core::mul_precision(seize_amount, price)?,
            config.haircut_bps,
        )?;
        let credit = protocol_core::div_precision(seized_value, deficit_price)?;
        if credit <= 0 {
            continue;
        }

        decrease_balance(env, &user, &asset, seize_amount)?;
        credited = checked_add(credited, credit)?;
        remaining_value = checked_sub(remaining_value, seized_value)?;
    }

    if credited > 0 {
        increase_balance(env, &user, &deficit_asset, credited)?;
    }
    CollateralSeized {
        user,
        deficit_asset,
        credited,
        // What the account's own collateral could not cover. This is the
        // amount `absorb_bad_debt` is about to draw from insurance, so it is
        // the number to alert on.
        uncovered_value: remaining_value.max(0),
    }
    .publish(env);
    Ok(credited)
}

/// Collateral assets scanned per seizure. `UserAssets` only ever grows with
/// assets the admin has listed, so this is a generous ceiling — it exists so a
/// liquidation can never be priced out of the ledger by a long asset list.
const MAX_SEIZE_SCAN: u32 = 16;

/// The account's seizable collateral, ordered by ascending haircut (most liquid
/// first), excluding the deficit asset itself and any de-listed asset.
///
/// Inactive collateral is skipped deliberately: `account_snapshot_all_assets`
/// excludes it from equity, so seizing it would create settlement value the
/// health calculation never counted.
fn seizure_order(env: &Env, user: &Address, deficit_asset: &Address) -> Vec<Address> {
    let assets: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::UserAssets(user.clone()))
        .unwrap_or_else(|| Vec::new(env));

    let mut ordered: Vec<Address> = Vec::new(env);
    let mut haircuts: Vec<u32> = Vec::new(env);

    for asset in assets.iter().take(MAX_SEIZE_SCAN as usize) {
        if asset == *deficit_asset {
            continue;
        }
        let config = match load_collateral(env, &asset) {
            Ok(config) => config,
            Err(_) => continue,
        };
        if !config.active {
            continue;
        }
        // Insertion sort, stable on ties — keeps the order deterministic across
        // nodes for identical state.
        let mut at = ordered.len();
        for i in 0..ordered.len() {
            if haircuts.get(i).unwrap_or(0) > config.haircut_bps {
                at = i;
                break;
            }
        }
        ordered.insert(at, asset);
        haircuts.insert(at, config.haircut_bps);
    }
    ordered
}

fn account_snapshot_all_assets(
    env: &Env,
    user: Address,
    positions: Vec<Position>,
) -> Result<protocol_core::AccountSnapshot, CoreError> {
    let user_assets_key = DataKey::UserAssets(user.clone());
    let user_assets: Vec<Address> = env
        .storage()
        .persistent()
        .get(&user_assets_key)
        .unwrap_or_else(|| Vec::new(env));

    let mut collateral: Vec<CollateralBalance> = Vec::new(env);
    for asset in user_assets.iter() {
        let amount = balance_of(env.clone(), user.clone(), asset.clone());
        // Zero balance contributes nothing — skip to avoid unnecessary oracle calls.
        // Negative balances MUST be included: they represent underwater accounts
        // that need the negative equity to trigger bad-debt coverage.
        if amount == 0 {
            continue;
        }
        let config = match env
            .storage()
            .persistent()
            .get::<DataKey, CollateralConfig>(&DataKey::Collateral(asset.clone()))
        {
            Some(c) => c,
            None => continue,
        };
        if !config.active {
            continue;
        }
        let price = oracle_get_price(env, &oracle_address(env)?, &config.oracle_asset, None)?;
        let value = protocol_core::mul_precision(amount, price.price)?;
        collateral.push_back(CollateralBalance {
            asset,
            amount,
            value,
            haircut_bps: config.haircut_bps,
        });
    }

    for position in positions.iter() {
        if position.owner != user {
            return Err(CoreError::Unauthorized);
        }
    }
    Ok(protocol_core::AccountSnapshot {
        owner: user,
        collateral,
        positions,
    })
}

fn load_markets_for_positions(
    env: &Env,
    positions: &Vec<Position>,
) -> Result<Map<u32, MarketSnapshot>, CoreError> {
    let mut markets = Map::new(env);
    for position in positions.iter() {
        if markets.contains_key(position.market_id) {
            continue;
        }
        let config: MarketConfig = env
            .storage()
            .persistent()
            .get(&DataKey::MarketConfig(position.market_id))
            .ok_or(CoreError::InvalidConfig)?;
        let guard = OracleGuard {
            max_age_secs: config.max_oracle_age_secs,
            max_confidence_bps: config.max_oracle_confidence_bps,
        };
        let oracle_price =
            oracle_get_price(env, &oracle_address(env)?, &config.base_asset, Some(guard))?.price;
        let funding_index_long = env
            .storage()
            .persistent()
            .get(&DataKey::FundingLong(config.market_id))
            .unwrap_or(0);
        let funding_index_short = env
            .storage()
            .persistent()
            .get(&DataKey::FundingShort(config.market_id))
            .unwrap_or(0);
        markets.set(
            config.market_id,
            MarketSnapshot {
                config,
                oracle_price,
                funding_index_long,
                funding_index_short,
            },
        );
    }
    Ok(markets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use perp_oracle_adapter::{OracleAdapterContract, OracleAdapterContractClient};
    use protocol_core::{MarginMode, OracleSource, PRECISION};
    use soroban_sdk::{testutils::Address as _, token, Address, Env, Symbol, Vec};

    fn setup(
        env: &Env,
    ) -> (
        Address,
        Address,
        Address,
        Address,
        Address,
        PerpVaultContractClient<'_>,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let user = Address::generate(env);
        let engine = Address::generate(env);
        let publisher = Address::generate(env);
        let settlement_admin = Address::generate(env);
        let token_contract = env.register_stellar_asset_contract_v2(settlement_admin.clone());
        let settlement_asset = token_contract.address();
        token::StellarAssetClient::new(env, &settlement_asset).mint(&user, &(1_000 * PRECISION));

        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(env, &oracle_id);
        oracle.initialize(&admin);
        oracle.set_feed(
            &Symbol::new(env, "USDC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.set_feed(
            &Symbol::new(env, "BTC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.write_price(
            &Symbol::new(env, "USDC"),
            &publisher,
            &PRECISION,
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );
        oracle.write_price(
            &Symbol::new(env, "BTC"),
            &publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );

        let vault_id = env.register(PerpVaultContract, ());
        let vault = PerpVaultContractClient::new(env, &vault_id);
        vault.initialize(&admin, &oracle_id, &engine);
        vault.set_collateral(&settlement_asset, &Symbol::new(env, "USDC"), &0, &true);
        vault.set_market_config(&MarketConfig {
            market_id: 1,
            base_asset: Symbol::new(env, "BTC"),
            settlement_asset: settlement_asset.clone(),
            max_leverage_bps: 100_000,
            initial_margin_bps: 1_000,
            maintenance_margin_bps: 500,
            liquidation_fee_bps: 50,
            max_open_interest: 10_000 * PRECISION,
            max_oracle_age_secs: 60,
            max_oracle_confidence_bps: 100,
            active: true,
        });

        (user, engine, publisher, settlement_asset, oracle_id, vault)
    }

    #[test]
    fn deposit_increases_internal_balance_after_token_transfer() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);

        assert_eq!(
            vault.deposit(&user, &settlement_asset, &(100 * PRECISION)),
            100 * PRECISION
        );
        assert_eq!(vault.balance_of(&user, &settlement_asset), 100 * PRECISION);
    }

    #[test]
    fn withdraw_rejects_unrealized_loss_even_with_token_balance() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        vault.deposit(&user, &settlement_asset, &(1_000 * PRECISION));

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
                mode: MarginMode::Cross,
            }],
        );
        vault.sync_positions(&user, &positions);

        let result = vault.try_withdraw(&user, &settlement_asset, &(100 * PRECISION));
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
    }

    #[test]
    fn synced_positions_must_belong_to_account_owner() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let other_user = Address::generate(&env);
        let positions = Vec::from_array(
            &env,
            [Position {
                position_id: 1,
                owner: other_user,
                market_id: 1,
                size: PRECISION,
                entry_price: 100 * PRECISION,
                margin: 10 * PRECISION,
                is_long: true,
                last_funding_index: 0,
                mode: MarginMode::Cross,
            }],
        );
        let result = vault.try_sync_positions(&user, &positions);
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
        assert_eq!(vault.balance_of(&user, &settlement_asset), 0);
    }

    // --- H4 pause tests ---

    #[test]
    fn paused_vault_rejects_deposit() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let admin = vault.admin().unwrap();
        vault.emergency_pause(&admin);
        assert!(vault.is_paused());
        let result = vault.try_deposit(&user, &settlement_asset, &(100 * PRECISION));
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
    }

    #[test]
    fn paused_vault_rejects_withdraw() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        // deposit before pause
        vault.deposit(&user, &settlement_asset, &(100 * PRECISION));
        let admin = vault.admin().unwrap();
        vault.emergency_pause(&admin);
        let result = vault.try_withdraw(&user, &settlement_asset, &(50 * PRECISION));
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
    }

    #[test]
    fn unpause_restores_deposit() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let admin = vault.admin().unwrap();
        vault.emergency_pause(&admin);
        assert!(vault.is_paused());
        vault.unpause();
        assert!(!vault.is_paused());
        // deposit should succeed after unpause
        assert_eq!(
            vault.deposit(&user, &settlement_asset, &(100 * PRECISION)),
            100 * PRECISION
        );
    }

    // --- Guardian fast-path pause ---

    #[test]
    fn guardian_can_pause_but_not_unpause_and_stranger_cannot_pause() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let guardian = Address::generate(&env);
        let stranger = Address::generate(&env);
        vault.set_guardian(&guardian);

        // A random address may not pause even with its auth mocked.
        assert!(vault.try_emergency_pause(&stranger).is_err());
        assert!(!vault.is_paused());

        // The guardian pauses instantly.
        vault.emergency_pause(&guardian);
        assert!(vault.is_paused());
        assert!(vault
            .try_deposit(&user, &settlement_asset, &(10 * PRECISION))
            .is_err());

        // Only the admin can unpause (guardian compromise cannot restart).
        vault.unpause();
        assert!(!vault.is_paused());
    }

    // --- Staged-launch deposit cap ---

    #[test]
    fn deposit_cap_blocks_over_cap_and_withdraw_frees_headroom() {
        let env = Env::default();
        let (user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);

        vault.set_deposit_cap(&settlement_asset, &(100 * PRECISION));
        assert_eq!(vault.deposit_cap(&settlement_asset), Some(100 * PRECISION));

        vault.deposit(&user, &settlement_asset, &(80 * PRECISION));
        assert_eq!(vault.total_deposited(&settlement_asset), 80 * PRECISION);

        // 80 + 30 > 100 → rejected; headroom-sized deposit passes.
        assert!(vault
            .try_deposit(&user, &settlement_asset, &(30 * PRECISION))
            .is_err());
        vault.deposit(&user, &settlement_asset, &(20 * PRECISION));
        assert_eq!(vault.total_deposited(&settlement_asset), 100 * PRECISION);

        // Withdrawals free capacity.
        vault.withdraw(&user, &settlement_asset, &(50 * PRECISION));
        assert_eq!(vault.total_deposited(&settlement_asset), 50 * PRECISION);
        vault.deposit(&user, &settlement_asset, &(50 * PRECISION));

        // Removing the cap lifts the limit entirely.
        vault.set_deposit_cap(&settlement_asset, &0);
        assert_eq!(vault.deposit_cap(&settlement_asset), None);
        vault.deposit(&user, &settlement_asset, &(500 * PRECISION));
    }

    // --- H6 multi-collateral test ---

    #[test]
    fn multi_collateral_health_includes_all_assets() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let engine = Address::generate(&env);
        let publisher = Address::generate(&env);

        // Create two separate token contracts: one for USDC, one for BTC
        let usdc_admin = Address::generate(&env);
        let btc_admin = Address::generate(&env);
        let usdc_contract = env.register_stellar_asset_contract_v2(usdc_admin.clone());
        let btc_contract = env.register_stellar_asset_contract_v2(btc_admin.clone());
        let usdc_asset = usdc_contract.address();
        let btc_asset = btc_contract.address();

        // Mint tokens to user
        token::StellarAssetClient::new(&env, &usdc_asset).mint(&user, &(1_000 * PRECISION));
        token::StellarAssetClient::new(&env, &btc_asset).mint(&user, &(10 * PRECISION));

        // Set up oracle with prices for USDC and BTC
        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);
        oracle.initialize(&admin);
        oracle.set_feed(
            &Symbol::new(&env, "USDC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        oracle.set_feed(
            &Symbol::new(&env, "BTC"),
            &publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        // USDC = $1, BTC = $10 (using PRECISION scale)
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
            &(10 * PRECISION),
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );

        // Initialize vault with both collateral types
        let vault_id = env.register(PerpVaultContract, ());
        let vault = PerpVaultContractClient::new(&env, &vault_id);
        vault.initialize(&admin, &oracle_id, &engine);
        vault.set_collateral(&usdc_asset, &Symbol::new(&env, "USDC"), &0, &true);
        vault.set_collateral(&btc_asset, &Symbol::new(&env, "BTC"), &0, &true);

        // Deposit both assets
        let usdc_deposit = 100 * PRECISION;
        let btc_deposit = 2 * PRECISION;
        vault.deposit(&user, &usdc_asset, &usdc_deposit);
        vault.deposit(&user, &btc_asset, &btc_deposit);

        // account_health called with USDC address should include BTC value too
        let health = vault.account_health(&user, &usdc_asset);

        // USDC value: 100 * PRECISION * PRECISION / PRECISION = 100 * PRECISION
        // BTC value:   2 * PRECISION * 10 * PRECISION / PRECISION = 20 * PRECISION
        // Total equity (no positions) = 120 * PRECISION
        assert_eq!(health.equity, 120 * PRECISION);
    }

    // --- seize_for_deficit: non-settlement collateral must pay for losses ---

    fn setup_seize(
        env: &Env,
        btc_haircut_bps: u32,
    ) -> (
        Address,
        Address,
        Address,
        Address,
        PerpVaultContractClient<'_>,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let user = Address::generate(env);
        let engine = Address::generate(env);
        let liquidation = Address::generate(env);
        let publisher = Address::generate(env);

        let usdc = env
            .register_stellar_asset_contract_v2(Address::generate(env))
            .address();
        let btc = env
            .register_stellar_asset_contract_v2(Address::generate(env))
            .address();
        token::StellarAssetClient::new(env, &btc).mint(&user, &(10 * PRECISION));

        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(env, &oracle_id);
        oracle.initialize(&admin);
        for asset in [Symbol::new(env, "USDC"), Symbol::new(env, "BTC")] {
            oracle.set_feed(
                &asset,
                &publisher,
                &OracleSource::Reflector,
                &OracleGuard {
                    max_age_secs: 60,
                    max_confidence_bps: 100,
                },
                &true,
            );
        }
        oracle.write_price(
            &Symbol::new(env, "USDC"),
            &publisher,
            &PRECISION,
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );
        oracle.write_price(
            &Symbol::new(env, "BTC"),
            &publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &env.ledger().timestamp(),
        );

        let vault_id = env.register(PerpVaultContract, ());
        let vault = PerpVaultContractClient::new(env, &vault_id);
        vault.initialize(&admin, &oracle_id, &engine);
        vault.set_liquidation(&liquidation);
        vault.set_collateral(&usdc, &Symbol::new(env, "USDC"), &0, &true);
        vault.set_collateral(&btc, &Symbol::new(env, "BTC"), &btc_haircut_bps, &true);

        (user, usdc, btc, liquidation, vault)
    }

    #[test]
    fn seize_for_deficit_covers_settlement_debit_from_other_collateral() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);

        // Trader is margined entirely in BTC: 2 BTC @ $10 = $20 of collateral.
        vault.deposit(&user, &btc, &(2 * PRECISION));
        // A $10 loss debits the settlement asset they never deposited.
        vault.apply_pnl(&user, &usdc, &(-10 * PRECISION));
        assert_eq!(vault.balance_of(&user, &usdc), -10 * PRECISION);

        let credited = vault.seize_for_deficit(&user, &usdc);

        // $10 of debt at $10/BTC with no haircut = exactly 1 BTC seized.
        assert_eq!(credited, 10 * PRECISION);
        assert_eq!(vault.balance_of(&user, &usdc), 0);
        assert_eq!(vault.balance_of(&user, &btc), PRECISION);
    }

    #[test]
    fn seize_for_deficit_prices_collateral_after_haircut() {
        let env = Env::default();
        // 50% haircut: BTC is worth half its oracle price as margin, so covering
        // the same debt must consume twice as many units.
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 5_000);

        vault.deposit(&user, &btc, &(2 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(-10 * PRECISION));

        let credited = vault.seize_for_deficit(&user, &usdc);

        // 2 BTC * $10 * (1 - 0.5) = $10 of usable value — all of it consumed.
        assert_eq!(credited, 10 * PRECISION);
        assert_eq!(vault.balance_of(&user, &usdc), 0);
        assert_eq!(vault.balance_of(&user, &btc), 0);
    }

    #[test]
    fn seize_for_deficit_leaves_uncovered_remainder_for_insurance() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);

        // Only $10 of collateral against a $25 loss — genuinely undercollateralised.
        vault.deposit(&user, &btc, &PRECISION);
        vault.apply_pnl(&user, &usdc, &(-25 * PRECISION));

        let credited = vault.seize_for_deficit(&user, &usdc);

        assert_eq!(credited, 10 * PRECISION);
        assert_eq!(vault.balance_of(&user, &btc), 0);
        // The $15 that collateral could not cover stays negative, so
        // absorb_bad_debt still draws exactly that much from insurance.
        assert_eq!(vault.balance_of(&user, &usdc), -15 * PRECISION);
    }

    #[test]
    fn seize_for_deficit_never_takes_more_than_the_deficit() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);

        vault.deposit(&user, &btc, &(5 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(-PRECISION));

        let credited = vault.seize_for_deficit(&user, &usdc);

        assert_eq!(credited, PRECISION);
        // Balance lands exactly at zero, never positive — seizure settles debt,
        // it does not fund the account.
        assert_eq!(vault.balance_of(&user, &usdc), 0);
        // $1 of debt at $10/BTC = 0.1 BTC taken out of 5.
        assert_eq!(vault.balance_of(&user, &btc), 49 * PRECISION / 10);
    }

    #[test]
    fn seize_for_deficit_is_a_noop_for_solvent_accounts() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);

        vault.deposit(&user, &btc, &(2 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(5 * PRECISION));

        assert_eq!(vault.seize_for_deficit(&user, &usdc), 0);
        assert_eq!(vault.balance_of(&user, &btc), 2 * PRECISION);
        assert_eq!(vault.balance_of(&user, &usdc), 5 * PRECISION);
    }

    #[test]
    fn seize_for_deficit_takes_lowest_haircut_collateral_first() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 5_000);

        // A second stable, listed at a 0% haircut — deposited AFTER btc, so
        // insertion order alone would pick btc first.
        let stbl = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        token::StellarAssetClient::new(&env, &stbl).mint(&user, &(100 * PRECISION));
        vault.set_collateral(&stbl, &Symbol::new(&env, "USDC"), &0, &true);

        vault.deposit(&user, &btc, &(2 * PRECISION));
        vault.deposit(&user, &stbl, &(50 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(-10 * PRECISION));

        vault.seize_for_deficit(&user, &usdc);

        // The liquid, un-haircut collateral pays; the volatile position is untouched.
        assert_eq!(vault.balance_of(&user, &stbl), 40 * PRECISION);
        assert_eq!(vault.balance_of(&user, &btc), 2 * PRECISION);
        assert_eq!(vault.balance_of(&user, &usdc), 0);
    }

    #[test]
    fn seize_for_deficit_skips_delisted_collateral() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);

        vault.deposit(&user, &btc, &(2 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(-10 * PRECISION));
        // De-listing drops the asset out of equity, so it must not back debt
        // either — otherwise seizure would settle value health never counted.
        vault.set_collateral(&btc, &Symbol::new(&env, "BTC"), &0, &false);

        assert_eq!(vault.seize_for_deficit(&user, &usdc), 0);
        assert_eq!(vault.balance_of(&user, &btc), 2 * PRECISION);
        assert_eq!(vault.balance_of(&user, &usdc), -10 * PRECISION);
    }

    #[test]
    fn upgrade_rejects_callers_without_admin_auth() {
        let env = Env::default();
        let (_user, _usdc, _btc, _liq, vault) = setup_seize(&env, 0);
        // Drop the blanket auth mock: with no authorisation attached, the admin
        // gate must reject the upgrade. This is the only thing standing between
        // a leaked key and arbitrary code in the vault, so it gets a test.
        env.set_auths(&[]);
        let result = vault.try_upgrade(&BytesN::from_array(&env, &[0u8; 32]));
        assert!(result.is_err());
    }

    #[test]
    fn settle_deficit_lets_the_owner_clear_their_own_debit() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);
        vault.deposit(&user, &btc, &(2 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(-10 * PRECISION));

        // No liquidation involved: the trader settles the debit themselves.
        assert_eq!(vault.settle_deficit(&user, &user, &usdc), 10 * PRECISION);
        assert_eq!(vault.balance_of(&user, &usdc), 0);
        assert_eq!(vault.balance_of(&user, &btc), PRECISION);
    }

    #[test]
    fn settle_deficit_lets_the_operator_clear_a_debit() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);
        let operator = Address::generate(&env);
        vault.set_operator(&operator);
        assert_eq!(vault.operator(), Some(operator.clone()));

        vault.deposit(&user, &btc, &(2 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(-10 * PRECISION));

        assert_eq!(
            vault.settle_deficit(&operator, &user, &usdc),
            10 * PRECISION
        );
        assert_eq!(vault.balance_of(&user, &usdc), 0);
    }

    #[test]
    fn settle_deficit_rejects_a_stranger() {
        let env = Env::default();
        let (user, usdc, btc, _liq, vault) = setup_seize(&env, 0);
        vault.set_operator(&Address::generate(&env));
        vault.deposit(&user, &btc, &(2 * PRECISION));
        vault.apply_pnl(&user, &usdc, &(-10 * PRECISION));

        // Seizure converts collateral at a haircut, so a third party must not be
        // able to force it on someone who would rather deposit to clear the debit.
        let stranger = Address::generate(&env);
        let result = vault.try_settle_deficit(&stranger, &user, &usdc);
        assert!(match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        });
        assert_eq!(vault.balance_of(&user, &btc), 2 * PRECISION);
        assert_eq!(vault.balance_of(&user, &usdc), -10 * PRECISION);
    }

    #[test]
    fn migrate_import_balances_credits_the_ledger_and_updates_total_deposited() {
        let env = Env::default();
        let (_user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        let imported = vault.migrate_import_balances(&Vec::from_array(
            &env,
            [
                MigratedBalance {
                    user: alice.clone(),
                    asset: settlement_asset.clone(),
                    amount: 500 * PRECISION,
                },
                MigratedBalance {
                    user: bob.clone(),
                    asset: settlement_asset.clone(),
                    amount: 250 * PRECISION,
                },
            ],
        ));

        assert_eq!(imported, 2);
        assert_eq!(vault.balance_of(&alice, &settlement_asset), 500 * PRECISION);
        assert_eq!(vault.balance_of(&bob, &settlement_asset), 250 * PRECISION);
        assert_eq!(vault.total_deposited(&settlement_asset), 750 * PRECISION);
    }

    #[test]
    fn migration_cannot_run_again_once_sealed() {
        let env = Env::default();
        let (_user, _engine, _publisher, settlement_asset, _oracle_id, vault) = setup(&env);
        let alice = Address::generate(&env);

        vault.migrate_import_balances(&Vec::from_array(
            &env,
            [MigratedBalance {
                user: alice.clone(),
                asset: settlement_asset.clone(),
                amount: 100 * PRECISION,
            }],
        ));
        assert!(!vault.migration_sealed());
        vault.seal_migration();
        assert!(vault.migration_sealed());

        let result = vault.try_migrate_import_balances(&Vec::from_array(
            &env,
            [MigratedBalance {
                user: alice,
                asset: settlement_asset,
                amount: 999 * PRECISION,
            }],
        ));
        assert_eq!(result, Err(Ok(CoreError::AlreadyInitialized)));
    }
}
