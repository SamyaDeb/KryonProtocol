#![no_std]
#![deny(unsafe_code)]

use protocol_core::CoreError;
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Symbol, Val, Vec};

/// 48 hours — minimum timelock delay for privileged protocol operations.
const MIN_SAFE_DELAY_SECS: u64 = 172_800;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Guardian,
    MinDelay,
    Paused,
    Proposal(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Queued,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceProposal {
    pub id: BytesN<32>,
    pub target: Address,
    pub action: Symbol,
    /// Arguments passed verbatim to `target.action(...)` at execution time.
    pub args: Vec<Val>,
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
    pub status: ProposalStatus,
}

#[contract]
pub struct PerpGovernanceContract;

#[contractimpl]
impl PerpGovernanceContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        guardian: Address,
        min_delay_secs: u64,
    ) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        if min_delay_secs < MIN_SAFE_DELAY_SECS {
            return Err(CoreError::InvalidConfig);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage()
            .instance()
            .set(&DataKey::MinDelay, &min_delay_secs);
        env.storage().instance().set(&DataKey::Paused, &false);
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

    pub fn queue(
        env: Env,
        id: BytesN<32>,
        target: Address,
        action: Symbol,
        args: Vec<Val>,
        wasm_hash: BytesN<32>,
        eta: u64,
    ) -> Result<GovernanceProposal, CoreError> {
        require_admin(&env)?;
        if env
            .storage()
            .persistent()
            .has(&DataKey::Proposal(id.clone()))
        {
            return Err(CoreError::AlreadyInitialized);
        }
        let min_delay = min_delay(&env)?;
        let earliest = env
            .ledger()
            .timestamp()
            .checked_add(min_delay)
            .ok_or(CoreError::MathOverflow)?;
        if eta < earliest {
            return Err(CoreError::InvalidConfig);
        }
        let proposal = GovernanceProposal {
            id: id.clone(),
            target,
            action,
            args,
            wasm_hash,
            eta,
            status: ProposalStatus::Queued,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        Ok(proposal)
    }

    /// Execute a matured proposal by actually invoking `target.action(args)`.
    ///
    /// When this governance contract is the admin of the target (the intended
    /// mainnet topology), the target's `require_admin` is satisfied by Soroban
    /// invoker auth — governance is the direct cross-contract caller. Status is
    /// marked Executed BEFORE the call so a reverting target cannot make the
    /// proposal replayable, and the guardian pause vetoes execution entirely.
    pub fn execute(env: Env, id: BytesN<32>) -> Result<GovernanceProposal, CoreError> {
        require_admin(&env)?;
        if Self::paused(env.clone()) {
            return Err(CoreError::Unauthorized);
        }
        let mut proposal = proposal(&env, &id)?;
        if proposal.status != ProposalStatus::Queued {
            return Err(CoreError::InvalidConfig);
        }
        if env.ledger().timestamp() < proposal.eta {
            return Err(CoreError::Unauthorized);
        }
        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        let _: Val = env.invoke_contract(&proposal.target, &proposal.action, proposal.args.clone());
        Ok(proposal)
    }

    pub fn cancel(env: Env, id: BytesN<32>) -> Result<GovernanceProposal, CoreError> {
        require_admin(&env)?;
        let mut proposal = proposal(&env, &id)?;
        if proposal.status != ProposalStatus::Queued {
            return Err(CoreError::InvalidConfig);
        }
        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        Ok(proposal)
    }

    pub fn emergency_pause(env: Env, paused: bool) -> Result<(), CoreError> {
        require_guardian(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    pub fn set_guardian(env: Env, guardian: Address) -> Result<(), CoreError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        Ok(())
    }

    /// The minimum timelock delay, in seconds. This is the number that makes
    /// governance meaningful, so it must be readable without trusting a
    /// deployment record.
    pub fn min_delay(env: Env) -> Option<u64> {
        env.storage().instance().get(&DataKey::MinDelay)
    }

    /// The guardian able to veto execution via `emergency_pause`.
    pub fn guardian(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Guardian)
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn proposal(env: Env, id: BytesN<32>) -> Result<GovernanceProposal, CoreError> {
        proposal(&env, &id)
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

fn require_guardian(env: &Env) -> Result<Address, CoreError> {
    let guardian: Address = env
        .storage()
        .instance()
        .get(&DataKey::Guardian)
        .ok_or(CoreError::InvalidConfig)?;
    guardian.require_auth();
    Ok(guardian)
}

fn min_delay(env: &Env) -> Result<u64, CoreError> {
    env.storage()
        .instance()
        .get(&DataKey::MinDelay)
        .ok_or(CoreError::InvalidConfig)
}

fn proposal(env: &Env, id: &BytesN<32>) -> Result<GovernanceProposal, CoreError> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(id.clone()))
        .ok_or(CoreError::InvalidConfig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        vec, Address, BytesN, Env, IntoVal, Symbol,
    };

    /// Minimal target contract proving that execute() really invokes
    /// target.action(args) — not just bookkeeping.
    #[contract]
    pub struct TestTarget;

    #[contractimpl]
    impl TestTarget {
        pub fn poke(env: Env, value: u32) {
            env.storage().instance().set(&symbol_short!("v"), &value);
        }
        pub fn value(env: Env) -> u32 {
            env.storage()
                .instance()
                .get(&symbol_short!("v"))
                .unwrap_or(0)
        }
    }

    // MIN_SAFE_DELAY_SECS = 172_800 (48 h). Tests use timestamp=100 so earliest ETA = 172_900.
    fn setup() -> (Env, Address, Address, PerpGovernanceContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 100;
        });
        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let contract_id = env.register(PerpGovernanceContract, ());
        let governance = PerpGovernanceContractClient::new(&env, &contract_id);
        governance.initialize(&admin, &guardian, &MIN_SAFE_DELAY_SECS);
        (env, admin, guardian, governance)
    }

    #[test]
    fn rejects_delay_below_48h() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let contract_id = env.register(PerpGovernanceContract, ());
        let governance = PerpGovernanceContractClient::new(&env, &contract_id);
        // 1 hour — below the 48 h minimum
        let result = governance.try_initialize(&admin, &guardian, &3_600u64);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_short_timelock_eta() {
        let (env, _admin, _guardian, governance) = setup();
        // ETA must be >= timestamp(100) + MIN_SAFE_DELAY_SECS(172_800) = 172_900
        let result = governance.try_queue(
            &id(&env, 1),
            &Address::generate(&env),
            &Symbol::new(&env, "upgrade"),
            &vec![&env],
            &id(&env, 2),
            &172_899,
        );

        assert!(result.is_err());
    }

    #[test]
    fn queues_and_executes_after_delay_invoking_target() {
        let (env, _admin, _guardian, governance) = setup();
        let target_id = env.register(TestTarget, ());
        let target = TestTargetClient::new(&env, &target_id);
        assert_eq!(target.value(), 0);

        let proposal_id = id(&env, 3);
        governance.queue(
            &proposal_id,
            &target_id,
            &Symbol::new(&env, "poke"),
            &vec![&env, 42u32.into_val(&env)],
            &id(&env, 4),
            &172_900,
        );
        // Too early: the timelock blocks execution.
        assert!(governance.try_execute(&proposal_id).is_err());
        assert_eq!(target.value(), 0);

        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 172_900;
        });
        let executed = governance.execute(&proposal_id);
        assert_eq!(executed.status, ProposalStatus::Executed);
        // The target was actually invoked with the queued args.
        assert_eq!(target.value(), 42);
        // Executed proposals cannot be replayed.
        assert!(governance.try_execute(&proposal_id).is_err());
    }

    #[test]
    fn guardian_can_pause() {
        let (_env, _admin, _guardian, governance) = setup();
        governance.emergency_pause(&true);
        assert!(governance.paused());
    }

    #[test]
    fn guardian_pause_vetoes_execution() {
        let (env, _admin, _guardian, governance) = setup();
        let target_id = env.register(TestTarget, ());
        let target = TestTargetClient::new(&env, &target_id);

        let proposal_id = id(&env, 5);
        governance.queue(
            &proposal_id,
            &target_id,
            &Symbol::new(&env, "poke"),
            &vec![&env, 7u32.into_val(&env)],
            &id(&env, 6),
            &172_900,
        );
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 172_900;
        });
        governance.emergency_pause(&true);
        assert!(governance.try_execute(&proposal_id).is_err());
        assert_eq!(target.value(), 0);

        governance.emergency_pause(&false);
        governance.execute(&proposal_id);
        assert_eq!(target.value(), 7);
    }

    fn id(env: &Env, value: u8) -> BytesN<32> {
        BytesN::from_array(env, &[value; 32])
    }
}
