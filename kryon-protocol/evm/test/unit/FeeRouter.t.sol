// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {FeeRouter} from "../../src/FeeRouter.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {Order} from "../../src/libraries/OrderLib.sol";
import {KryonTest} from "../utils/KryonTest.sol";

/// @notice ARC_MIGRATION_PLAN.md §5.8 fee tests, plus schedule plumbing.
contract FeeRouterTest is KryonTest {
    function setUp() public override {
        super.setUp();
        fund(alice, 100_000e6);
        fund(bob, 100_000e6);
    }

    // §5.8: a fee can't push an account below initial margin.
    function test_fee_cannot_push_account_below_initial_margin() public {
        address edge = newTrader("edge", 100e6);
        // 10 units @100 = 1000 notional, IM 10% = exactly 100: the taker fee
        // (0.35) is what would breach it.
        Order memory mo = makeOrder(alice, BTC, false, 10 * P, 100 * P);
        Order memory to = makeOrder(edge, BTC, true, 10 * P, 100 * P);
        bytes memory reason = settleReason(makeFill(mo, to, 10 * P, 100 * P));
        assertEq(bytes4(reason), Errors.InsufficientCollateral.selector);
        assertEq(bal(edge), 100 * P, "the rejected fill charged nothing");
        assertEq(engine.positionCount(edge), 0);
    }

    // §5.8: no fill ever has a negative net fee.
    function test_rebate_floor_holds_for_every_tier_pairing() public {
        vm.startPrank(address(timelock));
        feeRouter.setRebatesEnabled(true);
        feeRouter.setMarketFees(BTC, -200, 300); // -2 / +3 bps, net 1 bps
        feeRouter.defineTier(1, -200, 300);
        feeRouter.defineTier(2, 0, 100); // cheap taker tier
        vm.stopPrank();
        vm.startPrank(tierBot);
        feeRouter.setAccountTier(alice, 1); // maker rebate -2
        feeRouter.setAccountTier(bob, 2); // taker 1 bps
        vm.stopPrank();

        (int256 mf, int256 tf, uint8 mt, uint8 tt) = feeRouter.quote(BTC, alice, bob, 1000 * P);
        assertEq(mt, 1);
        assertEq(tt, 2);
        // Pairing -2 with +1 would net negative: the maker side is clamped.
        assertGe(mf + tf, 0);
        assertEq(mf + tf, 1000 * P * 100 / 1_000_000);

        int256 aliceBefore = bal(alice);
        trade(alice, bob, BTC, true, 10 * P, 100 * P);
        assertEq(bal(alice), aliceBefore - mf);
    }

    function test_rebate_is_paid_from_the_same_fills_taker_fee() public {
        vm.startPrank(address(timelock));
        feeRouter.setRebatesEnabled(true);
        feeRouter.setMarketFees(BTC, -100, 350);
        vm.stopPrank();
        int256 aliceBefore = bal(alice);
        trade(alice, bob, BTC, true, 10 * P, 100 * P); // notional 1000
        assertEq(bal(alice), aliceBefore + 1000 * P * 100 / 1_000_000, "maker rebate credited");
        int256 net = 1000 * P * 250 / 1_000_000;
        assertEq(bal(address(feeRouter)) + (bal(address(insurance))), net);
    }

    function test_negative_rates_are_ignored_while_rebates_are_off() public {
        vm.startPrank(address(timelock));
        feeRouter.setRebatesEnabled(true);
        feeRouter.setMarketFees(BTC, -100, 350);
        feeRouter.setRebatesEnabled(false);
        vm.stopPrank();
        (int256 mf,,,) = feeRouter.quote(BTC, alice, bob, 1000 * P);
        assertEq(mf, 0);
        asGov();
        vm.expectRevert(Errors.FeeRateOutOfBounds.selector);
        feeRouter.setMarketFees(BTC, -1, 350);
    }

    // §5.8: setters revert above the hard caps.
    function test_setters_revert_above_hard_caps() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(Errors.FeeRateOutOfBounds.selector);
        feeRouter.setMarketFees(BTC, 0, 2501);
        vm.expectRevert(Errors.FeeRateOutOfBounds.selector);
        feeRouter.setMarketFees(BTC, 2501, 350);
        vm.expectRevert(Errors.FeeRateOutOfBounds.selector);
        feeRouter.setMarketFees(BTC, 0, -1);
        feeRouter.setRebatesEnabled(true);
        vm.expectRevert(Errors.FeeRateOutOfBounds.selector);
        feeRouter.setMarketFees(BTC, -201, 350);
        vm.expectRevert(Errors.NetFeeBelowFloor.selector);
        feeRouter.setMarketFees(BTC, -200, 250);
        vm.expectRevert(Errors.FeeRateOutOfBounds.selector);
        feeRouter.setMinNetRate(99);
        vm.expectRevert(Errors.FeeRateOutOfBounds.selector);
        feeRouter.setMinNetRate(2501);
        vm.expectRevert(Errors.InvalidConfig.selector);
        feeRouter.setSplit(7000, 2000, 999);
        vm.expectRevert(Errors.InvalidConfig.selector);
        feeRouter.setSplit(7500, 999, 1501);
        vm.expectRevert(Errors.InvalidConfig.selector);
        feeRouter.setSplit(6900, 1000, 2100);
        vm.expectRevert(Errors.InvalidConfig.selector);
        feeRouter.setLiquidationSplit(999);
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownFeeTier.selector, uint8(0)));
        feeRouter.defineTier(0, 0, 350);
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownFeeTier.selector, uint8(17)));
        feeRouter.defineTier(17, 0, 350);
        vm.expectRevert(Errors.InvalidConfig.selector);
        feeRouter.setMarketFees(0, 0, 350);
        vm.stopPrank();
    }

    function test_fee_admin_is_governance_only() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(this),
                Roles.FEE_ADMIN_ROLE
            )
        );
        feeRouter.setMarketFees(BTC, 0, 350);
    }

    // §5.8: split conservation, exact at 1e18.
    function testFuzz_split_conserves_every_wei(uint64 sizeSeed, uint16 insBps, uint16 refBps) public {
        insBps = uint16(bound(insBps, 1000, 9000));
        refBps = uint16(bound(refBps, 0, 2000));
        vm.assume(uint256(insBps) + refBps <= 10_000);
        vm.startPrank(address(timelock));
        feeRouter.setSplit(10_000 - insBps - refBps, insBps, refBps);
        feeRouter.setReferralsEnabled(true);
        address referrer = makeAddr("referrer");
        feeRouter.setReferrerApproved(referrer, true);
        vm.stopPrank();

        int256 size = int256(bound(sizeSeed, 1, 1_000_000)) * 1e12; // 1e-6 .. 1 unit
        Order memory mo = makeOrder(alice, BTC, false, size, 100 * P + 7);
        Order memory to = makeOrder(bob, BTC, true, size, 100 * P + 7);
        to.referrer = referrer;
        mo.referrer = referrer;
        (int256 mf, int256 tf,,) = feeRouter.quote(BTC, alice, bob, size * (100 * P + 7) / P);
        int256 feeRouterBefore = bal(address(feeRouter));
        int256 insBefore = bal(address(insurance));
        settleOk(makeFill(mo, to, size, 100 * P + 7));

        int256 charged = mf + tf;
        int256 routed =
            (bal(address(feeRouter)) - feeRouterBefore) + (bal(address(insurance)) - insBefore);
        assertEq(routed, charged, "every charged wei lands in a bucket");
        assertEq(
            bal(address(feeRouter)), feeRouter.treasuryAccrued() + feeRouter.totalReferralAccrued()
        );
        assertEq(feeRouter.referralAccrued(referrer), feeRouter.totalReferralAccrued());
        assertSolvencyExact();
    }

    // §5.8: claim rounding. Claimed tokens * 1e12 <= accrued; dust remains.
    function test_claim_pays_whole_units_and_leaves_dust() public {
        trade(alice, bob, BTC, true, 3 * P + 7, 100 * P + 13);
        int256 accrued = feeRouter.treasuryAccrued();
        assertGt(accrued, 0);
        uint256 paid = feeRouter.claimTreasury();
        assertEq(usdc.balanceOf(treasury), paid);
        assertLe(int256(paid) * 1e12, accrued);
        int256 dust = feeRouter.treasuryAccrued();
        assertEq(dust, accrued - int256(paid) * 1e12);
        assertLt(dust, 1e12);
        assertEq(feeRouter.claimTreasury(), 0, "dust is not claimable");
        assertSolvencyExact();
    }

    function test_referrals_accrue_to_treasury_until_enabled() public {
        address referrer = makeAddr("referrer");
        Order memory mo = makeOrder(alice, BTC, false, 10 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, 10 * P, 100 * P);
        to.referrer = referrer;
        settleOk(makeFill(mo, to, 10 * P, 100 * P));
        assertEq(feeRouter.referralAccrued(referrer), 0);

        vm.startPrank(address(timelock));
        feeRouter.setReferralsEnabled(true);
        feeRouter.setReferrerApproved(referrer, true);
        vm.stopPrank();
        mo = makeOrder(alice, BTC, false, 10 * P, 100 * P);
        to = makeOrder(bob, BTC, true, 10 * P, 100 * P);
        to.referrer = referrer;
        settleOk(makeFill(mo, to, 10 * P, 100 * P));
        int256 takerFee = 1000 * P * 350 / 1_000_000;
        assertEq(feeRouter.referralAccrued(referrer), takerFee * 1000 / 10_000);

        uint256 paid = feeRouter.claimReferral(referrer);
        assertEq(usdc.balanceOf(referrer), paid);
        assertEq(paid, 35_000); // 0.035 USDC
    }

    function test_self_referral_earns_nothing() public {
        vm.startPrank(address(timelock));
        feeRouter.setReferralsEnabled(true);
        // Even an approved partner earns nothing on their own fees.
        feeRouter.setReferrerApproved(bob, true);
        vm.stopPrank();
        Order memory mo = makeOrder(alice, BTC, false, 10 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, 10 * P, 100 * P);
        to.referrer = bob;
        settleOk(makeFill(mo, to, 10 * P, 100 * P));
        assertEq(feeRouter.referralAccrued(bob), 0);
    }

    /// Review fix 5: a second wallet of the trader (or any unapproved address)
    /// can't collect the referral share.
    function test_unapproved_referrer_earns_nothing_and_share_goes_to_treasury() public {
        address sockPuppet = makeAddr("bobSecondWallet");
        asGov();
        feeRouter.setReferralsEnabled(true);
        Order memory mo = makeOrder(alice, BTC, false, 10 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, 10 * P, 100 * P);
        to.referrer = sockPuppet;
        mo.referrer = sockPuppet;
        (int256 mf, int256 tf,,) = feeRouter.quote(BTC, alice, bob, 1000 * P);
        settleOk(makeFill(mo, to, 10 * P, 100 * P));
        assertEq(feeRouter.referralAccrued(sockPuppet), 0);
        assertEq(feeRouter.totalReferralAccrued(), 0);
        int256 net = mf + tf;
        assertEq(feeRouter.treasuryAccrued() + bal(address(insurance)), net, "split conserves");
        assertEq(feeRouter.treasuryAccrued(), net - (mf * 2000 / 10_000 + tf * 2000 / 10_000));
        assertSolvencyExact();
    }

    function test_approved_referrer_earns_until_removed() public {
        address partner = makeAddr("partner");
        vm.startPrank(address(timelock));
        feeRouter.setReferralsEnabled(true);
        vm.expectEmit(address(feeRouter));
        emit FeeRouter.ReferrerApprovalSet(partner, true);
        feeRouter.setReferrerApproved(partner, true);
        vm.stopPrank();
        assertTrue(feeRouter.isApprovedReferrer(partner));

        Order memory mo = makeOrder(alice, BTC, false, 10 * P, 100 * P);
        Order memory to = makeOrder(bob, BTC, true, 10 * P, 100 * P);
        to.referrer = partner;
        settleOk(makeFill(mo, to, 10 * P, 100 * P));
        int256 earned = feeRouter.referralAccrued(partner);
        assertEq(earned, (1000 * P * 350 / 1_000_000) * 1000 / 10_000);
        assertEq(
            bal(address(feeRouter)), feeRouter.treasuryAccrued() + feeRouter.totalReferralAccrued()
        );

        asGov();
        feeRouter.setReferrerApproved(partner, false);
        mo = makeOrder(alice, BTC, false, 10 * P, 100 * P);
        to = makeOrder(bob, BTC, true, 10 * P, 100 * P);
        to.referrer = partner;
        settleOk(makeFill(mo, to, 10 * P, 100 * P));
        assertEq(feeRouter.referralAccrued(partner), earned);
        assertSolvencyExact();
    }

    function test_referrer_approval_is_fee_admin_only() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Roles.FEE_ADMIN_ROLE
            )
        );
        feeRouter.setReferrerApproved(alice, true);
        asGov();
        vm.expectRevert(Errors.ZeroAddress.selector);
        feeRouter.setReferrerApproved(address(0), true);
    }

    // §5.8: FEE_TIER_ROLE can only assign existing tiers.
    function test_tier_bot_can_only_assign_existing_tiers() public {
        vm.prank(tierBot);
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownFeeTier.selector, uint8(3)));
        feeRouter.setAccountTier(alice, 3);

        asGov();
        feeRouter.defineTier(3, 20, 200);
        vm.prank(tierBot);
        feeRouter.setAccountTier(alice, 3);
        assertEq(feeRouter.accountTier(alice), 3);
        (int256 mf,, uint8 mt,) = feeRouter.quote(BTC, alice, bob, 1000 * P);
        assertEq(mt, 3);
        assertEq(mf, 1000 * P * 20 / 1_000_000);

        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, carol, Roles.FEE_TIER_ROLE
            )
        );
        feeRouter.setAccountTier(alice, 0);
    }

    function test_quote_requires_a_schedule_and_positive_notional() public {
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownMarket.selector, uint32(99)));
        feeRouter.quote(99, alice, bob, P);
        vm.expectRevert(Errors.InvalidAmount.selector);
        feeRouter.quote(BTC, alice, bob, 0);
    }

    function test_charge_paths_are_restricted() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(this),
                Roles.FEE_SOURCE_ROLE
            )
        );
        feeRouter.chargeFill(BTC, alice, bob, P, address(0), address(0));
        vm.prank(address(liquidation));
        vm.expectRevert(Errors.InvalidAmount.selector);
        feeRouter.accrueLiquidationFee(BTC, bob, -1);
    }

    function test_launch_schedule_and_views() public {
        FeeRouter.Rates memory r = feeRouter.marketRates(BTC);
        assertEq(r.takerRate, 350);
        assertEq(r.makerRate, 50);
        assertEq(feeRouter.minNetRate(), 100);
        FeeRouter.Split memory sp = feeRouter.split();
        assertEq(sp.treasuryBps, 7000);
        assertEq(sp.insuranceBps, 2000);
        assertEq(sp.referralBps, 1000);
        (address t, address i) = feeRouter.recipients();
        assertEq(t, treasury);
        assertEq(i, address(insurance));
        assertFalse(feeRouter.rebatesEnabled());
        assertFalse(feeRouter.referralsEnabled());
        assertEq(feeRouter.liquidationInsuranceBps(), 5000);
        assertEq(feeRouter.vault(), address(vault));
        assertEq(feeRouter.tierRates(1).set, false);

        address newTreasury = makeAddr("newTreasury");
        asGov();
        feeRouter.setTreasury(newTreasury);
        (t,) = feeRouter.recipients();
        assertEq(t, newTreasury);
    }
}
