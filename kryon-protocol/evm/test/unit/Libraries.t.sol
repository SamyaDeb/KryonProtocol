// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Decimals} from "../../src/libraries/Decimals.sol";
import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {FundingLib} from "../../src/libraries/FundingLib.sol";
import {KryonMath as M} from "../../src/libraries/KryonMath.sol";
import {LiquidationLib} from "../../src/libraries/LiquidationLib.sol";
import {RiskLib} from "../../src/libraries/RiskLib.sol";
import {
    AccountHealth,
    FundingConfig,
    FundingState,
    LiquidationMode,
    LiquidationPlan,
    RiskCollateral,
    RiskMarket,
    RiskPosition
} from "../../src/libraries/Types.sol";

/// @dev External wrappers so reverts surface to `vm.expectRevert`.
contract LibHarness {
    function mulDiv(int256 a, int256 b, int256 c) external pure returns (int256) {
        return M.mulDiv(a, b, c);
    }

    function applyBps(int256 a, uint256 bps) external pure returns (int256) {
        return M.applyBps(a, bps);
    }

    function ceilDiv(int256 a, int256 b) external pure returns (int256) {
        return M.ceilDiv(a, b);
    }

    function impliedMaxLeverageBps(uint256 im) external pure returns (uint256) {
        return RiskLib.impliedMaxLeverageBps(im);
    }

    function premiumFromMark(int256 mark, int256 index) external pure returns (int256) {
        return FundingLib.premiumFromMark(mark, index);
    }

    function toTokenDown(int256 v) external pure returns (uint256) {
        return Decimals.toTokenDown(v);
    }

    function toInternal(uint256 v) external pure returns (int256) {
        return Decimals.toInternal(v);
    }

    function accountHealth(
        RiskCollateral[] memory c,
        RiskPosition[] memory p,
        RiskMarket[] memory m
    ) external pure returns (AccountHealth memory) {
        return RiskLib.accountHealth(c, p, m);
    }

    function validateWithdrawal(
        RiskCollateral[] memory c,
        RiskPosition[] memory p,
        RiskMarket[] memory m,
        int256 w
    ) external pure returns (AccountHealth memory) {
        return RiskLib.validateWithdrawal(c, p, m, w);
    }

    function plan(
        RiskCollateral[] memory c,
        RiskPosition[] memory p,
        RiskMarket[] memory m,
        uint256 id,
        uint256 bps
    ) external pure returns (LiquidationPlan memory) {
        return LiquidationLib.planLiquidation(c, p, m, id, bps);
    }
}

contract KryonMathTest is Test {
    int256 constant P = 1e18;
    LibHarness h = new LibHarness();

    // protocol-core::fixed tests
    function test_mulPrecision_scales_down() public pure {
        assertEq(M.mulPrecision(2 * P, 3 * P), 6 * P);
    }

    function test_signed_mulPrecision_does_not_overflow_before_division() public pure {
        assertEq(M.mulPrecision(-90 * P, P), -90 * P);
    }

    function test_applyBps_rejects_above_100_percent() public {
        vm.expectRevert(Errors.InvalidConfig.selector);
        h.applyBps(P, 10_001);
    }

    function test_ceilDiv_rounds_up() public pure {
        assertEq(M.ceilDiv(101, 10), 11);
        assertEq(M.ceilDiv(0, 10), 0);
    }

    function test_ceilDiv_rejects_bad_inputs() public {
        vm.expectRevert(Errors.InvalidAmount.selector);
        h.ceilDiv(-1, 10);
        vm.expectRevert(Errors.InvalidAmount.selector);
        h.ceilDiv(1, 0);
    }

    function test_mulDiv_division_by_zero() public {
        vm.expectRevert(Errors.DivisionByZero.selector);
        h.mulDiv(1, 1, 0);
    }

    function test_mulDiv_overflow_matches_i128_bound() public {
        vm.expectRevert(Errors.MathOverflow.selector);
        h.mulDiv(type(int128).max, 2, 1);
        vm.expectRevert(Errors.MathOverflow.selector);
        h.mulDiv(int256(type(int128).max) + 1, 1, 1);
    }

    function testFuzz_mulDiv_truncates_toward_zero(int128 a, int128 b, int128 c) public view {
        vm.assume(c != 0);
        int256 wide = int256(a) * int256(b) / int256(c);
        if (wide > type(int128).max || wide < type(int128).min) return;
        assertEq(h.mulDiv(a, b, c), wide);
    }

    // protocol-core::accounting tests
    function test_implied_leverage_is_the_inverse_of_initial_margin() public {
        assertEq(RiskLib.impliedMaxLeverageBps(1000), 100_000);
        assertEq(RiskLib.impliedMaxLeverageBps(500), 200_000);
        assertEq(RiskLib.impliedMaxLeverageBps(10_000), 10_000);
        vm.expectRevert(Errors.InvalidConfig.selector);
        h.impliedMaxLeverageBps(0);
    }

    function test_negative_collateral_is_debt_not_invalid_state() public pure {
        assertEq(RiskLib.collateralValueAfterHaircut(-100 * P, 500), -100 * P);
    }

    function test_max_leverage_bps() public pure {
        assertEq(RiskLib.maxLeverageBps(1000), 10 * P);
    }
}

contract DecimalsTest is Test {
    LibHarness h = new LibHarness();

    function testFuzz_token_to_internal_round_trip_is_exact(uint64 amount) public pure {
        int256 i = Decimals.toInternal(amount);
        assertEq(i, int256(uint256(amount)) * 1e12);
        assertEq(Decimals.toTokenDown(i), amount);
        assertEq(Decimals.toTokenUp(i), amount);
    }

    function testFuzz_credit_rounds_down_debit_rounds_up(uint96 internalAmount) public pure {
        int256 v = int256(uint256(internalAmount));
        uint256 down = Decimals.toTokenDown(v);
        uint256 up = Decimals.toTokenUp(v);
        assertLe(int256(down * 1e12), v, "credit never exceeds the internal amount");
        assertGe(int256(up * 1e12), v, "debit always covers the internal amount");
        assertLe(up - down, 1);
        if (uint256(v) % 1e12 == 0) assertEq(up, down);
    }

    function test_rejects_negative_and_oversized() public {
        vm.expectRevert(Errors.InvalidAmount.selector);
        h.toTokenDown(-1);
        vm.expectRevert(Errors.MathOverflow.selector);
        h.toInternal(Decimals.MAX_TOKEN_AMOUNT + 1);
    }
}

/// @notice Ports of risk-engine::{margin,funding,liquidation} unit tests.
contract RiskLibTest is Test {
    int256 constant P = 1e18;
    LibHarness h = new LibHarness();

    function _market(uint32 id, int256 price) internal pure returns (RiskMarket memory) {
        return RiskMarket({
            marketId: id,
            initialMarginBps: 1000,
            maintenanceMarginBps: 500,
            liquidationFeeBps: 50,
            active: true,
            oraclePrice: price,
            fundingIndexLong: 0,
            fundingIndexShort: 0
        });
    }

    function _pos(uint256 id, uint32 market, int256 size, int256 entry, int256 margin, bool iso)
        internal
        pure
        returns (RiskPosition memory)
    {
        return RiskPosition({
            positionId: id,
            marketId: market,
            size: size,
            entryPrice: entry,
            margin: margin,
            isLong: true,
            lastFundingIndex: 0,
            isolated: iso
        });
    }

    function _col(int256 v) internal pure returns (RiskCollateral[] memory c) {
        c = new RiskCollateral[](1);
        c[0] = RiskCollateral({value: v, haircutBps: 0});
    }

    function test_withdrawal_uses_unrealized_loss_not_locked_margin() public {
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = _pos(1, 1, 10 * P, 100 * P, 100 * P, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, 10 * P);
        AccountHealth memory hh = h.accountHealth(_col(1000 * P), p, m);
        assertEq(hh.unrealizedPnl, -900 * P);
        vm.expectRevert(Errors.InsufficientCollateral.selector);
        h.validateWithdrawal(_col(1000 * P), p, m, 900 * P);
    }

    function test_isolated_position_loss_counted_in_full() public view {
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = _pos(1, 1, 10 * P, 100 * P, 100 * P, true);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, P);
        AccountHealth memory hh = h.accountHealth(_col(1000 * P), p, m);
        assertEq(hh.unrealizedPnl, -990 * P);
        assertEq(hh.equity, 10 * P); // KRY-Q5
        assertTrue(hh.liquidatable);
    }

    function test_isolated_does_not_contaminate_cross_health() public view {
        RiskPosition[] memory p = new RiskPosition[](2);
        p[0] = _pos(1, 1, 10 * P, 100 * P, 100 * P, true);
        p[1] = _pos(2, 2, P, 100 * P, 0, false);
        RiskMarket[] memory m = new RiskMarket[](2);
        m[0] = _market(1, P);
        m[1] = _market(2, 100 * P);
        AccountHealth memory hh = h.accountHealth(_col(2000 * P), p, m);
        assertTrue(hh.liquidatable);
        assertGe(hh.marginRatio, 0);
        assertEq(hh.equity, 1010 * P);
    }

    function test_missing_or_inactive_market_is_invalid_config() public {
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = _pos(1, 7, P, 100 * P, 0, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, 100 * P);
        vm.expectRevert(Errors.InvalidConfig.selector);
        h.accountHealth(_col(P), p, m);
        m[0] = _market(7, 100 * P);
        m[0].active = false;
        vm.expectRevert(Errors.InvalidConfig.selector);
        h.accountHealth(_col(P), p, m);
    }

    function test_more_than_64_positions_is_invalid_config() public {
        RiskPosition[] memory p = new RiskPosition[](65);
        for (uint256 i = 0; i < 65; ++i) p[i] = _pos(i, 1, P, 100 * P, 0, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, 100 * P);
        vm.expectRevert(Errors.InvalidConfig.selector);
        h.accountHealth(_col(P), p, m);
    }

    function test_no_positions_margin_ratio_is_max() public view {
        AccountHealth memory hh =
            h.accountHealth(_col(5 * P), new RiskPosition[](0), new RiskMarket[](0));
        assertEq(hh.marginRatio, type(int128).max);
        assertFalse(hh.liquidatable);
        assertEq(hh.equity, 5 * P);
    }

    // funding
    function _cfg() internal pure returns (FundingConfig memory) {
        return FundingConfig({premiumCoeff: P, maxRatePerHour: P / 1000});
    }

    function _zero() internal pure returns (FundingState memory s) {}

    function test_premium_above_index_makes_longs_pay() public pure {
        int256 premium = FundingLib.premiumFromMark(101 * P, 100 * P);
        assertGt(premium, 0);
        FundingState memory n = FundingLib.updateFromPremium(_cfg(), _zero(), premium, 3600);
        assertGt(n.ratePerHour, 0);
        assertGt(n.longIndex, 0);
        assertLt(n.shortIndex, 0);
    }

    function test_premium_below_index_flips_the_sign() public pure {
        int256 premium = FundingLib.premiumFromMark(99 * P, 100 * P);
        FundingState memory n = FundingLib.updateFromPremium(_cfg(), _zero(), premium, 3600);
        assertLt(n.longIndex, 0);
        assertGt(n.shortIndex, 0);
    }

    function test_rate_is_clamped_to_the_configured_maximum() public pure {
        int256 premium = FundingLib.premiumFromMark(150 * P, 100 * P);
        FundingState memory n = FundingLib.updateFromPremium(_cfg(), _zero(), premium, 3600);
        assertEq(n.ratePerHour, _cfg().maxRatePerHour);
    }

    function test_a_single_update_never_charges_more_than_the_elapsed_cap() public pure {
        int256 premium = FundingLib.premiumFromMark(101 * P, 100 * P);
        FundingState memory hour = FundingLib.updateFromPremium(_cfg(), _zero(), premium, 3600);
        FundingState memory day = FundingLib.updateFromPremium(_cfg(), _zero(), premium, 86_400);
        assertEq(day.longIndex, hour.longIndex);
        assertEq(day.lastUpdate, 86_400);
    }

    function test_zero_premium_accrues_nothing() public pure {
        FundingState memory n = FundingLib.updateFromPremium(_cfg(), _zero(), 0, 3600);
        assertEq(n.ratePerHour, 0);
        assertEq(n.longIndex, 0);
    }

    function test_premium_rejects_a_non_positive_index() public {
        vm.expectRevert(Errors.InvalidPrice.selector);
        h.premiumFromMark(P, 0);
    }

    /// Arc: timestamps are non-decreasing. dt == 0 must be a no-op, not a revert.
    function test_equal_timestamps_leave_state_unchanged() public pure {
        FundingState memory s = FundingState({longIndex: 5, shortIndex: -5, ratePerHour: 7, lastUpdate: 100});
        FundingState memory n = FundingLib.updateFromPremium(_cfg(), s, 1e16, 100);
        assertEq(n.longIndex, 5);
        assertEq(n.ratePerHour, 7);
        assertEq(n.lastUpdate, 100);
    }

    // liquidation
    function test_partial_liquidation_does_not_over_liquidate() public view {
        int256 mark = 937 * P / 10;
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = _pos(42, 1, 100 * P, 100 * P, 0, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, mark);
        AccountHealth memory hh = h.accountHealth(_col(1000 * P), p, m);
        assertTrue(hh.liquidatable);
        int256 shortfall = hh.maintenanceMarginRequired - hh.equity;
        assertGt(shortfall, 0);

        LiquidationPlan memory pl = h.plan(_col(1000 * P), p, m, 42, 5000);
        assertEq(uint8(pl.mode), uint8(LiquidationMode.Partial));
        assertLt(pl.closeSize, 50 * P);
        int256 freed = M.mulDiv(100 * mark, 450, 10_000);
        assertEq(pl.closeSize, M.mulDiv(100 * P, shortfall, freed) + 1);

        // Closing exactly the plan restores maintenance, net of the penalty.
        int256 mmAfter = hh.maintenanceMarginRequired
            - M.applyBps(M.mulPrecision(pl.closeSize, mark), 500);
        assertGe(hh.equity - pl.penalty, mmAfter - 1);
    }

    function test_a_deep_breach_is_a_full_close() public view {
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = _pos(7, 1, 10 * P, 100 * P, 0, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, 94 * P);
        LiquidationPlan memory pl = h.plan(_col(10 * P), p, m, 7, 5000);
        assertEq(uint8(pl.mode), uint8(LiquidationMode.Full));
        assertEq(pl.closeSize, 10 * P);
    }

    function test_plan_rejects_healthy_account_and_bad_bps() public {
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = _pos(1, 1, P, 100 * P, 0, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, 100 * P);
        vm.expectRevert(Errors.NotLiquidatable.selector);
        h.plan(_col(1000 * P), p, m, 1, 5000);

        m[0] = _market(1, 10 * P);
        vm.expectRevert(Errors.InvalidConfig.selector);
        h.plan(_col(P), p, m, 1, 0);
        vm.expectRevert(Errors.InvalidConfig.selector);
        h.plan(_col(P), p, m, 99, 5000);
    }

    function test_deep_underwater_is_full_close() public view {
        RiskPosition[] memory p = new RiskPosition[](1);
        p[0] = _pos(1, 1, 10 * P, 100 * P, 0, false);
        RiskMarket[] memory m = new RiskMarket[](1);
        m[0] = _market(1, 10 * P);
        LiquidationPlan memory pl = h.plan(_col(10 * P), p, m, 1, 5000);
        assertEq(uint8(pl.mode), uint8(LiquidationMode.Full));
        assertEq(pl.closeSize, 10 * P);
        assertEq(pl.penalty, M.applyBps(100 * P, 50));
    }
}
