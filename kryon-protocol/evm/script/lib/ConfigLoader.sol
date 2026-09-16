// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";

import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {FundingConfig, MarketParams} from "../../src/libraries/Types.sol";
import {DeployConfig, MarketConfig} from "./KryonDeploy.sol";

/// @notice Loads infra/deploy/environments/<KRYON_NETWORK>.toml.
/// @dev Keys are read one by one (not decoded into structs) so the TOML stays
///      readable and key order never matters.
abstract contract ConfigLoader is Script {
    function networkName() internal view returns (string memory) {
        return vm.envOr("KRYON_NETWORK", string("arc-testnet"));
    }

    function configPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../infra/deploy/environments/", networkName(), ".toml");
    }

    function deploymentPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", networkName(), ".json");
    }

    function loadConfig() internal view returns (DeployConfig memory c) {
        string memory t = vm.readFile(configPath());
        c.chainId = vm.parseTomlUint(t, ".network.chain_id");
        c.usdc = vm.parseTomlAddress(t, ".assets.usdc");
        c.permit2 = vm.parseTomlAddress(t, ".assets.permit2");

        c.timelockDelay = vm.parseTomlUint(t, ".governance.timelock_min_delay_secs");
        c.proposers = _addresses(t, ".governance.proposers");
        c.executors = _addresses(t, ".governance.executors");
        c.guardian = vm.parseTomlAddress(t, ".governance.guardian");
        c.treasury = vm.parseTomlAddress(t, ".governance.treasury");

        c.operators = _addresses(t, ".roles.operators");
        c.publishers = _addresses(t, ".roles.publishers");
        c.fundingKeepers = _addresses(t, ".roles.funding_keepers");
        c.feeTierBots = _addresses(t, ".roles.fee_tier_bots");

        c.depositCap = vm.parseTomlUint(t, ".vault.deposit_cap");
        c.accountDepositCap = vm.parseTomlUint(t, ".vault.account_deposit_cap");
        c.openDepositsAtDeploy = vm.parseTomlBool(t, ".vault.open_deposits_at_deploy");

        c.maxRewardBps = uint16(vm.parseTomlUint(t, ".liquidation.max_reward_bps"));
        c.partialLiquidationBps = uint16(vm.parseTomlUint(t, ".liquidation.partial_liquidation_bps"));

        c.takerRate = int32(vm.parseTomlInt(t, ".fees.taker_rate"));
        c.makerRate = int32(vm.parseTomlInt(t, ".fees.maker_rate"));
        c.minNetRate = vm.parseTomlInt(t, ".fees.min_net_rate");
        c.rebatesEnabled = vm.parseTomlBool(t, ".fees.rebates_enabled");
        c.referralsEnabled = vm.parseTomlBool(t, ".fees.referrals_enabled");
        c.splitTreasuryBps = uint16(vm.parseTomlUint(t, ".fees.split_treasury_bps"));
        c.splitInsuranceBps = uint16(vm.parseTomlUint(t, ".fees.split_insurance_bps"));
        c.splitReferralBps = uint16(vm.parseTomlUint(t, ".fees.split_referral_bps"));
        c.liquidationInsuranceBps = uint16(vm.parseTomlUint(t, ".fees.liquidation_insurance_bps"));
        c.maxTotalOiPolicyBps = vm.parseTomlUint(t, ".risk.max_total_oi_policy_bps");

        string[] memory keys = vm.parseTomlStringArray(t, ".market_keys");
        c.markets = new MarketConfig[](keys.length);
        for (uint256 i = 0; i < keys.length; ++i) {
            c.markets[i] = _market(t, keys[i]);
        }
    }

    function _market(string memory t, string memory key) private pure returns (MarketConfig memory m) {
        string memory p = string.concat(".markets.", key, ".");
        m.id = uint32(_uint(t, p, "market_id"));
        m.symbol = vm.parseTomlString(t, string.concat(p, "symbol"));
        m.params = _params(t, p);
        m.funding = FundingConfig({
            premiumCoeff: vm.parseInt(vm.parseTomlString(t, string.concat(p, "funding_premium_coeff"))) * 1e18,
            maxRatePerHour: vm.parseInt(vm.parseTomlString(t, string.concat(p, "funding_max_rate_per_hour")))
        });
        m.oiPolicyBps = _uint(t, p, "oi_policy_bps");
        m.feed = _feed(t);
        m.ref = _reference(t, p);
    }

    function _params(string memory t, string memory p) private pure returns (MarketParams memory m) {
        m.oracleId = bytes32(bytes(vm.parseTomlString(t, string.concat(p, "oracle_id"))));
        m.initialMarginBps = uint16(_uint(t, p, "initial_margin_bps"));
        m.maintenanceMarginBps = uint16(_uint(t, p, "maintenance_margin_bps"));
        m.liquidationFeeBps = uint16(_uint(t, p, "liquidation_fee_bps"));
        m.maxExecutionDeviationBps = uint16(_uint(t, p, "max_execution_deviation_bps"));
        m.maxOracleConfidenceBps = uint16(_uint(t, p, "max_oracle_confidence_bps"));
        m.maxOracleAge = uint32(_uint(t, p, "max_oracle_age_secs"));
        m.maxLeverageBps = uint32(_uint(t, p, "max_leverage_bps"));
        m.active = vm.parseTomlBool(t, string.concat(p, "active"));
        m.listed = true;
        m.maxOpenInterest = vm.parseInt(vm.parseTomlString(t, string.concat(p, "max_open_interest"))) * 1e18;
        m.minFillNotional = int256(_uint(t, p, "min_fill_notional_usd")) * 1e18;
    }

    function _feed(string memory t) private pure returns (OracleAdapter.FeedConfig memory f) {
        string memory o = ".oracle.";
        f.listed = true;
        f.active = true;
        f.minPublishers = uint8(_uint(t, o, "min_publishers"));
        f.maxSpreadBps = uint16(_uint(t, o, "max_spread_bps"));
        f.maxJumpBps = uint16(_uint(t, o, "max_jump_bps"));
        f.maxConfidenceBps = uint16(_uint(t, o, "max_confidence_bps"));
        f.maxAge = uint32(_uint(t, o, "max_age_secs"));
    }

    function _reference(string memory t, string memory p)
        private
        pure
        returns (OracleAdapter.ReferenceFeed memory r)
    {
        string memory agg = vm.parseTomlString(t, string.concat(p, "reference_aggregator"));
        if (bytes(agg).length == 0) return r;
        r.aggregator = vm.parseAddress(agg);
        r.enabled = true;
        r.maxDivergenceBps = uint16(_uint(t, p, "reference_max_divergence_bps"));
        r.maxRefAge = uint32(_uint(t, p, "reference_max_age_secs"));
    }

    function _uint(string memory t, string memory prefix, string memory key) private pure returns (uint256) {
        return vm.parseTomlUint(t, string.concat(prefix, key));
    }

    function _addresses(string memory t, string memory key) private pure returns (address[] memory) {
        return vm.parseTomlAddressArray(t, key);
    }
}
