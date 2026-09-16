// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeployScript} from "./lib/DeployScript.sol";
import {DeploymentVerifier} from "./lib/DeploymentVerifier.sol";
import {DeployConfig, Deployment, Implementations, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Steps 00-05 in one broadcast, then the 99 checks in-process.
///         Handover happens in the same run that configured everything, so
///         the deployer never holds admin roles past this script.
contract DeployAll is DeployScript {
    function run() external {
        DeployConfig memory cfg = loadConfig();
        preflight(cfg);
        address who = deployer();
        vm.startBroadcast(who);
        (Deployment memory d, Implementations memory impls) = KryonDeploy.deployAll(cfg, who);
        vm.stopBroadcast();
        saveImplementations(impls, d.timelock);
        saveProxies(d);
        string[] memory failures = DeploymentVerifier.verify(d, cfg, who);
        require(failures.length == 0, failures.length == 0 ? "" : failures[0]);
    }
}
