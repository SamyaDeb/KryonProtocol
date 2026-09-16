// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Vm} from "forge-std/Test.sol";

import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {OracleSnapshot} from "../../src/libraries/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract OracleAdapterTest is KryonTest {
    bytes32 constant Q = "QUORUM";
    address pub2 = makeAddr("publisher2");
    address pub3 = makeAddr("publisher3");

    function _feed(uint8 minPublishers, uint16 spread, uint16 jump)
        internal
        pure
        returns (OracleAdapter.FeedConfig memory)
    {
        return OracleAdapter.FeedConfig({
            listed: true,
            active: true,
            minPublishers: minPublishers,
            maxSpreadBps: spread,
            maxJumpBps: jump,
            maxConfidenceBps: 200,
            maxAge: 60
        });
    }

    function _threePublishers() internal {
        address[] memory keys = new address[](3);
        keys[0] = publisher;
        keys[1] = pub2;
        keys[2] = pub3;
        vm.startPrank(address(timelock));
        oracle.setPublishers(keys);
        oracle.setFeed(Q, _feed(3, 300, 0));
        vm.stopPrank();
    }

    function _pushAs(address who, bytes32 id, int256 price, int256 conf, uint64 t) internal {
        bytes32[] memory ids = new bytes32[](1);
        int256[] memory prices = new int256[](1);
        int256[] memory confs = new int256[](1);
        ids[0] = id;
        prices[0] = price;
        confs[0] = conf;
        vm.prank(who);
        oracle.pushPrices(ids, prices, confs, t);
    }

    function _skipReason(Vm.Log[] memory logs) internal pure returns (bool found, uint8 reason) {
        bytes32 sig = keccak256("PriceUpdateSkipped(bytes32,uint8,int256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                (uint8 r,) = abi.decode(logs[i].data, (uint8, int256));
                return (true, r);
            }
        }
    }

    // ---------------------------------------------------- Soroban ports

    function test_rejects_unauthorized_publisher() public {
        address attacker = makeAddr("attacker");
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = BTC_ID;
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, Roles.PUBLISHER_ROLE
            )
        );
        oracle.pushPrices(ids, new int256[](1), new int256[](1), uint64(_now()));
    }

    function test_single_source_rejects_replayed_publish_time() public {
        uint64 t = uint64(_now());
        vm.warp(t + 5);
        vm.expectRevert(Errors.StaleOracle.selector);
        _pushAs(publisher, BTC_ID, 99 * P, P / 100, t);
        assertEq(oracle.getPrice(BTC_ID, 0, 0).price, 100 * P);
    }

    function test_quorum_price_uses_median_and_max_confidence() public {
        _threePublishers();
        uint64 t = uint64(_now());
        _pushAs(publisher, Q, 100 * P, P, t);
        _pushAs(pub2, Q, 101 * P, 2 * P, t);
        vm.warp(t + 1);
        _pushAs(pub3, Q, 99 * P, P, t + 1);
        OracleSnapshot memory s = oracle.getPrice(Q, 0, 0);
        assertEq(s.price, 100 * P);
        assertEq(s.confidence, 2 * P);
        assertEq(s.sourceCount, 3);
        assertEq(s.publishTime, t, "the oldest observation dates the aggregate");
    }

    function test_quorum_skips_wide_source_deviation() public {
        _threePublishers();
        uint64 t = uint64(_now());
        _pushAs(publisher, Q, 100 * P, P, t);
        _pushAs(pub2, Q, 101 * P, P, t);
        vm.recordLogs();
        _pushAs(pub3, Q, 130 * P, P, t);
        (bool skipped, uint8 reason) = _skipReason(vm.getRecordedLogs());
        assertTrue(skipped);
        assertEq(reason, uint8(OracleAdapter.SkipReason.SpreadTooWide));
        vm.expectRevert(Errors.StaleOracle.selector);
        oracle.getPrice(Q, 0, 0);
    }

    function test_quorum_waits_for_min_publishers() public {
        _threePublishers();
        vm.recordLogs();
        _pushAs(publisher, Q, 100 * P, P, uint64(_now()));
        (bool skipped, uint8 reason) = _skipReason(vm.getRecordedLogs());
        assertTrue(skipped);
        assertEq(reason, uint8(OracleAdapter.SkipReason.QuorumNotMet));
    }

    function test_quorum_rejects_duplicate_publishers() public {
        address[] memory keys = new address[](2);
        keys[0] = pub2;
        keys[1] = pub2;
        asGov();
        vm.expectRevert(Errors.DuplicateOracleSource.selector);
        oracle.setPublishers(keys);
    }

    function test_stale_observations_do_not_count_toward_quorum() public {
        _threePublishers();
        uint64 t = uint64(_now());
        _pushAs(publisher, Q, 100 * P, P, t);
        _pushAs(pub2, Q, 100 * P, P, t);
        vm.warp(t + 61);
        vm.recordLogs();
        _pushAs(pub3, Q, 100 * P, P, t + 61);
        (bool skipped, uint8 reason) = _skipReason(vm.getRecordedLogs());
        assertTrue(skipped);
        assertEq(reason, uint8(OracleAdapter.SkipReason.QuorumNotMet));
    }

    function test_even_quorum_takes_the_mean_of_the_middle_pair() public {
        address[] memory keys = new address[](2);
        keys[0] = publisher;
        keys[1] = pub2;
        vm.startPrank(address(timelock));
        oracle.setPublishers(keys);
        oracle.setFeed(Q, _feed(2, 300, 0));
        vm.stopPrank();
        uint64 t = uint64(_now());
        _pushAs(publisher, Q, 100 * P, P, t);
        _pushAs(pub2, Q, 101 * P, P, t);
        assertEq(oracle.getPrice(Q, 0, 0).price, 1005 * P / 10);
    }

    function test_removed_publisher_loses_its_role_and_its_vote() public {
        address[] memory keys = new address[](1);
        keys[0] = pub2;
        asGov();
        oracle.setPublishers(keys);
        assertFalse(oracle.hasRole(Roles.PUBLISHER_ROLE, publisher));
        assertTrue(oracle.hasRole(Roles.PUBLISHER_ROLE, pub2));
        vm.warp(_now() + 1);
        _pushAs(pub2, BTC_ID, 102 * P, P / 100, uint64(_now()));
        assertEq(oracle.getPrice(BTC_ID, 0, 0).price, 102 * P);
    }

    // --------------------------------------------------------- read guards

    function test_get_price_enforces_freshness_and_confidence() public {
        vm.warp(_now() + 61);
        vm.expectRevert(Errors.StaleOracle.selector);
        oracle.getPrice(BTC_ID, 0, 0);
        // A tighter caller bound applies even when the feed default passes.
        push(BTC_ID, 100 * P);
        vm.warp(_now() + 10);
        vm.expectRevert(Errors.StaleOracle.selector);
        oracle.getPrice(BTC_ID, 5, 0);
        // Confidence 2e16 on a price of 100e18 is 2 bps: fine under the
        // feed default, too wide for a caller that demands 1 bps.
        vm.warp(_now() + 1);
        _pushAs(publisher, BTC_ID, 100 * P, 2 * P / 100, uint64(_now()));
        assertEq(oracle.getPrice(BTC_ID, 60, 2).confidence, 2 * P / 100);
        vm.expectRevert(Errors.OracleConfidenceTooWide.selector);
        oracle.getPrice(BTC_ID, 60, 1);
    }

    function test_unknown_and_inactive_feeds() public {
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownFeed.selector, bytes32("NOPE")));
        oracle.getPrice("NOPE", 0, 0);
        OracleAdapter.FeedConfig memory f = oracle.feed(BTC_ID);
        f.active = false;
        asGov();
        oracle.setFeed(BTC_ID, f);
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.getPrice(BTC_ID, 0, 0);
        vm.warp(_now() + 1);
        vm.expectRevert(Errors.InvalidConfig.selector);
        _pushAs(publisher, BTC_ID, 1, 0, uint64(_now()));
    }

    function test_push_input_validation() public {
        vm.warp(_now() + 10);
        uint64 t = uint64(_now());
        vm.expectRevert(Errors.InvalidPrice.selector);
        _pushAs(publisher, BTC_ID, 0, 0, t);
        vm.expectRevert(Errors.InvalidPrice.selector);
        _pushAs(publisher, BTC_ID, P, -1, t);
        vm.expectRevert(Errors.StaleOracle.selector);
        _pushAs(publisher, BTC_ID, P, 0, t + 1);
        vm.expectRevert(Errors.StaleOracle.selector);
        _pushAs(publisher, BTC_ID, P, 0, t - 61);
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownFeed.selector, bytes32("NOPE")));
        _pushAs(publisher, "NOPE", P, 0, t);
        bytes32[] memory ids = new bytes32[](2);
        vm.prank(publisher);
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.pushPrices(ids, new int256[](1), new int256[](2), t);
    }

    function test_jump_guard_skips_outsized_moves() public {
        asGov();
        oracle.setFeed(BTC_ID, _feed(1, 50, 1000));
        vm.warp(_now() + 1);
        vm.recordLogs();
        _pushAs(publisher, BTC_ID, 111 * P, P / 100, uint64(_now()));
        (bool skipped, uint8 reason) = _skipReason(vm.getRecordedLogs());
        assertTrue(skipped);
        assertEq(reason, uint8(OracleAdapter.SkipReason.JumpTooLarge));
        vm.warp(_now() + 1);
        _pushAs(publisher, BTC_ID, 109 * P, P / 100, uint64(_now()));
        assertEq(oracle.getPrice(BTC_ID, 0, 0).price, 109 * P);
    }

    function test_feed_config_bounds() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setFeed(bytes32(0), _feed(1, 50, 0));
        OracleAdapter.FeedConfig memory f = _feed(0, 50, 0);
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setFeed(Q, f);
        f = _feed(1, 50, 0);
        f.maxAge = 301;
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setFeed(Q, f);
        f = _feed(1, 10_001, 0);
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setFeed(Q, f);
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setPublishers(new address[](0));
        vm.stopPrank();
    }

    // ------------------------------------------------- external reference

    function _ref(MockAggregator agg, bool required) internal {
        asGov();
        oracle.setReferenceFeed(
            BTC_ID,
            OracleAdapter.ReferenceFeed({
                aggregator: address(agg),
                enabled: true,
                required: required,
                maxDivergenceBps: 150,
                maxRefAge: 90_000
            })
        );
    }

    function test_reference_divergence_blocks_the_update() public {
        MockAggregator agg = new MockAggregator(8);
        agg.set(100e8, _now());
        _ref(agg, false);
        (bool ok, int256 refPrice) = oracle.referencePrice(BTC_ID);
        assertTrue(ok);
        assertEq(refPrice, 100 * P, "8-decimal answer scaled to 1e18");

        vm.warp(_now() + 1);
        _pushAs(publisher, BTC_ID, 1014 * P / 10, P / 100, uint64(_now())); // +1.4%: ok
        assertEq(oracle.getPrice(BTC_ID, 0, 0).price, 1014 * P / 10);

        vm.warp(_now() + 1);
        vm.recordLogs();
        _pushAs(publisher, BTC_ID, 102 * P, P / 100, uint64(_now())); // +2%: blocked
        (bool skipped, uint8 reason) = _skipReason(vm.getRecordedLogs());
        assertTrue(skipped);
        assertEq(reason, uint8(OracleAdapter.SkipReason.ReferenceDiverged));
    }

    function test_stale_reference_is_ignored_unless_required() public {
        MockAggregator agg = new MockAggregator(8);
        agg.set(50e8, _now() - 100_000); // stale and wildly off
        _ref(agg, false);
        vm.warp(_now() + 1);
        _pushAs(publisher, BTC_ID, 100 * P, P / 100, uint64(_now()));
        assertEq(oracle.latest(BTC_ID).writeTime, _now());

        _ref(agg, true);
        vm.warp(_now() + 1);
        vm.recordLogs();
        _pushAs(publisher, BTC_ID, 100 * P, P / 100, uint64(_now()));
        (bool skipped, uint8 reason) = _skipReason(vm.getRecordedLogs());
        assertTrue(skipped);
        assertEq(reason, uint8(OracleAdapter.SkipReason.ReferenceUnavailable));

        agg.setBroken(true);
        (bool ok,) = oracle.referencePrice(BTC_ID);
        assertFalse(ok);
    }

    function test_reference_config_bounds() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownFeed.selector, bytes32("NOPE")));
        oracle.setReferenceFeed(
            "NOPE", OracleAdapter.ReferenceFeed(address(1), true, false, 150, 90_000)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        oracle.setReferenceFeed(
            BTC_ID, OracleAdapter.ReferenceFeed(address(0), true, false, 150, 90_000)
        );
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setReferenceFeed(BTC_ID, OracleAdapter.ReferenceFeed(address(1), true, false, 5, 90_000));
        vm.expectRevert(Errors.InvalidConfig.selector);
        oracle.setReferenceFeed(
            BTC_ID, OracleAdapter.ReferenceFeed(address(1), true, false, 150, 3 days)
        );
        // Disabling needs no aggregator.
        oracle.setReferenceFeed(BTC_ID, OracleAdapter.ReferenceFeed(address(0), false, false, 0, 0));
        vm.stopPrank();
        (bool ok,) = oracle.referencePrice(BTC_ID);
        assertFalse(ok);
    }

    function test_views() public view {
        assertEq(oracle.publishers()[0], publisher);
        assertEq(oracle.feedIds().length, 2);
        assertEq(oracle.observation(BTC_ID, publisher).price, 100 * P);
        assertEq(oracle.referenceFeed(BTC_ID).aggregator, address(0));
    }
}
