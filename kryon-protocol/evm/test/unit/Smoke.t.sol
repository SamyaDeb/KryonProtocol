// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonTest} from "../utils/KryonTest.sol";

contract SmokeTest is KryonTest {
    function test_trade_charges_fees_and_conserves_value() public {
        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, 1 * P, 100 * P);
        (int256 mf, int256 tf) = fees(1 * P, 100 * P);
        assertEq(pos(bob, BTC).size, 1 * P);
        assertEq(pos(alice, BTC).size, -1 * P);
        assertEq(bal(alice), 1000 * P - mf);
        assertEq(bal(bob), 1000 * P - tf);
        assertSolvencyExact();
    }
}
