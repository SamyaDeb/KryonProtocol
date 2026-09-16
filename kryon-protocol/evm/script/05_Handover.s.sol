// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeployScript} from "./lib/DeployScript.sol";
import {DeployConfig, Deployment, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Step 05: every admin role to the timelock; the deployer renounces its own.
contract Handover is DeployScript {
    function run() external {
        DeployConfig memory cfg = loadConfig();
        preflight(cfg);
        Deployment memory d = loadDeployment();
        vm.startBroadcast(deployer());
        KryonDeploy.handover(d, deployer());
        vm.stopBroadcast();
    }
}
