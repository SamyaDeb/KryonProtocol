#![no_std]
#![deny(unsafe_code)]

use protocol_core::{apply_bps, checked_sub, CoreError, OracleGuard, OracleSnapshot, OracleSource};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Symbol, Vec};

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
    Config(Symbol),
    Price(Symbol),
    SourcePublisher(Symbol, OracleSource),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedConfig {
    pub publisher: Address,
    pub source: OracleSource,
    pub guard: OracleGuard,
    pub active: bool,
    pub required_sources: Vec<OracleSource>,
    pub min_sources: u32,
    pub max_source_deviation_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleObservation {
    pub publisher: Address,
    pub source: OracleSource,
    pub price: i128,
    pub confidence: i128,
    pub publish_time: u64,
}

#[contract]
pub struct OracleAdapterContract;

#[contractimpl]
impl OracleAdapterContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), CoreError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CoreError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    pub fn set_feed(
        env: Env,
        asset: Symbol,
        publisher: Address,
        source: OracleSource,
        guard: OracleGuard,
        active: bool,
    ) -> Result<(), CoreError> {
        require_admin(&env)?;
        validate_guard(&guard)?;
        let config = FeedConfig {
            publisher: publisher.clone(),
            source: source.clone(),
            guard,
            active,
            required_sources: Vec::from_array(&env, [source.clone()]),
            min_sources: 1,
            max_source_deviation_bps: 0,
        };
        env.storage()
            .persistent()
            .set(&DataKey::SourcePublisher(asset.clone(), source), &publisher);
        env.storage()
            .persistent()
            .set(&DataKey::Config(asset), &config);
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

    /// Permissionless instance-TTL keepalive — prevents the oracle instance
    /// (feed configs, price keys) from being archived.
    pub fn extend_instance_ttl(env: Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    pub fn set_quorum_feed(
        env: Env,
        asset: Symbol,
        guard: OracleGuard,
        required_sources: Vec<OracleSource>,
        min_sources: u32,
        max_source_deviation_bps: u32,
        active: bool,
    ) -> Result<(), CoreError> {
        require_admin(&env)?;
        validate_guard(&guard)?;
        validate_quorum_config(
            &env,
            &required_sources,
            min_sources,
            max_source_deviation_bps,
        )?;

        let config = FeedConfig {
            publisher: require_admin_readonly(&env)?,
            source: OracleSource::Quorum,
            guard,
            active,
            required_sources,
            min_sources,
            max_source_deviation_bps,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Config(asset), &config);
        Ok(())
    }

    pub fn set_source_publisher(
        env: Env,
        asset: Symbol,
        source: OracleSource,
        publisher: Address,
    ) -> Result<(), CoreError> {
        require_admin(&env)?;
        if source == OracleSource::Quorum {
            return Err(CoreError::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&DataKey::SourcePublisher(asset, source), &publisher);
        Ok(())
    }

    pub fn write_price(
        env: Env,
        asset: Symbol,
        publisher: Address,
        price: i128,
        confidence: i128,
        publish_time: u64,
    ) -> Result<OracleSnapshot, CoreError> {
        publisher.require_auth();
        let config = load_config(&env, asset.clone())?;
        if !config.active {
            return Err(CoreError::InvalidConfig);
        }
        if config.publisher != publisher {
            return Err(CoreError::Unauthorized);
        }

        let snapshot = OracleSnapshot {
            asset: asset.clone(),
            price,
            confidence,
            source: config.source,
            publish_time,
            write_time: env.ledger().timestamp(),
        };
        snapshot.validate(env.ledger().timestamp(), &config.guard)?;
        validate_monotonic_publish_time(&env, asset.clone(), publish_time)?;
        env.storage()
            .persistent()
            .set(&DataKey::Price(asset), &snapshot);
        Ok(snapshot)
    }

    pub fn write_quorum_price(
        env: Env,
        asset: Symbol,
        observations: Vec<OracleObservation>,
    ) -> Result<OracleSnapshot, CoreError> {
        let config = load_config(&env, asset.clone())?;
        if !config.active || config.source != OracleSource::Quorum {
            return Err(CoreError::InvalidConfig);
        }
        if observations.len() < config.min_sources {
            return Err(CoreError::OracleQuorumNotMet);
        }

        let mut prices = Vec::new(&env);
        let mut max_confidence = 0_i128;
        let mut publish_time = env.ledger().timestamp();
        let mut seen_sources = Vec::new(&env);

        for index in 0..observations.len() {
            let observation = observations
                .get(index)
                .ok_or(CoreError::OracleQuorumNotMet)?;
            validate_observation_source(&config, &seen_sources, &observation.source)?;
            let expected_publisher: Address = env
                .storage()
                .persistent()
                .get(&DataKey::SourcePublisher(
                    asset.clone(),
                    observation.source.clone(),
                ))
                .ok_or(CoreError::InvalidConfig)?;
            observation.publisher.require_auth();
            if observation.publisher != expected_publisher {
                return Err(CoreError::Unauthorized);
            }

            let snapshot = OracleSnapshot {
                asset: asset.clone(),
                price: observation.price,
                confidence: observation.confidence,
                source: observation.source.clone(),
                publish_time: observation.publish_time,
                write_time: env.ledger().timestamp(),
            };
            snapshot.validate(env.ledger().timestamp(), &config.guard)?;

            prices.push_back(observation.price);
            seen_sources.push_back(observation.source);
            if observation.confidence > max_confidence {
                max_confidence = observation.confidence;
            }
            if observation.publish_time < publish_time {
                publish_time = observation.publish_time;
            }
        }

        if seen_sources.len() < config.min_sources {
            return Err(CoreError::OracleQuorumNotMet);
        }

        sort_prices(&mut prices)?;
        let median = prices
            .get(prices.len() / 2)
            .ok_or(CoreError::OracleQuorumNotMet)?;
        validate_source_deviation(&prices, median, config.max_source_deviation_bps)?;
        validate_monotonic_publish_time(&env, asset.clone(), publish_time)?;

        let snapshot = OracleSnapshot {
            asset: asset.clone(),
            price: median,
            confidence: max_confidence,
            source: OracleSource::Quorum,
            publish_time,
            write_time: env.ledger().timestamp(),
        };
        snapshot.validate(env.ledger().timestamp(), &config.guard)?;
        env.storage()
            .persistent()
            .set(&DataKey::Price(asset), &snapshot);
        Ok(snapshot)
    }

    pub fn get_price(
        env: Env,
        asset: Symbol,
        override_guard: Option<OracleGuard>,
    ) -> Result<OracleSnapshot, CoreError> {
        let config = load_config(&env, asset.clone())?;
        if !config.active {
            return Err(CoreError::InvalidConfig);
        }
        let snapshot: OracleSnapshot = env
            .storage()
            .persistent()
            .get(&DataKey::Price(asset))
            .ok_or(CoreError::StaleOracle)?;
        // Enforce that the stored snapshot was produced by the correct write path.
        // Prevents a quorum-configured feed from returning a stale single-source price
        // (e.g., after upgrading a feed from single-source to quorum).
        if snapshot.source != config.source {
            return Err(CoreError::OracleQuorumNotMet);
        }
        let guard = override_guard.unwrap_or(config.guard);
        snapshot.validate(env.ledger().timestamp(), &guard)?;
        Ok(snapshot)
    }
}

fn require_admin(env: &Env) -> Result<Address, CoreError> {
    let admin = require_admin_readonly(env)?;
    admin.require_auth();
    Ok(admin)
}

fn require_admin_readonly(env: &Env) -> Result<Address, CoreError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(CoreError::InvalidConfig)?;
    Ok(admin)
}

fn load_config(env: &Env, asset: Symbol) -> Result<FeedConfig, CoreError> {
    env.storage()
        .persistent()
        .get(&DataKey::Config(asset))
        .ok_or(CoreError::InvalidConfig)
}

fn validate_guard(guard: &OracleGuard) -> Result<(), CoreError> {
    if guard.max_age_secs == 0 {
        return Err(CoreError::InvalidConfig);
    }
    if guard.max_confidence_bps > 10_000 {
        return Err(CoreError::InvalidConfig);
    }
    Ok(())
}

fn validate_quorum_config(
    env: &Env,
    required_sources: &Vec<OracleSource>,
    min_sources: u32,
    max_source_deviation_bps: u32,
) -> Result<(), CoreError> {
    if required_sources.is_empty()
        || min_sources < 3
        || min_sources % 2 == 0
        || min_sources > required_sources.len()
        || max_source_deviation_bps > 10_000
    {
        return Err(CoreError::InvalidConfig);
    }
    let mut seen: Vec<OracleSource> = Vec::new(env);
    for index in 0..required_sources.len() {
        let source = required_sources
            .get(index)
            .ok_or(CoreError::InvalidConfig)?;
        if source == OracleSource::Quorum || contains_source(&seen, &source) {
            return Err(CoreError::InvalidConfig);
        }
        seen.push_back(source);
    }
    Ok(())
}

fn validate_observation_source(
    config: &FeedConfig,
    seen_sources: &Vec<OracleSource>,
    source: &OracleSource,
) -> Result<(), CoreError> {
    if !contains_source(&config.required_sources, source) {
        return Err(CoreError::InvalidConfig);
    }
    if contains_source(seen_sources, source) {
        return Err(CoreError::DuplicateOracleSource);
    }
    Ok(())
}

fn contains_source(sources: &Vec<OracleSource>, needle: &OracleSource) -> bool {
    for index in 0..sources.len() {
        if sources.get(index).as_ref() == Some(needle) {
            return true;
        }
    }
    false
}

fn sort_prices(prices: &mut Vec<i128>) -> Result<(), CoreError> {
    for index in 1..prices.len() {
        let key = prices.get(index).ok_or(CoreError::InvalidPrice)?;
        let mut position = index;
        while position > 0 {
            let previous_index = position - 1;
            let previous = prices.get(previous_index).ok_or(CoreError::InvalidPrice)?;
            if previous <= key {
                break;
            }
            prices.set(position, previous);
            position = previous_index;
        }
        prices.set(position, key);
    }
    Ok(())
}

fn validate_source_deviation(
    prices: &Vec<i128>,
    median: i128,
    max_source_deviation_bps: u32,
) -> Result<(), CoreError> {
    let max_delta = apply_bps(median, max_source_deviation_bps)?;
    for index in 0..prices.len() {
        let price = prices.get(index).ok_or(CoreError::InvalidPrice)?;
        let delta = if price >= median {
            checked_sub(price, median)?
        } else {
            checked_sub(median, price)?
        };
        if delta > max_delta {
            return Err(CoreError::OracleDeviationTooWide);
        }
    }
    Ok(())
}

fn validate_monotonic_publish_time(
    env: &Env,
    asset: Symbol,
    publish_time: u64,
) -> Result<(), CoreError> {
    if let Some(previous) = env
        .storage()
        .persistent()
        .get::<DataKey, OracleSnapshot>(&DataKey::Price(asset))
    {
        if publish_time <= previous.publish_time {
            return Err(CoreError::StaleOracle);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::PRECISION;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env, Symbol, Vec,
    };

    #[test]
    fn rejects_unauthorized_publisher() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let publisher = Address::generate(&env);
        let attacker = Address::generate(&env);
        let asset = Symbol::new(&env, "BTC");
        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);

        oracle.initialize(&admin);
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

        let result = oracle.try_write_price(&asset, &attacker, &(100 * PRECISION), &PRECISION, &1);
        assert!(result.is_err());
    }

    #[test]
    fn single_source_rejects_replayed_publish_time() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 10;
        });
        let admin = Address::generate(&env);
        let publisher = Address::generate(&env);
        let asset = Symbol::new(&env, "ETH");
        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);

        oracle.initialize(&admin);
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
        oracle.write_price(&asset, &publisher, &(100 * PRECISION), &PRECISION, &5);

        let result = oracle.try_write_price(&asset, &publisher, &(99 * PRECISION), &PRECISION, &4);

        assert!(result.is_err());
        assert_eq!(oracle.get_price(&asset, &None).price, 100 * PRECISION);
    }

    #[test]
    fn quorum_price_uses_median_and_max_confidence() {
        let env = Env::default();
        env.mock_all_auths();
        let setup = quorum_setup(&env);

        let snapshot = setup.oracle.write_quorum_price(
            &setup.asset,
            &observations(
                &env,
                &setup.pyth,
                &setup.reflector,
                &setup.redstone,
                100 * PRECISION,
                101 * PRECISION,
                99 * PRECISION,
                PRECISION,
                2 * PRECISION,
                PRECISION,
                1,
            ),
        );

        assert_eq!(snapshot.price, 100 * PRECISION);
        assert_eq!(snapshot.confidence, 2 * PRECISION);
        assert_eq!(snapshot.source, OracleSource::Quorum);
        assert_eq!(snapshot.publish_time, 1);
    }

    #[test]
    fn quorum_rejects_wide_source_deviation() {
        let env = Env::default();
        env.mock_all_auths();
        let setup = quorum_setup(&env);

        let result = setup.oracle.try_write_quorum_price(
            &setup.asset,
            &observations(
                &env,
                &setup.pyth,
                &setup.reflector,
                &setup.redstone,
                100 * PRECISION,
                101 * PRECISION,
                130 * PRECISION,
                PRECISION,
                PRECISION,
                PRECISION,
                1,
            ),
        );

        assert!(result.is_err());
    }

    #[test]
    fn quorum_rejects_duplicate_source() {
        let env = Env::default();
        env.mock_all_auths();
        let setup = quorum_setup(&env);
        let duplicate = Vec::from_array(
            &env,
            [
                OracleObservation {
                    publisher: setup.pyth.clone(),
                    source: OracleSource::Pyth,
                    price: 100 * PRECISION,
                    confidence: PRECISION,
                    publish_time: 1,
                },
                OracleObservation {
                    publisher: setup.pyth.clone(),
                    source: OracleSource::Pyth,
                    price: 100 * PRECISION,
                    confidence: PRECISION,
                    publish_time: 1,
                },
            ],
        );

        let result = setup
            .oracle
            .try_write_quorum_price(&setup.asset, &duplicate);

        assert!(result.is_err());
    }

    #[test]
    fn quorum_rejects_replayed_publish_time() {
        let env = Env::default();
        env.mock_all_auths();
        let setup = quorum_setup(&env);
        setup.oracle.write_quorum_price(
            &setup.asset,
            &observations(
                &env,
                &setup.pyth,
                &setup.reflector,
                &setup.redstone,
                100 * PRECISION,
                101 * PRECISION,
                99 * PRECISION,
                PRECISION,
                PRECISION,
                PRECISION,
                2,
            ),
        );

        let result = setup.oracle.try_write_quorum_price(
            &setup.asset,
            &observations(
                &env,
                &setup.pyth,
                &setup.reflector,
                &setup.redstone,
                100 * PRECISION,
                101 * PRECISION,
                99 * PRECISION,
                PRECISION,
                PRECISION,
                PRECISION,
                2,
            ),
        );

        assert!(result.is_err());
    }

    #[test]
    fn quorum_rejects_even_or_two_source_configuration() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let asset = Symbol::new(&env, "BTC");
        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);
        oracle.initialize(&admin);

        let result = oracle.try_set_quorum_feed(
            &asset,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 100,
            },
            &Vec::from_array(&env, [OracleSource::Pyth, OracleSource::Reflector]),
            &2,
            &300,
            &true,
        );

        assert!(result.is_err());
    }

    #[test]
    fn get_price_rejects_stale_single_source_snapshot_after_quorum_upgrade() {
        // H7: if a feed is upgraded from single-source to quorum, the old single-source
        // snapshot must NOT be returned — get_price must enforce source == config.source.
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 10;
        });
        let admin = Address::generate(&env);
        let publisher = Address::generate(&env);
        let pyth = Address::generate(&env);
        let reflector = Address::generate(&env);
        let redstone = Address::generate(&env);
        let asset = Symbol::new(&env, "BTC");
        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(&env, &oracle_id);

        oracle.initialize(&admin);
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
        oracle.write_price(&asset, &publisher, &(100 * PRECISION), &PRECISION, &1);

        // Upgrade feed to quorum — old Reflector snapshot still in storage
        oracle.set_source_publisher(&asset, &OracleSource::Pyth, &pyth);
        oracle.set_source_publisher(&asset, &OracleSource::Reflector, &reflector);
        oracle.set_source_publisher(&asset, &OracleSource::RedStone, &redstone);
        oracle.set_quorum_feed(
            &asset,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 200,
            },
            &Vec::from_array(
                &env,
                [
                    OracleSource::Pyth,
                    OracleSource::Reflector,
                    OracleSource::RedStone,
                ],
            ),
            &3,
            &300,
            &true,
        );

        // get_price must reject the stale single-source snapshot
        let result = oracle.try_get_price(&asset, &None);
        assert!(result.is_err());
    }

    struct QuorumSetup<'a> {
        oracle: OracleAdapterContractClient<'a>,
        asset: Symbol,
        pyth: Address,
        reflector: Address,
        redstone: Address,
    }

    fn quorum_setup(env: &Env) -> QuorumSetup<'_> {
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 10;
        });
        let admin = Address::generate(env);
        let pyth = Address::generate(env);
        let reflector = Address::generate(env);
        let redstone = Address::generate(env);
        let asset = Symbol::new(env, "BTC");
        let oracle_id = env.register(OracleAdapterContract, ());
        let oracle = OracleAdapterContractClient::new(env, &oracle_id);

        oracle.initialize(&admin);
        oracle.set_quorum_feed(
            &asset,
            &OracleGuard {
                max_age_secs: 60,
                max_confidence_bps: 200,
            },
            &Vec::from_array(
                env,
                [
                    OracleSource::Pyth,
                    OracleSource::Reflector,
                    OracleSource::RedStone,
                ],
            ),
            &3,
            &300,
            &true,
        );
        oracle.set_source_publisher(&asset, &OracleSource::Pyth, &pyth);
        oracle.set_source_publisher(&asset, &OracleSource::Reflector, &reflector);
        oracle.set_source_publisher(&asset, &OracleSource::RedStone, &redstone);

        QuorumSetup {
            oracle,
            asset,
            pyth,
            reflector,
            redstone,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn observations(
        env: &Env,
        pyth: &Address,
        reflector: &Address,
        redstone: &Address,
        pyth_price: i128,
        reflector_price: i128,
        redstone_price: i128,
        pyth_confidence: i128,
        reflector_confidence: i128,
        redstone_confidence: i128,
        publish_time: u64,
    ) -> Vec<OracleObservation> {
        Vec::from_array(
            env,
            [
                OracleObservation {
                    publisher: pyth.clone(),
                    source: OracleSource::Pyth,
                    price: pyth_price,
                    confidence: pyth_confidence,
                    publish_time,
                },
                OracleObservation {
                    publisher: reflector.clone(),
                    source: OracleSource::Reflector,
                    price: reflector_price,
                    confidence: reflector_confidence,
                    publish_time,
                },
                OracleObservation {
                    publisher: redstone.clone(),
                    source: OracleSource::RedStone,
                    price: redstone_price,
                    confidence: redstone_confidence,
                    publish_time,
                },
            ],
        )
    }
}
