// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {Errors} from "../../src/libraries/Errors.sol";
import {AccountHealth, Position} from "../../src/libraries/Types.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract LiquidationTest is KryonTest {
    function setUp() public override {
        super.setUp();
        fund(alice, 100_000e6); // the counterparty
    }

    function _donate(uint256 amount6) internal {
        usdc.mint(address(this), amount6);
        usdc.approve(address(insurance), amount6);
        insurance.donate(amount6);
    }

    function _crash(int256 price) internal {
        vm.warp(_now() + 1);
        push(BTC_ID, price);
    }

    // ---------------------------------------------------- Soroban ports

    function test_cannot_liquidate_healthy_account() public {
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 100 * P);
        vm.prank(liquidator);
        vm.expectRevert(Errors.NotLiquidatable.selector);
        liquidation.liquidate(bob, BTC, uint256(P / 2));
    }

    function test_liquidates_unhealthy_account_and_pays_reward() public {
        _donate(1000e6);
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        _crash(10 * P);
        AccountHealth memory before = engine.accountHealth(bob);
        assertTrue(before.liquidatable);

        vm.prank(liquidator);
        int256 closed = liquidation.liquidate(bob, BTC, uint256(50 * P));
        assertEq(closed, 50 * P);

        AccountHealth memory afterH = engine.accountHealth(bob);
        assertLt(afterH.maintenanceMarginRequired, before.maintenanceMarginRequired);
        assertEq(pos(bob, BTC).size, 50 * P);
        // The backstop took over the closed size at the index price.
        Position memory ins = pos(address(insurance), BTC);
        assertEq(ins.size, 50 * P);
        assertEq(ins.openNotional, 500 * P);
        // Reward: 50 bps of the 500 closed notional, paid from the penalty.
        assertEq(bal(liquidator), 25 * P / 10);
        (int256 l, int256 s) = engine.openInterest(BTC);
        assertEq(l, s);
        assertSolvencyExact();
    }

    /// C1: a negative balance left after a full close is covered by insurance.
    function test_bad_debt_fully_covered_by_insurance_restores_zero_balance() public {
        _donate(1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, 20 * P, 100 * P);
        _crash(10 * P);
        int256 insBefore = bal(address(insurance));
        int256 bobBefore = bal(bob);

        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);

        // Realized loss 1800 + penalty 1 against ~1000: ~801 covered by insurance.
        int256 deficit = -(bobBefore - 1800 * P - P);
        assertGt(deficit, 0);
        assertEq(bal(bob), 0);
        assertEq(insurance.badDebt(), 0);
        assertEq(bal(address(insurance)), insBefore - deficit);
        assertEq(engine.positionCount(bob), 0);
        assertSolvencyExact();
    }

    /// C1: what the fund can't cover is recorded, and the account stays negative.
    function test_bad_debt_exceeding_fund_is_partially_covered_and_recorded() public {
        _donate(1000e6);
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        _crash(10 * P);
        int256 operating = insurance.operatingBalance();
        int256 bobBefore = bal(bob);

        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);

        int256 deficit = -(bobBefore - 9000 * P - 5 * P);
        assertEq(bal(address(insurance)), 0);
        assertEq(insurance.badDebt(), deficit - operating);
        assertEq(insurance.recordedDebt(bob), deficit - operating);
        assertEq(bal(bob), -(deficit - operating));
        assertEq(insurance.unfundedShortfall(), deficit - operating);
        assertSolvencyExact();
    }

    function test_recorded_bad_debt_is_settled_when_the_fund_is_refilled() public {
        _donate(10e6);
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        _crash(10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        int256 debt = insurance.badDebt();
        assertGt(debt, 0);

        // Refill with whole USDC covering the debt, then anyone settles.
        _donate(uint256(debt / 1e12) + 1);
        vm.prank(carol);
        insurance.settleBadDebt(bob);
        assertEq(insurance.badDebt(), 0);
        assertEq(bal(bob), 0);
        assertSolvencyExact();
    }

    /// A trader who repays their own deficit clears the recorded bad debt, so
    /// ADL can never socialise a loss that has already been paid.
    function test_repaying_a_deficit_clears_recorded_bad_debt() public {
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        _crash(10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        int256 debt = insurance.recordedDebt(bob);
        assertGt(debt, 0);

        fund(bob, uint256(debt / 2e12)); // repay about half
        assertEq(insurance.recordedDebt(bob), -bal(bob));
        assertEq(insurance.badDebt(), -bal(bob));

        fund(bob, uint256(debt / 1e12) + 1); // repay the rest
        assertEq(insurance.recordedDebt(bob), 0);
        assertEq(insurance.badDebt(), 0);
        assertEq(insurance.unfundedShortfall(), 0);
        vm.expectRevert(Errors.NoBadDebtToOffset.selector);
        liquidation.adl(alice, BTC, type(uint256).max);

        vm.expectRevert(Errors.Unauthorized.selector);
        insurance.refreshDebt(bob);
        assertSolvencyExact();
    }

    // ------------------------------------------------------------- ADL

    function test_adl_pays_down_bad_debt_from_an_in_profit_counterparty() public {
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        // Size the fund so the liquidation leaves exactly 900 of shortfall.
        int256 bobBal = bal(bob);
        int256 deficit = -(bobBal - 9000 * P - 5 * P);
        int256 wanted = deficit - 900 * P - bal(address(insurance));
        _donate(uint256(wanted / 1e12));
        assertEq(bal(address(insurance)), deficit - 900 * P);

        _crash(10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        assertEq(insurance.badDebt(), 900 * P);
        assertEq(insurance.unfundedShortfall(), 900 * P);

        int256 aliceBefore = bal(alice);
        vm.prank(carol);
        int256 closed = liquidation.adl(alice, BTC, type(uint256).max);
        // 900 of shortfall / 90 of profit per unit = 10 units.
        assertEq(closed, 10 * P);
        assertEq(pos(alice, BTC).size, -90 * P);
        assertEq(pos(address(insurance), BTC).size, 90 * P);
        // Alice's 900 realized gain was haircut to pay the shortfall.
        assertEq(bal(alice), aliceBefore);
        assertEq(insurance.unfundedShortfall(), 0);

        insurance.settleBadDebt(bob);
        assertEq(insurance.badDebt(), 0);
        assertEq(bal(bob), 0);
        assertSolvencyExact();
    }

    function test_adl_is_refused_without_recorded_bad_debt() public {
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 100 * P);
        vm.expectRevert(Errors.NoBadDebtToOffset.selector);
        liquidation.adl(alice, BTC, type(uint256).max);
    }

    function test_adl_refuses_a_counterparty_that_is_not_in_profit() public {
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        _crash(10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        assertGt(insurance.unfundedShortfall(), 0);

        // Same side as the backstop: never an ADL target.
        address otherLong = newTrader("otherLong", 1000e6);
        trade(alice, otherLong, BTC, true, P, 10 * P);
        vm.expectRevert(Errors.DirectionMismatch.selector);
        liquidation.adl(otherLong, BTC, type(uint256).max);

        // Opposite side but losing money.
        address loser = newTrader("loser", 1000e6);
        trade(otherLong, loser, BTC, false, P, 10 * P);
        _crash(105 * P / 10);
        vm.expectRevert(Errors.PositionNotInProfit.selector);
        liquidation.adl(loser, BTC, type(uint256).max);
    }

    // --------------------------------------------------------- guards

    function test_liquidation_guards() public {
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 100 * P);
        vm.prank(bob);
        vm.expectRevert(Errors.Unauthorized.selector);
        liquidation.liquidate(bob, BTC, 1);
        vm.expectRevert(Errors.InsuranceAccount.selector);
        liquidation.liquidate(address(insurance), BTC, 1);
        vm.expectRevert(Errors.InvalidAmount.selector);
        liquidation.liquidate(bob, BTC, 0);
        vm.expectRevert(Errors.PositionNotFound.selector);
        liquidation.liquidate(bob, ETH, 1);
        vm.expectRevert(Errors.InsuranceAccount.selector);
        liquidation.adl(address(insurance), BTC, 1);
        vm.expectRevert(Errors.InvalidAmount.selector);
        liquidation.adl(bob, BTC, 0);
    }

    function test_paused_liquidation_reverts() public {
        vm.prank(guardian);
        liquidation.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        liquidation.liquidate(bob, BTC, 1);
    }

    function test_penalty_above_reward_is_split_by_the_fee_router() public {
        asGov();
        liquidation.setParams(10, 5000); // reward 10 bps < penalty 50 bps
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        int256 px = 937 * P / 10;
        _crash(px);
        int256 treasuryBefore = feeRouter.treasuryAccrued();
        int256 insBefore = bal(address(insurance));
        vm.prank(liquidator);
        int256 closed = liquidation.liquidate(bob, BTC, type(uint256).max);
        int256 notional = closed * px / P;
        int256 penalty = notional * 50 / 10_000;
        int256 reward = notional * 10 / 10_000;
        assertEq(bal(liquidator), reward);
        int256 rest = penalty - reward;
        assertEq(feeRouter.treasuryAccrued() - treasuryBefore, rest - rest / 2);
        // Insurance also absorbs the taken-over position's PnL (zero at entry).
        assertEq(bal(address(insurance)) - insBefore, rest / 2);
        assertSolvencyExact();
    }

    function test_partial_step_is_capped() public {
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        _crash(95 * P); // equity ~596 vs MM 475: healthy
        vm.expectRevert(Errors.NotLiquidatable.selector);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        _crash(937 * P / 10); // equity just below MM
        AccountHealth memory h = engine.accountHealth(bob);
        assertTrue(h.liquidatable);
        assertGt(h.equity, 0);
        vm.prank(liquidator);
        int256 closed = liquidation.liquidate(bob, BTC, type(uint256).max);
        assertLe(closed, 50 * P, "never more than the per-step cap");
        assertGt(closed, 0);
        // One planned step restores maintenance margin.
        assertFalse(engine.accountHealth(bob).liquidatable);
        assertGt(pos(bob, BTC).size, 50 * P);
        assertSolvencyExact();
    }

    function test_params_are_bounded() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(Errors.InvalidConfig.selector);
        liquidation.setParams(0, 5000);
        vm.expectRevert(Errors.InvalidConfig.selector);
        liquidation.setParams(1001, 5000);
        vm.expectRevert(Errors.InvalidConfig.selector);
        liquidation.setParams(50, 999);
        vm.expectRevert(Errors.InvalidConfig.selector);
        liquidation.setParams(50, 10_001);
        vm.stopPrank();
        (uint16 r, uint16 pb) = liquidation.params();
        assertEq(r, 50);
        assertEq(pb, 5000);
    }
}
