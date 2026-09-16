// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonErrors as Errors} from "../../src/libraries/Errors.sol";
import {FundingConfig, MarketParams} from "../../src/libraries/Types.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract RiskParamsTest is KryonTest {
    function _params() internal view returns (MarketParams memory) {
        return risk.market(BTC);
    }

    function _expectBounds(MarketParams memory m) internal {
        asGov();
        vm.expectPartialRevert(Errors.ParameterOutOfBounds.selector);
        risk.setMarket(BTC, m);
    }

    function test_market_bounds() public {
        MarketParams memory m = _params();
        m.initialMarginBps = 99;
        _expectBounds(m);
        m = _params();
        m.initialMarginBps = 5001;
        _expectBounds(m);
        m = _params();
        m.maintenanceMarginBps = 24;
        _expectBounds(m);
        m = _params();
        m.maintenanceMarginBps = m.initialMarginBps + 1;
        _expectBounds(m);
        m = _params();
        m.liquidationFeeBps = m.maintenanceMarginBps + 1;
        _expectBounds(m);
        m = _params();
        m.maxExecutionDeviationBps = 0;
        _expectBounds(m);
        m = _params();
        m.maxExecutionDeviationBps = 1001;
        _expectBounds(m);
        m = _params();
        m.maxOracleAge = 0;
        _expectBounds(m);
        m = _params();
        m.maxOracleAge = 301;
        _expectBounds(m);
        m = _params();
        m.maxOracleConfidenceBps = 501;
        _expectBounds(m);
        m = _params();
        m.maxOpenInterest = 0;
        _expectBounds(m);
        m = _params();
        m.minFillNotional = -1;
        _expectBounds(m);
        m = _params();
        m.minFillNotional = 100_001 * P;
        _expectBounds(m);
    }

    /// KRY-Q8: the published leverage cap may be tighter, never looser.
    function test_leverage_cap_must_agree_with_initial_margin() public {
        MarketParams memory m = _params();
        m.maxLeverageBps = 100_001; // IM 10% implies 10x
        _expectBounds(m);
        m.maxLeverageBps = 50_000;
        asGov();
        risk.setMarket(BTC, m);
        assertEq(risk.market(BTC).maxLeverageBps, 50_000);
    }

    function test_oracle_id_is_immutable_for_a_listed_market() public {
        MarketParams memory m = _params();
        m.oracleId = ETH_ID;
        asGov();
        vm.expectRevert(Errors.InvalidConfig.selector);
        risk.setMarket(BTC, m);
        m.oracleId = bytes32(0);
        asGov();
        vm.expectRevert(Errors.InvalidConfig.selector);
        risk.setMarket(3, m);
        MarketParams memory valid = _params();
        asGov();
        vm.expectRevert(Errors.InvalidConfig.selector);
        risk.setMarket(0, valid);
    }

    function test_unknown_market_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownMarket.selector, uint32(9)));
        risk.market(9);
        asGov();
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownMarket.selector, uint32(9)));
        risk.setMarketActive(9, true);
        assertFalse(risk.isListed(9));
        assertEq(risk.marketIds().length, 2);
    }

    function test_funding_config_bounds() public {
        vm.startPrank(address(timelock));
        vm.expectPartialRevert(Errors.ParameterOutOfBounds.selector);
        risk.setFundingConfig(BTC, FundingConfig({premiumCoeff: -1, maxRatePerHour: 1}));
        vm.expectPartialRevert(Errors.ParameterOutOfBounds.selector);
        risk.setFundingConfig(BTC, FundingConfig({premiumCoeff: 11 * P, maxRatePerHour: 1}));
        vm.expectPartialRevert(Errors.ParameterOutOfBounds.selector);
        risk.setFundingConfig(BTC, FundingConfig({premiumCoeff: P, maxRatePerHour: 0}));
        vm.expectPartialRevert(Errors.ParameterOutOfBounds.selector);
        risk.setFundingConfig(BTC, FundingConfig({premiumCoeff: P, maxRatePerHour: 1e16 + 1}));
        vm.stopPrank();
    }

    /// KRY-Q11 port: the aggregate across markets is tracked...
    function test_oi_policy_tracks_the_aggregate_across_markets() public {
        vm.startPrank(address(timelock));
        assertEq(risk.totalOiPolicyBps(), 0);
        risk.setOiPolicy(BTC, 20_000);
        assertEq(risk.totalOiPolicyBps(), 20_000);
        risk.setOiPolicy(ETH, 50_000);
        assertEq(risk.totalOiPolicyBps(), 70_000);
        risk.setOiPolicy(BTC, 10_000);
        assertEq(risk.totalOiPolicyBps(), 60_000);
        risk.setOiPolicy(ETH, 0);
        assertEq(risk.totalOiPolicyBps(), 10_000);
        assertEq(risk.oiPolicyBps(ETH), 0);
        vm.stopPrank();
    }

    /// ...and a ceiling rejects over-commitment without mutating state.
    function test_aggregate_oi_policy_ceiling_rejects_overcommitment() public {
        vm.startPrank(address(timelock));
        risk.setMaxTotalOiPolicyBps(30_000);
        risk.setOiPolicy(BTC, 20_000);
        vm.expectRevert(Errors.AggregateOiPolicyExceeded.selector);
        risk.setOiPolicy(ETH, 20_000);
        assertEq(risk.totalOiPolicyBps(), 20_000);
        assertEq(risk.oiPolicyBps(ETH), 0);
        risk.setOiPolicy(ETH, 10_000);
        assertEq(risk.totalOiPolicyBps(), 30_000);
        assertEq(risk.maxTotalOiPolicyBps(), 30_000);

        vm.expectPartialRevert(Errors.ParameterOutOfBounds.selector);
        risk.setOiPolicy(BTC, 1_000_001);
        vm.expectPartialRevert(Errors.ParameterOutOfBounds.selector);
        risk.setMaxTotalOiPolicyBps(32_000_001);
        vm.stopPrank();
    }

    function test_market_count_is_bounded() public {
        uint256 room = risk.MAX_MARKETS() - risk.marketIds().length;
        MarketParams memory m = _params();
        vm.startPrank(address(timelock));
        for (uint32 i = 0; i < room; ++i) {
            m.oracleId = bytes32(uint256(1000 + i));
            risk.setMarket(1000 + i, m);
        }
        m.oracleId = "LAST";
        vm.expectRevert(Errors.InvalidConfig.selector);
        risk.setMarket(5000, m);
        vm.stopPrank();
    }

    function testFuzz_valid_params_round_trip(uint16 im, uint16 mm, uint16 fee) public {
        im = uint16(bound(im, 100, 5000));
        mm = uint16(bound(mm, 25, im));
        fee = uint16(bound(fee, 0, mm < 500 ? mm : 500));
        MarketParams memory m = _params();
        m.initialMarginBps = im;
        m.maintenanceMarginBps = mm;
        m.liquidationFeeBps = fee;
        m.maxLeverageBps = uint32(100_000_000 / uint256(im));
        asGov();
        risk.setMarket(BTC, m);
        MarketParams memory got = risk.market(BTC);
        assertEq(got.initialMarginBps, im);
        assertEq(got.maintenanceMarginBps, mm);
        assertEq(got.liquidationFeeBps, fee);
        assertTrue(got.listed);
    }
}
