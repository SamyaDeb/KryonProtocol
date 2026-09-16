// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice An account's net position in one market. One per (trader, marketId).
/// @dev `size` is signed (long > 0). `openNotional` is the signed cost basis
///      (sum of size * price paid in, 1e18 USDC), same sign as `size`. Storing
///      the basis instead of a rounded VWAP entry keeps value conservation
///      exact: every fill moves Σ(balance) - Σ(openNotional) by zero.
struct Position {
    int256 size;
    int256 openNotional;
    int256 lastFundingIndex;
}

/// @notice Per-market risk parameters, owned by RiskParams.
struct MarketParams {
    bytes32 oracleId;
    uint16 initialMarginBps;
    uint16 maintenanceMarginBps;
    uint16 liquidationFeeBps;
    uint16 maxExecutionDeviationBps;
    uint16 maxOracleConfidenceBps;
    uint32 maxOracleAge;
    uint32 maxLeverageBps;
    bool active;
    bool listed;
    /// Cap on long + short open interest, in base units (1e18).
    int256 maxOpenInterest;
    /// Smallest fill the gateway settles, in 1e18 USDC notional.
    int256 minFillNotional;
}

struct FundingConfig {
    /// Premium sensitivity (1e18 = rate equals premium).
    int256 premiumCoeff;
    /// Clamp on |rate| per hour, 1e18 = 100%.
    int256 maxRatePerHour;
}

struct FundingState {
    int256 longIndex;
    int256 shortIndex;
    int256 ratePerHour;
    uint64 lastUpdate;
}

/// @notice Time-weighted mark accumulator. See Engine._recordMark.
struct MarkState {
    int256 lastPrice;
    uint64 lastTs;
    int256 cumulative;
    uint64 windowStart;
}

struct AccountHealth {
    int256 collateralValue;
    int256 unrealizedPnl;
    int256 equity;
    int256 initialMarginRequired;
    int256 maintenanceMarginRequired;
    int256 freeCollateral;
    int256 marginRatio;
    bool liquidatable;
}

/// @notice Rust-reference shaped inputs for RiskLib (see risk-engine::margin).
struct RiskCollateral {
    int256 value;
    uint256 haircutBps;
}

struct RiskPosition {
    uint256 positionId;
    uint32 marketId;
    /// Unsigned magnitude, > 0.
    int256 size;
    int256 entryPrice;
    int256 margin;
    bool isLong;
    int256 lastFundingIndex;
    bool isolated;
}

struct RiskMarket {
    uint32 marketId;
    uint256 initialMarginBps;
    uint256 maintenanceMarginBps;
    uint256 liquidationFeeBps;
    bool active;
    int256 oraclePrice;
    int256 fundingIndexLong;
    int256 fundingIndexShort;
}

enum LiquidationMode {
    None,
    Partial,
    Full
}

struct LiquidationPlan {
    LiquidationMode mode;
    uint256 positionId;
    int256 closeSize;
    int256 penalty;
    AccountHealth expectedHealth;
}

/// @notice Aggregated oracle price. Every read carries source, timestamps and
///         confidence (protocol invariant 4).
struct OracleSnapshot {
    int256 price;
    int256 confidence;
    uint64 publishTime;
    uint64 writeTime;
    /// ORACLE_SOURCE_* constant.
    uint8 source;
    /// How many publisher observations the median was taken over.
    uint8 sourceCount;
}

uint8 constant ORACLE_SOURCE_NONE = 0;
uint8 constant ORACLE_SOURCE_QUORUM = 1;
