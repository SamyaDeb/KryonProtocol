// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";

import {DeployScript} from "./lib/DeployScript.sol";
import {DeploymentVerifier} from "./lib/DeploymentVerifier.sol";
import {DeployConfig, Deployment, Implementations, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Step 99: fails if any EOA holds an admin role, wiring is wrong, or
///         fees / risk params / oracle feeds differ from the environment config.
///         Read-only; safe to run against mainnet at any time.
contract VerifyDeployment is DeployScript {
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function run() external {
        DeployConfig memory cfg = loadConfig();
        require(block.chainid == cfg.chainId, "chain id does not match the environment config");
        Deployment memory d = loadDeployment();
        (Implementations memory impls,) = loadImplementations();
        address expectedDeployer = vm.envOr("DEPLOYER_ADDRESS", address(0));

        string[] memory failures = DeploymentVerifier.verify(d, cfg, expectedDeployer);
        uint256 extra = _implementationChecks(d, impls);

        string[] memory warnings = DeploymentVerifier.warnings(d, cfg);
        for (uint256 i = 0; i < warnings.length; ++i) console2.log(string.concat("WARN ", warnings[i]));
        for (uint256 i = 0; i < failures.length; ++i) console2.log(string.concat("FAIL ", failures[i]));
        if (failures.length + extra > 0) revert("99_VerifyDeployment: FAILED");
        console2.log("99_VerifyDeployment: OK");
        _writeReport(d, impls);
    }

    function _implementationChecks(Deployment memory d, Implementations memory i)
        internal
        view
        returns (uint256 bad)
    {
        address[8] memory proxies = KryonDeploy.proxies(d);
        address[8] memory expected =
            [i.vault, i.engine, i.gateway, i.oracle, i.liquidation, i.insurance, i.risk, i.feeRouter];
        for (uint256 k = 0; k < proxies.length; ++k) {
            address impl = address(uint160(uint256(vm.load(proxies[k], IMPL_SLOT))));
            if (impl != expected[k]) {
                console2.log(string.concat("FAIL implementation drift at ", vm.toString(proxies[k])));
                ++bad;
            }
            if (proxies[k].code.length == 0 || impl.code.length == 0) {
                console2.log(string.concat("FAIL no code at ", vm.toString(proxies[k])));
                ++bad;
            }
        }
    }

    /// @dev Proxies, implementations and runtime code hashes, for
    ///      infra/deploy/arc-<network>-deployment.json.
    function _writeReport(Deployment memory d, Implementations memory i) internal {
        address[8] memory proxies = KryonDeploy.proxies(d);
        address[8] memory impls = [i.vault, i.engine, i.gateway, i.oracle, i.liquidation, i.insurance, i.risk, i.feeRouter];
        string[8] memory names = ["vault", "engine", "gateway", "oracle", "liquidation", "insurance", "risk", "feeRouter"];
        string memory root = "verified";
        for (uint256 k = 0; k < proxies.length; ++k) {
            string memory c = names[k];
            vm.serializeAddress(c, "proxy", proxies[k]);
            vm.serializeAddress(c, "implementation", impls[k]);
            string memory entry = vm.serializeBytes32(c, "codeHash", impls[k].codehash);
            vm.serializeString(root, names[k], entry);
        }
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "verifiedAtBlock", block.number);
        string memory out = vm.serializeAddress(root, "timelock", address(d.timelock));
        vm.writeJson(out, string.concat(vm.projectRoot(), "/deployments/", networkName(), "-verified.json"));
    }
}
