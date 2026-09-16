use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CoreError {
    MathOverflow = 1,
    DivisionByZero = 2,
    InvalidAmount = 3,
    InvalidPrice = 4,
    InvalidConfig = 5,
    StaleOracle = 6,
    OracleConfidenceTooWide = 7,
    AccountInsolvent = 8,
    InsufficientCollateral = 9,
    NotLiquidatable = 10,
    Unauthorized = 11,
    AlreadyInitialized = 12,
    AssetDisabled = 13,
    PositionNotFound = 14,
    DirectionMismatch = 15,
    PriceOutsideBand = 16,
    OpenInterestExceeded = 17,
    LiquidationWouldNotImproveHealth = 18,
    InsuranceFundInsufficient = 19,
    OrderExpired = 20,
    OrderCancelled = 21,
    OrderOverfilled = 22,
    SelfTrade = 23,
    OracleQuorumNotMet = 24,
    OracleDeviationTooWide = 25,
    DuplicateOracleSource = 26,
    TooManyPositions = 27,
    DepositCapExceeded = 28,
    /// Isolated margin has no separate collateral bucket in the vault — a
    /// realised isolated loss draws down the same balance as cross positions,
    /// silently defeating the isolation the mode promises. Disabled at the
    /// entrypoint until the vault carries a real per-position margin ledger
    /// (open findings follow-up 2026-09-07, Q5-F).
    IsolatedMarginDisabled = 29,
    /// The insurance fund is pooled across every market, but each market's
    /// `OiPolicy` cap was being checked independently against the same
    /// undivided balance — so N markets could each claim up to their own
    /// multiple of the fund, with the fund's real aggregate commitment
    /// unbounded. This is returned when a `set_oi_policy` call would push the
    /// sum of every market's cap (in bps of the fund) past the configured
    /// ceiling (open findings follow-up 2026-09-07, Q11).
    AggregateOiPolicyExceeded = 30,
    /// Auto-deleveraging (`adl`) is a last resort for a shortfall that has
    /// already materialised on-chain, not a speculative risk control — it is
    /// refused while the insurance fund has no recorded bad debt to offset
    /// (open findings follow-up 2026-09-07, Q4).
    NoBadDebtToOffset = 31,
    /// `adl` may only force-close a position that is currently in profit at
    /// the given execution price — the whole point is to socialise an
    /// unbacked loss onto the winners of the unwound trade, not to touch an
    /// account that itself has nothing to give (open findings follow-up
    /// 2026-09-07, Q4).
    PositionNotInProfit = 32,
}
