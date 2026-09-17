// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Protocol-wide custom errors.
/// @dev The first block mirrors `protocol_core::CoreError` one-to-one so the
///      differential harness can compare failure modes, not just values.
library KryonErrors {
    error MathOverflow();
    error DivisionByZero();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidConfig();
    error StaleOracle();
    error OracleConfidenceTooWide();
    error AccountInsolvent();
    error InsufficientCollateral();
    error NotLiquidatable();
    error Unauthorized();
    error AlreadyInitialized();
    error AssetDisabled();
    error PositionNotFound();
    error DirectionMismatch();
    error PriceOutsideBand();
    error OpenInterestExceeded();
    error LiquidationWouldNotImproveHealth();
    error InsuranceFundInsufficient();
    error OrderExpired();
    error OrderCancelled();
    error OrderOverfilled();
    error SelfTrade();
    error OracleQuorumNotMet();
    error OracleDeviationTooWide();
    error DuplicateOracleSource();
    error TooManyPositions();
    error DepositCapExceeded();
    error IsolatedMarginDisabled();
    error AggregateOiPolicyExceeded();
    error NoBadDebtToOffset();
    error PositionNotInProfit();

    // --- EVM-only ---
    error ZeroAddress();
    error NativeValueRejected();
    error CollateralNotSupported(address token);
    error InvalidSignature();
    error NonceReused();
    error FillBelowMinNotional();
    error MarketInactive(uint32 marketId);
    error ParameterOutOfBounds(bytes32 name, int256 value);
    error OnlySelf();
    error BatchTooLarge();
    error FeeRateOutOfBounds();
    error NetFeeBelowFloor();
    error UnknownFeeTier(uint8 tier);
    error UnknownMarket(uint32 marketId);
    error UnknownFeed(bytes32 id);
    error NotPublisher();
    error CooldownActive();
    error NoPendingUnstake();
    error UnstakePending();
    error HasOpenPositions();
    error InsuranceAccount();
    error ExecutionPaused();
    error VetoCooldownActive();
    error PauseCooldownActive();
    error BackstopUnwindDisabled();
    error BackstopLimitExceeded();
}
