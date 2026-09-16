// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {Roles} from "../../src/governance/Roles.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {KryonTest} from "../utils/KryonTest.sol";

/// @notice Ports of the perp-insurance staking tests. Token amounts are USDC
///         (6 dp); balances and shares are 1e18 internal units.
contract InsuranceTest is KryonTest {
    function _give(address who, uint256 amount6) internal {
        usdc.mint(who, amount6);
        vm.prank(who);
        usdc.approve(address(insurance), type(uint256).max);
    }

    function _stake(address who, uint256 amount6) internal returns (int256) {
        _give(who, amount6);
        vm.prank(who);
        return insurance.stake(amount6);
    }

    function _sweep(int256 amount) internal {
        asGov();
        insurance.sweepToOperating(amount);
    }

    function _mature() internal {
        vm.warp(_now() + insurance.UNSTAKE_COOLDOWN() + 1);
    }

    function test_first_staker_gets_shares_1to1_and_cannot_claim_prior_donations() public {
        _give(treasury, 1000e6);
        vm.prank(treasury);
        insurance.donate(1000e6);

        int256 minted = _stake(alice, 100e6);
        assertEq(minted, 100 * P);
        assertEq(insurance.totalShares(), 100 * P);
        assertEq(insurance.stakedBalance(), 100 * P);
        assertEq(insurance.operatingBalance(), 1000 * P);
    }

    function test_a_second_staker_is_priced_against_staked_nav_not_donations() public {
        _give(treasury, 1000e6);
        vm.prank(treasury);
        insurance.donate(1000e6);
        _stake(alice, 100e6);
        _sweep(50 * P);
        assertEq(insurance.stakedBalance(), 50 * P);
        assertEq(insurance.operatingBalance(), 1050 * P);

        int256 minted = _stake(bob, 50e6);
        assertEq(minted, 100 * P);
        assertEq(insurance.totalShares(), 200 * P);
        assertEq(insurance.stakedBalance(), 100 * P);
    }

    function test_a_wiped_pool_does_not_dilute_the_staker_who_refills_it() public {
        _stake(alice, 1000e6);
        _sweep(1000 * P);
        assertEq(insurance.stakedBalance(), 0);
        assertEq(insurance.totalShares(), 0, "a wipe retires the outstanding shares");
        assertEq(insurance.sharesOf(alice), 0);
        assertEq(insurance.epoch(), 1);

        assertEq(_stake(bob, 100e6), 100 * P);
        vm.prank(bob);
        insurance.requestUnstake(100 * P);
        _mature();
        vm.prank(bob);
        assertEq(insurance.withdrawUnstaked(), 100e6, "the refilling staker owns all of it");
        assertEq(usdc.balanceOf(bob), 100e6);
    }

    function test_a_request_from_a_retired_epoch_pays_nothing() public {
        _stake(alice, 1000e6);
        vm.prank(alice);
        insurance.requestUnstake(1000 * P);
        _sweep(1000 * P);
        _stake(bob, 500e6);
        _mature();
        vm.prank(alice);
        assertEq(insurance.withdrawUnstaked(), 0);
        assertEq(insurance.stakedBalance(), 500 * P);
        assertEq(insurance.sharesOf(bob), 500 * P);
    }

    function test_unstake_is_gated_by_cooldown() public {
        _stake(alice, 100e6);
        vm.prank(alice);
        uint64 unlock = insurance.requestUnstake(100 * P);
        vm.prank(alice);
        vm.expectRevert(Errors.CooldownActive.selector);
        insurance.withdrawUnstaked();

        vm.warp(unlock);
        vm.prank(alice);
        assertEq(insurance.withdrawUnstaked(), 100e6);
        assertEq(insurance.totalShares(), 0);
        assertEq(insurance.stakedBalance(), 0);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertSolvencyExact();
    }

    function test_a_sweep_between_request_and_withdrawal_is_absorbed_by_the_staker() public {
        _stake(alice, 100e6);
        vm.prank(alice);
        insurance.requestUnstake(100 * P);
        _sweep(50 * P);
        _mature();
        vm.prank(alice);
        assertEq(insurance.withdrawUnstaked(), 50e6);
    }

    function test_sweep_only_moves_what_is_actually_staked() public {
        _stake(alice, 30e6);
        asGov();
        assertEq(insurance.sweepToOperating(1000 * P), 30 * P);
        assertEq(insurance.stakedBalance(), 0);
        assertEq(insurance.operatingBalance(), 30 * P);
    }

    function test_share_price_reflects_a_sweep() public {
        assertEq(insurance.sharePrice(), P);
        _stake(alice, 100e6);
        assertEq(insurance.sharePrice(), P);
        _sweep(50 * P);
        assertEq(insurance.sharePrice(), P / 2);
    }

    // ------------------------------------------------------------- guards

    function test_one_pending_request_at_a_time_and_bounds() public {
        _stake(alice, 100e6);
        vm.startPrank(alice);
        vm.expectRevert(Errors.InvalidAmount.selector);
        insurance.requestUnstake(0);
        vm.expectRevert(Errors.InsufficientCollateral.selector);
        insurance.requestUnstake(101 * P);
        insurance.requestUnstake(40 * P);
        vm.expectRevert(Errors.UnstakePending.selector);
        insurance.requestUnstake(10 * P);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(Errors.NoPendingUnstake.selector);
        insurance.withdrawUnstaked();

        vm.expectRevert(Errors.InvalidAmount.selector);
        insurance.stake(0);
        vm.expectRevert(Errors.InvalidAmount.selector);
        insurance.donate(0);
    }

    function test_partial_unstake_leaves_the_rest_staked() public {
        _stake(alice, 100e6);
        vm.prank(alice);
        insurance.requestUnstake(40 * P);
        _mature();
        vm.prank(alice);
        assertEq(insurance.withdrawUnstaked(), 40e6);
        assertEq(insurance.sharesOf(alice), 60 * P);
        assertEq(insurance.stakedBalance(), 60 * P);
    }

    function test_sweep_is_governance_only() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(this),
                Roles.DEFAULT_ADMIN_ROLE
            )
        );
        insurance.sweepToOperating(1);
        asGov();
        vm.expectRevert(Errors.InvalidAmount.selector);
        insurance.sweepToOperating(0);
    }

    function test_settle_bad_debt_guards() public {
        vm.expectRevert(Errors.InsuranceAccount.selector);
        insurance.settleBadDebt(address(insurance));
        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 100 * P);
        vm.expectRevert(Errors.HasOpenPositions.selector);
        insurance.settleBadDebt(bob);
        // A solvent, flat account: nothing to cover, nothing recorded.
        address flat = newTrader("flat", 1e6);
        assertEq(insurance.settleBadDebt(flat), 0);
        assertEq(insurance.badDebt(), 0);
    }

    function test_effective_balance_nets_bad_debt_and_never_goes_negative() public {
        assertEq(insurance.effectiveBalance(), 0);
        _give(treasury, 5e6);
        vm.prank(treasury);
        insurance.donate(5e6);
        assertEq(insurance.effectiveBalance(), 5 * P);
        _stake(alice, 100e6);
        assertEq(insurance.effectiveBalance(), 5 * P, "staked capital is not operating capital");
    }
}
