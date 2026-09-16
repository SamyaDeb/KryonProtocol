// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {KryonErrors as Errors} from "./libraries/Errors.sol";
import {RiskLib} from "./libraries/RiskLib.sol";
import {FundingConfig, MarketParams} from "./libraries/Types.sol";

/// @title RiskParams
/// @notice Per-market risk configuration. Every setter is RISK_ADMIN_ROLE
///         (the timelock after handover) and every value is held inside hard
///         bounds that not even the timelock can exceed.
contract RiskParams is KryonUpgradeable {
    uint16 public constant MIN_INITIAL_MARGIN_BPS = 100; // 100x
    uint16 public constant MAX_INITIAL_MARGIN_BPS = 5000; // 2x
    uint16 public constant MIN_MAINTENANCE_MARGIN_BPS = 25;
    uint16 public constant MAX_LIQUIDATION_FEE_BPS = 500;
    uint16 public constant MAX_EXECUTION_DEVIATION_BPS = 1000;
    uint32 public constant MAX_ORACLE_AGE = 300;
    uint16 public constant MAX_ORACLE_CONFIDENCE_BPS = 500;
    int256 public constant MAX_OPEN_INTEREST = 1e30;
    int256 public constant MAX_MIN_FILL_NOTIONAL = 100_000e18;
    int256 public constant MAX_PREMIUM_COEFF = 10e18;
    int256 public constant MAX_FUNDING_RATE_PER_HOUR = 1e16; // 1%/h
    uint256 public constant MAX_OI_POLICY_BPS = 1_000_000; // 100x the insurance fund
    uint256 public constant MAX_MARKETS = 32;

    /// @custom:storage-location erc7201:kryon.storage.RiskParams
    struct RiskParamsStorage {
        mapping(uint32 => MarketParams) markets;
        uint32[] ids;
        mapping(uint32 => FundingConfig) funding;
        mapping(uint32 => uint256) oiPolicyBps;
        uint256 totalOiPolicyBps;
        uint256 maxTotalOiPolicyBps;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.RiskParams")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x18ab5b7e69960f1ff40abd9615c5d351e790c49d4115538a920721d98ba36100;

    event MarketListed(uint32 indexed marketId, bytes32 indexed oracleId);
    event MarketParamsSet(uint32 indexed marketId, MarketParams params);
    event MarketActiveSet(uint32 indexed marketId, bool active);
    event FundingConfigSet(uint32 indexed marketId, int256 premiumCoeff, int256 maxRatePerHour);
    event OiPolicySet(uint32 indexed marketId, uint256 bps, uint256 totalBps);
    event MaxTotalOiPolicySet(uint256 bps);

    function _s() private pure returns (RiskParamsStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(address admin) external initializer {
        __KryonUpgradeable_init(admin);
    }

    // ---------------------------------------------------------------- setters

    /// @notice List a new market or replace an existing market's parameters.
    /// @dev `params.listed` is forced true. `active` controls whether the
    ///      market accepts exposure-increasing fills.
    function setMarket(uint32 marketId, MarketParams calldata params)
        external
        onlyRole(Roles.RISK_ADMIN_ROLE)
    {
        if (marketId == 0) revert Errors.InvalidConfig();
        _validateMarket(params);
        RiskParamsStorage storage $ = _s();
        MarketParams storage m = $.markets[marketId];
        if (!m.listed) {
            if ($.ids.length >= MAX_MARKETS) revert Errors.InvalidConfig();
            $.ids.push(marketId);
            emit MarketListed(marketId, params.oracleId);
        } else if (m.oracleId != params.oracleId) {
            // Re-pointing a live market at another feed would reprice every
            // open position in one step. List a new market instead.
            revert Errors.InvalidConfig();
        }
        $.markets[marketId] = params;
        $.markets[marketId].listed = true;
        emit MarketParamsSet(marketId, $.markets[marketId]);
    }

    function setMarketActive(uint32 marketId, bool active)
        external
        onlyRole(Roles.RISK_ADMIN_ROLE)
    {
        MarketParams storage m = _listed(marketId);
        m.active = active;
        emit MarketActiveSet(marketId, active);
    }

    function setFundingConfig(uint32 marketId, FundingConfig calldata cfg)
        external
        onlyRole(Roles.RISK_ADMIN_ROLE)
    {
        _listed(marketId);
        if (cfg.premiumCoeff < 0 || cfg.premiumCoeff > MAX_PREMIUM_COEFF) {
            revert Errors.ParameterOutOfBounds("premiumCoeff", cfg.premiumCoeff);
        }
        if (cfg.maxRatePerHour <= 0 || cfg.maxRatePerHour > MAX_FUNDING_RATE_PER_HOUR) {
            revert Errors.ParameterOutOfBounds("maxRatePerHour", cfg.maxRatePerHour);
        }
        _s().funding[marketId] = cfg;
        emit FundingConfigSet(marketId, cfg.premiumCoeff, cfg.maxRatePerHour);
    }

    /// @notice Cap a market's OI notional at a multiple of the insurance fund,
    ///         in bps (100_000 = 10x). 0 removes the cap. (KRY-Q4)
    /// @dev The fund is pooled, so the SUM of every market's bps is what
    ///      bounds its real commitment; that sum is held under
    ///      `maxTotalOiPolicyBps` when one is set. (KRY-Q11)
    function setOiPolicy(uint32 marketId, uint256 bps) external onlyRole(Roles.RISK_ADMIN_ROLE) {
        _listed(marketId);
        if (bps > MAX_OI_POLICY_BPS) revert Errors.ParameterOutOfBounds("oiPolicyBps", int256(bps));
        RiskParamsStorage storage $ = _s();
        uint256 newTotal = $.totalOiPolicyBps - $.oiPolicyBps[marketId] + bps;
        if ($.maxTotalOiPolicyBps != 0 && newTotal > $.maxTotalOiPolicyBps) {
            revert Errors.AggregateOiPolicyExceeded();
        }
        $.oiPolicyBps[marketId] = bps;
        $.totalOiPolicyBps = newTotal;
        emit OiPolicySet(marketId, bps, newTotal);
    }

    /// @notice Ceiling on the summed OI policy. 0 clears it.
    function setMaxTotalOiPolicyBps(uint256 bps) external onlyRole(Roles.RISK_ADMIN_ROLE) {
        if (bps > MAX_OI_POLICY_BPS * MAX_MARKETS) {
            revert Errors.ParameterOutOfBounds("maxTotalOiPolicyBps", int256(bps));
        }
        _s().maxTotalOiPolicyBps = bps;
        emit MaxTotalOiPolicySet(bps);
    }

    // ------------------------------------------------------------------ views

    function market(uint32 marketId) external view returns (MarketParams memory m) {
        m = _s().markets[marketId];
        if (!m.listed) revert Errors.UnknownMarket(marketId);
    }

    function isListed(uint32 marketId) external view returns (bool) {
        return _s().markets[marketId].listed;
    }

    function marketIds() external view returns (uint32[] memory) {
        return _s().ids;
    }

    function fundingConfig(uint32 marketId) external view returns (FundingConfig memory) {
        return _s().funding[marketId];
    }

    function oiPolicyBps(uint32 marketId) external view returns (uint256) {
        return _s().oiPolicyBps[marketId];
    }

    function totalOiPolicyBps() external view returns (uint256) {
        return _s().totalOiPolicyBps;
    }

    function maxTotalOiPolicyBps() external view returns (uint256) {
        return _s().maxTotalOiPolicyBps;
    }

    // --------------------------------------------------------------- internal

    function _listed(uint32 marketId) private view returns (MarketParams storage m) {
        m = _s().markets[marketId];
        if (!m.listed) revert Errors.UnknownMarket(marketId);
    }

    function _validateMarket(MarketParams calldata p) private pure {
        if (p.oracleId == bytes32(0)) revert Errors.InvalidConfig();
        if (p.initialMarginBps < MIN_INITIAL_MARGIN_BPS || p.initialMarginBps > MAX_INITIAL_MARGIN_BPS)
        {
            revert Errors.ParameterOutOfBounds("initialMarginBps", int256(uint256(p.initialMarginBps)));
        }
        if (
            p.maintenanceMarginBps < MIN_MAINTENANCE_MARGIN_BPS
                || p.maintenanceMarginBps > p.initialMarginBps
        ) {
            revert Errors.ParameterOutOfBounds(
                "maintenanceMarginBps", int256(uint256(p.maintenanceMarginBps))
            );
        }
        // A penalty above maintenance would itself push a just-liquidatable
        // account into bad debt.
        if (
            p.liquidationFeeBps > MAX_LIQUIDATION_FEE_BPS
                || p.liquidationFeeBps > p.maintenanceMarginBps
        ) {
            revert Errors.ParameterOutOfBounds(
                "liquidationFeeBps", int256(uint256(p.liquidationFeeBps))
            );
        }
        if (p.maxExecutionDeviationBps == 0 || p.maxExecutionDeviationBps > MAX_EXECUTION_DEVIATION_BPS)
        {
            revert Errors.ParameterOutOfBounds(
                "maxExecutionDeviationBps", int256(uint256(p.maxExecutionDeviationBps))
            );
        }
        if (p.maxOracleAge == 0 || p.maxOracleAge > MAX_ORACLE_AGE) {
            revert Errors.ParameterOutOfBounds("maxOracleAge", int256(uint256(p.maxOracleAge)));
        }
        if (p.maxOracleConfidenceBps == 0 || p.maxOracleConfidenceBps > MAX_ORACLE_CONFIDENCE_BPS) {
            revert Errors.ParameterOutOfBounds(
                "maxOracleConfidenceBps", int256(uint256(p.maxOracleConfidenceBps))
            );
        }
        // KRY-Q8: the published leverage cap may be tighter than the margin
        // requirement implies, never looser.
        if (
            p.maxLeverageBps == 0
                || p.maxLeverageBps > RiskLib.impliedMaxLeverageBps(p.initialMarginBps)
        ) {
            revert Errors.ParameterOutOfBounds("maxLeverageBps", int256(uint256(p.maxLeverageBps)));
        }
        if (p.maxOpenInterest <= 0 || p.maxOpenInterest > MAX_OPEN_INTEREST) {
            revert Errors.ParameterOutOfBounds("maxOpenInterest", p.maxOpenInterest);
        }
        if (p.minFillNotional < 0 || p.minFillNotional > MAX_MIN_FILL_NOTIONAL) {
            revert Errors.ParameterOutOfBounds("minFillNotional", p.minFillNotional);
        }
    }
}
