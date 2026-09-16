#![no_std]
#![deny(unsafe_code)]
//! Advisory risk views. **Never** a source of truth for moving value.
//!
//! Every entrypoint here takes the `AccountSnapshot` as a CALLER-SUPPLIED
//! ARGUMENT. The contract does not read the vault's balances or the engine's
//! positions; it computes over whatever the caller hands it. Anyone can
//! therefore obtain a "healthy" answer for an account that is deeply
//! underwater, simply by describing a different account.
//!
//! That is fine for what this is — a calculator that front-ends and keepers can
//! use to preview a hypothetical — and catastrophic if anything ever gates a
//! withdrawal, a trade or a liquidation on its output. The authoritative health
//! computation is `perp-vault::account_health`, which reads the vault's own
//! stored balances and positions and cannot be fed a fiction.
//!
//! Two further reasons not to wire this in:
//!
//! - `set_market` stores a `MarketSnapshot` with an `oracle_price` frozen at
//!   the moment it was written. Nothing refreshes it, so its answers drift from
//!   the market with no staleness guard to stop them.
//! - It has never been configured on any network. `set_market` was never called
//!   for a single market on testnet or mainnet, so in practice every entrypoint
//!   returns `InvalidConfig` today (see the note in `client/scripts/add-market.ts`).
//!
//! The one genuinely valuable thing in here is `plan_liquidation`, which sizes a
//! partial liquidation to the minimum that restores health. That logic is now
//! mirrored in the liquidation keeper, where it can act on authoritative data.

use protocol_core::{AccountSnapshot, CoreError, MarketSnapshot};
use risk_engine::{
    account_health, plan_liquidation, validate_withdrawal, AccountHealth, LiquidationPlan,
};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Market(u32),
}

#[contract]
pub struct PerpRiskContract;

#[contractimpl]
impl PerpRiskContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            // Every other contract in the protocol reports this as
            // AlreadyInitialized; reporting InvalidConfig here sent a redeploy
            // script looking for a bad argument instead of an existing install.
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
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

    pub fn set_market(env: Env, market: MarketSnapshot) -> Result<(), CoreError> {
        require_admin(&env)?;
        if market.config.market_id == 0 || market.oracle_price <= 0 {
            return Err(CoreError::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Market(market.config.market_id), &market);
        Ok(())
    }

    /// Health for a caller-supplied snapshot. Advisory only — see the module
    /// docs. Do not gate value movement on this; use `perp-vault::account_health`.
    pub fn get_account_health(
        env: Env,
        account: AccountSnapshot,
    ) -> Result<AccountHealth, CoreError> {
        let markets = load_markets_for_account(&env, &account)?;
        account_health(&env, &account, &markets)
    }

    pub fn validate_withdraw(
        env: Env,
        account: AccountSnapshot,
        withdrawal_value: i128,
    ) -> Result<AccountHealth, CoreError> {
        let markets = load_markets_for_account(&env, &account)?;
        validate_withdrawal(&env, &account, &markets, withdrawal_value)
    }

    pub fn liquidation_plan(
        env: Env,
        account: AccountSnapshot,
        position_id: u64,
        partial_liquidation_bps: u32,
    ) -> Result<LiquidationPlan, CoreError> {
        let markets = load_markets_for_account(&env, &account)?;
        plan_liquidation(
            &env,
            &account,
            &markets,
            position_id,
            partial_liquidation_bps,
        )
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

fn load_markets_for_account(
    env: &Env,
    account: &AccountSnapshot,
) -> Result<Map<u32, MarketSnapshot>, CoreError> {
    let mut out = Map::new(env);
    for position in account.positions.iter() {
        if out.contains_key(position.market_id) {
            continue;
        }
        let market = env
            .storage()
            .persistent()
            .get(&DataKey::Market(position.market_id))
            .ok_or(CoreError::InvalidConfig)?;
        out.set(position.market_id, market);
    }
    Ok(out)
}
