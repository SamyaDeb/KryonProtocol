// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IInsurance, IOracleAdapter, IRiskParams, IVault} from "./interfaces/IKryon.sol";
import {Errors} from "./libraries/Errors.sol";
import {FundingLib} from "./libraries/FundingLib.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";
import {RiskCalc} from "./libraries/RiskCalc.sol";
import {RiskLib} from "./libraries/RiskLib.sol";
import {
    AccountHealth,
    FundingConfig,
    FundingState,
    LiquidationPlan,
    MarkState,
    MarketParams,
    Position,
    RiskCollateral,
    RiskMarket,
    RiskPosition
} from "./libraries/Types.sol";

/// @title Engine
/// @notice Positions, open interest, funding and the time-weighted mark.
/// @dev One net position per (trader, marketId), cross-margined per account.
///      Every fill changes Σ(balance) - Σ(openNotional) by exactly zero across
///      the two sides, because both sides use the same `fillNotional` and the
///      removed cost basis is booked against realized PnL.
///      The engine's own vault account is the funding pool. Payers round up,
///      receivers round down, so the pool only ever keeps dust.
contract Engine is KryonUpgradeable {
    /// I2: well below RiskLib's 64-entry buffer, so a trader can never brick
    /// their own health check (which gates settlement and liquidation).
    uint256 public constant MAX_POSITIONS_PER_ACCOUNT = 16;
    bytes32 public constant REASON_FUNDING = "FUNDING";
    bytes32 public constant REASON_TRADE = "TRADE";
    bytes32 public constant REASON_LIQUIDATION = "LIQUIDATION";
    bytes32 public constant REASON_ADL = "ADL";

    /// @custom:storage-location erc7201:kryon.storage.Engine
    struct EngineStorage {
        IVault vault;
        IOracleAdapter oracle;
        IRiskParams risk;
        IInsurance insurance;
        address gateway;
        address liquidation;
        mapping(address => mapping(uint32 => Position)) positions;
        mapping(address => uint32[]) accountMarkets;
        /// 1-based index into accountMarkets; 0 = absent.
        mapping(address => mapping(uint32 => uint256)) marketSlot;
        mapping(uint32 => int256) longOpenInterest;
        mapping(uint32 => int256) shortOpenInterest;
        mapping(uint32 => FundingState) funding;
        mapping(uint32 => MarkState) marks;
        /// Σ openNotional over every position (signed).
        int256 netCostBasis;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.Engine")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xfa8e8bdd1e13da029dba03bb246aaa013931acabae2ab1188ea875a8c7cdb000;

    event PositionChanged(
        address indexed trader,
        uint32 indexed marketId,
        bytes32 indexed reason,
        int256 sizeDelta,
        int256 price,
        int256 size,
        int256 openNotional,
        int256 realizedPnl
    );
    event FundingSettled(address indexed trader, uint32 indexed marketId, int256 amount);
    event FundingUpdated(
        uint32 indexed marketId,
        int256 longIndex,
        int256 shortIndex,
        int256 ratePerHour,
        int256 premium,
        int256 mark,
        int256 index
    );
    event WiringSet(bytes32 indexed what, address indexed value);

    modifier onlyGateway() {
        if (msg.sender != _s().gateway) revert Errors.Unauthorized();
        _;
    }

    modifier onlyLiquidation() {
        if (msg.sender != _s().liquidation) revert Errors.Unauthorized();
        _;
    }

    function _s() private pure returns (EngineStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(address admin, address vault_, address oracle_, address risk_)
        external
        initializer
    {
        if (vault_ == address(0) || oracle_ == address(0) || risk_ == address(0)) {
            revert Errors.ZeroAddress();
        }
        __KryonUpgradeable_init(admin);
        EngineStorage storage $ = _s();
        $.vault = IVault(vault_);
        $.oracle = IOracleAdapter(oracle_);
        $.risk = IRiskParams(risk_);
    }

    // ---------------------------------------------------------------- wiring

    function setGateway(address gateway_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (gateway_ == address(0)) revert Errors.ZeroAddress();
        _s().gateway = gateway_;
        emit WiringSet("gateway", gateway_);
    }

    function setLiquidation(address liquidation_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (liquidation_ == address(0)) revert Errors.ZeroAddress();
        _s().liquidation = liquidation_;
        emit WiringSet("liquidation", liquidation_);
    }

    function setInsurance(address insurance_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (insurance_ == address(0)) revert Errors.ZeroAddress();
        _s().insurance = IInsurance(insurance_);
        emit WiringSet("insurance", insurance_);
    }

    // ---------------------------------------------------------------- trading

    /// @notice Apply one side of a matched fill. Gateway only.
    /// @param size Unsigned fill size (1e18 base units), > 0.
    /// @param fillNotional `mulPrecision(size, price)`, computed once per fill
    ///        by the gateway so both sides book the identical amount.
    /// @return increasedExposure True if the fill opened or grew a position.
    function applyFill(
        address trader,
        uint32 marketId,
        bool isBuy,
        int256 size,
        int256 price,
        int256 fillNotional,
        bool reduceOnly
    ) external onlyGateway whenNotPaused returns (bool increasedExposure) {
        if (size <= 0 || price <= 0 || fillNotional <= 0) revert Errors.InvalidAmount();
        MarketParams memory m = _s().risk.market(marketId);
        int256 index = _indexPrice(m);
        int256 maxDelta = M.applyBps(index, m.maxExecutionDeviationBps);
        if (price < M.sub(index, maxDelta) || price > M.add(index, maxDelta)) {
            revert Errors.PriceOutsideBand();
        }
        _recordMark(marketId, price);
        (increasedExposure,) = _trade(
            trader, marketId, m, isBuy ? size : -size, price, fillNotional, reduceOnly, true, REASON_TRADE
        );
    }

    /// @notice Post-fill margin check, run by the gateway after fees are charged.
    /// @dev A fill that increased exposure must leave equity >= initial margin.
    ///      A pure reduction must not leave the account liquidatable, and a
    ///      full close must not leave it with a negative balance; those
    ///      accounts go through liquidation instead.
    function requireMargin(address trader, bool increasedExposure) external view {
        AccountHealth memory h = _accountHealth(trader);
        if (increasedExposure) {
            if (h.equity < h.initialMarginRequired) revert Errors.InsufficientCollateral();
        } else if (_s().accountMarkets[trader].length == 0) {
            if (h.equity < 0) revert Errors.InsufficientCollateral();
        } else if (h.liquidatable) {
            revert Errors.InsufficientCollateral();
        }
    }

    // ------------------------------------------------------------ liquidation

    /// @notice Move `size` of `trader`'s position to `receiver` (the insurance
    ///         backstop) at `price`. Liquidation only.
    /// @dev Keeps long and short open interest equal and value conserved, which
    ///      a one-sided close cannot. Does not move the mark.
    function liquidationTransfer(
        address trader,
        address receiver,
        uint32 marketId,
        int256 size,
        int256 price
    ) external onlyLiquidation whenNotPaused returns (int256 traderRealizedPnl) {
        EngineStorage storage $ = _s();
        int256 s = $.positions[trader][marketId].size;
        if (s == 0) revert Errors.PositionNotFound();
        if (size <= 0 || size > M.abs(s) || price <= 0) revert Errors.InvalidAmount();
        MarketParams memory m = $.risk.market(marketId);
        int256 n = M.mulPrecision(size, price);
        int256 delta = s > 0 ? -size : size;
        (, traderRealizedPnl) =
            _trade(trader, marketId, m, delta, price, n, true, false, REASON_LIQUIDATION);
        _trade(receiver, marketId, m, -delta, price, n, false, false, REASON_LIQUIDATION);
    }

    /// @notice Auto-deleverage: close `size` of the backstop's position
    ///         against an opposite `counterparty` position. Liquidation only.
    function adlTransfer(
        address backstop,
        address counterparty,
        uint32 marketId,
        int256 size,
        int256 price
    ) external onlyLiquidation whenNotPaused returns (int256 counterpartyRealizedPnl) {
        EngineStorage storage $ = _s();
        int256 b = $.positions[backstop][marketId].size;
        int256 c = $.positions[counterparty][marketId].size;
        if (b == 0 || c == 0) revert Errors.PositionNotFound();
        if ((b > 0) == (c > 0)) revert Errors.DirectionMismatch();
        if (size <= 0 || size > M.abs(b) || size > M.abs(c) || price <= 0) {
            revert Errors.InvalidAmount();
        }
        MarketParams memory m = $.risk.market(marketId);
        int256 n = M.mulPrecision(size, price);
        (, counterpartyRealizedPnl) = _trade(
            counterparty, marketId, m, c > 0 ? -size : size, price, n, true, false, REASON_ADL
        );
        _trade(backstop, marketId, m, b > 0 ? -size : size, price, n, true, false, REASON_ADL);
    }

    // ---------------------------------------------------------------- funding

    /// @notice Advance funding for a market from the mark-vs-index premium.
    /// @dev Fails closed on a stale or wide oracle once the market has a mark.
    ///      Tolerates repeated calls in the same second (Arc timestamps are
    ///      non-decreasing).
    function updateFunding(uint32 marketId)
        external
        onlyRole(Roles.KEEPER_ROLE)
        whenNotPaused
        returns (FundingState memory next)
    {
        EngineStorage storage $ = _s();
        FundingConfig memory cfg = $.risk.fundingConfig(marketId);
        MarketParams memory m = $.risk.market(marketId);
        FundingState memory current = $.funding[marketId];
        uint64 now_ = uint64(block.timestamp);
        if (current.lastUpdate == 0) {
            // First update starts the clock; nothing accrues for the time
            // before the market was configured.
            current.lastUpdate = now_;
            $.funding[marketId] = current;
        }

        // Consuming the TWAP closes the averaging window, so each funding
        // period is priced on the time since the previous one.
        int256 mark = _consumeTwap(marketId);
        int256 premium = 0;
        int256 index = 0;
        if (mark > 0) {
            index = _indexPrice(m);
            premium = FundingLib.premiumFromMark(mark, index);
        }
        next = FundingLib.updateFromPremium(cfg, current, premium, now_);
        $.funding[marketId] = next;
        emit FundingUpdated(
            marketId, next.longIndex, next.shortIndex, next.ratePerHour, premium, mark, index
        );
    }

    // ------------------------------------------------------------------ views

    function accountHealth(address trader) external view returns (AccountHealth memory) {
        return _accountHealth(trader);
    }

    /// @notice Reverts with InsufficientCollateral unless equity after removing
    ///         `withdrawalValue` still covers initial margin.
    function validateWithdrawal(address trader, int256 withdrawalValue)
        external
        view
        returns (AccountHealth memory)
    {
        (RiskCollateral[] memory c, RiskPosition[] memory p, RiskMarket[] memory mk) =
            _riskInputs(trader);
        return RiskCalc.validateWithdrawal(c, p, mk, withdrawalValue);
    }

    /// @notice RiskLib.planLiquidation for `trader`'s position in `marketId`.
    function planLiquidationSize(address trader, uint32 marketId, uint256 partialBps)
        external
        view
        returns (int256 closeSize, AccountHealth memory health)
    {
        (RiskCollateral[] memory c, RiskPosition[] memory p, RiskMarket[] memory mk) =
            _riskInputs(trader);
        LiquidationPlan memory plan =
            RiskCalc.planLiquidation(c, p, mk, uint256(marketId), partialBps);
        return (plan.closeSize, plan.expectedHealth);
    }

    function getPosition(address trader, uint32 marketId) external view returns (Position memory) {
        return _s().positions[trader][marketId];
    }

    /// @notice Every open position of `trader`, with its market id.
    function positionsOf(address trader)
        external
        view
        returns (uint32[] memory marketIds, Position[] memory positions)
    {
        EngineStorage storage $ = _s();
        marketIds = $.accountMarkets[trader];
        positions = new Position[](marketIds.length);
        for (uint256 i = 0; i < marketIds.length; ++i) {
            positions[i] = $.positions[trader][marketIds[i]];
        }
    }

    function positionCount(address trader) external view returns (uint256) {
        return _s().accountMarkets[trader].length;
    }

    /// @notice Validated oracle index for a market (the market's own guard).
    function indexPrice(uint32 marketId) external view returns (int256) {
        return _indexPrice(_s().risk.market(marketId));
    }

    /// @notice Last executed fill price, or 0 before the market has traded.
    function markPrice(uint32 marketId) external view returns (int256) {
        return _s().marks[marketId].lastPrice;
    }

    function markState(uint32 marketId) external view returns (MarkState memory) {
        return _s().marks[marketId];
    }

    function fundingState(uint32 marketId) external view returns (FundingState memory) {
        return _s().funding[marketId];
    }

    function openInterest(uint32 marketId) external view returns (int256 longOi, int256 shortOi) {
        return (_s().longOpenInterest[marketId], _s().shortOpenInterest[marketId]);
    }

    function netCostBasis() external view returns (int256) {
        return _s().netCostBasis;
    }

    /// @notice Insurance coverage of a market's OI notional, in bps.
    ///         `type(int128).max` when the market has no open interest.
    function insuranceCoverageBps(uint32 marketId) external view returns (int256) {
        EngineStorage storage $ = _s();
        int256 oi = $.longOpenInterest[marketId] + $.shortOpenInterest[marketId];
        if (oi <= 0) return M.I128_MAX;
        int256 oiNotional = RiskLib.notional(oi, _indexPrice($.risk.market(marketId)));
        return M.mulDiv(_effectiveInsurance(), 10_000, oiNotional);
    }

    function wiring()
        external
        view
        returns (
            address vault_,
            address oracle_,
            address risk_,
            address insurance_,
            address gateway_,
            address liquidation_
        )
    {
        EngineStorage storage $ = _s();
        return (
            address($.vault),
            address($.oracle),
            address($.risk),
            address($.insurance),
            $.gateway,
            $.liquidation
        );
    }

    // --------------------------------------------------------------- internal

    /// @return increased Whether exposure grew.
    /// @return realized  Realized PnL booked to the trader (excl. funding).
    function _trade(
        address trader,
        uint32 marketId,
        MarketParams memory m,
        int256 delta,
        int256 price,
        int256 fillNotional,
        bool reduceOnly,
        bool enforceLimits,
        bytes32 reason
    ) private returns (bool increased, int256 realized) {
        EngineStorage storage $ = _s();
        Position storage p = $.positions[trader][marketId];
        _settleFunding(trader, marketId, p);
        int256 s = p.size;

        if (s == 0 || (s > 0) == (delta > 0)) {
            if (reduceOnly) revert Errors.PositionNotFound();
            if (s == 0) _addMarket(trader, marketId, enforceLimits);
            _open(trader, marketId, m, p, delta, fillNotional, enforceLimits);
            increased = true;
        } else {
            int256 absS = M.abs(s);
            int256 absD = M.abs(delta);
            int256 closeQty = M.min(absS, absD);
            int256 residual = absD - closeQty;
            // Split the one fill notional so both portions sum to it exactly.
            int256 closeNotional = residual == 0 ? fillNotional : M.mulPrecision(closeQty, price);
            int256 removedBasis =
                closeQty == absS ? p.openNotional : M.mulDiv(p.openNotional, closeQty, absS);
            realized = (s > 0 ? closeNotional : -closeNotional) - removedBasis;

            p.openNotional -= removedBasis;
            p.size = s > 0 ? s - closeQty : s + closeQty;
            $.netCostBasis -= removedBasis;
            _changeOpenInterest(marketId, s > 0, -closeQty);

            if (residual > 0) {
                if (reduceOnly) revert Errors.InvalidAmount();
                _open(
                    trader,
                    marketId,
                    m,
                    p,
                    delta > 0 ? residual : -residual,
                    fillNotional - closeNotional,
                    enforceLimits
                );
                increased = true;
            } else if (p.size == 0) {
                delete $.positions[trader][marketId];
                _removeMarket(trader, marketId);
            }
            if (realized != 0) $.vault.applyPnl(trader, realized);
        }

        if (increased && enforceLimits) _checkOpenInterest(marketId, m, price);
        Position memory after_ = $.positions[trader][marketId];
        emit PositionChanged(
            trader, marketId, reason, delta, price, after_.size, after_.openNotional, realized
        );
    }

    /// @dev `p` is empty or already on `delta`'s side.
    function _open(
        address, /* trader */
        uint32 marketId,
        MarketParams memory m,
        Position storage p,
        int256 delta,
        int256 notional_,
        bool enforceLimits
    ) private {
        EngineStorage storage $ = _s();
        if (enforceLimits && !m.active) revert Errors.MarketInactive(marketId);
        if (p.size == 0) {
            FundingState storage f = $.funding[marketId];
            p.lastFundingIndex = delta > 0 ? f.longIndex : f.shortIndex;
        }
        int256 signedNotional = delta > 0 ? notional_ : -notional_;
        p.size = M.add(p.size, delta);
        p.openNotional = M.add(p.openNotional, signedNotional);
        $.netCostBasis = M.add($.netCostBasis, signedNotional);
        _changeOpenInterest(marketId, delta > 0, M.abs(delta));
    }

    function _settleFunding(address trader, uint32 marketId, Position storage p) private {
        if (p.size == 0) return;
        FundingState storage f = _s().funding[marketId];
        int256 idx = p.size > 0 ? f.longIndex : f.shortIndex;
        int256 d = M.sub(idx, p.lastFundingIndex);
        p.lastFundingIndex = idx;
        if (d == 0) return;
        IVault vault_ = _s().vault;
        if (d > 0) {
            int256 paid = M.mulPrecisionUp(M.abs(p.size), d);
            vault_.transferInternal(trader, address(this), paid, REASON_FUNDING);
            emit FundingSettled(trader, marketId, -paid);
        } else {
            int256 received = M.mulPrecision(M.abs(p.size), -d);
            vault_.transferInternal(address(this), trader, received, REASON_FUNDING);
            emit FundingSettled(trader, marketId, received);
        }
    }

    function _changeOpenInterest(uint32 marketId, bool isLong, int256 amount) private {
        EngineStorage storage $ = _s();
        if (isLong) {
            $.longOpenInterest[marketId] = M.add($.longOpenInterest[marketId], amount);
        } else {
            $.shortOpenInterest[marketId] = M.add($.shortOpenInterest[marketId], amount);
        }
    }

    function _checkOpenInterest(uint32 marketId, MarketParams memory m, int256 price) private view {
        EngineStorage storage $ = _s();
        int256 oi = $.longOpenInterest[marketId] + $.shortOpenInterest[marketId];
        if (oi > m.maxOpenInterest) revert Errors.OpenInterestExceeded();
        uint256 bps = $.risk.oiPolicyBps(marketId);
        if (bps == 0) return;
        // KRY-Q4: never carry more OI than the insurance fund can stand behind.
        int256 cap = M.mulDiv(_effectiveInsurance(), int256(bps), 10_000);
        if (RiskLib.notional(oi, price) > cap) revert Errors.InsuranceFundInsufficient();
    }

    function _effectiveInsurance() private view returns (int256) {
        IInsurance ins = _s().insurance;
        return address(ins) == address(0) ? int256(0) : ins.effectiveBalance();
    }

    function _addMarket(address trader, uint32 marketId, bool capped) private {
        EngineStorage storage $ = _s();
        uint32[] storage list = $.accountMarkets[trader];
        if (capped && list.length >= MAX_POSITIONS_PER_ACCOUNT) revert Errors.TooManyPositions();
        list.push(marketId);
        $.marketSlot[trader][marketId] = list.length;
    }

    function _removeMarket(address trader, uint32 marketId) private {
        EngineStorage storage $ = _s();
        uint32[] storage list = $.accountMarkets[trader];
        uint256 slot = $.marketSlot[trader][marketId];
        uint32 last = list[list.length - 1];
        list[slot - 1] = last;
        $.marketSlot[trader][last] = slot;
        list.pop();
        delete $.marketSlot[trader][marketId];
    }

    function _indexPrice(MarketParams memory m) private view returns (int256) {
        return _s().oracle.getPrice(m.oracleId, m.maxOracleAge, m.maxOracleConfidenceBps).price;
    }

    function _accountHealth(address trader) private view returns (AccountHealth memory) {
        (RiskCollateral[] memory c, RiskPosition[] memory p, RiskMarket[] memory mk) =
            _riskInputs(trader);
        return RiskCalc.accountHealth(c, p, mk);
    }

    /// @dev Adapts on-chain state to the Rust-reference shape RiskLib takes.
    ///      Positions are keyed by market id. Delisted-but-open markets are
    ///      still valued (`active: true` here means "has a valid config").
    function _riskInputs(address trader)
        private
        view
        returns (RiskCollateral[] memory c, RiskPosition[] memory p, RiskMarket[] memory mk)
    {
        EngineStorage storage $ = _s();
        c = new RiskCollateral[](1);
        c[0] = RiskCollateral({value: $.vault.balanceOf(trader), haircutBps: 0});

        uint32[] storage ids = $.accountMarkets[trader];
        p = new RiskPosition[](ids.length);
        mk = new RiskMarket[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            uint32 id = ids[i];
            Position storage pos = $.positions[trader][id];
            MarketParams memory m = $.risk.market(id);
            FundingState storage f = $.funding[id];
            int256 absSize = M.abs(pos.size);
            // Entry is derived from the exact basis; floor at 1 wei so dust
            // basis can never make the position unpriceable.
            int256 entry = M.max(1, M.divPrecision(M.abs(pos.openNotional), absSize));
            p[i] = RiskPosition({
                positionId: uint256(id),
                marketId: id,
                size: absSize,
                entryPrice: entry,
                margin: 0,
                isLong: pos.size > 0,
                lastFundingIndex: pos.lastFundingIndex,
                isolated: false
            });
            mk[i] = RiskMarket({
                marketId: id,
                initialMarginBps: m.initialMarginBps,
                maintenanceMarginBps: m.maintenanceMarginBps,
                liquidationFeeBps: m.liquidationFeeBps,
                active: true,
                oraclePrice: _indexPrice(m),
                fundingIndexLong: f.longIndex,
                fundingIndexShort: f.shortIndex
            });
        }
    }

    // -------------------------------------------------------------- mark TWAP

    /// @dev Credit the price standing since `lastTs`, then move `lastTs` to now.
    function _accrueMark(MarkState memory st, uint64 now_) private pure {
        if (now_ > st.lastTs && st.lastPrice > 0) {
            st.cumulative = M.add(st.cumulative, M.mul(st.lastPrice, int256(uint256(now_ - st.lastTs))));
        }
        st.lastTs = now_;
    }

    /// @notice Record an executed gateway fill price into the TWAP mark.
    /// @dev Time-weighted, not fill-weighted (KRY-Q6): a burst of prints in one
    ///      block barely moves it. Liquidation and ADL never call this.
    function _recordMark(uint32 marketId, int256 price) private {
        EngineStorage storage $ = _s();
        uint64 now_ = uint64(block.timestamp);
        MarkState memory st = $.marks[marketId];
        if (st.lastTs == 0) {
            st.lastTs = now_;
            st.windowStart = now_;
        }
        _accrueMark(st, now_);
        if (st.lastPrice == 0) {
            st.windowStart = now_;
            st.cumulative = 0;
        }
        st.lastPrice = price;
        $.marks[marketId] = st;
    }

    /// @dev TWAP since the last read; closes the window. 0 if never traded.
    function _consumeTwap(uint32 marketId) private returns (int256 twap) {
        EngineStorage storage $ = _s();
        uint64 now_ = uint64(block.timestamp);
        MarkState memory st = $.marks[marketId];
        if (st.lastPrice <= 0) return 0;
        _accrueMark(st, now_);
        uint64 elapsed = now_ > st.windowStart ? now_ - st.windowStart : 0;
        // A zero-length window has nothing to average; the standing price is
        // the best estimate.
        twap = elapsed > 0 ? M.mulDiv(st.cumulative, 1, int256(uint256(elapsed))) : st.lastPrice;
        st.cumulative = 0;
        st.windowStart = now_;
        $.marks[marketId] = st;
    }
}
