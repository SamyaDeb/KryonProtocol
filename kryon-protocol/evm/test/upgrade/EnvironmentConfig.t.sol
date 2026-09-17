// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {ConfigLoader} from "../../script/lib/ConfigLoader.sol";
import {DeploymentVerifier} from "../../script/lib/DeploymentVerifier.sol";
import {DeployConfig, Deployment, KryonDeploy} from "../../script/lib/KryonDeploy.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Reads infra/deploy/environments/<network>.toml through the same
///         loader the deploy scripts use.
contract EnvironmentConfigReader is ConfigLoader {
    function load(string memory network) external returns (DeployConfig memory) {
        vm.setEnv("KRYON_NETWORK", network);
        return loadConfig();
    }
}

/// @notice The approved Arc mainnet and testnet parameters deploy and verify
///         cleanly, and no active market lets the liquidator reward consume the
///         whole liquidation penalty (Phase 1 decision 4).
/// @dev One test function on purpose: the loader selects the file through the
///      KRYON_NETWORK environment variable, which parallel tests would race on.
///      Addresses that only exist on Arc (USDC, Permit2, Chainlink proxies) and
///      the governance/role placeholders are replaced with local stand-ins;
///      every economic and risk parameter is used exactly as configured.
contract EnvironmentConfigTest is Test {
    uint32 internal constant XLM_ID = 1;
    uint32 internal constant BTC_ID = 2;
    uint32 internal constant ETH_ID = 3;
    uint32 internal constant ADA_ID = 6;

    address internal deployer = makeAddr("deployer");

    function test_arc_environment_configs_deploy_and_verify_cleanly() public {
        vm.warp(1_790_000_000);
        EnvironmentConfigReader reader = new EnvironmentConfigReader();
        string[2] memory networks = ["arc-mainnet", "arc-testnet"];
        for (uint256 n = 0; n < networks.length; ++n) {
            DeployConfig memory cfg = reader.load(networks[n]);
            _checkDecisions(cfg, networks[n]);
            _localise(cfg);

            vm.startPrank(deployer);
            (Deployment memory d,) = KryonDeploy.deployAll(cfg, deployer);
            vm.stopPrank();

            string[] memory failures = DeploymentVerifier.verify(d, cfg, deployer);
            for (uint256 i = 0; i < failures.length; ++i) {
                emit log_named_string(networks[n], failures[i]);
            }
            assertEq(failures.length, 0, string.concat(networks[n], ": verifier failures"));
            string[] memory warnings = DeploymentVerifier.warnings(d, cfg);
            for (uint256 i = 0; i < warnings.length; ++i) {
                emit log_named_string(networks[n], warnings[i]);
            }
            assertEq(warnings.length, 0, string.concat(networks[n], ": verifier warnings"));
        }
    }

    function _checkDecisions(DeployConfig memory cfg, string memory network) internal pure {
        uint256 active;
        for (uint256 i = 0; i < cfg.markets.length; ++i) {
            uint32 id = cfg.markets[i].id;
            string memory what = string.concat(network, " ", cfg.markets[i].symbol);
            assertTrue(
                id != XLM_ID && id != ADA_ID,
                string.concat(what, ": XLM and ADA have no Arc reference feed")
            );
            if (!cfg.markets[i].params.active) continue;
            ++active;
            assertTrue(
                id == BTC_ID || id == ETH_ID, string.concat(what, ": only BTC and ETH launch")
            );
            assertGt(
                cfg.markets[i].params.liquidationFeeBps,
                cfg.maxRewardBps,
                string.concat(
                    what,
                    ": liquidator reward must leave part of the penalty for insurance and treasury"
                )
            );
        }
        assertEq(active, 2, string.concat(network, ": active market count"));
    }

    function _localise(DeployConfig memory cfg) internal {
        cfg.usdc = address(new MockUSDC());
        cfg.permit2 = address(new MockPermit2());
        cfg.proposers = _one(makeAddr("governanceSafe"));
        cfg.executors = cfg.proposers;
        cfg.guardian = makeAddr("guardianSafe");
        cfg.treasury = makeAddr("treasurySafe");
        cfg.operators = _one(makeAddr("operator"));
        cfg.publishers = _one(makeAddr("publisher"));
        cfg.fundingKeepers = _one(makeAddr("fundingKeeper"));
        cfg.feeTierBots = _one(makeAddr("tierBot"));
        for (uint256 i = 0; i < cfg.markets.length; ++i) {
            address agg = cfg.markets[i].ref.aggregator;
            if (cfg.markets[i].ref.enabled && agg.code.length == 0) {
                deployCodeTo("MockAggregator.sol:MockAggregator", abi.encode(uint8(8)), agg);
            }
        }
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }
}
