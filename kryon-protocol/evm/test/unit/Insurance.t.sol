// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {Roles} from "../../src/governance/Roles.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
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

    // ----------------------------------- mark-to-market backstop (review fix 3)

    function _price(int256 price) internal {
        vm.warp(_now() + 1);
        push(BTC_ID, price);
    }

    /// Bob goes long 100 BTC at 100 against alice; the index crashes to 10 and
    /// bob is liquidated in full, so the backstop holds long 100 at 10.
    function _backstopTakesLong() internal {
        fund(alice, 100_000e6);
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        _price(10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        assertEq(pos(address(insurance), BTC).size, 100 * P);
    }

    function test_account_value_marks_positions_and_flags_stale_prices() public {
        _backstopTakesLong();
        (int256 equity, bool priced) = engine.accountValue(address(insurance));
        assertTrue(priced);
        assertEq(equity, engine.accountHealth(address(insurance)).equity);
        _price(8 * P);
        (int256 lower,) = engine.accountValue(address(insurance));
        assertEq(lower, equity - 200 * P, "100 units x 2 of index move");

        vm.warp(_now() + 61);
        (equity, priced) = engine.accountValue(address(insurance));
        assertFalse(priced);
        assertEq(equity, 0);
        // A flat account needs no price.
        (equity, priced) = engine.accountValue(carol);
        assertTrue(priced);
    }

    function test_shortfall_counts_the_backstop_positions_unrealized_loss() public {
        _backstopTakesLong();
        int256 debt = insurance.badDebt();
        assertGt(debt, 0);
        // Refill cash past the recorded debt without settling it: in cash the
        // debt looks funded.
        _give(treasury, uint256(debt / 1e12) + 200);
        vm.prank(treasury);
        insurance.donate(uint256(debt / 1e12) + 200);
        assertEq(insurance.unfundedShortfall(), 0);
        assertGt(insurance.operatingBalance(), debt);

        // The backstop's long loses 500; marked capital no longer covers the debt.
        _price(5 * P);
        (int256 marked,) = insurance.markedOperatingBalance();
        assertEq(marked, insurance.operatingBalance() - 500 * P);
        int256 shortfall = insurance.unfundedShortfall();
        assertEq(shortfall, debt - marked);
        assertGt(shortfall, 0);

        // ADL may now pay it down from the in-profit short.
        vm.prank(carol);
        int256 closed = liquidation.adl(alice, BTC, type(uint256).max);
        assertGt(closed, 0);
        assertLt(insurance.unfundedShortfall(), shortfall);
        assertSolvencyExact();
    }

    function test_effective_balance_drops_as_the_backstop_loses() public {
        _give(treasury, 20_000e6);
        vm.prank(treasury);
        insurance.donate(20_000e6);
        _backstopTakesLong();
        assertEq(insurance.badDebt(), 0);
        int256 cash = insurance.operatingBalance();
        assertEq(insurance.effectiveBalance(), cash);

        _price(9 * P);
        assertEq(insurance.effectiveBalance(), cash - 100 * P);
        _price(6 * P);
        assertEq(insurance.effectiveBalance(), cash - 400 * P);
        assertEq(insurance.operatingBalance(), cash, "cash is unchanged");
        _price(12 * P);
        assertEq(insurance.effectiveBalance(), cash + 200 * P);
    }

    function test_an_unstake_under_water_absorbs_the_loss_pro_rata() public {
        address s1 = makeAddr("staker1");
        address s2 = makeAddr("staker2");
        _stake(s1, 1000e6);
        _stake(s2, 1000e6);
        _backstopTakesLong(); // no operating cash: the whole deficit is bad debt
        assertEq(insurance.operatingBalance(), 0);

        _price(5 * P); // backstop long loses 500
        (int256 marked,) = insurance.markedOperatingBalance();
        assertEq(marked, -500 * P);
        assertEq(insurance.redeemableStake(), 1500 * P);

        vm.prank(s1);
        insurance.requestUnstake(1000 * P);
        vm.prank(s2);
        insurance.requestUnstake(500 * P);
        _mature();
        push(BTC_ID, 5 * P);

        vm.prank(s1);
        assertEq(insurance.withdrawUnstaked(), 750e6, "not the full 1000");
        assertEq(insurance.stakedBalance(), 1250 * P);
        assertEq(insurance.redeemableStake(), 750 * P);
        // Same 0.75 per share for the staker who stays. (A full exit would take
        // the backstop account below initial margin, which the vault refuses.)
        vm.prank(s2);
        assertEq(insurance.withdrawUnstaked(), 375e6, "the remaining staker is not diluted");
        assertEq(insurance.redeemableStake(), 375 * P);
        assertEq(insurance.totalShares(), 500 * P);
        assertSolvencyExact();
    }

    function test_stale_backstop_price_fails_closed() public {
        _stake(carol, 100e6);
        _backstopTakesLong();
        vm.prank(carol);
        insurance.requestUnstake(100 * P);
        _mature(); // no republish: the BTC index is stale

        assertEq(insurance.effectiveBalance(), 0);
        (, bool priced) = insurance.markedOperatingBalance();
        assertFalse(priced);
        vm.expectRevert(Errors.StaleOracle.selector);
        insurance.unfundedShortfall();
        vm.expectRevert(Errors.StaleOracle.selector);
        insurance.redeemableStake();
        vm.prank(carol);
        vm.expectRevert(Errors.StaleOracle.selector);
        insurance.withdrawUnstaked();
        vm.expectRevert(Errors.StaleOracle.selector);
        liquidation.adl(alice, BTC, type(uint256).max);
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
