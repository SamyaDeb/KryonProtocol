// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeployScript} from "./lib/DeployScript.sol";
import {DeployConfig, Deployment, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Step 03: oracle feeds, market risk params, funding, OI policy.
contract ConfigureMarkets is DeployScript {
    function run() external {
        DeployConfig memory cfg = loadConfig();
        preflight(cfg);
        Deployment memory d = loadDeployment();
        vm.startBroadcast(deployer());
        KryonDeploy.configureMarkets(d, cfg);
        vm.stopBroadcast();
    }
}
