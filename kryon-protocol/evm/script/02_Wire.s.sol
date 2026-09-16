// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeployScript} from "./lib/DeployScript.sol";
import {DeployConfig, Deployment, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Step 02: contract wiring, protocol roles, service keys, guardian.
contract Wire is DeployScript {
    function run() external {
        DeployConfig memory cfg = loadConfig();
        preflight(cfg);
        Deployment memory d = loadDeployment();
        vm.startBroadcast(deployer());
        KryonDeploy.wire(d, cfg, deployer());
        vm.stopBroadcast();
    }
}
