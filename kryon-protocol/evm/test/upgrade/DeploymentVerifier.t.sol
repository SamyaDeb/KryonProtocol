// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeploymentVerifier} from "../../script/lib/DeploymentVerifier.sol";
import {DeployConfig} from "../../script/lib/KryonDeploy.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {MarketParams} from "../../src/libraries/Types.sol";
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

    function test_flags_active_pauses_and_running_cooldowns() public {
        vm.prank(guardian);
        vault.pause();
        asGov();
        engine.pauseIndefinitely();
        string[] memory f = _failures();
        assertEq(f.length, 2);
        assertEq(f[0], "Vault: guardian pause active");
        assertEq(f[1], "Engine: paused indefinitely");

        // After expiry the guardian cooldown and a lifted veto still show up.
        vm.warp(_now() + 72 hours);
        asGov();
        engine.unpause();
        vm.prank(guardian);
        timelock.pauseExecution();
        vm.warp(_now() + 7 days - 1);
        push(BTC_ID, 100 * P);
        push(ETH_ID, 2000 * P);
        f = _failures();
        assertEq(f.length, 1);
        assertEq(f[0], "Timelock: execution is vetoed");
        vm.warp(_now() + 1);
        f = _failures();
        assertEq(f.length, 1);
        assertEq(f[0], "Timelock: guardian veto cooldown active");
        vm.warp(_now() + 3 days);
        assertEq(_failures().length, 0);
    }

    // ----------------------------------------- exact timelock role sets (fix 6)

    function _asTimelock(bytes32 role, address who) internal {
        vm.prank(address(timelock));
        timelock.grantRole(role, who);
    }

    function test_timelock_roles_are_enumerable() public view {
        assertEq(timelock.getRoleMemberCount(timelock.PROPOSER_ROLE()), 1);
        assertEq(timelock.getRoleMember(timelock.PROPOSER_ROLE(), 0), governance);
        assertEq(timelock.getRoleMember(timelock.CANCELLER_ROLE(), 0), governance);
        assertEq(timelock.getRoleMember(timelock.EXECUTOR_ROLE(), 0), governance);
        assertEq(timelock.getRoleMembers(timelock.DEFAULT_ADMIN_ROLE())[0], address(timelock));
        assertEq(timelock.getRoleMember(Roles.PAUSER_ROLE, 0), guardian);
    }

    function test_flags_an_extra_timelock_proposer() public {
        _asTimelock(timelock.PROPOSER_ROLE(), makeAddr("rogueProposer"));
        string[] memory f = _failures();
        assertEq(f.length, 1);
        assertEq(f[0], "Timelock: PROPOSER_ROLE holders differ from config");
    }

    function test_flags_an_extra_timelock_executor() public {
        _asTimelock(timelock.EXECUTOR_ROLE(), makeAddr("rogueExecutor"));
        string[] memory f = _failures();
        assertEq(f.length, 1);
        assertEq(f[0], "Timelock: EXECUTOR_ROLE holders differ from config");
    }

    function test_flags_an_extra_timelock_canceller() public {
        _asTimelock(timelock.CANCELLER_ROLE(), makeAddr("rogueCanceller"));
        string[] memory f = _failures();
        assertEq(f.length, 1);
        assertEq(f[0], "Timelock: CANCELLER_ROLE holders differ from config");
    }

    function test_flags_an_extra_timelock_admin_or_veto_holder() public {
        _asTimelock(timelock.DEFAULT_ADMIN_ROLE(), makeAddr("rogueAdmin"));
        _asTimelock(Roles.PAUSER_ROLE, makeAddr("rogueGuardian"));
        string[] memory f = _failures();
        assertEq(f.length, 2);
        assertEq(f[0], "Timelock: DEFAULT_ADMIN_ROLE holders differ from config");
        assertEq(f[1], "Timelock: PAUSER_ROLE holders differ from config");

        // Revocation keeps the enumeration in sync.
        vm.startPrank(address(timelock));
        timelock.revokeRole(timelock.DEFAULT_ADMIN_ROLE(), makeAddr("rogueAdmin"));
        timelock.revokeRole(Roles.PAUSER_ROLE, makeAddr("rogueGuardian"));
        vm.stopPrank();
        assertEq(_failures().length, 0);
    }

    // ------------------------------------------- liquidation reward warning (fix 7)

    function test_warns_when_the_reward_consumes_the_whole_penalty() public {
        // Fixture: max reward 50 bps; BTC fee 50, ETH fee 35. Both active.
        string[] memory w = DeploymentVerifier.warnings(d, baseConfig());
        assertEq(w.length, 2);
        assertEq(
            w[0],
            "BTC-PERP: liquidation fee (50 bps) <= max liquidator reward (50 bps); insurance and treasury receive nothing from its liquidations"
        );
        assertEq(_failures().length, 0, "a warning, not a failure");

        vm.startPrank(address(timelock));
        MarketParams memory eth = risk.market(ETH);
        eth.active = false;
        risk.setMarket(ETH, eth);
        vm.stopPrank();
        assertEq(DeploymentVerifier.warnings(d, baseConfig()).length, 1, "inactive markets are skipped");

        asGov();
        liquidation.setParams(15, 5000);
        assertEq(DeploymentVerifier.warnings(d, baseConfig()).length, 0);
    }

    function console2_log(string memory) internal pure {}
}
