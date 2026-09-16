// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {Fill, Order} from "../../src/libraries/OrderLib.sol";
import {MarketParams} from "../../src/libraries/Types.sol";
import {KryonTest} from "../utils/KryonTest.sol";

/// @notice Gas for the ARC_MIGRATION_PLAN.md §5.6 unit-economics table.
///         Numbers are printed (-vv) and recorded in MIGRATION_PROGRESS.md.
contract GasTest is KryonTest {
    function _fills(uint256 n, uint256 salt) internal returns (Fill[] memory fills) {
        fills = new Fill[](n);
        for (uint256 i = 0; i < n; ++i) {
            address maker = newTrader(string.concat("m", vm.toString(salt), "_", vm.toString(i)), 10_000e6);
            address taker = newTrader(string.concat("t", vm.toString(salt), "_", vm.toString(i)), 10_000e6);
            Order memory mo = makeOrder(maker, BTC, false, P, 100 * P);
            Order memory to = makeOrder(taker, BTC, true, P, 100 * P);
            fills[i] = makeFill(mo, to, P, 100 * P);
        }
    }

    function _settleGas(Fill[] memory fills) internal returns (uint256 used) {
        vm.prank(operator);
        uint256 g = gasleft();
        uint256 settled = gateway.settleFillsSigned(fills);
        used = g - gasleft();
        assertEq(settled, fills.length);
    }

    function test_gas_settle_fills() public {
        emit log_named_uint("settle 1 fill (both sides open)", _settleGas(_fills(1, 1)));
        uint256 g40 = _settleGas(_fills(40, 2));
        emit log_named_uint("settle 40 fills", g40);
        emit log_named_uint("  per fill", g40 / 40);
    }

    /// The common case for a market maker: both sides already hold a position.
    function test_gas_settle_fills_increasing_existing_positions() public {
        Fill[] memory seed = _fills(40, 3);
        _settleGas(seed);
        Fill[] memory again = new Fill[](40);
        for (uint256 i = 0; i < 40; ++i) {
            Order memory mo = makeOrder(seed[i].maker.owner, BTC, false, P, 100 * P);
            Order memory to = makeOrder(seed[i].taker.owner, BTC, true, P, 100 * P);
            again[i] = makeFill(mo, to, P, 100 * P);
        }
        uint256 g40 = _settleGas(again);
        emit log_named_uint("settle 40 fills, existing positions", g40);
        emit log_named_uint("  per fill", g40 / 40);
    }

    function test_gas_oracle_push_8_markets() public {
        bytes32[] memory ids = new bytes32[](8);
        int256[] memory prices = new int256[](8);
        int256[] memory confs = new int256[](8);
        vm.startPrank(address(timelock));
        for (uint256 i = 0; i < 8; ++i) {
            ids[i] = bytes32(uint256(0xfeed + i));
            prices[i] = 100 * P;
            confs[i] = P / 100;
            oracle.setFeed(ids[i], oracle.feed(BTC_ID));
        }
        vm.stopPrank();
        vm.warp(_now() + 1);
        vm.prank(publisher);
        oracle.pushPrices(ids, prices, confs, uint64(_now()));
        vm.warp(_now() + 1);
        vm.prank(publisher);
        uint256 g = gasleft();
        oracle.pushPrices(ids, prices, confs, uint64(_now()));
        emit log_named_uint("oracle push, 8 markets (warm)", g - gasleft());
    }

    function test_gas_funding_update() public {
        fund(alice, 10_000e6);
        fund(bob, 10_000e6);
        trade(alice, bob, BTC, true, P, 100 * P);
        skipAndRepublish(3600, 100 * P);
        vm.prank(keeper);
        uint256 g = gasleft();
        engine.updateFunding(BTC);
        emit log_named_uint("funding update, 1 market", g - gasleft());
    }

    function test_gas_liquidation() public {
        fund(alice, 100_000e6);
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        vm.warp(_now() + 1);
        push(BTC_ID, 937 * P / 10);
        vm.prank(liquidator);
        uint256 g = gasleft();
        liquidation.liquidate(bob, BTC, type(uint256).max);
        emit log_named_uint("partial liquidation", g - gasleft());
    }

    function test_gas_deposit_withdraw() public {
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 100e6);
        uint256 g = gasleft();
        vault.deposit(100e6);
        emit log_named_uint("deposit (cold account)", g - gasleft());
        g = gasleft();
        vault.withdraw(50e6);
        emit log_named_uint("withdraw", g - gasleft());
        vm.stopPrank();
    }
}
