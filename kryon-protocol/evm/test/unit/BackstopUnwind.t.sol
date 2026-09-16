// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {Roles} from "../../src/governance/Roles.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {Fill, Order} from "../../src/libraries/OrderLib.sol";
import {KryonTest} from "../utils/KryonTest.sol";

/// @notice Plan §4.4: the Insurance backstop closes taken-over positions
///         through the order book, within on-chain limits.
contract BackstopUnwindTest is KryonTest {
    address signer;
    uint256 signerKey;

    function setUp() public override {
        super.setUp();
        (signer, signerKey) = makeAddrAndKey("backstopSigner");
        fund(alice, 100_000e6);
        fund(bob, 1100e6);
        fund(carol, 100_000e6);
        // Bob is liquidated at 10: the backstop now holds his 100-unit long.
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        vm.warp(_now() + 1);
        push(BTC_ID, 10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        assertEq(pos(address(insurance), BTC).size, 100 * P);

        vm.startPrank(address(timelock));
        insurance.grantRole(Roles.BACKSTOP_SIGNER_ROLE, signer);
        insurance.setUnwindLimits(50, 500 * P, 800 * P); // 0.5% band, $500 per fill, $800 per day
        vm.stopPrank();
    }

    function _unwindOrder(int256 size, int256 limit) internal returns (Order memory o) {
        o = makeOrder(address(insurance), BTC, false, size, limit);
        o.reduceOnly = true;
        o.expiry = uint64(_now() + 30 minutes);
    }

    function _backstopSig(Order memory o, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, gateway.hashOrder(o));
        return abi.encode(abi.encode(o), abi.encodePacked(r, s, v));
    }

    function _fill(Order memory backstopOrder, bytes memory sig, int256 size, int256 price)
        internal
        returns (Fill memory f)
    {
        Order memory taker = makeOrder(carol, BTC, true, size, price);
        f = Fill({
            fillId: keccak256(abi.encode("unwind", ++fillSeq)),
            maker: backstopOrder,
            makerSignature: sig,
            taker: taker,
            takerSignature: sign(taker),
            size: uint256(size),
            price: uint256(price)
        });
    }

    function test_backstop_unwinds_through_the_order_book() public {
        Order memory o = _unwindOrder(10 * P, 10 * P);
        settleOk(_fill(o, _backstopSig(o, signerKey), 10 * P, 10 * P));
        assertEq(pos(address(insurance), BTC).size, 90 * P);
        assertEq(pos(carol, BTC).size, 10 * P);
        (,,, int256 usedToday) = insurance.unwindLimits();
        assertEq(usedToday, 100 * P);
        assertSolvencyExact();
    }

    function test_backstop_can_unwind_while_its_own_account_is_underwater() public {
        // Bob's deficit left the operating balance at zero and the backstop's
        // long is losing further: its fills must still settle (reduce-only).
        vm.warp(_now() + 1);
        push(BTC_ID, 99 * P / 10);
        Order memory o = _unwindOrder(10 * P, 99 * P / 10);
        settleOk(_fill(o, _backstopSig(o, signerKey), 10 * P, 99 * P / 10));
        assertEq(pos(address(insurance), BTC).size, 90 * P);
    }

    function test_rejects_orders_that_could_add_exposure() public {
        Order memory o = _unwindOrder(10 * P, 10 * P);
        o.reduceOnly = false;
        assertEq(
            bytes4(settleReason(_fill(o, _backstopSig(o, signerKey), 10 * P, 10 * P))),
            Errors.InvalidSignature.selector
        );
    }

    function test_rejects_unauthorized_or_revoked_signers() public {
        Order memory o = _unwindOrder(10 * P, 10 * P);
        assertEq(
            bytes4(settleReason(_fill(o, _backstopSig(o, aliceKey), 10 * P, 10 * P))),
            Errors.InvalidSignature.selector
        );
        asGov();
        insurance.revokeRole(Roles.BACKSTOP_SIGNER_ROLE, signer);
        o = _unwindOrder(10 * P, 10 * P);
        assertEq(
            bytes4(settleReason(_fill(o, _backstopSig(o, signerKey), 10 * P, 10 * P))),
            Errors.InvalidSignature.selector
        );
    }

    function test_rejects_long_lived_orders_and_mismatched_payloads() public {
        Order memory o = _unwindOrder(10 * P, 10 * P);
        o.expiry = uint64(_now() + 2 hours);
        assertEq(
            bytes4(settleReason(_fill(o, _backstopSig(o, signerKey), 10 * P, 10 * P))),
            Errors.InvalidSignature.selector
        );
        // A valid signature over one order can't authorize a different order.
        Order memory signed = _unwindOrder(10 * P, 10 * P);
        Order memory submitted = _unwindOrder(10 * P, 10 * P);
        assertEq(
            bytes4(settleReason(_fill(submitted, _backstopSig(signed, signerKey), 10 * P, 10 * P))),
            Errors.InvalidSignature.selector
        );
    }

    function test_fill_price_must_stay_near_the_index() public {
        // 0.8% above the index: inside the market's 1% band, outside the backstop's 0.5%.
        int256 price = 1008 * P / 100;
        Order memory o = _unwindOrder(10 * P, price);
        assertEq(
            bytes4(settleReason(_fill(o, _backstopSig(o, signerKey), 10 * P, price))),
            Errors.PriceOutsideBand.selector
        );
    }

    function test_per_fill_and_daily_caps() public {
        Order memory big = _unwindOrder(60 * P, 10 * P); // $600 > $500 per fill
        assertEq(
            bytes4(settleReason(_fill(big, _backstopSig(big, signerKey), 60 * P, 10 * P))),
            Errors.BackstopLimitExceeded.selector
        );
        for (uint256 i = 0; i < 2; ++i) {
            Order memory o = _unwindOrder(40 * P, 10 * P); // $400 twice = $800 cap
            settleOk(_fill(o, _backstopSig(o, signerKey), 40 * P, 10 * P));
        }
        Order memory over = _unwindOrder(1 * P, 10 * P);
        assertEq(
            bytes4(settleReason(_fill(over, _backstopSig(over, signerKey), 1 * P, 10 * P))),
            Errors.BackstopLimitExceeded.selector
        );
        // The cap resets the next day.
        skipAndRepublish(1 days, 10 * P);
        Order memory next = _unwindOrder(1 * P, 10 * P);
        settleOk(_fill(next, _backstopSig(next, signerKey), 1 * P, 10 * P));
    }

    function test_unwinds_are_disabled_until_governance_sets_limits() public {
        asGov();
        insurance.setUnwindLimits(0, 0, 0);
        Order memory o = _unwindOrder(10 * P, 10 * P);
        assertEq(
            bytes4(settleReason(_fill(o, _backstopSig(o, signerKey), 10 * P, 10 * P))),
            Errors.InvalidSignature.selector
        );
        vm.prank(address(gateway));
        vm.expectRevert(Errors.BackstopUnwindDisabled.selector);
        insurance.onBackstopFill(BTC, 1, uint256(10 * P));
    }

    function test_is_valid_signature_never_reverts_on_garbage() public view {
        assertEq(insurance.isValidSignature(bytes32(0), ""), bytes4(0xffffffff));
        assertEq(insurance.isValidSignature(bytes32(0), new bytes(200)), bytes4(0xffffffff));
        bytes memory wrongLength = abi.encode(new bytes(31), new bytes(65));
        assertEq(insurance.isValidSignature(bytes32(0), wrongLength), bytes4(0xffffffff));
        assertTrue(IERC1271.isValidSignature.selector != bytes4(0xffffffff));
    }

    function test_hook_and_limit_guards() public {
        vm.expectRevert(Errors.Unauthorized.selector);
        insurance.onBackstopFill(BTC, 1, uint256(10 * P));
        vm.startPrank(address(timelock));
        vm.expectRevert(Errors.InvalidConfig.selector);
        insurance.setUnwindLimits(501, 1, 1);
        vm.expectRevert(Errors.InvalidConfig.selector);
        insurance.setUnwindLimits(50, 1_000_001 * P, 1_000_001 * P);
        vm.expectRevert(Errors.InvalidConfig.selector);
        insurance.setUnwindLimits(50, 10 * P, 9 * P);
        vm.expectRevert(Errors.ZeroAddress.selector);
        insurance.setGateway(address(0));
        vm.expectRevert(Errors.ZeroAddress.selector);
        gateway.setBackstop(address(0));
        vm.stopPrank();
        assertEq(gateway.backstop(), address(insurance));
        assertEq(insurance.gateway(), address(gateway));
    }
}
