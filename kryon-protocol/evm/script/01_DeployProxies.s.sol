// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonTimelock} from "../src/governance/KryonTimelock.sol";
import {DeployScript} from "./lib/DeployScript.sol";
import {DeployConfig, Deployment, Implementations, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Step 01: ERC1967 proxies, initialized with the deployer as admin.
contract DeployProxies is DeployScript {
    function run() external {
        DeployConfig memory cfg = loadConfig();
        preflight(cfg);
        (Implementations memory impls, KryonTimelock timelock) = loadImplementations();
        vm.startBroadcast(deployer());
        Deployment memory d = KryonDeploy.deployProxies(impls, cfg, deployer(), timelock);
        vm.stopBroadcast();
        saveProxies(d);
    }
}
