// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Errors} from "../../src/libraries/Errors.sol";
import {FundingLib} from "../../src/libraries/FundingLib.sol";
import {KryonMath as M} from "../../src/libraries/KryonMath.sol";
import {LiquidationLib} from "../../src/libraries/LiquidationLib.sol";
import {RiskLib} from "../../src/libraries/RiskLib.sol";
import {
    AccountHealth,
    FundingConfig,
    FundingState,
    LiquidationPlan,
    RiskCollateral,
    RiskMarket,
    RiskPosition
} from "../../src/libraries/Types.sol";

/// @dev External entry points so library reverts can be caught.
contract DiffTarget {
    function mulDiv(int256 a, int256 b, int256 c) external pure returns (int256) {
        return M.mulDiv(a, b, c);
    }

    function applyBps(int256 a, uint256 bps) external pure returns (int256) {
        return M.applyBps(a, bps);
    }

    function ceilDiv(int256 a, int256 b) external pure returns (int256) {
        return M.ceilDiv(a, b);
    }

    function premium(int256 mark, int256 index) external pure returns (int256) {
        return FundingLib.premiumFromMark(mark, index);
    }

    function funding(FundingConfig memory c, FundingState memory s, int256 p, uint64 t)
        external
        pure
        returns (FundingState memory)
    {
        return FundingLib.updateFromPremium(c, s, p, t);
    }

    function health(RiskCollateral[] memory c, RiskPosition[] memory p, RiskMarket[] memory m)
        external
        pure
        returns (AccountHealth memory)
    {
        return RiskLib.accountHealth(c, p, m);
    }

    function withdraw(
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

/// @notice G1: the Solidity libraries against the Rust reference model
///         (crates/protocol-core, crates/risk-engine), value for value and
///         error for error. Run with `FOUNDRY_PROFILE=differential`.
contract DifferentialTest is Test {
    DiffTarget internal t;
    string internal bin;
    bytes4[32] internal coreErrors;

    struct RiskAccount {
        RiskCollateral[] c;
        RiskPosition[] p;
        RiskMarket[] m;
    }

    function setUp() public {
        t = new DiffTarget();
        bin = vm.envOr("KRYON_REF_BIN", string("../target/release/kryon-ref"));
        coreErrors = [
            Errors.MathOverflow.selector,
            Errors.DivisionByZero.selector,
            Errors.InvalidAmount.selector,
            Errors.InvalidPrice.selector,
            Errors.InvalidConfig.selector,
            Errors.StaleOracle.selector,
            Errors.OracleConfidenceTooWide.selector,
            Errors.AccountInsolvent.selector,
            Errors.InsufficientCollateral.selector,
            Errors.NotLiquidatable.selector,
            Errors.Unauthorized.selector,
            Errors.AlreadyInitialized.selector,
            Errors.AssetDisabled.selector,
            Errors.PositionNotFound.selector,
            Errors.DirectionMismatch.selector,
            Errors.PriceOutsideBand.selector,
            Errors.OpenInterestExceeded.selector,
            Errors.LiquidationWouldNotImproveHealth.selector,
            Errors.InsuranceFundInsufficient.selector,
            Errors.OrderExpired.selector,
            Errors.OrderCancelled.selector,
            Errors.OrderOverfilled.selector,
            Errors.SelfTrade.selector,
            Errors.OracleQuorumNotMet.selector,
            Errors.OracleDeviationTooWide.selector,
            Errors.DuplicateOracleSource.selector,
            Errors.TooManyPositions.selector,
            Errors.DepositCapExceeded.selector,
            Errors.IsolatedMarginDisabled.selector,
            Errors.AggregateOiPolicyExceeded.selector,
            Errors.NoBadDebtToOffset.selector,
            Errors.PositionNotInProfit.selector
        ];
    }

    // ------------------------------------------------------------ plumbing

    function _ref(string[] memory args) internal returns (uint256 err, int256[] memory values) {
        string[] memory cmd = new string[](args.length + 1);
        cmd[0] = bin;
        for (uint256 i = 0; i < args.length; ++i) cmd[i + 1] = args[i];
        return abi.decode(vm.ffi(cmd), (uint256, int256[]));
    }

    function _code(bytes memory reason) internal view returns (uint256) {
        bytes4 sel = bytes4(reason);
        for (uint256 i = 0; i < coreErrors.length; ++i) {
            if (coreErrors[i] == sel) return i + 1;
        }
        return type(uint256).max; // a panic or foreign error: always a mismatch
    }

    function _s(int256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function _u(uint256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function _cat(string[] memory a, string[] memory b) internal pure returns (string[] memory out) {
        out = new string[](a.length + b.length);
        for (uint256 i = 0; i < a.length; ++i) out[i] = a[i];
        for (uint256 i = 0; i < b.length; ++i) out[a.length + i] = b[i];
    }

    function _one(string memory a) internal pure returns (string[] memory out) {
        out = new string[](1);
        out[0] = a;
    }

    function _healthValues(AccountHealth memory h) internal pure returns (int256[] memory v) {
        v = new int256[](8);
        v[0] = h.collateralValue;
        v[1] = h.unrealizedPnl;
        v[2] = h.equity;
        v[3] = h.initialMarginRequired;
        v[4] = h.maintenanceMarginRequired;
        v[5] = h.freeCollateral;
        v[6] = h.marginRatio;
        v[7] = h.liquidatable ? int256(1) : int256(0);
    }

    function _assertSame(uint256 refErr, int256[] memory refValues, uint256 solErr, int256[] memory solValues)
        internal
        pure
    {
        assertEq(solErr, refErr, "error code differs from the Rust reference");
        if (refErr != 0) return;
        assertEq(solValues.length, refValues.length, "value count");
        for (uint256 i = 0; i < refValues.length; ++i) {
            assertEq(solValues[i], refValues[i], "value differs from the Rust reference");
        }
    }

    // ----------------------------------------------------------- fixed point

    function testFuzz_mulDiv(int128 a, int128 b, int128 c) public {
        string[] memory args = new string[](4);
        (args[0], args[1], args[2], args[3]) = ("muldiv", _s(a), _s(b), _s(c));
        (uint256 re, int256[] memory rv) = _ref(args);
        int256[] memory sv = new int256[](1);
        uint256 se;
        try t.mulDiv(a, b, c) returns (int256 r) {
            sv[0] = r;
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    function testFuzz_applyBps(int128 amount, uint32 bps) public {
        if (bps > 20_000) bps = bps % 20_000;
        string[] memory args = new string[](3);
        (args[0], args[1], args[2]) = ("applybps", _s(amount), _u(bps));
        (uint256 re, int256[] memory rv) = _ref(args);
        int256[] memory sv = new int256[](1);
        uint256 se;
        try t.applyBps(amount, bps) returns (int256 r) {
            sv[0] = r;
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    function testFuzz_ceilDiv(int128 a, int128 b) public {
        string[] memory args = new string[](3);
        (args[0], args[1], args[2]) = ("ceildiv", _s(a), _s(b));
        (uint256 re, int256[] memory rv) = _ref(args);
        int256[] memory sv = new int256[](1);
        uint256 se;
        try t.ceilDiv(a, b) returns (int256 r) {
            sv[0] = r;
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    // --------------------------------------------------------------- funding

    function testFuzz_premium(int128 mark, int128 index) public {
        string[] memory args = new string[](3);
        (args[0], args[1], args[2]) = ("premium", _s(mark), _s(index));
        (uint256 re, int256[] memory rv) = _ref(args);
        int256[] memory sv = new int256[](1);
        uint256 se;
        try t.premium(mark, index) returns (int256 r) {
            sv[0] = r;
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    function testFuzz_funding(
        int128 coeff,
        int128 maxRate,
        int128 longIdx,
        int128 shortIdx,
        int128 rate,
        uint32 last,
        int128 premium,
        uint32 dt
    ) public {
        uint64 now_ = uint64(last) + uint64(dt % 20_000) - (dt % 3 == 0 ? uint64(last % 50) : 0);
        FundingConfig memory c = FundingConfig(coeff, maxRate);
        FundingState memory s = FundingState(longIdx, shortIdx, rate, last);
        string[] memory args = new string[](9);
        args[0] = "funding";
        args[1] = _s(coeff);
        args[2] = _s(maxRate);
        args[3] = _s(longIdx);
        args[4] = _s(shortIdx);
        args[5] = _s(rate);
        args[6] = _u(last);
        args[7] = _s(premium);
        args[8] = _u(now_);
        (uint256 re, int256[] memory rv) = _ref(args);
        int256[] memory sv = new int256[](4);
        uint256 se;
        try t.funding(c, s, premium, now_) returns (FundingState memory n) {
            (sv[0], sv[1], sv[2], sv[3]) = (n.longIndex, n.shortIndex, n.ratePerHour, int256(uint256(n.lastUpdate)));
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    // ------------------------------------------------------------ accounts

    /// @dev Mostly realistic accounts, with seeds that also reach the edges:
    ///      negative collateral, zero/negative sizes and prices, inactive or
    ///      missing markets, isolated positions, and bps above 100%.
    function _account(uint256 seed) internal pure returns (RiskAccount memory a, string[] memory args) {
        uint256 r = uint256(keccak256(abi.encode(seed)));
        uint256 nm = 1 + (r % 3);
        uint256 np = (r >> 8) % 5;
        a.c = new RiskCollateral[](1);
        int256 colValue = int256(uint256(uint128(r >> 16)) % 1e24) - (r % 7 == 0 ? int256(3e23) : int256(0));
        a.c[0] = RiskCollateral({value: colValue, haircutBps: (r >> 128) % 10_050});
        args = new string[](3);
        args[0] = _s(colValue);
        args[1] = _u(a.c[0].haircutBps);
        args[2] = _u(np);

        a.p = new RiskPosition[](np);
        for (uint256 i = 0; i < np; ++i) {
            uint256 q = uint256(keccak256(abi.encode(seed, "p", i)));
            RiskPosition memory p = RiskPosition({
                positionId: i + 1,
                marketId: uint32(1 + (q % (nm + 1))), // sometimes a missing market
                size: q % 11 == 0 ? int256(0) : int256(1 + (q >> 8) % 1e24),
                entryPrice: q % 13 == 0 ? -int256(1) : int256(1 + (q >> 96) % 1e23),
                margin: int256((q >> 32) % 1e22),
                isLong: q % 2 == 0,
                lastFundingIndex: int256((q >> 64) % 1e18) - 5e17,
                isolated: q % 5 == 0
            });
            a.p[i] = p;
            string[] memory pa = new string[](8);
            pa[0] = _u(p.positionId);
            pa[1] = _u(p.marketId);
            pa[2] = _s(p.size);
            pa[3] = _s(p.entryPrice);
            pa[4] = p.isLong ? "1" : "0";
            pa[5] = _s(p.lastFundingIndex);
            pa[6] = p.isolated ? "1" : "0";
            pa[7] = _s(p.margin);
            args = _cat(args, pa);
        }

        args = _cat(args, _one(_u(nm)));
        a.m = new RiskMarket[](nm);
        for (uint256 i = 0; i < nm; ++i) {
            uint256 q = uint256(keccak256(abi.encode(seed, "m", i)));
            uint256 im = q % 17 == 0 ? 10_001 + q % 100 : 100 + (q >> 8) % 5000;
            RiskMarket memory m = RiskMarket({
                marketId: uint32(i + 1),
                initialMarginBps: im,
                maintenanceMarginBps: 25 + (q >> 24) % im,
                liquidationFeeBps: (q >> 40) % 600,
                active: q % 19 != 0,
                oraclePrice: q % 23 == 0 ? int256(0) : int256(1 + (q >> 56) % 1e23),
                fundingIndexLong: int256((q >> 120) % 1e18) - 5e17,
                fundingIndexShort: int256((q >> 184) % 1e18) - 5e17
            });
            a.m[i] = m;
            string[] memory ma = new string[](8);
            ma[0] = _u(m.marketId);
            ma[1] = _u(m.initialMarginBps);
            ma[2] = _u(m.maintenanceMarginBps);
            ma[3] = _u(m.liquidationFeeBps);
            ma[4] = m.active ? "1" : "0";
            ma[5] = _s(m.oraclePrice);
            ma[6] = _s(m.fundingIndexLong);
            ma[7] = _s(m.fundingIndexShort);
            args = _cat(args, ma);
        }
    }

    function testFuzz_accountHealth(uint256 seed) public {
        (RiskAccount memory a, string[] memory args) = _account(seed);
        (uint256 re, int256[] memory rv) = _ref(_cat(_one("health"), args));
        int256[] memory sv;
        uint256 se;
        try t.health(a.c, a.p, a.m) returns (AccountHealth memory h) {
            sv = _healthValues(h);
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    function testFuzz_validateWithdrawal(uint256 seed, int128 w) public {
        (RiskAccount memory a, string[] memory args) = _account(seed);
        int256 amount = seed % 3 == 0 ? int256(w) : int256(uint256(uint128(w)) % 1e24);
        (uint256 re, int256[] memory rv) =
            _ref(_cat(_cat(_one("withdraw"), args), _one(_s(amount))));
        int256[] memory sv;
        uint256 se;
        try t.withdraw(a.c, a.p, a.m, amount) returns (AccountHealth memory h) {
            sv = _healthValues(h);
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    function testFuzz_planLiquidation(uint256 seed, uint8 target, uint16 bps) public {
        (RiskAccount memory a, string[] memory args) = _account(seed);
        uint256 id = uint256(target) % (a.p.length + 2);
        uint256 b = uint256(bps) % 10_500;
        string[] memory tail = new string[](2);
        (tail[0], tail[1]) = (_u(id), _u(b));
        (uint256 re, int256[] memory rv) = _ref(_cat(_cat(_one("plan"), args), tail));
        int256[] memory sv;
        uint256 se;
        try t.plan(a.c, a.p, a.m, id, b) returns (LiquidationPlan memory pl) {
            int256[] memory hv = _healthValues(pl.expectedHealth);
            sv = new int256[](12);
            sv[0] = int256(uint256(pl.mode));
            sv[1] = int256(pl.positionId);
            sv[2] = pl.closeSize;
            sv[3] = pl.penalty;
            for (uint256 i = 0; i < 8; ++i) sv[4 + i] = hv[i];
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }

    /// A liquidatable-by-construction account, so the plan path is exercised
    /// far more often than random accounts reach it.
    function testFuzz_planLiquidation_underwater(uint64 colSeed, uint64 sizeSeed, uint32 dropBps, uint16 bps)
        public
    {
        int256 entry = 100e18;
        int256 size = int256(uint256(sizeSeed % 1000) + 1) * 1e18;
        int256 price = entry - entry * int256(uint256(dropBps % 9000) + 1) / 10_000;
        int256 col = int256(uint256(colSeed) % 1e22);
        RiskAccount memory a;
        a.c = new RiskCollateral[](1);
        a.c[0] = RiskCollateral(col, 0);
        a.p = new RiskPosition[](1);
        a.p[0] = RiskPosition(1, 1, size, entry, 0, true, 0, false);
        a.m = new RiskMarket[](1);
        a.m[0] = RiskMarket(1, 1000, 500, 50, true, price, 0, 0);
        uint256 b = 1 + uint256(bps) % 10_000;

        string[] memory args = new string[](22);
        args[0] = "plan";
        args[1] = _s(col);
        args[2] = "0";
        args[3] = "1";
        (args[4], args[5], args[6], args[7]) = ("1", "1", _s(size), _s(entry));
        (args[8], args[9], args[10], args[11]) = ("1", "0", "0", "0");
        args[12] = "1";
        (args[13], args[14], args[15], args[16]) = ("1", "1000", "500", "50");
        (args[17], args[18], args[19], args[20]) = ("1", _s(price), "0", "0");
        args[21] = "1";
        string[] memory full = _cat(args, _one(_u(b)));
        (uint256 re, int256[] memory rv) = _ref(full);
        int256[] memory sv;
        uint256 se;
        try t.plan(a.c, a.p, a.m, 1, b) returns (LiquidationPlan memory pl) {
            int256[] memory hv = _healthValues(pl.expectedHealth);
            sv = new int256[](12);
            sv[0] = int256(uint256(pl.mode));
            sv[1] = int256(pl.positionId);
            sv[2] = pl.closeSize;
            sv[3] = pl.penalty;
            for (uint256 i = 0; i < 8; ++i) sv[4 + i] = hv[i];
        } catch (bytes memory reason) {
            se = _code(reason);
        }
        _assertSame(re, rv, se, sv);
    }
}
