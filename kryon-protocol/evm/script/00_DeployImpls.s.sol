// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonTimelock} from "../src/governance/KryonTimelock.sol";
import {DeployScript} from "./lib/DeployScript.sol";
import {DeployConfig, Implementations, KryonDeploy} from "./lib/KryonDeploy.sol";

/// @notice Step 00: implementation contracts and the governance timelock.
/// @dev KRYON_NETWORK=arc-testnet arc-forge script script/00_DeployImpls.s.sol \
///        --rpc-url $ARC_TESTNET_RPC_URL --account <keystore> --broadcast
contract DeployImpls is DeployScript {
    function run() external {
        DeployConfig memory cfg = loadConfig();
        preflight(cfg);
        vm.startBroadcast(deployer());
        Implementations memory impls = KryonDeploy.deployImplementations();
        KryonTimelock timelock = KryonDeploy.deployTimelock(cfg);
        vm.stopBroadcast();
        saveImplementations(impls, timelock);
    }
}
