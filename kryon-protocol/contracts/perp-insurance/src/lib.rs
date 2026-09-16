#![no_std]
#![deny(unsafe_code)]

use protocol_core::{checked_add, checked_sub, mul_div, CoreError, PRECISION};
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

/// How long a staker must wait between requesting an unstake and actually
/// withdrawing. Without this, a staker who sees a liquidation (and the
/// governance sweep it might trigger) coming could unstake and withdraw in
/// the same transaction, exiting before absorbing any loss — exactly the
/// front-running problem every insurance-fund staking design has to guard
/// against.
pub const UNSTAKE_COOLDOWN_SECS: u64 = 7 * 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Liquidation,
    Vault,
    Balance(Address),
    BadDebt(Address),
    /// Staked capital, tracked separately from `Balance` — the plain
    /// donation/operating pool that `pay_liquidator` and `cover_deficit`
    /// already draw from. Kept apart so a staker's claim can never include
    /// capital they never contributed (see `stake`), and so liquidation
    /// payouts can never silently draw down staked capital without the
    /// deliberate, visible `sweep_to_operating` action.
    StakedBalance(Address),
    /// (asset, staker) -> shares outstanding, tagged with the epoch they were
    /// minted in. Shares from a retired epoch are worthless; see `Epoch`.
    Shares(Address, Address),
    /// asset -> current share epoch, bumped whenever a loss takes staked NAV to
    /// zero while shares are still outstanding.
    ///
    /// Without this a wiped pool becomes a trap. `sweep_to_operating` can take
    /// NAV to zero while `TotalShares` stays positive, and `stake` then mints
    /// 1:1 against nothing — so the next staker is instantly diluted by shares
    /// that will never have a claim on anything. Depositing 100 into a pool
    /// that once held 1,000,000 shares redeems for about 0.01. Retiring the
    /// epoch invalidates those shares in a single write, without enumerating
    /// holders, which this contract cannot do.
    Epoch(Address),
    /// asset -> total shares outstanding, the denominator for share pricing.
    TotalShares(Address),
    /// (asset, staker) -> a requested-but-not-yet-withdrawn unstake.
    PendingUnstake(Address, Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUnstakeRequest {
    pub shares: i128,
    pub unlock_time: u64,
    /// Epoch the shares were minted in. A request that outlives its epoch is
    /// trying to redeem shares a loss already wrote off.
    pub epoch: u32,
}

/// A staker's share balance, valid only within `epoch`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShareBalance {
    pub epoch: u32,
    pub shares: i128,
}

#[contract]
pub struct PerpInsuranceContract;

#[contractimpl]
impl PerpInsuranceContract {
    pub fn initialize(env: Env, admin: Address, liquidation: Address) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Liquidation, &liquidation);
        Ok(())
    }

    pub fn set_liquidation(env: Env, liquidation: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Liquidation, &liquidation);
        Ok(())
    }

    /// Register the vault that is authorized to pull deficit coverage and record
    /// uncovered bad debt. The vault is the only party that knows a user's exact
    /// negative balance, so it — not the liquidation contract — drives coverage.
    pub fn set_vault(env: Env, vault: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Vault, &vault);
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

    pub fn deposit(
        env: Env,
        funder: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, CoreError> {
        funder.require_auth();
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let insurance = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&funder, &insurance, &amount);
        increase_balance(&env, &asset, amount)
    }

    pub fn pay_liquidator(
        env: Env,
        liquidator: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, CoreError> {
        require_liquidation(&env)?;
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let balance = balance_of(env.clone(), asset.clone());
        if balance < amount {
            return Err(CoreError::InsuranceFundInsufficient);
        }
        let next = decrease_balance(&env, &asset, amount)?;
        let insurance = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&insurance, &liquidator, &amount);
        Ok(next)
    }

    /// Cover an account deficit by transferring up to `amount` of `asset` to the
    /// vault. Returns the amount actually covered (capped by the fund balance).
    /// Only the registered vault may call this — it pulls real tokens into vault
    /// reserves so the vault can credit the underwater account back toward zero,
    /// keeping Σ(internal balances) ≤ token reserves.
    pub fn cover_deficit(env: Env, asset: Address, amount: i128) -> Result<i128, CoreError> {
        let vault = require_vault(&env)?;
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let balance = balance_of(env.clone(), asset.clone());
        let covered = if balance < amount { balance } else { amount };
        if covered <= 0 {
            return Ok(0);
        }
        decrease_balance(&env, &asset, covered)?;
        let insurance = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&insurance, &vault, &covered);
        Ok(covered)
    }

    pub fn record_bad_debt(env: Env, asset: Address, amount: i128) -> Result<i128, CoreError> {
        require_vault(&env)?;
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let current = bad_debt_of(env.clone(), asset.clone());
        let next = checked_add(current, amount)?;
        env.storage()
            .persistent()
            .set(&DataKey::BadDebt(asset), &next);
        Ok(next)
    }

    /// Offset recorded bad debt once it has been paid out through
    /// auto-deleveraging rather than left as a pending shortfall.
    ///
    /// `record_bad_debt` tracks a loss that has already happened but not yet
    /// been realised against anyone — the winning counterparty's matching
    /// gain is still unrealised, so nothing has actually been paid out of
    /// vault reserves for it yet. `adl` (on the liquidation contract) forces
    /// that realisation early and in a bounded amount instead of leaving it to
    /// surface later as whichever depositor tries to withdraw last; once paid,
    /// the shortfall is no longer PENDING; it is now embedded directly in the
    /// vault's reserves. Leaving it recorded here too would double-count the
    /// same shortfall as both "pending" and "paid" — so it is cleared here as
    /// ADL actually pays it out. Never goes negative: reducing by more than is
    /// recorded simply clears it to zero rather than erroring, since the
    /// caller may be offsetting against a slightly stale read.
    ///
    /// Gated the same as `pay_liquidator`: only the contract already trusted
    /// to move insurance funds during liquidation-adjacent actions may call.
    pub fn reduce_bad_debt(env: Env, asset: Address, amount: i128) -> Result<i128, CoreError> {
        require_liquidation(&env)?;
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let current = bad_debt_of(env.clone(), asset.clone());
        let next = core::cmp::max(0, checked_sub(current, amount)?);
        env.storage()
            .persistent()
            .set(&DataKey::BadDebt(asset), &next);
        Ok(next)
    }

    pub fn balance_of(env: Env, asset: Address) -> i128 {
        balance_of(env, asset)
    }

    pub fn bad_debt_of(env: Env, asset: Address) -> i128 {
        bad_debt_of(env, asset)
    }

    /// Deposit into the staked pool and mint shares priced against it.
    ///
    /// KRY-Q4 backstop. Unlike `deposit` (a one-way donation with no claim
    /// back), staked capital is redeemable — its value moves with
    /// `staked_balance_of`, which only ever changes via a `stake`/
    /// `withdraw_unstaked` pair or an explicit `sweep_to_operating`. Shares
    /// are priced against `StakedBalance` alone, never `Balance` — pricing
    /// them against the shared operating pool would let the first staker
    /// walk away with every donation made before any shares existed, since
    /// there would be no existing share supply to price that capital against.
    pub fn stake(
        env: Env,
        staker: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, CoreError> {
        staker.require_auth();
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let nav_before = staked_balance_of(env.clone(), asset.clone());
        let total_shares = total_shares_of(env.clone(), asset.clone());

        let insurance = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&staker, &insurance, &amount);
        increase_staked_balance(&env, &asset, amount)?;

        let minted = if total_shares <= 0 || nav_before <= 0 {
            amount
        } else {
            mul_div(amount, total_shares, nav_before)?
        };
        let next_shares = checked_add(
            shares_of(env.clone(), asset.clone(), staker.clone()),
            minted,
        )?;
        env.storage().persistent().set(
            &DataKey::Shares(asset.clone(), staker.clone()),
            &ShareBalance {
                epoch: epoch_of(&env, &asset),
                shares: next_shares,
            },
        );
        let next_total = checked_add(total_shares, minted)?;
        env.storage()
            .persistent()
            .set(&DataKey::TotalShares(asset), &next_total);
        Ok(minted)
    }

    /// Start the cooldown on redeeming `shares`. Only one request may be
    /// outstanding per staker per asset at a time — withdraw or let the
    /// existing one lapse before requesting again.
    pub fn request_unstake(
        env: Env,
        staker: Address,
        asset: Address,
        shares: i128,
    ) -> Result<u64, CoreError> {
        staker.require_auth();
        if shares <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        if shares > shares_of(env.clone(), asset.clone(), staker.clone()) {
            return Err(CoreError::InsufficientCollateral);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::PendingUnstake(asset.clone(), staker.clone()))
        {
            return Err(CoreError::InvalidConfig);
        }
        let unlock_time = env.ledger().timestamp() + UNSTAKE_COOLDOWN_SECS;
        let epoch = epoch_of(&env, &asset);
        env.storage().persistent().set(
            &DataKey::PendingUnstake(asset, staker),
            &PendingUnstakeRequest {
                shares,
                unlock_time,
                epoch,
            },
        );
        Ok(unlock_time)
    }

    /// Redeem a matured unstake request at the CURRENT share price — not the
    /// price at request time, so a staker who requested before a
    /// `sweep_to_operating` still absorbs their share of that loss rather
    /// than dodging it by having requested first.
    pub fn withdraw_unstaked(env: Env, staker: Address, asset: Address) -> Result<i128, CoreError> {
        staker.require_auth();
        let request: PendingUnstakeRequest = env
            .storage()
            .persistent()
            .get(&DataKey::PendingUnstake(asset.clone(), staker.clone()))
            .ok_or(CoreError::InvalidConfig)?;
        if env.ledger().timestamp() < request.unlock_time {
            return Err(CoreError::InvalidConfig);
        }

        // A request that outlived its epoch is redeeming shares a loss already
        // wrote off. Clear it and pay nothing, rather than letting it compute a
        // claim against the new epoch's capital, which belongs to whoever
        // recapitalised the pool.
        if request.epoch != epoch_of(&env, &asset) {
            env.storage()
                .persistent()
                .remove(&DataKey::Shares(asset.clone(), staker.clone()));
            env.storage()
                .persistent()
                .remove(&DataKey::PendingUnstake(asset, staker));
            return Ok(0);
        }

        let total_shares = total_shares_of(env.clone(), asset.clone());
        let nav = staked_balance_of(env.clone(), asset.clone());
        let payout = if total_shares <= 0 {
            0
        } else {
            mul_div(request.shares, nav, total_shares)?.min(nav)
        };

        if payout > 0 {
            decrease_staked_balance(&env, &asset, payout)?;
            let insurance = env.current_contract_address();
            token::Client::new(&env, &asset).transfer(&insurance, &staker, &payout);
        }

        let remaining_shares = checked_sub(
            shares_of(env.clone(), asset.clone(), staker.clone()),
            request.shares,
        )?;
        if remaining_shares <= 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::Shares(asset.clone(), staker.clone()));
        } else {
            env.storage().persistent().set(
                &DataKey::Shares(asset.clone(), staker.clone()),
                &ShareBalance {
                    epoch: request.epoch,
                    shares: remaining_shares,
                },
            );
        }
        let remaining_total = checked_sub(total_shares, request.shares)?;
        if remaining_total <= 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::TotalShares(asset.clone()));
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::TotalShares(asset.clone()), &remaining_total);
        }
        env.storage()
            .persistent()
            .remove(&DataKey::PendingUnstake(asset, staker));
        Ok(payout)
    }

    /// Move staked capital into the operating pool that `pay_liquidator` and
    /// `cover_deficit` draw from — the moment stakers actually absorb a loss.
    ///
    /// Deliberately a separate, explicit, admin-gated action rather than an
    /// automatic draw from `liquidate`/`absorb_bad_debt`: those are among the
    /// most sensitive, already-hardened paths in the protocol (C1, KRY-Q4),
    /// and wiring a new capital source directly into them is exactly the kind
    /// of change that turns into the next incident if rushed. In production
    /// the admin MUST be the governance timelock, so a sweep inherits its
    /// delay and cancellation window — stakers get advance notice, not a
    /// silent draw-down.
    pub fn sweep_to_operating(env: Env, asset: Address, amount: i128) -> Result<i128, CoreError> {
        require_admin(&env)?;
        if amount <= 0 {
            return Err(CoreError::InvalidAmount);
        }
        let available = staked_balance_of(env.clone(), asset.clone());
        let swept = if available < amount {
            available
        } else {
            amount
        };
        if swept <= 0 {
            return Ok(0);
        }
        decrease_staked_balance(&env, &asset, swept)?;
        increase_balance(&env, &asset, swept)?;
        // A sweep that takes NAV to zero has written the stakers off entirely.
        // Retire their shares here rather than leaving them to dilute whoever
        // recapitalises the pool next.
        retire_shares_if_wiped(&env, &asset)?;
        Ok(swept)
    }

    pub fn staked_balance_of(env: Env, asset: Address) -> i128 {
        staked_balance_of(env, asset)
    }

    pub fn shares_of(env: Env, asset: Address, staker: Address) -> i128 {
        shares_of(env, asset, staker)
    }

    pub fn total_shares_of(env: Env, asset: Address) -> i128 {
        total_shares_of(env, asset)
    }

    pub fn pending_unstake(
        env: Env,
        asset: Address,
        staker: Address,
    ) -> Option<PendingUnstakeRequest> {
        env.storage()
            .persistent()
            .get(&DataKey::PendingUnstake(asset, staker))
    }

    /// Current redemption value of one share, in the asset's own units
    /// scaled by `PRECISION` — e.g. `PRECISION` itself means 1:1. Readable so
    /// a staker (or the UI) can see the effect of a sweep before deciding
    /// whether to stake or unstake, the same way `insurance_coverage_bps`
    /// makes the OI cap's real bite visible on the engine.
    pub fn share_price(env: Env, asset: Address) -> i128 {
        let total_shares = total_shares_of(env.clone(), asset.clone());
        if total_shares <= 0 {
            return PRECISION;
        }
        let nav = staked_balance_of(env.clone(), asset.clone());
        mul_div(nav, PRECISION, total_shares).unwrap_or(0)
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

fn require_vault(env: &Env) -> Result<Address, CoreError> {
    let vault: Address = env
        .storage()
        .instance()
        .get(&DataKey::Vault)
        .ok_or(CoreError::InvalidConfig)?;
    vault.require_auth();
    Ok(vault)
}

fn balance_of(env: Env, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(asset))
        .unwrap_or(0)
}

fn bad_debt_of(env: Env, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::BadDebt(asset))
        .unwrap_or(0)
}

fn increase_balance(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    let next = checked_add(balance_of(env.clone(), asset.clone()), amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(asset.clone()), &next);
    Ok(next)
}

fn decrease_balance(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    let next = checked_sub(balance_of(env.clone(), asset.clone()), amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::Balance(asset.clone()), &next);
    Ok(next)
}

fn staked_balance_of(env: Env, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::StakedBalance(asset))
        .unwrap_or(0)
}

fn increase_staked_balance(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    let next = checked_add(staked_balance_of(env.clone(), asset.clone()), amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::StakedBalance(asset.clone()), &next);
    Ok(next)
}

fn decrease_staked_balance(env: &Env, asset: &Address, amount: i128) -> Result<i128, CoreError> {
    let next = checked_sub(staked_balance_of(env.clone(), asset.clone()), amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::StakedBalance(asset.clone()), &next);
    Ok(next)
}

fn epoch_of(env: &Env, asset: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::Epoch(asset.clone()))
        .unwrap_or(0)
}

/// Retire every outstanding share when a loss has taken staked NAV to zero.
///
/// The condition is exact: zero NAV with shares still outstanding means those
/// shares have no claim on anything and never will, so leaving them alive would
/// dilute whoever recapitalises the pool. The last staker withdrawing normally
/// also drives NAV to zero, but their shares are burned in the same call, so
/// `total_shares` is zero too and this correctly does nothing.
fn retire_shares_if_wiped(env: &Env, asset: &Address) -> Result<(), CoreError> {
    if staked_balance_of(env.clone(), asset.clone()) > 0 {
        return Ok(());
    }
    if total_shares_of(env.clone(), asset.clone()) <= 0 {
        return Ok(());
    }
    let next = epoch_of(env, asset)
        .checked_add(1)
        .ok_or(CoreError::MathOverflow)?;
    env.storage()
        .persistent()
        .set(&DataKey::Epoch(asset.clone()), &next);
    env.storage()
        .persistent()
        .remove(&DataKey::TotalShares(asset.clone()));
    Ok(())
}

fn shares_of(env: Env, asset: Address, staker: Address) -> i128 {
    let epoch = epoch_of(&env, &asset);
    env.storage()
        .persistent()
        .get::<DataKey, ShareBalance>(&DataKey::Shares(asset, staker))
        .filter(|b| b.epoch == epoch)
        .map(|b| b.shares)
        .unwrap_or(0)
}

fn total_shares_of(env: Env, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalShares(asset))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, Env,
    };

    struct Setup<'a> {
        env: Env,
        admin: Address,
        asset: Address,
        insurance: PerpInsuranceContractClient<'a>,
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let vault = Address::generate(&env);
        let liquidation = Address::generate(&env);
        let asset_admin = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(asset_admin)
            .address();

        let insurance_id = env.register(PerpInsuranceContract, ());
        let insurance = PerpInsuranceContractClient::new(&env, &insurance_id);
        insurance.initialize(&admin, &liquidation);
        insurance.set_vault(&vault);

        Setup {
            env,
            admin,
            asset,
            insurance,
        }
    }

    fn fund(s: &Setup, who: &Address, amount: i128) {
        token::StellarAssetClient::new(&s.env, &s.asset).mint(who, &amount);
    }

    #[test]
    fn first_staker_gets_shares_1to1_and_cannot_claim_prior_donations() {
        let s = setup();

        // A plain donation, made before anyone stakes.
        fund(&s, &s.admin, 1_000);
        s.insurance.deposit(&s.admin, &s.asset, &1_000);

        // The first staker deposits 100 into the SEPARATE staked pool.
        let staker = Address::generate(&s.env);
        fund(&s, &staker, 100);
        let minted = s.insurance.stake(&staker, &s.asset, &100);

        assert_eq!(minted, 100);
        assert_eq!(s.insurance.total_shares_of(&s.asset), 100);
        // Staked NAV is exactly what was staked — the 1_000 donation never
        // entered this ledger, so it is not claimable via shares.
        assert_eq!(s.insurance.staked_balance_of(&s.asset), 100);
        assert_eq!(s.insurance.balance_of(&s.asset), 1_000);
    }

    #[test]
    fn a_second_staker_is_priced_against_staked_nav_not_donations() {
        let s = setup();
        fund(&s, &s.admin, 1_000);
        s.insurance.deposit(&s.admin, &s.asset, &1_000); // untouchable by stakers

        let alice = Address::generate(&s.env);
        fund(&s, &alice, 100);
        s.insurance.stake(&alice, &s.asset, &100);

        // Staked NAV moves from a sweep before Bob stakes: 100 -> 50.
        s.insurance.sweep_to_operating(&s.asset, &50);
        assert_eq!(s.insurance.staked_balance_of(&s.asset), 50);
        assert_eq!(s.insurance.balance_of(&s.asset), 1_050);

        // Bob stakes 50 into a pool now worth 50 behind 100 shares — he
        // should get 100 shares (50 * 100 / 50), matching Alice's price per
        // share exactly, not the 1:1 rate a naive read of "100 in, 100 out"
        // would suggest.
        let bob = Address::generate(&s.env);
        fund(&s, &bob, 50);
        let minted = s.insurance.stake(&bob, &s.asset, &50);
        assert_eq!(minted, 100);
        assert_eq!(s.insurance.total_shares_of(&s.asset), 200);
        assert_eq!(s.insurance.staked_balance_of(&s.asset), 100);
    }

    /// A pool wiped to zero must not expropriate whoever recapitalises it.
    ///
    /// `sweep_to_operating` can take staked NAV to zero while `TotalShares`
    /// stays positive. Before share epochs, `stake` then minted 1:1 against a
    /// zero NAV, so the next staker was instantly diluted by shares that could
    /// never have a claim on anything: depositing 100 into a pool that had held
    /// 1,000 shares redeemed for about 9. The pool became a trap — it could
    /// never be recapitalised, because every new deposit was partly seized by
    /// wiped-out holders.
    #[test]
    fn a_wiped_pool_does_not_dilute_the_staker_who_refills_it() {
        let s = setup();

        let alice = Address::generate(&s.env);
        fund(&s, &alice, 1_000);
        s.insurance.stake(&alice, &s.asset, &1_000);
        assert_eq!(s.insurance.total_shares_of(&s.asset), 1_000);

        // A loss consumes the entire staked pool.
        s.insurance.sweep_to_operating(&s.asset, &1_000);
        assert_eq!(s.insurance.staked_balance_of(&s.asset), 0);

        // Alice's shares are retired: they have no claim, and saying so is the
        // point — leaving them alive is what diluted the next staker.
        assert_eq!(
            s.insurance.total_shares_of(&s.asset),
            0,
            "a wipe must retire the outstanding shares"
        );
        assert_eq!(s.insurance.shares_of(&s.asset, &alice), 0);

        // Bob recapitalises and must own the pool outright.
        let bob = Address::generate(&s.env);
        fund(&s, &bob, 100);
        let minted = s.insurance.stake(&bob, &s.asset, &100);
        assert_eq!(minted, 100);
        assert_eq!(s.insurance.total_shares_of(&s.asset), 100);

        // Redeeming returns the full deposit, not a fraction of it.
        s.insurance.request_unstake(&bob, &s.asset, &100);
        s.env
            .ledger()
            .with_mut(|l| l.timestamp += UNSTAKE_COOLDOWN_SECS + 1);
        assert_eq!(
            s.insurance.withdraw_unstaked(&bob, &s.asset),
            100,
            "the staker who refilled a wiped pool owns all of it"
        );
    }

    /// An unstake request that predates a wipe must not reach across it.
    #[test]
    fn a_request_from_a_retired_epoch_pays_nothing() {
        let s = setup();

        let alice = Address::generate(&s.env);
        fund(&s, &alice, 1_000);
        s.insurance.stake(&alice, &s.asset, &1_000);
        s.insurance.request_unstake(&alice, &s.asset, &1_000);

        // The pool is wiped while her request sits in cooldown, then refilled
        // by someone else.
        s.insurance.sweep_to_operating(&s.asset, &1_000);
        let bob = Address::generate(&s.env);
        fund(&s, &bob, 500);
        s.insurance.stake(&bob, &s.asset, &500);

        s.env
            .ledger()
            .with_mut(|l| l.timestamp += UNSTAKE_COOLDOWN_SECS + 1);
        assert_eq!(
            s.insurance.withdraw_unstaked(&alice, &s.asset),
            0,
            "a request cannot redeem shares a loss already wrote off"
        );
        // Bob's capital is untouched.
        assert_eq!(s.insurance.staked_balance_of(&s.asset), 500);
        assert_eq!(s.insurance.shares_of(&s.asset, &bob), 500);
    }

    #[test]
    fn unstake_is_gated_by_cooldown() {
        let s = setup();
        let staker = Address::generate(&s.env);
        fund(&s, &staker, 100);
        s.insurance.stake(&staker, &s.asset, &100);

        s.insurance.request_unstake(&staker, &s.asset, &100);
        let too_early = s.insurance.try_withdraw_unstaked(&staker, &s.asset);
        assert!(too_early.is_err());

        s.env.ledger().with_mut(|l| {
            l.timestamp += UNSTAKE_COOLDOWN_SECS;
        });
        let payout = s.insurance.withdraw_unstaked(&staker, &s.asset);
        assert_eq!(payout, 100);
        assert_eq!(s.insurance.total_shares_of(&s.asset), 0);
        assert_eq!(s.insurance.staked_balance_of(&s.asset), 0);
        assert_eq!(token::Client::new(&s.env, &s.asset).balance(&staker), 100);
    }

    #[test]
    fn a_sweep_between_request_and_withdrawal_is_absorbed_by_the_staker() {
        let s = setup();
        let staker = Address::generate(&s.env);
        fund(&s, &staker, 100);
        s.insurance.stake(&staker, &s.asset, &100);
        s.insurance.request_unstake(&staker, &s.asset, &100);

        // A sweep happens during the cooldown, halving staked NAV.
        s.insurance.sweep_to_operating(&s.asset, &50);

        s.env.ledger().with_mut(|l| {
            l.timestamp += UNSTAKE_COOLDOWN_SECS;
        });
        // Priced at withdrawal time, not request time — the staker gets 50,
        // not the 100 they would have gotten had they escaped the sweep.
        let payout = s.insurance.withdraw_unstaked(&staker, &s.asset);
        assert_eq!(payout, 50);
    }

    #[test]
    fn sweep_only_moves_what_is_actually_staked() {
        let s = setup();
        let staker = Address::generate(&s.env);
        fund(&s, &staker, 30);
        s.insurance.stake(&staker, &s.asset, &30);

        let swept = s.insurance.sweep_to_operating(&s.asset, &1_000);
        assert_eq!(swept, 30);
        assert_eq!(s.insurance.staked_balance_of(&s.asset), 0);
        assert_eq!(s.insurance.balance_of(&s.asset), 30);
    }

    #[test]
    fn share_price_reflects_a_sweep() {
        let s = setup();
        let staker = Address::generate(&s.env);
        fund(&s, &staker, 100);
        s.insurance.stake(&staker, &s.asset, &100);
        assert_eq!(s.insurance.share_price(&s.asset), PRECISION);

        s.insurance.sweep_to_operating(&s.asset, &50);
        assert_eq!(s.insurance.share_price(&s.asset), PRECISION / 2);
    }
}
