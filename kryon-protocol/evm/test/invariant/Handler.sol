// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {Vm} from "forge-std/Vm.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {Deployment} from "../../script/lib/KryonDeploy.sol";
import {Engine} from "../../src/Engine.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Insurance} from "../../src/Insurance.sol";
import {Liquidation} from "../../src/Liquidation.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {OrderGateway} from "../../src/OrderGateway.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {Vault} from "../../src/Vault.sol";
import {FundingLib} from "../../src/libraries/FundingLib.sol";
import {KryonMath as M} from "../../src/libraries/KryonMath.sol";
import {Fill, Order} from "../../src/libraries/OrderLib.sol";
import {AccountHealth, FundingConfig, FundingState, Position} from "../../src/libraries/Types.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Drives the deployed system with random deposits, withdrawals,
///         matched trades, price moves, funding, liquidations, ADL, claims
///         and insurance flows. Records ghost violations for the invariants
///         that are about *how* an action was allowed, not the end state.
contract Handler is CommonBase, StdCheats, StdUtils {
    int256 constant P = 1e18;
    uint256 constant ACTORS = 6;

    Vault public vault;
    Engine public engine;
    OrderGateway public gateway;
    OracleAdapter public oracle;
    Liquidation public liquidation;
    Insurance public insurance;
    RiskParams public risk;
    FeeRouter public feeRouter;
    MockUSDC public usdc;

    address public operator;
    address public publisher;
    address public keeper;

    uint32[] public markets;
    bytes32[] public oracleIds;
    mapping(uint32 => int256) public index;

    address[] public actors;
    mapping(address => uint256) public keys;
    mapping(address => uint256) public nonces;

    uint64 public lastPush;
    uint256 public fillSeq;

    // ghost state
    uint256 public withdrawalsBelowInitialMargin; // invariant 1
    uint256 public liquidationsOfHealthyAccounts; // invariant 2
    uint256 public fundingNotFromPremium; // invariant 3
    uint256 public feedsStuckAfterOutage; // oracle re-anchor (review fix 2)
    uint256 public outages;
    uint256 public calls;
    uint256 public trades;
    uint256 public liquidations;
    uint256 public adls;

    constructor(
        Deployment memory d,
        MockUSDC usdc_,
        address operator_,
        address publisher_,
        address keeper_,
        uint32[] memory markets_,
        bytes32[] memory oracleIds_
    ) {
        vault = d.vault;
        engine = d.engine;
        gateway = d.gateway;
        oracle = d.oracle;
        liquidation = d.liquidation;
        insurance = d.insurance;
        risk = d.risk;
        feeRouter = d.feeRouter;
        usdc = usdc_;
        operator = operator_;
        publisher = publisher_;
        keeper = keeper_;
        markets = markets_;
        oracleIds = oracleIds_;
        for (uint256 i = 0; i < markets_.length; ++i) {
            index[markets_[i]] = oracle.latest(oracleIds_[i]).price;
        }
        lastPush = uint64(vm.getBlockTimestamp());
        for (uint256 i = 0; i < ACTORS; ++i) {
            (address a, uint256 k) = makeAddrAndKey(string.concat("actor", vm.toString(i)));
            actors.push(a);
            keys[a] = k;
            _fund(a, 10_000e6);
        }
    }

    function _fund(address a, uint256 amount) internal {
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _tick(uint256 secs) internal {
        vm.warp(_now() + secs);
        _republish();
    }

    function _republish() internal {
        if (lastPush >= _now()) vm.warp(lastPush + 1);
        bytes32[] memory ids = new bytes32[](markets.length);
        int256[] memory prices = new int256[](markets.length);
        int256[] memory confs = new int256[](markets.length);
        for (uint256 i = 0; i < markets.length; ++i) {
            ids[i] = oracleIds[i];
            prices[i] = index[markets[i]];
            confs[i] = prices[i] / 10_000;
        }
        vm.prank(publisher);
        oracle.pushPrices(ids, prices, confs, uint64(_now()));
        lastPush = uint64(_now());
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint256 actorSeed, uint256 amount) external {
        ++calls;
        address a = _actor(actorSeed);
        _fund(a, bound(amount, 1, 50_000e6));
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        ++calls;
        address a = _actor(actorSeed);
        uint256 max = vault.withdrawableBalance(a);
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(a);
        try vault.withdraw(amount) {
            AccountHealth memory h = engine.accountHealth(a);
            if (h.equity < h.initialMarginRequired) ++withdrawalsBelowInitialMargin;
        } catch {}
    }

    function trade(
        uint256 makerSeed,
        uint256 takerSeed,
        uint256 marketSeed,
        uint256 sizeSeed,
        int256 offsetBps,
        bool takerLong
    ) external {
        ++calls;
        address maker = _actor(makerSeed);
        address taker = _actor(takerSeed);
        if (maker == taker) taker = _actor(takerSeed + 1);
        uint32 m = markets[marketSeed % markets.length];
        int256 idx = index[m];
        offsetBps = bound(offsetBps, -90, 90);
        int256 price = idx + idx * offsetBps / 10_000;
        // Size against the thinner account so trades land at 0.1x-6x leverage
        // and price moves can push accounts into liquidation.
        int256 equity = M.min(vault.balanceOf(maker), vault.balanceOf(taker));
        if (equity <= 1e18) return;
        int256 notional_ = equity * int256(bound(sizeSeed, 10, 600)) / 100;
        int256 size = notional_ * P / price;
        if (size <= 0) return;

        Order memory mo = _order(maker, m, !takerLong, size, price);
        Order memory to = _order(taker, m, takerLong, size, price);
        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({
            fillId: bytes32(++fillSeq),
            maker: mo,
            makerSignature: _sign(mo),
            taker: to,
            takerSignature: _sign(to),
            size: uint256(size),
            price: uint256(price)
        });
        vm.recordLogs();
        vm.prank(operator);
        uint256 ok = gateway.settleFillsSigned(fills);
        trades += ok;
        if (ok == 0) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i = 0; i < logs.length; ++i) {
                if (logs[i].topics[0] == keccak256("FillRejected(bytes32,bytes)")) {
                    bytes memory reason = abi.decode(logs[i].data, (bytes));
                    ++rejectCount[bytes4(reason)];
                    if (!seenReason[bytes4(reason)]) {
                        seenReason[bytes4(reason)] = true;
                        rejectReasons.push(bytes4(reason));
                    }
                }
            }
        }
    }

    mapping(bytes4 => uint256) public rejectCount;
    mapping(bytes4 => bool) internal seenReason;
    bytes4[] public rejectReasons;

    function rejectReasonCount() external view returns (uint256) {
        return rejectReasons.length;
    }

    function movePrice(uint256 marketSeed, int256 moveBps, uint256 secs) external {
        ++calls;
        uint32 m = markets[marketSeed % markets.length];
        moveBps = bound(moveBps, -1500, 1500);
        int256 next = index[m] + index[m] * moveBps / 10_000;
        if (next < 1e15) next = 1e15;
        index[m] = next;
        _tick(bound(secs, 1, 30));
    }

    /// @notice Oracle outage longer than maxAge, then a move beyond the jump
    ///         guard. The feed must re-anchor on the first push after it.
    function oracleOutage(uint256 marketSeed, int256 moveBps, uint256 gap) external {
        ++calls;
        uint256 k = marketSeed % markets.length;
        uint32 m = markets[k];
        moveBps = bound(moveBps, -5000, 5000);
        int256 next = index[m] + index[m] * moveBps / 10_000;
        if (next < 1e15) next = 1e15;
        index[m] = next;
        vm.warp(_now() + bound(gap, uint256(oracle.feed(oracleIds[k]).maxAge) + 1, 1 hours));
        _republish();
        ++outages;
        for (uint256 i = 0; i < markets.length; ++i) {
            if (oracle.latest(oracleIds[i]).price != index[markets[i]]) ++feedsStuckAfterOutage;
        }
    }

    function updateFunding(uint256 marketSeed, uint256 secs) external {
        ++calls;
        uint32 m = markets[marketSeed % markets.length];
        _tick(bound(secs, 0, 2 hours));
        FundingState memory before = engine.fundingState(m);
        vm.recordLogs();
        vm.prank(keeper);
        try engine.updateFunding(m) returns (FundingState memory next) {
            _checkFunding(m, before, next);
        } catch {}
    }

    /// @dev Invariant 3: the new rate is exactly the clamped premium of the
    ///      TWAP mark against the oracle index, and longs pay what shorts get.
    function _checkFunding(uint32 m, FundingState memory before, FundingState memory next) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FundingUpdated(uint32,int256,int256,int256,int256,int256,int256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            (,,, int256 premium, int256 mark, int256 idx) =
                abi.decode(logs[i].data, (int256, int256, int256, int256, int256, int256));
            int256 expectedPremium = mark > 0 ? FundingLib.premiumFromMark(mark, idx) : int256(0);
            if (premium != expectedPremium) ++fundingNotFromPremium;
            if (next.lastUpdate > before.lastUpdate) {
                FundingConfig memory cfg = risk.fundingConfig(m);
                int256 rate = M.clamp(
                    M.mulPrecision(premium, cfg.premiumCoeff), -cfg.maxRatePerHour, cfg.maxRatePerHour
                );
                if (next.ratePerHour != rate) ++fundingNotFromPremium;
            }
        }
        if (next.longIndex - before.longIndex != before.shortIndex - next.shortIndex) {
            ++fundingNotFromPremium;
        }
    }

    /// @notice A keeper sweep: try every actor in every market.
    function liquidate(uint256 maxSize) external {
        ++calls;
        maxSize = bound(maxSize, 1, type(uint256).max);
        for (uint256 i = 0; i < actors.length; ++i) {
            for (uint256 j = 0; j < markets.length; ++j) {
                address a = actors[i];
                bool wasLiquidatable = engine.accountHealth(a).liquidatable;
                vm.prank(address(0xBEEF));
                try liquidation.liquidate(a, markets[j], maxSize) {
                    ++liquidations;
                    if (!wasLiquidatable) ++liquidationsOfHealthyAccounts;
                } catch {}
            }
        }
    }

    function adl() external {
        ++calls;
        for (uint256 i = 0; i < actors.length; ++i) {
            for (uint256 j = 0; j < markets.length; ++j) {
                vm.prank(address(0xADD1));
                try liquidation.adl(actors[i], markets[j], type(uint256).max) {
                    ++adls;
                } catch {}
            }
        }
    }

    function settleAllBadDebt() external {
        ++calls;
        for (uint256 i = 0; i < actors.length; ++i) {
            try insurance.settleBadDebt(actors[i]) {} catch {}
        }
    }

    function settleBadDebt(uint256 actorSeed) external {
        ++calls;
        try insurance.settleBadDebt(_actor(actorSeed)) {} catch {}
    }

    function donate(uint256 amount) external {
        ++calls;
        amount = bound(amount, 1, 20_000e6);
        usdc.mint(address(this), amount);
        usdc.approve(address(insurance), amount);
        insurance.donate(amount);
    }

    function stake(uint256 actorSeed, uint256 amount) external {
        ++calls;
        address a = _actor(actorSeed);
        amount = bound(amount, 1, 10_000e6);
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(insurance), amount);
        insurance.stake(amount);
        vm.stopPrank();
    }

    function unstake(uint256 actorSeed, int256 shares) external {
        ++calls;
        address a = _actor(actorSeed);
        int256 held = insurance.sharesOf(a);
        if (held <= 0) return;
        shares = bound(shares, 1, held);
        vm.prank(a);
        try insurance.requestUnstake(shares) {} catch {}
        vm.warp(_now() + 7 days + 1);
        _republish();
        vm.prank(a);
        try insurance.withdrawUnstaked() {} catch {}
    }

    function claimTreasury() external {
        ++calls;
        feeRouter.claimTreasury();
    }

    // --------------------------------------------------------------- helpers

    function _order(address owner, uint32 m, bool isLong, int256 size, int256 limit)
        internal
        returns (Order memory)
    {
        return Order({
            owner: owner,
            marketId: m,
            isLong: isLong,
            size: uint256(size),
            limitPrice: uint256(limit),
            reduceOnly: false,
            nonce: ++nonces[owner],
            expiry: uint64(_now() + 1 hours),
            referrer: address(0)
        });
    }

    function _sign(Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[o.owner], gateway.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    /// @notice Σ openNotional over every account the handler can create.
    function sumCostBasis() external view returns (int256 sum) {
        for (uint256 i = 0; i < actors.length; ++i) {
            sum += _accountBasis(actors[i]);
        }
        sum += _accountBasis(address(insurance));
    }

    function _accountBasis(address a) internal view returns (int256 sum) {
        (, Position[] memory ps) = engine.positionsOf(a);
        for (uint256 j = 0; j < ps.length; ++j) {
            sum += ps[j].openNotional;
        }
    }

    function sumBalances() external view returns (int256 sum) {
        for (uint256 i = 0; i < actors.length; ++i) {
            sum += vault.balanceOf(actors[i]);
        }
        sum += vault.balanceOf(address(insurance));
        sum += vault.balanceOf(address(feeRouter));
        sum += vault.balanceOf(address(engine));
        sum += vault.balanceOf(address(0xBEEF));
        sum += vault.balanceOf(address(0xADD1));
        sum += vault.balanceOf(address(this));
    }
}
