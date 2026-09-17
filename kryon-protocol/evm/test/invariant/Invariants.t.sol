// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControlEnumerable} from
    "@openzeppelin/contracts/access/extensions/IAccessControlEnumerable.sol";

import {KryonDeploy} from "../../script/lib/KryonDeploy.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {MarketParams, ORACLE_SOURCE_QUORUM, OracleSnapshot} from "../../src/libraries/Types.sol";
import {KryonTest} from "../utils/KryonTest.sol";
import {Handler} from "./Handler.sol";

/// @notice ARC_MIGRATION_PLAN.md §3 protocol invariants 1-6, plus the
///         accounting identities the design depends on.
contract InvariantsTest is KryonTest {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        uint32[] memory ms = new uint32[](2);
        ms[0] = BTC;
        ms[1] = ETH;
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = BTC_ID;
        ids[1] = ETH_ID;
        // Room for leveraged campaign trades; the caps have their own unit tests.
        vm.startPrank(address(timelock));
        for (uint256 i = 0; i < ms.length; ++i) {
            MarketParams memory m = risk.market(ms[i]);
            m.maxOpenInterest = 1e30;
            risk.setMarket(ms[i], m);
            // Mainnet jump guard, so the outage action exercises the re-anchor.
            OracleAdapter.FeedConfig memory f = oracle.feed(ids[i]);
            f.maxJumpBps = 2000;
            oracle.setFeed(ids[i], f);
        }
        vm.stopPrank();
        handler = new Handler(d, usdc, operator, publisher, keeper, ms, ids);

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.withdraw.selector;
        selectors[2] = Handler.trade.selector;
        selectors[3] = Handler.trade.selector;
        selectors[4] = Handler.trade.selector;
        selectors[5] = Handler.movePrice.selector;
        selectors[6] = Handler.updateFunding.selector;
        selectors[7] = Handler.liquidate.selector;
        selectors[8] = Handler.adl.selector;
        selectors[9] = Handler.settleAllBadDebt.selector;
        selectors[10] = Handler.donate.selector;
        selectors[11] = Handler.stake.selector;
        selectors[12] = Handler.claimTreasury.selector;
        selectors[13] = Handler.oracleOutage.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Invariant 1: withdrawals are validated against current equity.
    function invariant_1_withdrawals_respect_initial_margin() public view {
        assertEq(handler.withdrawalsBelowInitialMargin(), 0);
    }

    /// Invariant 2: liquidation is based on account health.
    function invariant_2_only_unhealthy_accounts_are_liquidated() public view {
        assertEq(handler.liquidationsOfHealthyAccounts(), 0);
    }

    /// Invariant 3: funding derives from the mark-index premium.
    function invariant_3_funding_is_the_clamped_premium() public view {
        assertEq(handler.fundingNotFromPremium(), 0);
    }

    /// Invariant 4: every oracle read carries source, timestamps, confidence.
    function invariant_4_oracle_snapshots_are_well_formed() public view {
        bytes32[2] memory ids = [BTC_ID, ETH_ID];
        for (uint256 i = 0; i < ids.length; ++i) {
            OracleSnapshot memory s = oracle.latest(ids[i]);
            assertEq(s.source, ORACLE_SOURCE_QUORUM);
            assertGt(s.price, 0);
            assertGe(s.confidence, 0);
            assertLe(s.publishTime, s.writeTime);
            assertLe(s.writeTime, vm.getBlockTimestamp());
            assertGe(s.sourceCount, 1);
        }
    }

    /// Invariant 4 (liveness): an outage followed by a move beyond the jump
    /// guard never leaves a feed stuck on the old price.
    function invariant_4_feeds_reanchor_after_an_outage() public view {
        assertEq(handler.feedsStuckAfterOutage(), 0);
    }

    /// Invariant 5: balances + fee buckets + insurance - unsettled bad debt
    /// == vault USDC, exactly (open cost basis included; see Vault docs).
    function invariant_5_vault_is_exactly_solvent() public view {
        assertSolvencyExact();
        assertEq(vault.totalLedger(), handler.sumBalances(), "ledger total is the sum of accounts");
        assertEq(engine.netCostBasis(), handler.sumCostBasis(), "cost basis total is exact");
        assertEq(
            bal(address(feeRouter)),
            feeRouter.treasuryAccrued() + feeRouter.totalReferralAccrued(),
            "fee buckets account for every wei"
        );
    }

    /// Invariant 6: only the timelock can upgrade or change parameters.
    function invariant_6_admin_roles_stay_with_the_timelock() public view {
        address[8] memory all = KryonDeploy.proxies(d);
        bytes32[4] memory roles =
            [Roles.DEFAULT_ADMIN_ROLE, Roles.UPGRADER_ROLE, Roles.RISK_ADMIN_ROLE, Roles.FEE_ADMIN_ROLE];
        for (uint256 i = 0; i < all.length; ++i) {
            for (uint256 r = 0; r < roles.length; ++r) {
                IAccessControlEnumerable c = IAccessControlEnumerable(all[i]);
                assertEq(c.getRoleMemberCount(roles[r]), 1);
                assertEq(c.getRoleMember(roles[r], 0), address(timelock));
            }
        }
    }

    /// Matched fills and backstop takeovers keep both sides of every market equal.
    function invariant_open_interest_is_balanced() public view {
        uint32[2] memory ms = [BTC, ETH];
        for (uint256 i = 0; i < ms.length; ++i) {
            (int256 l, int256 s) = engine.openInterest(ms[i]);
            assertEq(l, s);
            assertGe(l, 0);
        }
    }

    /// Recorded bad debt never exceeds what accounts actually owe.
    function invariant_bad_debt_is_backed_by_negative_balances() public view {
        int256 owed;
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            int256 b = bal(handler.actors(i));
            if (b < 0) owed -= b;
        }
        assertLe(insurance.badDebt(), owed);
    }

    function invariant_staking_never_mints_against_nothing() public view {
        if (insurance.totalShares() > 0) assertGt(insurance.stakedBalance(), 0);
    }

    uint256 internal totalTrades;
    uint256 internal totalLiquidations;
    uint256 internal totalAdls;

    /// Coverage probe: the campaign must actually trade and liquidate, or the
    /// invariants above are passing vacuously.
    function afterInvariant() external {
        totalTrades += handler.trades();
        totalLiquidations += handler.liquidations();
        totalAdls += handler.adls();
        vm.writeLine(
            "out/invariant-coverage.log",
            string.concat(
                vm.toString(handler.trades()), " ",
                vm.toString(handler.liquidations()), " ",
                vm.toString(handler.adls()), " ",
                vm.toString(insurance.badDebt())
            )
        );
        emit log_named_uint("campaign trades", handler.trades());
        emit log_named_uint("campaign liquidations", handler.liquidations());
        emit log_named_uint("campaign adls", handler.adls());
        emit log_named_int("insurance bad debt", insurance.badDebt());
        for (uint256 i = 0; i < handler.rejectReasonCount(); ++i) {
            bytes4 r = handler.rejectReasons(i);
            emit log_named_bytes32("reject", bytes32(r));
            emit log_named_uint("  count", handler.rejectCount(r));
        }
    }
}
