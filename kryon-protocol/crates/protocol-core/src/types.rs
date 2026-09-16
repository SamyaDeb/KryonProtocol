use soroban_sdk::{contracttype, Address, Symbol, Vec};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarginMode {
    Cross,
    Isolated,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketId(pub u32);

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketConfig {
    pub market_id: u32,
    pub base_asset: Symbol,
    pub settlement_asset: Address,
    pub max_leverage_bps: u32,
    pub initial_margin_bps: u32,
    pub maintenance_margin_bps: u32,
    pub liquidation_fee_bps: u32,
    pub max_open_interest: i128,
    pub max_oracle_age_secs: u64,
    pub max_oracle_confidence_bps: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub position_id: u64,
    pub owner: Address,
    pub market_id: u32,
    pub size: i128,
    pub entry_price: i128,
    pub margin: i128,
    pub is_long: bool,
    pub last_funding_index: i128,
    pub mode: MarginMode,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralBalance {
    pub asset: Address,
    pub amount: i128,
    pub value: i128,
    pub haircut_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralConfig {
    pub asset: Address,
    pub oracle_asset: Symbol,
    pub haircut_bps: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSnapshot {
    pub owner: Address,
    pub collateral: Vec<CollateralBalance>,
    pub positions: Vec<Position>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketSnapshot {
    pub config: MarketConfig,
    pub oracle_price: i128,
    pub funding_index_long: i128,
    pub funding_index_short: i128,
}
