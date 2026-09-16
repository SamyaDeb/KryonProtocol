// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Vm} from "forge-std/Test.sol";

import {Engine} from "../../src/Engine.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Insurance} from "../../src/Insurance.sol";
import {Liquidation} from "../../src/Liquidation.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {OrderGateway} from "../../src/OrderGateway.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {Vault} from "../../src/Vault.sol";
import {Decimals} from "../../src/libraries/Decimals.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {KryonMath as M} from "../../src/libraries/KryonMath.sol";
import {LiquidationLib} from "../../src/libraries/LiquidationLib.sol";
import {Fill, Order} from "../../src/libraries/OrderLib.sol";
import {RiskLib} from "../../src/libraries/RiskLib.sol";
import {
    AccountHealth,
    LiquidationMode,
    LiquidationPlan,
    RiskCollateral,
    RiskMarket,
    RiskPosition
} from "../../src/libraries/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract GuardLibs {
    function div(int256 a, int256 b) external pure returns (int256) {
        return M.div(a, b);
    }

    function mulUp(int256 a, int256 b) external pure returns (int256) {
        return M.mulPrecisionUp(a, b);
    }

    function tokenUp(int256 v) external pure returns (uint256) {
        return Decimals.toTokenUp(v);
    }

    function maxLev(uint256 im) external pure returns (int256) {
        return RiskLib.maxLeverageBps(im);
    }

    function notional(int256 s, int256 p) external pure returns (int256) {
        return RiskLib.notional(s, p);
    }

    function pnl(RiskPosition memory p, int256 mark) external pure returns (int256) {
        return RiskLib.signedPositionPnl(p, mark);
    }

    function withdraw(int256 w) external pure returns (AccountHealth memory) {
        return RiskLib.validateWithdrawal(new RiskCollateral[](0), new RiskPosition[](0), new RiskMarket[](0), w);
    }

    function plan(RiskCollateral[] memory c, RiskPosition[] memory p, RiskMarket[] memory m)
        external
        pure
        returns (LiquidationPlan memory)
    {
        return LiquidationLib.planLiquidation(c, p, m, 1, 5000);
    }
}

/// @notice Guard and edge paths not reached by the behavioural suites.
contract GuardsTest is KryonTest {
    GuardLibs libs = new GuardLibs();

    // ------------------------------------------------------------ initializers

    function _proxy(address impl, bytes memory init) internal returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }

    function test_initializers_reject_zero_addresses() public {
        address rp = address(new RiskParams());
        vm.expectRevert(Errors.ZeroAddress.selector);
        _proxy(rp, abi.encodeCall(RiskParams.initialize, (address(0))));
        address v = address(new Vault());
        vm.expectRevert(Errors.ZeroAddress.selector);
        _proxy(v, abi.encodeCall(Vault.initialize, (alice, address(0), address(1))));
        address e = address(new Engine());
        vm.expectRevert(Errors.ZeroAddress.selector);
        _proxy(e, abi.encodeCall(Engine.initialize, (alice, address(0), address(1), address(1))));
        address ins = address(new Insurance());
        vm.expectRevert(Errors.ZeroAddress.selector);
        _proxy(ins, abi.encodeCall(Insurance.initialize, (alice, address(0), address(1))));
        address fr = address(new FeeRouter());
        vm.expectRevert(Errors.ZeroAddress.selector);
        _proxy(fr, abi.encodeCall(FeeRouter.initialize, (alice, address(1), address(0), address(1))));
        address gw = address(new OrderGateway());
        vm.expectRevert(Errors.ZeroAddress.selector);
        _proxy(gw, abi.encodeCall(OrderGateway.initialize, (alice, address(0), address(1), address(1))));
        address lq = address(new Liquidation());
        vm.expectRevert(Errors.ZeroAddress.selector);
        _proxy(
            lq,
            abi.encodeCall(
                Liquidation.initialize,
                (alice, address(1), address(1), address(1), address(1), address(0), 50, 5000)
            )
        );
    }

    function test_wiring_setters_reject_zero_addresses() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(Errors.ZeroAddress.selector);
        engine.setLiquidation(address(0));
        vm.expectRevert(Errors.ZeroAddress.selector);
        engine.setInsurance(address(0));
        vm.expectRevert(Errors.ZeroAddress.selector);
        vault.setEngine(address(0));
        vm.expectRevert(Errors.ZeroAddress.selector);
        vault.setInsurance(address(0));
        vm.expectRevert(Errors.ZeroAddress.selector);
        insurance.setEngine(address(0));
        vm.expectRevert(Errors.ZeroAddress.selector);
        insurance.setLiquidation(address(0));
        vm.expectRevert(Errors.ZeroAddress.selector);
        feeRouter.setTreasury(address(0));
        address[] memory keys = new address[](1);
        vm.expectRevert(Errors.ZeroAddress.selector);
        oracle.setPublishers(keys);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ engine

    function test_engine_entry_point_amount_guards() public {
        vm.startPrank(address(gateway));
        vm.expectRevert(Errors.InvalidAmount.selector);
        engine.applyFill(alice, BTC, true, 0, P, P, false);
        vm.stopPrank();

        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 100 * P);
        vm.startPrank(address(liquidation));
        vm.expectRevert(Errors.PositionNotFound.selector);
        engine.liquidationTransfer(carol, address(insurance), BTC, P, 100 * P);
        vm.expectRevert(Errors.InvalidAmount.selector);
        engine.liquidationTransfer(bob, address(insurance), BTC, 2 * P, 100 * P);
        vm.expectRevert(Errors.PositionNotFound.selector);
        engine.adlTransfer(carol, bob, BTC, P, 100 * P);
        vm.expectRevert(Errors.DirectionMismatch.selector);
        engine.adlTransfer(bob, bob, BTC, P, 100 * P);
        vm.expectRevert(Errors.InvalidAmount.selector);
        engine.adlTransfer(alice, bob, BTC, 2 * P, 100 * P);
        vm.stopPrank();
    }

    function test_full_close_with_negative_balance_is_refused() public {
        fund(alice, 10_000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, 99 * P, 100 * P);
        // Take bob's balance negative without touching the position.
        vm.prank(address(engine));
        vault.transferInternal(bob, carol, 1500 * P, "TEST");
        Order memory mo = makeOrder(alice, BTC, true, 99 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, false, 99 * P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, 99 * P, 100 * P))), Errors.InsufficientCollateral.selector);
    }

    function test_coverage_is_infinite_without_open_interest() public view {
        assertEq(engine.insuranceCoverageBps(BTC), type(int128).max);
    }

    // --------------------------------------------------------------- oracle

    function test_aggregate_rejects_an_observation_older_than_the_last_aggregate() public {
        address pub2 = makeAddr("pub2");
        address[] memory keys = new address[](2);
        keys[0] = publisher;
        keys[1] = pub2;
        OracleAdapter.FeedConfig memory f = oracle.feed(BTC_ID);
        vm.startPrank(address(timelock));
        oracle.setPublishers(keys);
        oracle.setFeed(BTC_ID, f); // min 1 publisher
        vm.stopPrank();
        vm.warp(_now() + 10);
        push(BTC_ID, 100 * P); // aggregate dated now
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = BTC_ID;
        int256[] memory prices = new int256[](1);
        prices[0] = 100 * P;
        int256[] memory confs = new int256[](1);
        vm.recordLogs();
        vm.prank(pub2);
        oracle.pushPrices(ids, prices, confs, uint64(_now() - 5));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool skipped;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("PriceUpdateSkipped(bytes32,uint8,int256)")) {
                (uint8 reason,) = abi.decode(logs[i].data, (uint8, int256));
                skipped = reason == uint8(OracleAdapter.SkipReason.NotMonotonic);
            }
        }
        assertTrue(skipped);
    }

    function test_reference_edge_cases_are_unreadable_not_reverting() public {
        MockAggregator agg = new MockAggregator(19); // more decimals than 1e18 supports
        agg.set(1, _now());
        _setRef(address(agg));
        (bool ok,) = oracle.referencePrice(BTC_ID);
        assertFalse(ok);

        MockAggregator neg = new MockAggregator(8);
        neg.set(-1, _now());
        _setRef(address(neg));
        (ok,) = oracle.referencePrice(BTC_ID);
        assertFalse(ok);

        MockAggregator future = new MockAggregator(8);
        future.set(100e8, _now() + 1);
        _setRef(address(future));
        (ok,) = oracle.referencePrice(BTC_ID);
        assertFalse(ok);

        MockAggregator huge = new MockAggregator(0);
        huge.set(type(int256).max, _now());
        _setRef(address(huge));
        (ok,) = oracle.referencePrice(BTC_ID);
        assertFalse(ok);

        // An address without code is rejected at configuration time...
        asGov();
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setReferenceFeed(BTC_ID, OracleAdapter.ReferenceFeed(makeAddr("empty"), true, false, 150, 90_000));

        // ...and if the aggregator later loses its code, pushes still succeed.
        MockAggregator doomed = new MockAggregator(8);
        doomed.set(100e8, _now());
        _setRef(address(doomed));
        vm.etch(address(doomed), "");
        (ok,) = oracle.referencePrice(BTC_ID);
        assertFalse(ok);
        push(BTC_ID, 100 * P);
    }

    function _setRef(address agg) internal {
        asGov();
        oracle.setReferenceFeed(BTC_ID, OracleAdapter.ReferenceFeed(agg, true, false, 150, 90_000));
    }

    // ------------------------------------------------------------ fee router

    function test_rebate_with_zero_maker_and_zero_amount_paths() public {
        vm.startPrank(address(timelock));
        feeRouter.setMarketFees(BTC, 0, 350);
        vm.stopPrank();
        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 100 * P); // maker fee exactly 0
        assertEq(bal(alice), 1000 * P);

        vm.prank(address(liquidation));
        feeRouter.accrueLiquidationFee(BTC, bob, 0);
        assertEq(feeRouter.claimReferral(carol), 0);
    }

    // ---------------------------------------------------------------- vault

    function test_vault_withdraw_and_pnl_guards() public {
        fund(alice, 10e6);
        vm.startPrank(alice);
        vm.expectRevert(Errors.ZeroAddress.selector);
        vault.withdrawTo(address(0), 1);
        vm.expectRevert(Errors.InvalidAmount.selector);
        vault.withdraw(0);
        vm.stopPrank();
        vm.prank(address(engine));
        vault.applyPnl(alice, 0);
        assertEq(bal(alice), 10 * P);
    }

    // ------------------------------------------------------------ insurance

    function test_insurance_edges() public {
        // Nothing staked: a sweep moves nothing.
        asGov();
        assertEq(insurance.sweepToOperating(1), 0);

        // refreshDebt on an account with no record is a no-op.
        vm.prank(address(vault));
        insurance.refreshDebt(alice);

    }

    function test_refresh_debt_never_increases_the_record() public {
        fund(alice, 100_000e6);
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        vm.warp(_now() + 1);
        push(BTC_ID, 10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        int256 debt = insurance.recordedDebt(bob);
        vm.prank(address(engine));
        vault.transferInternal(bob, carol, P, "MORE_DEBT");
        vm.prank(address(vault));
        insurance.refreshDebt(bob);
        assertEq(insurance.recordedDebt(bob), debt);
    }

    // -------------------------------------------------------------- gateway

    function test_gateway_rejects_empty_orders() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        Fill memory f = makeFill(mo, to, P, 100 * P);
        f.maker = _copy(mo);
        f.maker.owner = address(0);
        assertEq(bytes4(settleReason(f)), Errors.ZeroAddress.selector);
        f.maker = _copy(mo);
        f.maker.limitPrice = 0;
        assertEq(bytes4(settleReason(f)), Errors.InvalidAmount.selector);
    }

    function _copy(Order memory o) internal pure returns (Order memory c) {
        c = Order(o.owner, o.marketId, o.isLong, o.size, o.limitPrice, o.reduceOnly, o.nonce, o.expiry, o.referrer);
    }

    // ------------------------------------------------------------ libraries

    function test_library_guards() public {
        vm.expectRevert(Errors.DivisionByZero.selector);
        libs.div(1, 0);
        vm.expectRevert(Errors.InvalidAmount.selector);
        libs.mulUp(-1, 1);
        vm.expectRevert(Errors.InvalidAmount.selector);
        libs.tokenUp(-1);
        assertEq(libs.tokenUp(0), 0);
        vm.expectRevert(Errors.InvalidConfig.selector);
        libs.maxLev(0);
        vm.expectRevert(Errors.InvalidAmount.selector);
        libs.notional(0, P);
        RiskPosition memory p = RiskPosition(1, 1, P, 0, 0, true, 0, false);
        vm.expectRevert(Errors.InvalidPrice.selector);
        libs.pnl(p, P);
        vm.expectRevert(Errors.InvalidAmount.selector);
        libs.withdraw(-1);
    }

    function test_liquidation_plan_with_fee_at_maintenance_closes_in_full() public view {
        RiskCollateral[] memory c = new RiskCollateral[](1);
        c[0] = RiskCollateral(1000 * P, 0);
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = RiskPosition(1, 1, 100 * P, 100 * P, 0, true, 0, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = RiskMarket(1, 1000, 500, 500, true, 937 * P / 10, 0, 0);
        LiquidationPlan memory pl = libs.plan(c, p, m);
        assertEq(uint8(pl.mode), uint8(LiquidationMode.Full));
    }
}
