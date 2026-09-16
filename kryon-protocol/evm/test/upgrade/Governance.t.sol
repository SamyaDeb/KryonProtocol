// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAccessControlEnumerable} from
    "@openzeppelin/contracts/access/extensions/IAccessControlEnumerable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {KryonDeploy} from "../../script/lib/KryonDeploy.sol";
import {Vault} from "../../src/Vault.sol";
import {KryonTimelock} from "../../src/governance/KryonTimelock.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {VaultV2, EngineV2} from "../mocks/UpgradeMocks.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract GovernanceTest is KryonTest {
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function _schedule(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(governance);
        timelock.schedule(target, 0, data, bytes32(0), salt, 48 hours);
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(governance);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    // ---------------------------------------------------- Soroban ports

    function test_rejects_delay_below_48h() public {
        vm.expectRevert(Errors.InvalidConfig.selector);
        new KryonTimelock(1 hours, _one(governance), _one(governance), guardian);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new KryonTimelock(48 hours, _one(governance), _one(governance), address(0));
        assertEq(timelock.getMinDelay(), 48 hours);
        vm.prank(address(timelock));
        vm.expectRevert(Errors.InvalidConfig.selector);
        timelock.updateDelay(47 hours);
    }

    function test_rejects_short_timelock_eta() public {
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 1 hours, 48 hours)
        );
        timelock.schedule(address(vault), 0, "", bytes32(0), bytes32(0), 1 hours);
    }

    function test_queues_and_executes_an_upgrade_after_the_delay() public {
        fund(alice, 10e6);
        address v2 = address(new VaultV2());
        bytes memory call = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (v2, ""));
        _schedule(address(vault), call, "upgrade");

        vm.prank(governance);
        vm.expectRevert();
        timelock.execute(address(vault), 0, call, bytes32(0), "upgrade");

        vm.warp(_now() + 48 hours);
        _execute(address(vault), call, "upgrade");
        assertEq(address(uint160(uint256(vm.load(address(vault), IMPL_SLOT)))), v2);
        assertEq(VaultV2(address(vault)).version(), 2);
        assertEq(bal(alice), 10 * P, "state survives the upgrade");

        vm.prank(governance);
        vm.expectRevert();
        timelock.execute(address(vault), 0, call, bytes32(0), "upgrade");
    }

    function test_guardian_veto() public {
        bytes memory call = abi.encodeCall(Vault.setDepositCaps, (1, 1));
        bytes memory lift = abi.encodeCall(KryonTimelock.unpauseExecution, ());
        _schedule(address(vault), call, "caps");
        _schedule(address(timelock), lift, "lift");
        vm.warp(_now() + 48 hours);

        vm.prank(guardian);
        timelock.pauseExecution();
        assertTrue(timelock.executionPaused());

        vm.prank(governance);
        vm.expectRevert(Errors.ExecutionPaused.selector);
        timelock.execute(address(vault), 0, call, bytes32(0), "caps");

        address[] memory targets = new address[](1);
        targets[0] = address(vault);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = call;
        vm.prank(governance);
        vm.expectRevert(Errors.ExecutionPaused.selector);
        timelock.executeBatch(targets, values, payloads, bytes32(0), "batch");

        vm.prank(guardian);
        vm.expectRevert(Errors.Unauthorized.selector);
        timelock.unpauseExecution();

        // Lifting the veto is itself a timelocked operation.
        _execute(address(timelock), lift, "lift");
        assertFalse(timelock.executionPaused());
        _execute(address(vault), call, "caps");
        (uint256 total,) = vault.depositCaps();
        assertEq(total, 1);
    }

    function test_only_governance_can_schedule_and_only_guardian_can_veto() public {
        vm.prank(alice);
        vm.expectRevert();
        timelock.schedule(address(vault), 0, "", bytes32(0), bytes32(0), 48 hours);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, Roles.PAUSER_ROLE
            )
        );
        timelock.pauseExecution();
    }

    // ---------------------------------------------------------- handover

    function test_after_handover_only_the_timelock_holds_admin_roles() public view {
        address[8] memory all = KryonDeploy.proxies(d);
        bytes32[4] memory adminRoles =
            [Roles.DEFAULT_ADMIN_ROLE, Roles.UPGRADER_ROLE, Roles.RISK_ADMIN_ROLE, Roles.FEE_ADMIN_ROLE];
        for (uint256 i = 0; i < all.length; ++i) {
            IAccessControlEnumerable c = IAccessControlEnumerable(all[i]);
            for (uint256 r = 0; r < adminRoles.length; ++r) {
                assertEq(c.getRoleMemberCount(adminRoles[r]), 1, "exactly one admin holder");
                assertEq(c.getRoleMember(adminRoles[r], 0), address(timelock));
            }
            assertFalse(c.hasRole(Roles.PAUSER_ROLE, deployer));
            assertTrue(c.hasRole(Roles.PAUSER_ROLE, guardian));
            assertFalse(c.hasRole(Roles.DEFAULT_ADMIN_ROLE, guardian));
        }
        // The timelock administers itself; nobody else holds its admin role.
        assertEq(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)), true);
        assertEq(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer), false);
    }

    function test_deployer_can_no_longer_upgrade_or_configure() public {
        address v2 = address(new EngineV2());
        vm.startPrank(deployer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, Roles.UPGRADER_ROLE
            )
        );
        engine.upgradeToAndCall(v2, "");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, Roles.RISK_ADMIN_ROLE
            )
        );
        vault.setDepositCaps(1, 1);
        vm.stopPrank();
    }

    function test_implementations_cannot_be_initialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        Vault(impls.vault).initialize(alice, address(usdc), address(permit2));
    }

    function test_proxies_cannot_be_reinitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(alice, address(usdc), address(permit2));
    }

    function test_proxies_point_at_their_implementations() public view {
        assertEq(address(uint160(uint256(vm.load(address(vault), IMPL_SLOT)))), impls.vault);
        assertEq(address(uint160(uint256(vm.load(address(engine), IMPL_SLOT)))), impls.engine);
        assertEq(address(uint160(uint256(vm.load(address(gateway), IMPL_SLOT)))), impls.gateway);
        assertEq(address(uint160(uint256(vm.load(address(feeRouter), IMPL_SLOT)))), impls.feeRouter);
    }

    function test_engine_upgrade_keeps_positions() public {
        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 100 * P);
        address v2 = address(new EngineV2());
        bytes memory call = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (v2, ""));
        _schedule(address(engine), call, "engine");
        vm.warp(_now() + 48 hours);
        _execute(address(engine), call, "engine");
        assertEq(EngineV2(address(engine)).version(), 2);
        assertEq(pos(bob, BTC).size, P);
        assertSolvencyExact();
    }
}
