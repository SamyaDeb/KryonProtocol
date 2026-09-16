// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Vm} from "forge-std/Test.sol";

import {Roles} from "../../src/governance/Roles.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {Cancel, Fill, Order, OrderLib} from "../../src/libraries/OrderLib.sol";
import {FundingConfig, FundingState, MarketParams} from "../../src/libraries/Types.sol";
import {MockERC1271Wallet} from "../mocks/MockERC1271Wallet.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract OrderGatewayTest is KryonTest {
    function setUp() public override {
        super.setUp();
        fund(alice, 10_000e6);
        fund(bob, 10_000e6);
    }

    // ---------------------------------------------------- Soroban ports

    function test_matched_fill_opens_both_sides_and_tracks_fills() public {
        Order memory mo = makeOrder(alice, BTC, false, 2 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        settleOk(makeFill(mo, to, P, 100 * P));
        assertEq(gateway.filled(mo.owner, mo.nonce), uint256(P));
        assertEq(gateway.filled(to.owner, to.nonce), uint256(P));
        assertLt(pos(alice, BTC).size, 0);
        assertGt(pos(bob, BTC).size, 0);
    }

    function test_rejects_overfill_replay() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        Fill memory f = makeFill(mo, to, P, 100 * P);
        settleOk(f);
        assertEq(bytes4(settleReason(f)), Errors.OrderOverfilled.selector);
    }

    function test_partial_fills_up_to_signed_size() public {
        Order memory mo = makeOrder(alice, BTC, false, 3 * P, 100 * P);
        for (uint256 i = 0; i < 3; ++i) {
            settleOk(makeFill(mo, makeOrder(bob, BTC, true, P, 100 * P), P, 100 * P));
        }
        assertEq(gateway.filled(mo.owner, mo.nonce), uint256(3 * P));
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, 1, 100 * P))), Errors.OrderOverfilled.selector);
    }

    /// KRY-Q1: funding comes from the mark-vs-index premium; a matched book
    /// keeps long OI == short OI, so an OI-imbalance formula could never fire.
    function test_funding_tracks_the_premium_not_the_open_interest_imbalance() public {
        int256 rich = 101 * P;
        bool[3] memory makerLong = [false, false, true];
        for (uint256 i = 0; i < 3; ++i) {
            trade(alice, bob, BTC, !makerLong[i], P, rich);
            (int256 l, int256 s) = engine.openInterest(BTC);
            assertEq(l, s, "long and short OI stay equal in a matched book");
        }
        assertGt(engine.markPrice(BTC), 100 * P);
        skipAndRepublish(3600, 100 * P);
        vm.prank(keeper);
        FundingState memory st = engine.updateFunding(BTC);
        assertGt(st.ratePerHour, 0);
        assertGt(st.longIndex, 0);
        assertLt(st.shortIndex, 0);
    }

    /// KRY-Q6: the mark is weighted by time, not fill count.
    function test_a_late_burst_of_rich_fills_barely_moves_funding() public {
        uint256 snap = vm.snapshotState();
        int256 lateBurst = _burstRun(3000);
        vm.revertToState(snap);
        int256 sustained = _burstRun(600);
        assertGt(lateBurst, 0);
        assertGt(sustained, lateBurst * 3);
    }

    function _burstRun(uint256 offset) internal returns (int256) {
        asGov();
        risk.setFundingConfig(BTC, _cfg(P, P / 100));
        uint256 t0 = _now();
        trade(alice, bob, BTC, true, P, 100 * P);
        vm.warp(t0 + offset);
        push(BTC_ID, 100 * P);
        for (uint256 i = 0; i < 3; ++i) {
            trade(alice, bob, BTC, true, P, 101 * P);
        }
        vm.warp(t0 + 3600);
        push(BTC_ID, 100 * P);
        vm.prank(keeper);
        return engine.updateFunding(BTC).ratePerHour;
    }

    function test_funding_stays_flat_when_the_mark_tracks_the_index() public {
        trade(alice, bob, BTC, true, P, 100 * P);
        skipAndRepublish(3600, 100 * P);
        vm.prank(keeper);
        FundingState memory st = engine.updateFunding(BTC);
        assertEq(st.ratePerHour, 0);
        assertEq(st.longIndex, 0);
    }

    function test_cancelled_order_cannot_fill() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        vm.prank(alice);
        gateway.cancelOrder(mo.nonce);
        assertTrue(gateway.isCancelled(alice, mo.nonce));
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, P, 100 * P))), Errors.OrderCancelled.selector);
    }

    function test_cancel_is_permanent_even_after_the_order_would_have_expired() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        vm.prank(alice);
        gateway.cancelOrder(mo.nonce);
        skipAndRepublish(30 days, 100 * P);
        assertTrue(gateway.isCancelled(alice, mo.nonce));
    }

    function test_rejects_an_order_dated_past_the_max_ttl() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        mo.expiry = uint64(_now() + gateway.MAX_ORDER_TTL() + 1);
        assertEq(bytes4(settleReason(makeFill(mo, to, P, 100 * P))), Errors.OrderExpired.selector);
    }

    function test_rejects_expired_order() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        Fill memory f = makeFill(mo, to, P, 100 * P);
        skipAndRepublish(2 hours, 100 * P);
        assertEq(bytes4(settleReason(f)), Errors.OrderExpired.selector);
    }

    function test_matched_fill_charges_maker_and_taker_fees() public {
        trade(alice, bob, BTC, true, P, 100 * P);
        (int256 mf, int256 tf) = fees(P, 100 * P);
        assertEq(mf, P / 200); // 0.5 bps of 100
        assertEq(tf, 35 * P / 1000); // 3.5 bps of 100
        assertEq(bal(alice), 10_000 * P - mf);
        assertEq(bal(bob), 10_000 * P - tf);
        int256 net = mf + tf;
        assertEq(bal(address(insurance)), net * 2000 / 10_000);
        assertEq(feeRouter.treasuryAccrued(), net - net * 2000 / 10_000);
    }

    function test_guardian_can_pause_gateway_but_not_unpause() public {
        vm.prank(guardian);
        gateway.pause();
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        Fill[] memory fills = new Fill[](1);
        fills[0] = makeFill(mo, to, P, 100 * P);
        vm.prank(operator);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        gateway.settleFillsSigned(fills);

        vm.prank(guardian);
        vm.expectRevert();
        gateway.unpause();
        asGov();
        gateway.unpause();
        settleOk(fills[0]);
    }

    // ------------------------------------------------- EIP-712 signatures

    function test_tampered_order_is_rejected() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        Fill memory f = makeFill(mo, to, P, 100 * P);
        f.taker.size = uint256(2 * P); // signature was over size = 1
        assertEq(bytes4(settleReason(f)), Errors.InvalidSignature.selector);
        f.taker.size = uint256(P);
        f.taker.limitPrice = uint256(200 * P);
        assertEq(bytes4(settleReason(f)), Errors.InvalidSignature.selector);
    }

    function test_signature_from_another_key_is_rejected() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        Fill memory f = makeFill(mo, to, P, 100 * P);
        f.takerSignature = signWith(carolKey, to);
        assertEq(bytes4(settleReason(f)), Errors.InvalidSignature.selector);
        f.takerSignature = hex"deadbeef";
        assertEq(bytes4(settleReason(f)), Errors.InvalidSignature.selector);
    }

    /// Cross-chain replay protection: the domain binds chain id and gateway.
    function test_signature_for_another_chain_is_rejected() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        vm.chainId(5042);
        Fill memory f = makeFill(mo, to, P, 100 * P);
        vm.chainId(31_337);
        assertEq(bytes4(settleReason(f)), Errors.InvalidSignature.selector);
    }

    function test_domain_and_typehash_match_the_published_spec() public view {
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Kryon"),
                keccak256("1"),
                uint256(31_337),
                address(gateway)
            )
        );
        assertEq(gateway.domainSeparator(), expectedDomain);
        // Computed independently with `cast keccak`; the client must match.
        assertEq(OrderLib.ORDER_TYPEHASH, 0x21f9888ce344eb6dac96951d5836f845f2c3575a9a8b9326e9738f31a7a7f35e);
        assertEq(OrderLib.CANCEL_TYPEHASH, 0xe8845e2494f817ea8c4a4ec528e0ef1f7ad7f9c616163958bb73103d4c54041c);
    }

    /// Parity vector for client/lib/market/eip712.ts: a fixed order on a fixed
    /// domain (chain 5042002, gateway 0x…C0FFEE) must hash to this digest.
    function test_eip712_parity_vector() public pure {
        Order memory o = Order({
            owner: 0x1111111111111111111111111111111111111111,
            marketId: 2,
            isLong: true,
            size: 1_500_000_000_000_000_000,
            limitPrice: 65_000_000_000_000_000_000_000,
            reduceOnly: false,
            nonce: 42,
            expiry: 1_790_000_000,
            referrer: 0x0000000000000000000000000000000000000000
        });
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Kryon"),
                keccak256("1"),
                uint256(5_042_002),
                address(0x0000000000000000000000000000000000C0FFEE)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, OrderLib.hashStruct(o)));
        // Computed independently with `cast` (abi-encode + keccak).
        assertEq(digest, 0x3743031a08c230b780fb7de256d4133060df6d15605dd1d497e009f92b05895e);
    }

    function test_erc1271_wallet_can_trade() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(carol);
        address w = address(wallet);
        keyOf[w] = carolKey;
        usdc.mint(w, 1000e6);
        vm.startPrank(w);
        usdc.approve(address(vault), 1000e6);
        vault.deposit(1000e6);
        vm.stopPrank();
        trade(alice, w, BTC, true, P, 100 * P);
        assertEq(pos(w, BTC).size, P);

        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(w, BTC, true, P, 100 * P);
        Fill memory f = makeFill(mo, to, P, 100 * P);
        f.takerSignature = signWith(bobKey, to);
        assertEq(bytes4(settleReason(f)), Errors.InvalidSignature.selector);
    }

    /// An EIP-7702-delegated EOA has code but still signs with its own key.
    function test_eip7702_delegated_eoa_signature_is_accepted() public {
        vm.etch(bob, abi.encodePacked(hex"ef0100", address(0xDE1E6A7E)));
        assertGt(bob.code.length, 0);
        trade(alice, bob, BTC, true, P, 100 * P);
        assertEq(pos(bob, BTC).size, P);
    }

    // --------------------------------------------------- order validation

    function test_rejects_self_trade_same_side_and_market_mismatch() public {
        Order memory a1 = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory a2 = makeOrder(alice, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(a1, a2, P, 100 * P))), Errors.SelfTrade.selector);

        Order memory b1 = makeOrder(bob, BTC, false, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(a1, b1, P, 100 * P))), Errors.DirectionMismatch.selector);

        Order memory b2 = makeOrder(bob, ETH, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(a1, b2, P, 100 * P))), Errors.InvalidConfig.selector);
    }

    function test_fill_price_must_respect_both_limits() public {
        // Buyer's limit is a ceiling.
        Order memory mo = makeOrder(alice, BTC, false, P, 99 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, P, 100 * P + 1))), Errors.PriceOutsideBand.selector);
        // Seller's limit is a floor.
        mo = makeOrder(alice, BTC, false, P, 100 * P);
        to = makeOrder(bob, BTC, true, P, 101 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, P, 100 * P - 1))), Errors.PriceOutsideBand.selector);
        // Anything in between settles.
        settleOk(makeFill(mo, to, P, 100 * P + 5e17));
    }

    function test_nonce_is_bound_to_one_order() public {
        Order memory mo = makeOrder(alice, BTC, false, 2 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        settleOk(makeFill(mo, to, P, 100 * P));

        Order memory again = mo;
        again.size = uint256(5 * P); // a second order under the same nonce
        Order memory to2 = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(again, to2, P, 100 * P))), Errors.NonceReused.selector);
    }

    function test_cancel_up_to_voids_older_nonces() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P); // nonce 1
        vm.prank(alice);
        gateway.cancelUpTo(2);
        assertTrue(gateway.isCancelled(alice, 1));
        assertFalse(gateway.isCancelled(alice, 2));
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, P, 100 * P))), Errors.OrderCancelled.selector);

        vm.prank(alice);
        vm.expectRevert(Errors.InvalidConfig.selector);
        gateway.cancelUpTo(2);
        trade(alice, bob, BTC, true, P, 100 * P); // nonce 2 works
    }

    function test_signed_cancel_can_be_posted_by_anyone() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Cancel memory c = Cancel({owner: alice, nonce: mo.nonce, deadline: uint64(_now() + 60)});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, gateway.hashCancel(c));
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(carol);
        vm.expectRevert(Errors.InvalidSignature.selector);
        gateway.cancelSigned(Cancel({owner: bob, nonce: mo.nonce, deadline: c.deadline}), sig);

        vm.prank(carol);
        gateway.cancelSigned(c, sig);
        assertTrue(gateway.isCancelled(alice, mo.nonce));

        vm.warp(_now() + 61);
        vm.expectRevert(Errors.OrderExpired.selector);
        gateway.cancelSigned(c, sig);
    }

    function test_cancel_orders_batch() public {
        uint256[] memory nonces = new uint256[](3);
        nonces[0] = 7;
        nonces[1] = 8;
        nonces[2] = 9;
        vm.prank(alice);
        gateway.cancelOrders(nonces);
        assertTrue(gateway.isCancelled(alice, 8));
    }

    function test_min_fill_notional() public {
        MarketParams memory m = _withMinFill(20 * P);
        asGov();
        risk.setMarket(BTC, m);
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(
            bytes4(settleReason(makeFill(mo, to, P / 10, 100 * P))), Errors.FillBelowMinNotional.selector
        );
        settleOk(makeFill(mo, to, P / 5, 100 * P));
    }

    function test_rejects_zero_and_oversized_amounts() public {
        Order memory mo = makeOrder(alice, BTC, false, P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, P, 100 * P);
        assertEq(bytes4(settleReason(makeFill(mo, to, 0, 100 * P))), Errors.InvalidAmount.selector);
        Order memory big = makeOrder(bob, BTC, true, P, 100 * P);
        big.size = type(uint256).max;
        Order memory bigm = makeOrder(alice, BTC, false, P, 100 * P);
        bigm.size = type(uint256).max;
        Fill memory f = makeFill(bigm, big, 0, 100 * P);
        f.size = uint256(uint128(type(int128).max)) + 1;
        assertEq(bytes4(settleReason(f)), Errors.MathOverflow.selector);
    }

    // ------------------------------------------------------------ batching

    /// A bad fill in a batch is rejected on its own; the rest settle.
    function test_batch_isolates_a_failing_fill() public {
        Fill[] memory fills = new Fill[](3);
        fills[0] = makeFill(
            makeOrder(alice, BTC, false, P, 100 * P), makeOrder(bob, BTC, true, P, 100 * P), P, 100 * P
        );
        fills[1] = makeFill(
            makeOrder(alice, BTC, false, P, 100 * P), makeOrder(bob, BTC, true, P, 100 * P), P, 100 * P
        );
        fills[1].makerSignature = hex"00";
        address broke = newTrader("broke", 1e6);
        fills[2] = makeFill(
            makeOrder(alice, BTC, false, 100 * P, 100 * P),
            makeOrder(broke, BTC, true, 100 * P, 100 * P),
            100 * P,
            100 * P
        );
        vm.recordLogs();
        vm.prank(operator);
        uint256 settled = gateway.settleFillsSigned(fills);
        assertEq(settled, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 rejected;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("FillRejected(bytes32,bytes)")) {
                ++rejected;
                assertTrue(logs[i].topics[1] == fills[1].fillId || logs[i].topics[1] == fills[2].fillId);
            }
        }
        assertEq(rejected, 2);
        assertEq(pos(bob, BTC).size, P);
        assertEq(engine.positionCount(broke), 0);
        assertSolvencyExact();
    }

    function test_only_operator_settles_and_settle_one_is_internal() public {
        Fill[] memory fills = new Fill[](1);
        fills[0] = makeFill(
            makeOrder(alice, BTC, false, P, 100 * P), makeOrder(bob, BTC, true, P, 100 * P), P, 100 * P
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Roles.OPERATOR_ROLE
            )
        );
        gateway.settleFillsSigned(fills);
        vm.expectRevert(Errors.OnlySelf.selector);
        gateway.settleOne(fills[0]);
    }

    function test_batch_size_bounds() public {
        vm.prank(operator);
        vm.expectRevert(Errors.BatchTooLarge.selector);
        gateway.settleFillsSigned(new Fill[](0));
        vm.prank(operator);
        vm.expectRevert(Errors.BatchTooLarge.selector);
        gateway.settleFillsSigned(new Fill[](65));
    }

    function test_starved_batch_reverts_instead_of_rejecting() public {
        Fill[] memory fills = new Fill[](2);
        fills[0] = makeFill(
            makeOrder(alice, BTC, false, P, 100 * P), makeOrder(bob, BTC, true, P, 100 * P), P, 100 * P
        );
        fills[1] = fills[0];
        vm.prank(operator);
        vm.expectRevert(Errors.InvalidConfig.selector);
        gateway.settleFillsSigned{gas: 400_000}(fills);
    }

    // ------------------------------------------------------------ helpers

    function _cfg(int256 coeff, int256 maxRate) internal pure returns (FundingConfig memory c) {
        c.premiumCoeff = coeff;
        c.maxRatePerHour = maxRate;
    }

    function _withMinFill(int256 minFill) internal view returns (MarketParams memory m) {
        m = risk.market(BTC);
        m.minFillNotional = minFill;
    }
}
