// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";

import {
    DeployConfig,
    Deployment,
    Implementations,
    KryonDeploy,
    MarketConfig
} from "../../script/lib/KryonDeploy.sol";
import {Engine} from "../../src/Engine.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Insurance} from "../../src/Insurance.sol";
import {Liquidation} from "../../src/Liquidation.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {OrderGateway} from "../../src/OrderGateway.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {Vault} from "../../src/Vault.sol";
import {KryonTimelock} from "../../src/governance/KryonTimelock.sol";
import {Fill, Order} from "../../src/libraries/OrderLib.sol";
import {FundingConfig, MarketParams, Position} from "../../src/libraries/Types.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Full-system fixture, deployed through KryonDeploy exactly as the
///         scripts do and handed over to the timelock. Admin actions in tests
///         are made as the timelock (i.e. an executed governance proposal).
abstract contract KryonTest is Test {
    int256 internal constant P = 1e18;
    uint32 internal constant BTC = 1;
    uint32 internal constant ETH = 2;
    bytes32 internal constant BTC_ID = "BTC";
    bytes32 internal constant ETH_ID = "ETH";

    /// Launch schedule in millionths.
    int32 internal constant TAKER_RATE = 350;
    int32 internal constant MAKER_RATE = 50;

    MockUSDC internal usdc;
    MockPermit2 internal permit2;
    Deployment internal d;
    Implementations internal impls;

    Vault internal vault;
    Engine internal engine;
    OrderGateway internal gateway;
    OracleAdapter internal oracle;
    Liquidation internal liquidation;
    Insurance internal insurance;
    RiskParams internal risk;
    FeeRouter internal feeRouter;
    KryonTimelock internal timelock;

    address internal deployer = makeAddr("deployer");
    address internal governance = makeAddr("governanceSafe");
    address internal guardian = makeAddr("guardianSafe");
    address internal treasury = makeAddr("treasurySafe");
    address internal operator = makeAddr("operator");
    address internal publisher = makeAddr("publisher");
    address internal keeper = makeAddr("fundingKeeper");
    address internal tierBot = makeAddr("tierBot");
    address internal liquidator = makeAddr("liquidator");

    address internal alice;
    uint256 internal aliceKey;
    address internal bob;
    uint256 internal bobKey;
    address internal carol;
    uint256 internal carolKey;

    mapping(address => uint256) internal keyOf;
    mapping(address => uint256) internal nextNonce;
    mapping(bytes32 => uint64) internal lastPush;
    uint256 internal fillSeq;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        (carol, carolKey) = makeAddrAndKey("carol");
        keyOf[alice] = aliceKey;
        keyOf[bob] = bobKey;
        keyOf[carol] = carolKey;

        usdc = new MockUSDC();
        permit2 = new MockPermit2();

        vm.startPrank(deployer);
        (d, impls) = KryonDeploy.deployAll(baseConfig(), deployer);
        vm.stopPrank();

        vault = d.vault;
        engine = d.engine;
        gateway = d.gateway;
        oracle = d.oracle;
        liquidation = d.liquidation;
        insurance = d.insurance;
        risk = d.risk;
        feeRouter = d.feeRouter;
        timelock = d.timelock;

        push(BTC_ID, 100 * P);
        push(ETH_ID, 2000 * P);
    }

    // ----------------------------------------------------------------- config

    function baseConfig() internal view virtual returns (DeployConfig memory c) {
        c.chainId = 31_337;
        c.usdc = address(usdc);
        c.permit2 = address(permit2);
        c.timelockDelay = 48 hours;
        c.proposers = _one(governance);
        c.executors = _one(governance);
        c.guardian = guardian;
        c.treasury = treasury;
        c.operators = _one(operator);
        c.publishers = _one(publisher);
        c.fundingKeepers = _one(keeper);
        c.feeTierBots = _one(tierBot);
        c.depositCap = type(uint256).max;
        c.accountDepositCap = type(uint256).max;
        c.openDepositsAtDeploy = true;
        c.maxRewardBps = 50;
        c.partialLiquidationBps = 5000;
        c.takerRate = TAKER_RATE;
        c.makerRate = MAKER_RATE;
        c.minNetRate = 100;
        c.splitTreasuryBps = 7000;
        c.splitInsuranceBps = 2000;
        c.splitReferralBps = 1000;
        c.liquidationInsuranceBps = 5000;
        c.markets = new MarketConfig[](2);
        c.markets[0] = marketConfig(BTC, "BTC-PERP", BTC_ID, 1000, 500, 50, 1000 * P);
        c.markets[1] = marketConfig(ETH, "ETH-PERP", ETH_ID, 500, 250, 35, 10_000 * P);
    }

    function marketConfig(
        uint32 id,
        string memory symbol,
        bytes32 oracleId,
        uint16 im,
        uint16 mm,
        uint16 liqFee,
        int256 maxOi
    ) internal pure returns (MarketConfig memory m) {
        m.id = id;
        m.symbol = symbol;
        m.params = MarketParams({
            oracleId: oracleId,
            initialMarginBps: im,
            maintenanceMarginBps: mm,
            liquidationFeeBps: liqFee,
            maxExecutionDeviationBps: 100,
            maxOracleConfidenceBps: 100,
            maxOracleAge: 60,
            maxLeverageBps: uint32(100_000_000 / uint256(im)),
            active: true,
            listed: true,
            maxOpenInterest: maxOi,
            minFillNotional: 0
        });
        m.funding = FundingConfig({premiumCoeff: P, maxRatePerHour: P / 100});
        m.feed = OracleAdapter.FeedConfig({
            listed: true,
            active: true,
            minPublishers: 1,
            maxSpreadBps: 50,
            maxJumpBps: 0,
            maxConfidenceBps: 100,
            maxAge: 60
        });
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    // ---------------------------------------------------------------- helpers

    /// @notice Publish `price` for `id` now (confidence 1% of 1e18 like the
    ///         Soroban fixtures). Advances time a second if needed so the
    ///         publisher's timestamps stay strictly increasing.
    function push(bytes32 id, int256 price) internal {
        if (lastPush[id] >= _now()) vm.warp(lastPush[id] + 1);
        bytes32[] memory ids = new bytes32[](1);
        int256[] memory prices = new int256[](1);
        int256[] memory confs = new int256[](1);
        ids[0] = id;
        prices[0] = price;
        confs[0] = P / 100;
        vm.prank(publisher);
        oracle.pushPrices(ids, prices, confs, uint64(_now()));
        lastPush[id] = uint64(_now());
    }

    /// @notice Move time forward and republish both indexes so nothing is stale.
    function skipAndRepublish(uint256 secs, int256 btc) internal {
        vm.warp(_now() + secs);
        push(BTC_ID, btc);
        push(ETH_ID, 2000 * P);
    }

    function fund(address user, uint256 amount6) internal {
        usdc.mint(user, amount6);
        vm.startPrank(user);
        usdc.approve(address(vault), amount6);
        vault.deposit(amount6);
        vm.stopPrank();
    }

    /// @dev Test code is compiled with via-IR, which may reuse a TIMESTAMP read
    ///      across a `vm.warp`. Always read the clock through the cheatcode.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function asGov() internal {
        vm.prank(address(timelock));
    }

    function newTrader(string memory name, uint256 amount6) internal returns (address who) {
        uint256 key;
        (who, key) = makeAddrAndKey(name);
        keyOf[who] = key;
        if (amount6 > 0) fund(who, amount6);
    }

    function makeOrder(address owner, uint32 marketId, bool isLong, int256 size, int256 limit)
        internal
        returns (Order memory o)
    {
        o = Order({
            owner: owner,
            marketId: marketId,
            isLong: isLong,
            size: uint256(size),
            limitPrice: uint256(limit),
            reduceOnly: false,
            nonce: ++nextNonce[owner],
            expiry: uint64(_now() + 1 hours),
            referrer: address(0)
        });
    }

    function sign(Order memory o) internal view returns (bytes memory) {
        return signWith(keyOf[o.owner], o);
    }

    function signWith(uint256 key, Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, gateway.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function makeFill(Order memory maker, Order memory taker, int256 size, int256 price)
        internal
        returns (Fill memory f)
    {
        f = Fill({
            fillId: keccak256(abi.encode("fill", ++fillSeq)),
            maker: maker,
            makerSignature: sign(maker),
            taker: taker,
            takerSignature: sign(taker),
            size: uint256(size),
            price: uint256(price)
        });
    }

    function settle(Fill memory f) internal returns (uint256 settled) {
        Fill[] memory fills = new Fill[](1);
        fills[0] = f;
        vm.prank(operator);
        settled = gateway.settleFillsSigned(fills);
    }

    /// @notice Settle one fill and revert the test with the rejection reason if
    ///         it was rejected.
    function settleOk(Fill memory f) internal {
        vm.recordLogs();
        uint256 n = settle(f);
        if (n == 1) return;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("FillRejected(bytes32,bytes)")) {
                bytes memory reason = abi.decode(logs[i].data, (bytes));
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
        revert("fill not settled");
    }

    /// @notice Settle and return the raw rejection reason ("" when settled).
    function settleReason(Fill memory f) internal returns (bytes memory) {
        vm.recordLogs();
        if (settle(f) == 1) return "";
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("FillRejected(bytes32,bytes)")) {
                return abi.decode(logs[i].data, (bytes));
            }
        }
        revert("no rejection event");
    }

    /// @notice Match `taker` (buying if `takerLong`) against `maker` at `price`.
    function trade(address maker, address taker, uint32 marketId, bool takerLong, int256 size, int256 price)
        internal
    {
        Order memory mo = makeOrder(maker, marketId, !takerLong, size, price);
        Order memory to = makeOrder(taker, marketId, takerLong, size, price);
        settleOk(makeFill(mo, to, size, price));
    }

    function pos(address trader, uint32 marketId) internal view returns (Position memory) {
        return engine.getPosition(trader, marketId);
    }

    function bal(address account) internal view returns (int256) {
        return vault.balanceOf(account);
    }

    /// @notice Taker and maker fee on a fill, at the launch schedule.
    function fees(int256 size, int256 price) internal pure returns (int256 makerFee, int256 takerFee) {
        int256 n = size * price / P;
        makerFee = _ceil(n * MAKER_RATE, 1_000_000);
        takerFee = _ceil(n * TAKER_RATE, 1_000_000);
    }

    function _ceil(int256 a, int256 b) internal pure returns (int256) {
        return a == 0 ? int256(0) : (a - 1) / b + 1;
    }

    /// @notice Protocol invariant 5, exact.
    function assertSolvencyExact() internal view {
        (int256 assets, int256 liabilities) = vault.solvency();
        assertEq(assets, liabilities, "invariant 5: vault USDC == ledger - cost basis");
    }

    function expectErr(bytes4 selector) internal {
        vm.expectRevert(abi.encodeWithSelector(selector));
    }
}
