use crate::CoreError;
use soroban_sdk::{contracttype, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleSource {
    RedStone,
    Pyth,
    Reflector,
    Quorum,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleSnapshot {
    pub asset: Symbol,
    pub price: i128,
    pub confidence: i128,
    pub source: OracleSource,
    pub publish_time: u64,
    pub write_time: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleGuard {
    pub max_age_secs: u64,
    pub max_confidence_bps: u32,
}

impl OracleSnapshot {
    pub fn validate(&self, now: u64, guard: &OracleGuard) -> Result<(), CoreError> {
        if self.price <= 0 {
            return Err(CoreError::InvalidPrice);
        }
        if self.publish_time > now || self.write_time > now {
            return Err(CoreError::StaleOracle);
        }
        let publish_age = now.saturating_sub(self.publish_time);
        let write_age = now.saturating_sub(self.write_time);
        if publish_age > guard.max_age_secs || write_age > guard.max_age_secs {
            return Err(CoreError::StaleOracle);
        }
        if self.confidence < 0 {
            return Err(CoreError::InvalidPrice);
        }
        let max_conf = crate::apply_bps(self.price, guard.max_confidence_bps)?;
        if self.confidence > max_conf {
            return Err(CoreError::OracleConfidenceTooWide);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PRECISION;
    use soroban_sdk::Env;

    #[test]
    fn rejects_stale_publish_time_even_with_fresh_write() {
        let env = Env::default();
        let snapshot = OracleSnapshot {
            asset: Symbol::new(&env, "BTC"),
            price: 100 * PRECISION,
            confidence: PRECISION,
            source: OracleSource::Reflector,
            publish_time: 1,
            write_time: 101,
        };

        assert_eq!(
            snapshot.validate(
                101,
                &OracleGuard {
                    max_age_secs: 60,
                    max_confidence_bps: 100,
                },
            ),
            Err(CoreError::StaleOracle)
        );
    }

    #[test]
    fn rejects_future_publish_time() {
        let env = Env::default();
        let snapshot = OracleSnapshot {
            asset: Symbol::new(&env, "ETH"),
            price: 100 * PRECISION,
            confidence: PRECISION,
            source: OracleSource::Pyth,
            publish_time: 102,
            write_time: 100,
        };

        assert_eq!(
            snapshot.validate(
                100,
                &OracleGuard {
                    max_age_secs: 60,
                    max_confidence_bps: 100,
                },
            ),
            Err(CoreError::StaleOracle)
        );
    }
}
