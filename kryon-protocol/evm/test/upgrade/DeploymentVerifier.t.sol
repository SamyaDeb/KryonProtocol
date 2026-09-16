// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeploymentVerifier} from "../../script/lib/DeploymentVerifier.sol";
import {DeployConfig} from "../../script/lib/KryonDeploy.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract DeploymentVerifierTest is KryonTest {
    function _failures() internal view returns (string[] memory) {
        return DeploymentVerifier.verify(d, baseConfig(), deployer);
    }

    function test_a_correct_deployment_passes() public view {
        string[] memory f = _failures();
        for (uint256 i = 0; i < f.length; ++i) console2_log(f[i]);
        assertEq(f.length, 0);
    }

    function test_flags_an_eoa_holding_an_admin_role() public {
        asGov();
        engine.grantRole(Roles.UPGRADER_ROLE, makeAddr("rogueEOA"));
        string[] memory f = _failures();
        assertGt(f.length, 0);
        assertEq(f[0], "Engine: an EOA holds UPGRADER_ROLE");
    }

    function test_flags_a_fee_schedule_that_differs_from_config() public {
        asGov();
        feeRouter.setMarketFees(BTC, 50, 400);
        string[] memory f = _failures();
        assertEq(f.length, 1);
        assertEq(f[0], "FeeRouter: schedule differs for BTC-PERP");
    }

    function test_flags_risk_param_drift_and_extra_operators() public {
        vm.startPrank(address(timelock));
        risk.setOiPolicy(ETH, 10_000);
        gateway.grantRole(Roles.OPERATOR_ROLE, makeAddr("extraOperator"));
        vm.stopPrank();
        string[] memory f = _failures();
        assertEq(f.length, 2);
    }

    function test_flags_a_vetoed_timelock_and_open_deposits_on_a_closed_config() public {
        vm.prank(guardian);
        timelock.pauseExecution();
        DeployConfig memory cfg = baseConfig();
        cfg.openDepositsAtDeploy = false;
        string[] memory f = DeploymentVerifier.verify(d, cfg, deployer);
        assertEq(f.length, 2);
    }

    function console2_log(string memory) internal pure {}
}
