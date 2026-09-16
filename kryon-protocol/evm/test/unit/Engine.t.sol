// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {Order} from "../../src/libraries/OrderLib.sol";
import {AccountHealth, FundingState, MarketParams, Position} from "../../src/libraries/Types.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract EngineTest is KryonTest {
    function setUp() public override {
        super.setUp();
        fund(alice, 1000e6);
        fund(bob, 1000e6);
    }

    // ---------------------------------------------------- Soroban ports

    function test_opens_position_and_syncs_health() public {
        trade(alice, bob, BTC, true, 5 * P, 100 * P);
        assertEq(pos(bob, BTC).size, 5 * P);
        assertEq(engine.positionCount(bob), 1);
        (int256 longOi, int256 shortOi) = engine.openInterest(BTC);
        assertEq(longOi, 5 * P);
        assertEq(shortOi, 5 * P);
        AccountHealth memory h = engine.accountHealth(bob);
        assertGt(h.equity, 0);
        assertEq(h.initialMarginRequired, 50 * P);
        assertEq(h.maintenanceMarginRequired, 25 * P);
    }

    function test_rejects_direct_position_mutation_without_order_gateway() public {
        vm.expectRevert(Errors.Unauthorized.selector);
        engine.applyFill(bob, BTC, true, P, 100 * P, 100 * P, false);
        assertEq(engine.positionCount(bob), 0);
    }

    function test_rejects_execution_outside_oracle_band() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 150 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 150 * P);
        bytes memory reason = settleReason(makeFill(mo, to, P, 150 * P));
        assertEq(bytes4(reason), Errors.PriceOutsideBand.selector);
    }

    function test_rejects_open_that_breaks_initial_margin() public {
        Order memory mo = makeOrder(alice, BTC, false, 200 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, 200 * P, 100 * P);
        bytes memory reason = settleReason(makeFill(mo, to, 200 * P, 100 * P));
        assertEq(bytes4(reason), Errors.InsufficientCollateral.selector);
        assertEq(engine.positionCount(bob), 0);
    }

    function test_close_realizes_profit_to_vault_balance() public {
        trade(alice, bob, BTC, true, P, 100 * P);
        push(BTC_ID, 101 * P);
        trade(alice, bob, BTC, false, P, 101 * P);
        (, int256 tf1) = fees(P, 100 * P);
        (, int256 tf2) = fees(P, 101 * P);
        assertEq(bal(bob), 1001 * P - tf1 - tf2);
        assertEq(engine.positionCount(bob), 0);
        assertEq(pos(bob, BTC).openNotional, 0);
        assertSolvencyExact();
    }

    function test_open_position_enforces_per_account_cap() public {
        uint256 cap = engine.MAX_POSITIONS_PER_ACCOUNT();
        for (uint32 i = 0; i <= cap; ++i) _listExtraMarket(100 + i);
        for (uint32 i = 0; i < cap; ++i) {
            trade(alice, bob, 100 + i, true, P / 100, 100 * P);
        }
        assertEq(engine.positionCount(bob), cap);
        Order memory mo = makeOrder(alice, 100 + uint32(cap), false, P / 100, 100 * P);
        Order memory to = makeOrder(bob, 100 + uint32(cap), true, P / 100, 100 * P);
        bytes memory reason = settleReason(makeFill(mo, to, P / 100, 100 * P));
        assertEq(bytes4(reason), Errors.TooManyPositions.selector);
    }

    /// KRY-Q4: OI may not exceed what the insurance fund can stand behind.
    /// OI here counts both sides (long + short), as the Soroban engine did.
    function test_open_interest_is_capped_against_the_insurance_fund() public {
        usdc.mint(address(this), 100e6);
        usdc.approve(address(insurance), 100e6);
        insurance.donate(100e6);
        asGov();
        risk.setOiPolicy(BTC, 40_000); // 4x the fund

        trade(alice, bob, BTC, true, P, 100 * P); // OI notional 200
        assertGe(engine.insuranceCoverageBps(BTC), 5000);
        trade(alice, bob, BTC, true, P, 100 * P); // 400 -- within 4x(100 + fee share)

        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(
            bytes4(settleReason(makeFill(mo, to, P, 100 * P))),
            Errors.InsuranceFundInsufficient.selector,
            "opening past the insurance-backed ceiling is refused"
        );

        // Exiting is always allowed.
        trade(alice, bob, BTC, false, 2 * P, 100 * P);
        assertEq(pos(bob, BTC).size, 0);
    }

    function test_markets_without_an_oi_policy_are_uncapped() public {
        assertEq(risk.oiPolicyBps(BTC), 0);
        trade(alice, bob, BTC, true, 5 * P, 100 * P);
        (int256 l,) = engine.openInterest(BTC);
        assertEq(l, 5 * P);
    }

    function test_max_open_interest_is_enforced() public {
        fund(alice, 100_000e6);
        fund(bob, 100_000e6);
        trade(alice, bob, BTC, true, 500 * P, 100 * P); // long+short = 1000 = cap
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, P, 100 * P))), Errors.OpenInterestExceeded.selector);
    }

    function test_funding_update_is_settled_before_close() public {
        int256 mark = 101 * P;
        trade(alice, bob, BTC, true, P, mark);
        uint256 t0 = _now();
        vm.warp(t0 + 3600);
        push(BTC_ID, 100 * P);
        vm.prank(keeper);
        FundingState memory f = engine.updateFunding(BTC);
        assertEq(f.longIndex, P / 100); // 1% premium, 1%/h clamp, one hour

        int256 bobBefore = bal(bob);
        int256 aliceBefore = bal(alice);
        push(BTC_ID, mark);
        trade(alice, bob, BTC, false, P, mark);
        (int256 mf, int256 tf) = fees(P, mark);
        // Bob (long) pays 0.01 funding, realized trade PnL is zero.
        assertEq(bal(bob), bobBefore - P / 100 - tf);
        // Alice (short) receives it.
        assertEq(bal(alice), aliceBefore + P / 100 - mf);
        assertEq(bal(address(engine)), 0, "funding pool nets to zero");
        assertSolvencyExact();
    }

    // -------------------------------------------------------- new behaviour

    function test_flip_long_to_short_splits_notional_exactly() public {
        trade(alice, bob, BTC, true, 2 * P, 100 * P);
        push(BTC_ID, 99 * P + 7);
        trade(alice, bob, BTC, false, 5 * P, 99 * P + 7);
        Position memory p = pos(bob, BTC);
        assertEq(p.size, -3 * P);
        assertEq(p.openNotional, -((3 * P) * (99 * P + 7) / P));
        assertEq(pos(alice, BTC).size, 3 * P);
        assertSolvencyExact();
    }

    function test_partial_reduce_books_proportional_basis() public {
        trade(alice, bob, BTC, true, 3 * P, 100 * P);
        push(BTC_ID, 100 * P + 1);
        trade(alice, bob, BTC, true, 1 * P, 100 * P + 1);
        Position memory p = pos(bob, BTC);
        int256 basis = p.openNotional;
        trade(alice, bob, BTC, false, P, 100 * P + 1);
        assertEq(pos(bob, BTC).openNotional, basis - basis / 4);
        assertSolvencyExact();
    }

    function test_reduce_only_rules() public {
        // No position: a reduce-only order can't open one.
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        to.reduceOnly = true;
        assertEq(bytes4(settleReason(makeFill(mo, to, P, 100 * P))), Errors.PositionNotFound.selector);

        trade(alice, bob, BTC, true, P, 100 * P);
        // Reduce-only may not flip through zero.
        mo = makeOrder(alice, BTC, true, 2 * P, 100 * P);
        to = makeOrder(bob, BTC, false, 2 * P, 100 * P);
        to.reduceOnly = true;
        assertEq(bytes4(settleReason(makeFill(mo, to, 2 * P, 100 * P))), Errors.InvalidAmount.selector);

        // An exact close is fine.
        mo = makeOrder(alice, BTC, true, P, 100 * P);
        to = makeOrder(bob, BTC, false, P, 100 * P);
        to.reduceOnly = true;
        settleOk(makeFill(mo, to, P, 100 * P));
        assertEq(engine.positionCount(bob), 0);
    }

    function test_inactive_market_is_reduce_only() public {
        trade(alice, bob, BTC, true, P, 100 * P);
        asGov();
        risk.setMarketActive(BTC, false);
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(
            bytes4(settleReason(makeFill(mo, to, P, 100 * P))),
            bytes4(abi.encodeWithSelector(Errors.MarketInactive.selector, BTC))
        );
        trade(alice, bob, BTC, false, P, 100 * P);
        assertEq(engine.positionCount(bob), 0);
    }

    function test_funding_tolerates_repeated_updates_in_one_second() public {
        trade(alice, bob, BTC, true, P, 101 * P);
        vm.warp(_now() + 600);
        push(BTC_ID, 100 * P);
        vm.startPrank(keeper);
        FundingState memory a = engine.updateFunding(BTC);
        FundingState memory b = engine.updateFunding(BTC);
        vm.stopPrank();
        assertEq(a.longIndex, b.longIndex);
        assertEq(a.lastUpdate, b.lastUpdate);
    }

    function test_update_funding_is_keeper_only() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Roles.KEEPER_ROLE
            )
        );
        engine.updateFunding(BTC);
    }

    function test_update_funding_fails_closed_on_stale_index() public {
        trade(alice, bob, BTC, true, P, 100 * P);
        vm.warp(_now() + 3600);
        vm.prank(keeper);
        vm.expectRevert(Errors.StaleOracle.selector);
        engine.updateFunding(BTC);
    }

    function test_funding_without_config_reverts() public {
        _listExtraMarket(77);
        // A listed market whose funding config was never set.
        vm.prank(keeper);
        vm.expectRevert(Errors.InvalidConfig.selector);
        engine.updateFunding(77);
    }

    function test_positions_of_lists_every_market() public {
        trade(alice, bob, BTC, true, P, 100 * P);
        trade(alice, bob, ETH, false, P / 10, 2000 * P);
        (uint32[] memory ids, Position[] memory ps) = engine.positionsOf(bob);
        assertEq(ids.length, 2);
        assertEq(ids[0], BTC);
        assertEq(ids[1], ETH);
        assertEq(ps[1].size, -P / 10);
        trade(alice, bob, BTC, false, P, 100 * P);
        (ids,) = engine.positionsOf(bob);
        assertEq(ids.length, 1);
        assertEq(ids[0], ETH);
    }

    function test_liquidation_and_adl_entry_points_are_restricted() public {
        vm.expectRevert(Errors.Unauthorized.selector);
        engine.liquidationTransfer(bob, alice, BTC, P, 100 * P);
        vm.expectRevert(Errors.Unauthorized.selector);
        engine.adlTransfer(bob, alice, BTC, P, 100 * P);
    }

    function test_mark_is_last_fill_and_twap_is_time_weighted() public {
        assertEq(engine.markPrice(BTC), 0);
        trade(alice, bob, BTC, true, P, 100 * P);
        assertEq(engine.markPrice(BTC), 100 * P);
        vm.warp(_now() + 100);
        push(BTC_ID, 100 * P);
        trade(alice, bob, BTC, true, P, 101 * P);
        assertEq(engine.markPrice(BTC), 101 * P);
        assertEq(engine.markState(BTC).cumulative, 100 * P * 100);
    }

    function test_wiring_setters_are_admin_only() public {
        vm.expectRevert();
        engine.setGateway(address(1));
        asGov();
        vm.expectRevert(Errors.ZeroAddress.selector);
        engine.setGateway(address(0));
    }

    // ----------------------------------------------------------- helpers

    function _listExtraMarket(uint32 id) internal {
        bytes32 oid = bytes32(uint256(id) << 200);
        MarketParams memory m = marketConfig(id, "X", oid, 1000, 500, 50, 1000 * P).params;
        OracleAdapter.FeedConfig memory feed = marketConfig(id, "X", oid, 1000, 500, 50, 0).feed;
        vm.startPrank(address(timelock));
        oracle.setFeed(oid, feed);
        risk.setMarket(id, m);
        feeRouter.setMarketFees(id, MAKER_RATE, TAKER_RATE);
        vm.stopPrank();
        push(oid, 100 * P);
    }
}
