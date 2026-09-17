// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IInsurance, IOracleAdapter, IRiskParams, IVault} from "./interfaces/IKryon.sol";
import {KryonErrors as Errors} from "./libraries/Errors.sol";
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
///
///      Storage is packed into int128 fields (all values are already held to
///      the i128 range by KryonMath) and an account's open markets are a
///      bitmap over market ids 1-255, so opening a position costs one or two
///      fresh slots instead of five.
contract Engine is KryonUpgradeable {
    /// I2: well below RiskLib's 64-entry buffer, so a trader can never brick
    /// their own health check (which gates settlement and liquidation).
    uint256 public constant MAX_POSITIONS_PER_ACCOUNT = 16;
    bytes32 public constant REASON_FUNDING = "FUNDING";
    bytes32 public constant REASON_TRADE = "TRADE";
    bytes32 public constant REASON_LIQUIDATION = "LIQUIDATION";
    bytes32 public constant REASON_ADL = "ADL";

    /// Two slots: (size, openNotional) and (lastFundingIndex).
    struct StoredPosition {
        int128 size;
        int128 openNotional;
        int128 lastFundingIndex;
    }

    /// Two slots: (longIndex, shortIndex) and (ratePerHour, lastUpdate).
    struct StoredFunding {
        int128 longIndex;
        int128 shortIndex;
        int128 ratePerHour;
        uint64 lastUpdate;
    }

    /// Two slots: (lastPrice, lastTs, windowStart) and (cumulative).
    struct StoredMark {
        int128 lastPrice;
        uint64 lastTs;
        uint64 windowStart;
        int128 cumulative;
    }

    /// One slot.
    struct OpenInterest {
        int128 long;
        int128 short;
    }

    /// @custom:storage-location erc7201:kryon.storage.Engine
    struct EngineStorage {
        IVault vault;
        IOracleAdapter oracle;
        IRiskParams risk;
        IInsurance insurance;
        address gateway;
        address liquidation;
        mapping(address => mapping(uint32 => StoredPosition)) positions;
        /// Bit `id` set = the account has a position in market `id` (1-255).
        mapping(address => uint256) marketBitmap;
        mapping(uint32 => OpenInterest) openInterest;
        mapping(uint32 => StoredFunding) funding;
        mapping(uint32 => StoredMark) marks;
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
        assembly ("memory-safe") {
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
    ) external onlyGateway whenNotPaused nonReentrant returns (bool increasedExposure) {
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
        // The backstop only ever trades reduce-only (enforced by Insurance and
        // the Engine), so its fills can only shrink exposure.
        if (trader == address(_s().insurance) && !increasedExposure) return;
        AccountHealth memory h = _accountHealth(trader);
        if (increasedExposure) {
            if (h.equity < h.initialMarginRequired) revert Errors.InsufficientCollateral();
        } else if (_s().marketBitmap[trader] == 0) {
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
    // Calls reach only the Vault (no callbacks); the function is nonReentrant.
    // slither-disable-next-line reentrancy-no-eth
    function liquidationTransfer(
        address trader,
        address receiver,
        uint32 marketId,
        int256 size,
        int256 price
    ) external onlyLiquidation whenNotPaused nonReentrant returns (int256 traderRealizedPnl) {
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
    // Calls reach only the Vault (no callbacks); the function is nonReentrant.
    // slither-disable-next-line reentrancy-no-eth
    function adlTransfer(
        address backstop,
        address counterparty,
        uint32 marketId,
        int256 size,
        int256 price
    ) external onlyLiquidation whenNotPaused nonReentrant returns (int256 counterpartyRealizedPnl) {
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
        nonReentrant
        returns (FundingState memory next)
    {
        EngineStorage storage $ = _s();
        FundingConfig memory cfg = $.risk.fundingConfig(marketId);
        MarketParams memory m = $.risk.market(marketId);
        FundingState memory current = _loadFunding(marketId);
        uint64 now_ = uint64(block.timestamp);
        if (current.lastUpdate == 0) {
            // First update starts the clock; nothing accrues for the time
            // before the market was configured.
            current.lastUpdate = now_;
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
        $.funding[marketId] = StoredFunding({
            longIndex: int128(M.bound128(next.longIndex)),
            shortIndex: int128(M.bound128(next.shortIndex)),
            ratePerHour: int128(M.bound128(next.ratePerHour)),
            lastUpdate: next.lastUpdate
        });
        emit FundingUpdated(
            marketId, next.longIndex, next.shortIndex, next.ratePerHour, premium, mark, index
        );
    }

    // ------------------------------------------------------------------ views

    function accountHealth(address trader) external view returns (AccountHealth memory) {
        return _accountHealth(trader);
    }

    /// @notice Mark-to-market account value: collateral + unrealized PnL +
    ///         pending funding, on the same RiskLib path as `accountHealth`.
    /// @dev Never reverts. If any held market cannot be priced (stale, wide or
    ///      inactive oracle) or the health computation fails for any other
    ///      reason, returns `(0, false)`; callers must fail closed on it.
    function accountValue(address trader) external view returns (int256 equity, bool priced) {
        try this.accountHealth(trader) returns (AccountHealth memory h) {
            return (h.equity, true);
        } catch {
            return (0, false);
        }
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
        StoredPosition memory p = _s().positions[trader][marketId];
        return Position(p.size, p.openNotional, p.lastFundingIndex);
    }

    /// @notice Every open position of `trader`, in ascending market id.
    function positionsOf(address trader)
        external
        view
        returns (uint32[] memory marketIds, Position[] memory positions)
    {
        EngineStorage storage $ = _s();
        marketIds = _marketIds($.marketBitmap[trader]);
        positions = new Position[](marketIds.length);
        for (uint256 i = 0; i < marketIds.length; ++i) {
            StoredPosition memory p = $.positions[trader][marketIds[i]];
            positions[i] = Position(p.size, p.openNotional, p.lastFundingIndex);
        }
    }

    function positionCount(address trader) external view returns (uint256) {
        return _popcount(_s().marketBitmap[trader]);
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
        StoredMark memory st = _s().marks[marketId];
        return MarkState(st.lastPrice, st.lastTs, st.cumulative, st.windowStart);
    }

    function fundingState(uint32 marketId) external view returns (FundingState memory) {
        return _loadFunding(marketId);
    }

    function openInterest(uint32 marketId) external view returns (int256 longOi, int256 shortOi) {
        OpenInterest memory oi = _s().openInterest[marketId];
        return (oi.long, oi.short);
    }

    function netCostBasis() external view returns (int256) {
        return _s().netCostBasis;
    }

    /// @notice Insurance coverage of a market's OI notional, in bps.
    ///         `type(int128).max` when the market has no open interest.
    function insuranceCoverageBps(uint32 marketId) external view returns (int256) {
        EngineStorage storage $ = _s();
        OpenInterest memory o = $.openInterest[marketId];
        int256 oi = int256(o.long) + int256(o.short);
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

    /// @dev External calls reach only the Vault, which never calls back into
    ///      the Engine; every entry point is also nonReentrant. The position
    ///      is read once, updated in memory and written once.
    /// @return increased Whether exposure grew.
    /// @return realized  Realized PnL booked to the trader (excl. funding).
    // slither-disable-next-line reentrancy-no-eth
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
        Position memory p = _loadPosition(trader, marketId);
        _settleFunding(trader, marketId, p);
        int256 s = p.size;
        int256 basisChange;

        if (s == 0 || (s > 0) == (delta > 0)) {
            if (reduceOnly) revert Errors.PositionNotFound();
            if (s == 0) _addMarket(trader, marketId, enforceLimits);
            basisChange = _open(marketId, m, p, delta, fillNotional, enforceLimits);
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
            basisChange = -removedBasis;
            _changeOpenInterest(marketId, s > 0, -closeQty);

            if (residual > 0) {
                if (reduceOnly) revert Errors.InvalidAmount();
                basisChange += _open(
                    marketId,
                    m,
                    p,
                    delta > 0 ? residual : -residual,
                    fillNotional - closeNotional,
                    enforceLimits
                );
                increased = true;
            }
        }

        $.netCostBasis = M.add($.netCostBasis, basisChange);
        if (p.size == 0) {
            delete $.positions[trader][marketId];
            $.marketBitmap[trader] &= ~(uint256(1) << marketId);
        } else {
            $.positions[trader][marketId] = StoredPosition({
                size: int128(M.bound128(p.size)),
                openNotional: int128(M.bound128(p.openNotional)),
                lastFundingIndex: int128(M.bound128(p.lastFundingIndex))
            });
        }
        if (realized != 0) $.vault.applyPnl(trader, realized);

        if (increased && enforceLimits) _checkOpenInterest(marketId, m, price);
        emit PositionChanged(trader, marketId, reason, delta, price, p.size, p.openNotional, realized);
    }

    /// @dev `p` is flat or already on `delta`'s side. Returns the basis added.
    function _open(
        uint32 marketId,
        MarketParams memory m,
        Position memory p,
        int256 delta,
        int256 notional_,
        bool enforceLimits
    ) private returns (int256 signedNotional) {
        if (enforceLimits && !m.active) revert Errors.MarketInactive(marketId);
        if (p.size == 0) {
            StoredFunding memory f = _s().funding[marketId];
            p.lastFundingIndex = delta > 0 ? f.longIndex : f.shortIndex;
        }
        signedNotional = delta > 0 ? notional_ : -notional_;
        p.size = M.add(p.size, delta);
        p.openNotional = M.add(p.openNotional, signedNotional);
        _changeOpenInterest(marketId, delta > 0, M.abs(delta));
    }

    function _settleFunding(address trader, uint32 marketId, Position memory p) private {
        if (p.size == 0) return;
        StoredFunding memory f = _s().funding[marketId];
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
        OpenInterest storage oi = _s().openInterest[marketId];
        if (isLong) {
            oi.long = int128(M.add(oi.long, amount));
        } else {
            oi.short = int128(M.add(oi.short, amount));
        }
    }

    function _checkOpenInterest(uint32 marketId, MarketParams memory m, int256 price) private view {
        EngineStorage storage $ = _s();
        OpenInterest memory o = $.openInterest[marketId];
        int256 oi = int256(o.long) + int256(o.short);
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
        if (marketId == 0 || marketId > 255) revert Errors.UnknownMarket(marketId);
        EngineStorage storage $ = _s();
        uint256 bitmap = $.marketBitmap[trader];
        if (capped && _popcount(bitmap) >= MAX_POSITIONS_PER_ACCOUNT) revert Errors.TooManyPositions();
        $.marketBitmap[trader] = bitmap | (uint256(1) << marketId);
    }

    function _popcount(uint256 bitmap) private pure returns (uint256 n) {
        for (; bitmap != 0; bitmap &= bitmap - 1) ++n;
    }

    /// @dev Set bits in ascending order.
    function _marketIds(uint256 bitmap) private pure returns (uint32[] memory ids) {
        ids = new uint32[](_popcount(bitmap));
        for (uint256 i = 0; bitmap != 0; ++i) {
            uint256 lowest = bitmap & (~bitmap + 1);
            ids[i] = uint32(Math.log2(lowest));
            bitmap ^= lowest;
        }
    }

    function _loadPosition(address trader, uint32 marketId) private view returns (Position memory) {
        StoredPosition memory p = _s().positions[trader][marketId];
        return Position(p.size, p.openNotional, p.lastFundingIndex);
    }

    function _loadFunding(uint32 marketId) private view returns (FundingState memory) {
        StoredFunding memory f = _s().funding[marketId];
        return FundingState(f.longIndex, f.shortIndex, f.ratePerHour, f.lastUpdate);
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

        uint32[] memory ids = _marketIds($.marketBitmap[trader]);
        p = new RiskPosition[](ids.length);
        mk = new RiskMarket[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            uint32 id = ids[i];
            StoredPosition memory pos = $.positions[trader][id];
            MarketParams memory m = $.risk.market(id);
            StoredFunding memory f = $.funding[id];
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
    function _accrueMark(StoredMark memory st, uint64 now_) private pure {
        if (now_ > st.lastTs && st.lastPrice > 0) {
            st.cumulative = int128(
                M.add(st.cumulative, M.mul(st.lastPrice, int256(uint256(now_ - st.lastTs))))
            );
        }
        st.lastTs = now_;
    }

    /// @notice Record an executed gateway fill price into the TWAP mark.
    /// @dev Time-weighted, not fill-weighted (KRY-Q6): a burst of prints in one
    ///      block barely moves it. Liquidation and ADL never call this. Both
    ///      sides of a fill record the same price, so the second is a no-op.
    function _recordMark(uint32 marketId, int256 price) private {
        EngineStorage storage $ = _s();
        uint64 now_ = uint64(block.timestamp);
        StoredMark memory st = $.marks[marketId];
        // Exact match on purpose: the second side of the same fill is a no-op.
        // slither-disable-next-line incorrect-equality
        if (st.lastPrice == price && st.lastTs == now_) return;
        if (st.lastTs == 0) {
            st.lastTs = now_;
            st.windowStart = now_;
        }
        _accrueMark(st, now_);
        if (st.lastPrice <= 0) {
            st.windowStart = now_;
            st.cumulative = 0;
            // The funding clock starts with the market's first trade.
            StoredFunding storage f = $.funding[marketId];
            if (f.lastUpdate == 0) f.lastUpdate = now_;
        }
        st.lastPrice = int128(M.bound128(price));
        $.marks[marketId] = st;
    }

    /// @dev TWAP since the last read; closes the window. 0 if never traded.
    function _consumeTwap(uint32 marketId) private returns (int256 twap) {
        EngineStorage storage $ = _s();
        uint64 now_ = uint64(block.timestamp);
        StoredMark memory st = $.marks[marketId];
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
