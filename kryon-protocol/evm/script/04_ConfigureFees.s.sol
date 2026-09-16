// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeployScript} from "./lib/DeployScript.sol";
import {DeployConfig, Deployment, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Step 04: fee schedule, net floor, split, flags.
contract ConfigureFees is DeployScript {
    function run() external {
        DeployConfig memory cfg = loadConfig();
        preflight(cfg);
        Deployment memory d = loadDeployment();
        vm.startBroadcast(deployer());
        KryonDeploy.configureFees(d, cfg);
        vm.stopBroadcast();
    }
}
