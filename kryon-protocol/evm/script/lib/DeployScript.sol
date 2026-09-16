// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Engine} from "../../src/Engine.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Insurance} from "../../src/Insurance.sol";
import {Liquidation} from "../../src/Liquidation.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {OrderGateway} from "../../src/OrderGateway.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {Vault} from "../../src/Vault.sol";
import {KryonTimelock} from "../../src/governance/KryonTimelock.sol";
import {ConfigLoader} from "./ConfigLoader.sol";
import {DeployConfig, Deployment, Implementations} from "./KryonDeploy.sol";

/// @notice Shared plumbing for the numbered deploy scripts: config, the
///         deployment record, and the guard rails every step runs first.
abstract contract DeployScript is ConfigLoader {
    uint256 internal constant ARC_MAINNET = 5042;

    function deployer() internal view returns (address) {
        return vm.envOr("DEPLOYER_ADDRESS", msg.sender);
    }

    /// @notice Refuse to run against the wrong chain, against mainnet without an
    ///         explicit opt-in, or with placeholder governance addresses.
    function preflight(DeployConfig memory cfg) internal view {
        require(block.chainid == cfg.chainId, "chain id does not match the environment config");
        if (block.chainid == ARC_MAINNET) {
            require(vm.envOr("KRYON_ALLOW_MAINNET", false), "mainnet deploy requires KRYON_ALLOW_MAINNET=true");
        }
        require(cfg.guardian != address(0), "config: governance.guardian is a placeholder");
        require(cfg.treasury != address(0), "config: governance.treasury is a placeholder");
        require(cfg.proposers.length > 0 && cfg.executors.length > 0, "config: timelock proposers/executors empty");
        require(cfg.operators.length > 0, "config: roles.operators empty");
        require(cfg.publishers.length > 0, "config: roles.publishers empty");
        require(cfg.fundingKeepers.length > 0, "config: roles.funding_keepers empty");
        if (block.chainid == ARC_MAINNET) {
            // Governance, guardian and treasury must be Safes, never EOAs.
            for (uint256 i = 0; i < cfg.proposers.length; ++i) {
                require(cfg.proposers[i].code.length > 0, "mainnet: proposer must be a contract (Safe)");
            }
            require(cfg.guardian.code.length > 0, "mainnet: guardian must be a contract (Safe)");
            require(cfg.treasury.code.length > 0, "mainnet: treasury must be a contract (Safe)");
            require(!cfg.openDepositsAtDeploy, "mainnet: deposits open only after 99_VerifyDeployment");
        }
    }

    // ------------------------------------------------------ deployment record

    function saveImplementations(Implementations memory i, KryonTimelock timelock) internal {
        string memory k = "impls";
        vm.serializeAddress(k, "vault", i.vault);
        vm.serializeAddress(k, "engine", i.engine);
        vm.serializeAddress(k, "gateway", i.gateway);
        vm.serializeAddress(k, "oracle", i.oracle);
        vm.serializeAddress(k, "liquidation", i.liquidation);
        vm.serializeAddress(k, "insurance", i.insurance);
        vm.serializeAddress(k, "risk", i.risk);
        string memory implsJson = vm.serializeAddress(k, "feeRouter", i.feeRouter);
        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "timelock", address(timelock));
        string memory out = vm.serializeString(root, "implementations", implsJson);
        vm.writeJson(out, deploymentPath());
    }

    function saveProxies(Deployment memory d) internal {
        string memory k = "proxies";
        vm.serializeAddress(k, "vault", address(d.vault));
        vm.serializeAddress(k, "engine", address(d.engine));
        vm.serializeAddress(k, "gateway", address(d.gateway));
        vm.serializeAddress(k, "oracle", address(d.oracle));
        vm.serializeAddress(k, "liquidation", address(d.liquidation));
        vm.serializeAddress(k, "insurance", address(d.insurance));
        vm.serializeAddress(k, "risk", address(d.risk));
        string memory proxiesJson = vm.serializeAddress(k, "feeRouter", address(d.feeRouter));
        vm.writeJson(proxiesJson, deploymentPath(), ".proxies");
    }

    function loadImplementations() internal view returns (Implementations memory i, KryonTimelock timelock) {
        string memory j = vm.readFile(deploymentPath());
        require(vm.parseJsonUint(j, ".chainId") == block.chainid, "deployment record is for another chain");
        timelock = KryonTimelock(payable(vm.parseJsonAddress(j, ".timelock")));
        i.vault = vm.parseJsonAddress(j, ".implementations.vault");
        i.engine = vm.parseJsonAddress(j, ".implementations.engine");
        i.gateway = vm.parseJsonAddress(j, ".implementations.gateway");
        i.oracle = vm.parseJsonAddress(j, ".implementations.oracle");
        i.liquidation = vm.parseJsonAddress(j, ".implementations.liquidation");
        i.insurance = vm.parseJsonAddress(j, ".implementations.insurance");
        i.risk = vm.parseJsonAddress(j, ".implementations.risk");
        i.feeRouter = vm.parseJsonAddress(j, ".implementations.feeRouter");
    }

    function loadDeployment() internal view returns (Deployment memory d) {
        string memory j = vm.readFile(deploymentPath());
        (, d.timelock) = loadImplementations();
        d.vault = Vault(vm.parseJsonAddress(j, ".proxies.vault"));
        d.engine = Engine(vm.parseJsonAddress(j, ".proxies.engine"));
        d.gateway = OrderGateway(vm.parseJsonAddress(j, ".proxies.gateway"));
        d.oracle = OracleAdapter(vm.parseJsonAddress(j, ".proxies.oracle"));
        d.liquidation = Liquidation(vm.parseJsonAddress(j, ".proxies.liquidation"));
        d.insurance = Insurance(vm.parseJsonAddress(j, ".proxies.insurance"));
        d.risk = RiskParams(vm.parseJsonAddress(j, ".proxies.risk"));
        d.feeRouter = FeeRouter(vm.parseJsonAddress(j, ".proxies.feeRouter"));
    }
}
