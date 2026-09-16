#![no_std]
#![deny(unsafe_code)]

use protocol_core::{apply_bps, mul_div, signed_position_pnl, CoreError, Position};
use risk_engine::AccountHealth;
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Engine,
    Vault,
    Insurance,
    SettlementAsset,
    MaxRewardBps,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationReceipt {
    pub user: Address,
    pub liquidator: Address,
    pub position_id: u64,
    pub close_size: i128,
    pub realized_pnl: i128,
    pub reward: i128,
    pub health_before: AccountHealth,
    pub health_after: AccountHealth,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdlReceipt {
    pub counterparty: Address,
    pub keeper: Address,
    pub position_id: u64,
    pub close_size: i128,
    pub realized_pnl: i128,
    pub bad_debt_before: i128,
    pub bad_debt_after: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTradeResult {
    pub position_id: u64,
    pub remaining_size: i128,
    pub entry_price: i128,
    pub realized_pnl: i128,
    pub funding_pnl: i128,
    pub execution_price: i128,
    pub account_equity: i128,
}

#[contract]
pub struct PerpLiquidationContract;

#[contractimpl]
impl PerpLiquidationContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        engine: Address,
        vault: Address,
        insurance: Address,
        settlement_asset: Address,
        max_reward_bps: u32,
    ) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        if max_reward_bps > 1_000 {
            return Err(CoreError::InvalidConfig);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Engine, &engine);
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.storage()
            .instance()
            .set(&DataKey::Insurance, &insurance);
        env.storage()
            .instance()
            .set(&DataKey::SettlementAsset, &settlement_asset);
        env.storage()
            .instance()
            .set(&DataKey::MaxRewardBps, &max_reward_bps);
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

    /// Re-point dependencies after a redeploy. Without these, redeploying the
    /// vault/engine/insurance would strand the liquidation contract on dead
    /// addresses (the values are otherwise only set at `initialize`).
    pub fn set_engine(env: Env, engine: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Engine, &engine);
        Ok(())
    }

    pub fn set_vault(env: Env, vault: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Vault, &vault);
        Ok(())
    }

    pub fn set_insurance(env: Env, insurance: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Insurance, &insurance);
        Ok(())
    }

    /// The liquidator's reward, in bps of the closed notional.
    ///
    /// Readable because it is the entire economic case for liquidating. A
    /// testnet drill found this set to 0 on a live deployment: liquidations
    /// succeeded, closed the position correctly, and paid the liquidator
    /// nothing. No rational keeper runs at a loss, so liquidation would simply
    /// never have happened — and with no reader, nothing could tell you that
    /// from outside.
    pub fn max_reward_bps(env: Env) -> Option<u32> {
        env.storage().instance().get(&DataKey::MaxRewardBps)
    }

    /// Retune the liquidator reward.
    ///
    /// Previously this could only be set at `initialize`, so a deployment that
    /// launched with the wrong value — including 0, which disables liquidation
    /// economics entirely — could never correct it without redeploying the
    /// contract and rewiring every peer. Capped at the same 1_000 bps that
    /// `initialize` enforces, so this cannot become a drain on the insurance
    /// fund.
    pub fn set_max_reward_bps(env: Env, max_reward_bps: u32) -> Result<(), CoreError> {
        require_admin(&env)?;
        if max_reward_bps > 1_000 {
            return Err(CoreError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxRewardBps, &max_reward_bps);
        Ok(())
    }

    pub fn liquidate(
        env: Env,
        liquidator: Address,
        user: Address,
        position_id: u64,
        close_size: i128,
        execution_price: i128,
    ) -> Result<LiquidationReceipt, CoreError> {
        liquidator.require_auth();
        if liquidator == user {
            return Err(CoreError::Unauthorized);
        }
        if close_size <= 0 || execution_price <= 0 {
            return Err(CoreError::InvalidAmount);
        }

        let settlement_asset = settlement_asset(&env)?;
        let health_before = vault_health(&env, &user)?;
        if !health_before.liquidatable {
            return Err(CoreError::NotLiquidatable);
        }

        let trade = engine_liquidate_reduce(&env, &user, position_id, close_size, execution_price)?;
        let health_after = vault_health(&env, &user)?;
        let improved = if health_before.equity > 0 && health_after.equity > 0 {
            health_after.margin_ratio > health_before.margin_ratio
        } else {
            health_after.maintenance_margin_required < health_before.maintenance_margin_required
        };
        if !improved {
            return Err(CoreError::LiquidationWouldNotImproveHealth);
        }

        let reward = liquidation_reward(&env, close_size, execution_price)?;
        if reward > 0 {
            insurance_pay_liquidator(&env, &liquidator, &settlement_asset, reward)?;
        }
        // Restore solvency. Order matters: the account's own collateral must be
        // exhausted before the insurance fund is touched, or a trader margined in
        // a non-settlement asset socialises losses they are fully collateralised
        // for. `seize_for_deficit` reassigns their other collateral at haircut
        // value; only the remainder becomes a claim on insurance and, past that,
        // recorded bad debt.
        // Seizure is NOT gated on health. The vault has already paid the winning
        // counterparty in the settlement asset, so any settlement debit is a real
        // reserve shortfall even when the account's total equity is comfortably
        // positive — a trader margined in USDT0 would otherwise sit on a permanent
        // negative USDC balance backed by USDT0 the vault cannot spend.
        vault_seize_for_deficit(&env, &user, &settlement_asset)?;
        // Insurance is the last resort, and only for a truly underwater account.
        if health_after.equity < 0 {
            vault_absorb_bad_debt(&env, &user, &settlement_asset)?;
        }

        Ok(LiquidationReceipt {
            user,
            liquidator,
            position_id,
            close_size,
            realized_pnl: trade.realized_pnl,
            reward,
            health_before,
            health_after,
        })
    }

    /// Auto-deleveraging: force-close part of an in-profit counterparty's
    /// position to pay down insurance's recorded bad debt.
    ///
    /// KRY-Q4. `liquidate` closes only the distressed side — the winning
    /// counterparty is never looked up, so the insurance fund is the
    /// protocol's implicit counterparty of last resort. `set_oi_policy`
    /// bounds how much NEW risk the fund can be exposed to, but does nothing
    /// once a shortfall has already happened. Positions are stored only per
    /// account (no global index), so there is no way to verify on-chain that
    /// `counterparty` is the globally "best" (most profitable, most levered)
    /// target — the two checks below are what CAN be verified per-position,
    /// without needing one:
    ///
    ///   1. `counterparty`'s position must be in profit at `execution_price`
    ///      right now. ADL can only ever take from a winner, never touch an
    ///      account with nothing to give.
    ///   2. The close size is capped so the realized pnl paid out can never
    ///      exceed the fund's actual recorded shortfall — a wrong or
    ///      malicious keeper target costs at most one bounded call, not a
    ///      drain on a healthy account.
    ///
    /// Callable by anyone, like `liquidate` — the safety comes from the two
    /// on-chain checks above, not from restricting who may call. Refused
    /// entirely while there is no recorded bad debt: this is a response to an
    /// already-materialised shortfall, not a speculative risk control.
    pub fn adl(
        env: Env,
        keeper: Address,
        counterparty: Address,
        position_id: u64,
        close_size: i128,
        execution_price: i128,
    ) -> Result<AdlReceipt, CoreError> {
        keeper.require_auth();
        if close_size <= 0 || execution_price <= 0 {
            return Err(CoreError::InvalidAmount);
        }

        let settlement_asset = settlement_asset(&env)?;
        let bad_debt_before = insurance_bad_debt_of(&env, &settlement_asset)?;
        if bad_debt_before <= 0 {
            return Err(CoreError::NoBadDebtToOffset);
        }

        let position = engine_find_position(&env, &counterparty, position_id)?;
        let unrealized_pnl = signed_position_pnl(&position, execution_price)?;
        if unrealized_pnl <= 0 {
            return Err(CoreError::PositionNotInProfit);
        }

        // Cap the close size at what the current shortfall can actually
        // absorb, so ADL never pays out more than the fund is short by —
        // whatever the keeper requested or however large the position is.
        // Pnl scales with size * (price - entry), not size * price, so the
        // cap has to go through the position's own per-unit pnl rather than
        // the raw execution price.
        let max_size_for_bad_debt = mul_div(bad_debt_before, position.size, unrealized_pnl)?;
        let effective_close_size = close_size.min(position.size).min(max_size_for_bad_debt);
        if effective_close_size <= 0 {
            return Err(CoreError::NoBadDebtToOffset);
        }

        let trade = engine_liquidate_reduce(
            &env,
            &counterparty,
            position_id,
            effective_close_size,
            execution_price,
        )?;

        // The realized gain just credited to the counterparty is exactly the
        // amount of previously-PENDING shortfall that has now been PAID —
        // clear it here so it is not counted both as recorded bad debt and as
        // a real credit sitting in the counterparty's vault balance.
        let offset = trade.realized_pnl.max(0).min(bad_debt_before);
        let bad_debt_after = if offset > 0 {
            insurance_reduce_bad_debt(&env, &settlement_asset, offset)?
        } else {
            bad_debt_before
        };

        Ok(AdlReceipt {
            counterparty,
            keeper,
            position_id,
            close_size: effective_close_size,
            realized_pnl: trade.realized_pnl,
            bad_debt_before,
            bad_debt_after,
        })
    }
}

fn engine_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Engine)
        .ok_or(CoreError::InvalidConfig)
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

fn vault_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Vault)
        .ok_or(CoreError::InvalidConfig)
}

fn insurance_address(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::Insurance)
        .ok_or(CoreError::InvalidConfig)
}

fn settlement_asset(env: &Env) -> Result<Address, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::SettlementAsset)
        .ok_or(CoreError::InvalidConfig)
}

fn max_reward_bps(env: &Env) -> Result<u32, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::MaxRewardBps)
        .ok_or(CoreError::InvalidConfig)
}

fn vault_health(env: &Env, user: &Address) -> Result<AccountHealth, CoreError> {
    env.invoke_contract::<Result<AccountHealth, CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "account_health"),
        vec![
            env,
            user.into_val(env),
            settlement_asset(env)?.into_val(env),
        ],
    )
}

fn liquidation_reward(
    env: &Env,
    close_size: i128,
    execution_price: i128,
) -> Result<i128, CoreError> {
    let notional = protocol_core::mul_precision(close_size, execution_price)?;
    apply_bps(notional, max_reward_bps(env)?)
}

fn engine_liquidate_reduce(
    env: &Env,
    user: &Address,
    position_id: u64,
    close_size: i128,
    execution_price: i128,
) -> Result<EngineTradeResult, CoreError> {
    env.invoke_contract::<Result<EngineTradeResult, CoreError>>(
        &engine_address(env)?,
        &Symbol::new(env, "liquidate_reduce"),
        vec![
            env,
            user.into_val(env),
            position_id.into_val(env),
            close_size.into_val(env),
            execution_price.into_val(env),
        ],
    )
}

fn engine_positions(env: &Env, user: &Address) -> Result<Vec<Position>, CoreError> {
    Ok(env.invoke_contract::<Vec<Position>>(
        &engine_address(env)?,
        &Symbol::new(env, "positions"),
        vec![env, user.into_val(env)],
    ))
}

fn engine_find_position(
    env: &Env,
    user: &Address,
    position_id: u64,
) -> Result<Position, CoreError> {
    engine_positions(env, user)?
        .iter()
        .find(|p| p.position_id == position_id)
        .ok_or(CoreError::PositionNotFound)
}

fn insurance_pay_liquidator(
    env: &Env,
    liquidator: &Address,
    asset: &Address,
    amount: i128,
) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &insurance_address(env)?,
        &Symbol::new(env, "pay_liquidator"),
        vec![
            env,
            liquidator.into_val(env),
            asset.into_val(env),
            amount.into_val(env),
        ],
    )
}

fn insurance_bad_debt_of(env: &Env, asset: &Address) -> Result<i128, CoreError> {
    Ok(env.invoke_contract::<i128>(
        &insurance_address(env)?,
        &Symbol::new(env, "bad_debt_of"),
        vec![env, asset.into_val(env)],
    ))
}

fn insurance_reduce_bad_debt(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &insurance_address(env)?,
        &Symbol::new(env, "reduce_bad_debt"),
        vec![env, asset.into_val(env), amount.into_val(env)],
    )
}

fn vault_seize_for_deficit(env: &Env, user: &Address, asset: &Address) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "seize_for_deficit"),
        vec![env, user.into_val(env), asset.into_val(env)],
    )
}

fn vault_absorb_bad_debt(env: &Env, user: &Address, asset: &Address) -> Result<i128, CoreError> {
    env.invoke_contract::<Result<i128, CoreError>>(
        &vault_address(env)?,
        &Symbol::new(env, "absorb_bad_debt"),
        vec![env, user.into_val(env), asset.into_val(env)],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use perp_engine::{EngineMarketConfig, PerpEngineContract, PerpEngineContractClient};
    use perp_insurance::{PerpInsuranceContract, PerpInsuranceContractClient};
    use perp_oracle_adapter::{OracleAdapterContract, OracleAdapterContractClient};
    use perp_vault::{PerpVaultContract, PerpVaultContractClient};
    use protocol_core::{MarginMode, MarketConfig, OracleGuard, OracleSource, PRECISION};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, Env, Symbol,
    };

    struct Setup<'a> {
        env: Env,
        user: Address,
        liquidator: Address,
        publisher: Address,
        settlement_asset: Address,
        oracle: OracleAdapterContractClient<'a>,
        vault: PerpVaultContractClient<'a>,
        engine: PerpEngineContractClient<'a>,
        insurance: PerpInsuranceContractClient<'a>,
        liquidation: PerpLiquidationContractClient<'a>,
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let liquidator = Address::generate(&env);
        let publisher = Address::generate(&env);
        let settlement_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(settlement_admin.clone());
        let settlement_asset = token_contract.address();
        token::StellarAssetClient::new(&env, &settlement_asset).mint(&user, &(10_000 * PRECISION));
        token::StellarAssetClient::new(&env, &settlement_asset).mint(&admin, &(10_000 * PRECISION));

        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);
        oracle.initialize(&admin);
        for asset in [Symbol::new(&env, "USDC"), Symbol::new(&env, "BTC")] {
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
        let insurance_id = env.register(PerpInsuranceContract, ());
        let liquidation_id = env.register(PerpLiquidationContract, ());

        let vault = PerpVaultContractClient::new(&env, &vault_id);
        let engine = PerpEngineContractClient::new(&env, &engine_id);
        let insurance = PerpInsuranceContractClient::new(&env, &insurance_id);
        let liquidation = PerpLiquidationContractClient::new(&env, &liquidation_id);

        vault.initialize(&admin, &oracle_id, &engine_id);
        vault.set_collateral(&settlement_asset, &Symbol::new(&env, "USDC"), &0, &true);
        vault.set_insurance(&insurance_id);
        vault.set_liquidation(&liquidation_id);
        engine.initialize(&admin, &oracle_id, &vault_id, &settlement_asset);
        engine.set_order_gateway(&admin);
        engine.set_liquidation(&liquidation_id);
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
                max_oracle_age_secs: 60,
                max_oracle_confidence_bps: 100,
                active: true,
            },
            max_execution_deviation_bps: 100,
        });
        insurance.initialize(&admin, &liquidation_id);
        insurance.set_vault(&vault_id);
        insurance.deposit(&admin, &settlement_asset, &(1_000 * PRECISION));
        liquidation.initialize(
            &admin,
            &engine_id,
            &vault_id,
            &insurance_id,
            &settlement_asset,
            &50,
        );
        vault.deposit(&user, &settlement_asset, &(1_000 * PRECISION));

        Setup {
            env,
            user,
            liquidator,
            publisher,
            settlement_asset,
            oracle,
            vault,
            engine,
            insurance,
            liquidation,
        }
    }

    #[test]
    fn cannot_liquidate_healthy_account() {
        let s = setup();
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        let result = s.liquidation.try_liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(PRECISION / 2),
            &(100 * PRECISION),
        );
        assert!(result.is_err());
    }

    #[test]
    fn liquidates_unhealthy_account_and_pays_reward() {
        let s = setup();
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(100 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|ledger| {
            ledger.timestamp += 1;
        });
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        let receipt = s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(50 * PRECISION),
            &(10 * PRECISION),
        );
        assert!(receipt.health_before.liquidatable);
        assert!(
            receipt.health_after.maintenance_margin_required
                < receipt.health_before.maintenance_margin_required
        );
        assert_eq!(
            s.engine.positions(&s.user).get(0).unwrap().size,
            50 * PRECISION
        );
        assert_eq!(
            token::Client::new(&s.env, &s.settlement_asset).balance(&s.liquidator),
            receipt.reward
        );
        assert!(s.insurance.balance_of(&s.settlement_asset) < 1_000 * PRECISION);
        assert!(s.vault.account_health(&s.user, &s.settlement_asset).equity < 1_000 * PRECISION);
    }

    // C1 solvency: when liquidation drives a balance negative, the vault must pull
    // real tokens from the insurance fund and credit the account back toward zero.
    #[test]
    fn bad_debt_fully_covered_by_insurance_restores_zero_balance() {
        let s = setup(); // insurance funded with 1_000 * PRECISION
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(20 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|l| l.timestamp += 1);
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        // Full close: realized loss 20*(10-100) = -1800 → balance 1000-1800 = -800.
        s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(20 * PRECISION),
            &(10 * PRECISION),
        );

        // Insurance covered the 800 deficit in full: balance back to 0, no bad debt.
        assert_eq!(s.vault.balance_of(&s.user, &s.settlement_asset), 0);
        assert_eq!(s.insurance.bad_debt_of(&s.settlement_asset), 0);
        // Fund paid the 1*PRECISION reward + 800 deficit out of 1_000.
        assert_eq!(
            s.insurance.balance_of(&s.settlement_asset),
            1_000 * PRECISION - PRECISION - 800 * PRECISION
        );
    }

    // C1 solvency: when the fund cannot fully cover, it is drained and the
    // uncovered remainder is recorded as protocol bad debt.
    #[test]
    fn bad_debt_exceeding_fund_is_partially_covered_and_recorded() {
        let s = setup(); // insurance funded with 1_000 * PRECISION
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(100 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|l| l.timestamp += 1);
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        // Full close: realized -9000 → balance -8000. Reward 5 leaves fund at 995,
        // which fully drains covering 995 of the 8000 deficit.
        s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(100 * PRECISION),
            &(10 * PRECISION),
        );

        assert_eq!(s.insurance.balance_of(&s.settlement_asset), 0);
        assert_eq!(
            s.insurance.bad_debt_of(&s.settlement_asset),
            8_000 * PRECISION - 995 * PRECISION
        );
        assert_eq!(
            s.vault.balance_of(&s.user, &s.settlement_asset),
            -(8_000 * PRECISION) + 995 * PRECISION
        );
    }

    /// Lists a second collateral (the USDT0 case) and moves the trader's entire
    /// margin into it, so they hold zero of the settlement asset.
    fn margin_in_non_settlement_collateral(s: &Setup, haircut_bps: u32) -> Address {
        let usdt0 = s
            .env
            .register_stellar_asset_contract_v2(Address::generate(&s.env))
            .address();
        token::StellarAssetClient::new(&s.env, &usdt0).mint(&s.user, &(10_000 * PRECISION));
        s.oracle.set_feed(
            &Symbol::new(&s.env, "USDT0"),
            &s.publisher,
            &OracleSource::Reflector,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &true,
        );
        s.oracle.write_price(
            &Symbol::new(&s.env, "USDT0"),
            &s.publisher,
            &PRECISION,
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );
        s.vault
            .set_collateral(&usdt0, &Symbol::new(&s.env, "USDT0"), &haircut_bps, &true);

        // setup() funds the trader in the settlement asset — take it back out so
        // the account is margined purely in USDT0.
        s.vault
            .withdraw(&s.user, &s.settlement_asset, &(1_000 * PRECISION));
        assert_eq!(s.vault.balance_of(&s.user, &s.settlement_asset), 0);
        s.vault.deposit(&s.user, &usdt0, &(1_000 * PRECISION));
        usdt0
    }

    // The USDT0 case, fully collateralised: a trader margined entirely in a
    // non-settlement asset takes a loss smaller than their collateral. Their own
    // USDT0 must absorb all of it — the insurance fund should pay the liquidator's
    // reward and nothing more.
    #[test]
    fn non_settlement_collateral_absorbs_loss_without_touching_insurance() {
        let s = setup();
        let usdt0 = margin_in_non_settlement_collateral(&s, 200); // 2% haircut

        // 1_000 USDT0 at a 2% haircut = 980 of usable equity.
        // Notional 9_000 at 10% initial margin = 900 required.
        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(90 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|l| l.timestamp += 1);
        // BTC 100 -> 91: unrealised loss 90 * 9 = 810, well inside the 980 posted.
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(91 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        let receipt = s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(90 * PRECISION),
            &(91 * PRECISION),
        );

        // The 810 loss came out of the trader's USDT0, not the fund.
        assert_eq!(s.insurance.bad_debt_of(&s.settlement_asset), 0);
        assert_eq!(
            s.insurance.balance_of(&s.settlement_asset),
            1_000 * PRECISION - receipt.reward
        );
        // Settlement debit cleared; the un-seized remainder stays the trader's.
        assert_eq!(s.vault.balance_of(&s.user, &s.settlement_asset), 0);
        // 810 of debt / 0.98 = 826.530612244897959183 USDT0 taken (rounded down,
        // in the protocol's favour) out of 1_000 posted.
        assert_eq!(
            s.vault.balance_of(&s.user, &usdt0),
            1_000 * PRECISION - 826_530_612_244_897_959_183
        );
    }

    // The USDT0 case, genuinely underwater: collateral is seized first and the
    // insurance fund covers only the shortfall that remains.
    #[test]
    fn insurance_covers_only_the_shortfall_left_after_seizure() {
        let s = setup();
        let usdt0 = margin_in_non_settlement_collateral(&s, 200);

        let opened = s.engine.open_position(
            &s.user,
            &1,
            &(20 * PRECISION),
            &true,
            &(100 * PRECISION),
            &MarginMode::Cross,
        );
        s.env.ledger().with_mut(|l| l.timestamp += 1);
        // BTC 100 -> 10: realised loss 20 * 90 = 1_800 against 980 of usable
        // collateral, so 820 is real bad debt.
        s.oracle.write_price(
            &Symbol::new(&s.env, "BTC"),
            &s.publisher,
            &(10 * PRECISION),
            &(PRECISION / 100),
            &s.env.ledger().timestamp(),
        );

        let receipt = s.liquidation.liquidate(
            &s.liquidator,
            &s.user,
            &opened.position_id,
            &(20 * PRECISION),
            &(10 * PRECISION),
        );

        // Every unit of USDT0 was taken before insurance was asked for anything.
        assert_eq!(s.vault.balance_of(&s.user, &usdt0), 0);
        // Fund covered 1_800 - 980 = 820, not the full 1_800.
        assert_eq!(
            s.insurance.balance_of(&s.settlement_asset),
            1_000 * PRECISION - receipt.reward - 820 * PRECISION
        );
        assert_eq!(s.vault.balance_of(&s.user, &s.settlement_asset), 0);
        assert_eq!(s.insurance.bad_debt_of(&s.settlement_asset), 0);
    }

    /// KRY-Q4: `liquidate` never touches the winning counterparty, so a
    /// shortfall the fund cannot fully cover just sits as recorded bad debt
    /// forever. These tests cover `adl`, the mechanism that pays it down by
    /// force-closing part of an in-profit counterparty's position instead.
    mod adl {
        use super::*;

        /// Deposits, opens a short on market 1, and returns the address —
        /// the counterparty on the other side of `s.user`'s long.
        fn open_short_counterparty(s: &Setup, size: i128, entry_price: i128) -> Address {
            let counterparty = Address::generate(&s.env);
            token::StellarAssetClient::new(&s.env, &s.settlement_asset)
                .mint(&counterparty, &(1_000 * PRECISION));
            s.vault
                .deposit(&counterparty, &s.settlement_asset, &(1_000 * PRECISION));
            s.engine.open_position(
                &counterparty,
                &1,
                &size,
                &false,
                &entry_price,
                &MarginMode::Cross,
            );
            counterparty
        }

        #[test]
        fn adl_pays_down_bad_debt_from_an_in_profit_counterparty() {
            let s = setup();
            // Re-fund insurance so the liquidation below leaves an exact,
            // hand-checkable 900 * PRECISION of bad debt: deficit 8_000, minus
            // reward 5, minus the 7_100 the fund can still cover.
            s.insurance
                .deposit(&s.user, &s.settlement_asset, &(6_105 * PRECISION)); // 1_000 (setup) + 6_105 = 7_105

            let counterparty = open_short_counterparty(&s, 100 * PRECISION, 100 * PRECISION);
            let opened = s.engine.open_position(
                &s.user,
                &1,
                &(100 * PRECISION),
                &true,
                &(100 * PRECISION),
                &MarginMode::Cross,
            );
            s.env.ledger().with_mut(|l| l.timestamp += 1);
            s.oracle.write_price(
                &Symbol::new(&s.env, "BTC"),
                &s.publisher,
                &(10 * PRECISION),
                &(PRECISION / 100),
                &s.env.ledger().timestamp(),
            );

            s.liquidation.liquidate(
                &s.liquidator,
                &s.user,
                &opened.position_id,
                &(100 * PRECISION),
                &(10 * PRECISION),
            );
            assert_eq!(
                s.insurance.bad_debt_of(&s.settlement_asset),
                900 * PRECISION
            );

            let counterparty_position = s.engine.positions(&counterparty).get(0).unwrap();
            let keeper = Address::generate(&s.env);
            let counterparty_balance_before =
                s.vault.balance_of(&counterparty, &s.settlement_asset);

            // Ask to close the whole 100 * PRECISION position — the 900
            // bad-debt cap must bind well before that, at 10 * PRECISION
            // (10 * 90 price-delta = 900, exactly the shortfall).
            let receipt = s.liquidation.adl(
                &keeper,
                &counterparty,
                &counterparty_position.position_id,
                &(100 * PRECISION),
                &(10 * PRECISION),
            );

            assert_eq!(receipt.close_size, 10 * PRECISION);
            assert_eq!(receipt.realized_pnl, 900 * PRECISION);
            assert_eq!(receipt.bad_debt_before, 900 * PRECISION);
            assert_eq!(receipt.bad_debt_after, 0);
            assert_eq!(s.insurance.bad_debt_of(&s.settlement_asset), 0);

            // Only the capped amount was closed — 90 of the original 100
            // remains open, still carrying the rest of the profit.
            assert_eq!(
                s.engine.positions(&counterparty).get(0).unwrap().size,
                90 * PRECISION
            );
            assert_eq!(
                s.vault.balance_of(&counterparty, &s.settlement_asset),
                counterparty_balance_before + 900 * PRECISION
            );
        }

        #[test]
        fn adl_is_refused_without_recorded_bad_debt() {
            let s = setup(); // fully solvent, no liquidation has happened
            let counterparty = open_short_counterparty(&s, 10 * PRECISION, 100 * PRECISION);
            let position = s.engine.positions(&counterparty).get(0).unwrap();
            let keeper = Address::generate(&s.env);

            let result = s.liquidation.try_adl(
                &keeper,
                &counterparty,
                &position.position_id,
                &(10 * PRECISION),
                &(100 * PRECISION),
            );
            assert_eq!(result, Err(Ok(CoreError::NoBadDebtToOffset)));
        }

        #[test]
        fn adl_refuses_a_counterparty_that_is_not_in_profit() {
            let s = setup();
            s.insurance
                .deposit(&s.user, &s.settlement_asset, &(6_105 * PRECISION));

            // A second long, same side as the distressed user — it is
            // underwater at the very price the distressed user is
            // liquidated at, so it is exactly the wrong ADL target.
            let other_long = Address::generate(&s.env);
            token::StellarAssetClient::new(&s.env, &s.settlement_asset)
                .mint(&other_long, &(1_000 * PRECISION));
            s.vault
                .deposit(&other_long, &s.settlement_asset, &(1_000 * PRECISION));
            let other_position = s.engine.open_position(
                &other_long,
                &1,
                &PRECISION,
                &true,
                &(100 * PRECISION),
                &MarginMode::Cross,
            );

            let opened = s.engine.open_position(
                &s.user,
                &1,
                &(100 * PRECISION),
                &true,
                &(100 * PRECISION),
                &MarginMode::Cross,
            );
            s.env.ledger().with_mut(|l| l.timestamp += 1);
            s.oracle.write_price(
                &Symbol::new(&s.env, "BTC"),
                &s.publisher,
                &(10 * PRECISION),
                &(PRECISION / 100),
                &s.env.ledger().timestamp(),
            );
            s.liquidation.liquidate(
                &s.liquidator,
                &s.user,
                &opened.position_id,
                &(100 * PRECISION),
                &(10 * PRECISION),
            );
            assert_eq!(
                s.insurance.bad_debt_of(&s.settlement_asset),
                900 * PRECISION
            );

            let keeper = Address::generate(&s.env);
            let result = s.liquidation.try_adl(
                &keeper,
                &other_long,
                &other_position.position_id,
                &PRECISION,
                &(10 * PRECISION),
            );
            assert_eq!(result, Err(Ok(CoreError::PositionNotInProfit)));
        }
    }
}
