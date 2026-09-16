// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonTest} from "../utils/KryonTest.sol";
import {Handler} from "./Handler.sol";

contract HandlerSmokeTest is KryonTest {
    function test_handler_can_trade() public {
        uint32[] memory ms = new uint32[](2);
        ms[0] = BTC;
        ms[1] = ETH;
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = BTC_ID;
        ids[1] = ETH_ID;
        Handler h = new Handler(d, usdc, operator, publisher, keeper, ms, ids);
        h.deposit(0, 10_000e6);
        h.deposit(1, 10_000e6);
        h.trade(0, 1, 0, 1e18, 10, true);
        assertEq(h.trades(), 1);
    }
}
