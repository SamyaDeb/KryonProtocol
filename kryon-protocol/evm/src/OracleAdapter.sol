// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {AggregatorV3Interface} from "./interfaces/IKryon.sol";
import {Errors} from "./libraries/Errors.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";
import {ORACLE_SOURCE_QUORUM, OracleSnapshot} from "./libraries/Types.sol";

/// @title OracleAdapter
/// @notice Pushed CEX-median prices from an allowlist of publisher keys,
///         aggregated on-chain into a quorum median.
/// @dev Each publisher's latest observation is stored. After every push the
///      feed is re-aggregated over the observations that are still fresh.
///      Guards that fail (quorum, source spread, per-update jump, external
///      reference divergence) skip the update and emit an event rather than
///      revert, so one bad feed never blocks a publisher's batch. A skipped
///      update lets the price go stale, and a stale price halts the market.
contract OracleAdapter is KryonUpgradeable {
    uint256 public constant MAX_PUBLISHERS = 5;
    uint32 public constant MAX_FEED_AGE = 300;
    uint32 public constant MAX_REF_AGE = 2 days;
    uint16 public constant MIN_REF_DIVERGENCE_BPS = 10;
    uint16 public constant MAX_BPS = 10_000;

    struct FeedConfig {
        bool listed;
        bool active;
        uint8 minPublishers;
        uint16 maxSpreadBps;
        /// Max move vs the previous aggregate in one update. 0 disables.
        uint16 maxJumpBps;
        uint16 maxConfidenceBps;
        uint32 maxAge;
    }

    /// @notice Independent cross-check (e.g. Chainlink Data Feeds on Arc).
    struct ReferenceFeed {
        address aggregator;
        bool enabled;
        /// When true, a stale or unreadable reference also blocks updates.
        bool required;
        uint16 maxDivergenceBps;
        uint32 maxRefAge;
    }

    struct Observation {
        int256 price;
        int256 confidence;
        uint64 publishTime;
    }

    /// @custom:storage-location erc7201:kryon.storage.OracleAdapter
    struct OracleStorage {
        address[] publishers;
        mapping(bytes32 => FeedConfig) feeds;
        bytes32[] feedIds;
        mapping(bytes32 => ReferenceFeed) refs;
        mapping(bytes32 => mapping(address => Observation)) observations;
        mapping(bytes32 => OracleSnapshot) snapshots;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.OracleAdapter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xc6187b3d7c7e8d8ee4364b65fb617e123cce4294bb34e4db3c351f9e094f4900;

    enum SkipReason {
        QuorumNotMet,
        SpreadTooWide,
        JumpTooLarge,
        ReferenceDiverged,
        ReferenceUnavailable,
        NotMonotonic
    }

    event PublishersSet(address[] publishers);
    event FeedConfigured(bytes32 indexed id, FeedConfig config);
    event ReferenceFeedConfigured(bytes32 indexed id, ReferenceFeed ref);
    event ObservationPushed(
        bytes32 indexed id, address indexed publisher, int256 price, int256 confidence, uint64 publishTime
    );
    event PriceUpdated(
        bytes32 indexed id,
        int256 price,
        int256 confidence,
        uint64 publishTime,
        uint64 writeTime,
        uint8 sourceCount
    );
    event PriceUpdateSkipped(bytes32 indexed id, SkipReason reason, int256 candidate);

    function _s() private pure returns (OracleStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(address admin) external initializer {
        __KryonUpgradeable_init(admin);
    }

    // ---------------------------------------------------------------- config

    /// @notice Replace the publisher set. Each must be a distinct key on a
    ///         separate host, so the quorum median is real.
    function setPublishers(address[] calldata keys) external onlyRole(Roles.RISK_ADMIN_ROLE) {
        if (keys.length == 0 || keys.length > MAX_PUBLISHERS) revert Errors.InvalidConfig();
        OracleStorage storage $ = _s();
        for (uint256 i = 0; i < $.publishers.length; ++i) {
            _revokeRole(Roles.PUBLISHER_ROLE, $.publishers[i]);
        }
        for (uint256 i = 0; i < keys.length; ++i) {
            if (keys[i] == address(0)) revert Errors.ZeroAddress();
            for (uint256 j = 0; j < i; ++j) {
                if (keys[j] == keys[i]) revert Errors.DuplicateOracleSource();
            }
            _grantRole(Roles.PUBLISHER_ROLE, keys[i]);
        }
        // Aggregation only iterates this list, so observations left behind by
        // removed keys can never count toward a quorum.
        $.publishers = keys;
        emit PublishersSet(keys);
    }

    function setFeed(bytes32 id, FeedConfig calldata cfg) external onlyRole(Roles.RISK_ADMIN_ROLE) {
        if (id == bytes32(0)) revert Errors.InvalidConfig();
        if (cfg.maxAge == 0 || cfg.maxAge > MAX_FEED_AGE) revert Errors.InvalidConfig();
        if (cfg.maxConfidenceBps > MAX_BPS || cfg.maxSpreadBps > MAX_BPS || cfg.maxJumpBps > MAX_BPS) {
            revert Errors.InvalidConfig();
        }
        if (cfg.minPublishers == 0 || cfg.minPublishers > MAX_PUBLISHERS) revert Errors.InvalidConfig();
        OracleStorage storage $ = _s();
        if (!$.feeds[id].listed) $.feedIds.push(id);
        $.feeds[id] = cfg;
        $.feeds[id].listed = true;
        emit FeedConfigured(id, $.feeds[id]);
    }

    function setReferenceFeed(bytes32 id, ReferenceFeed calldata ref)
        external
        onlyRole(Roles.RISK_ADMIN_ROLE)
    {
        if (!_s().feeds[id].listed) revert Errors.UnknownFeed(id);
        if (ref.enabled) {
            if (ref.aggregator == address(0)) revert Errors.ZeroAddress();
            if (ref.aggregator.code.length == 0) revert Errors.InvalidConfig();
            if (ref.maxDivergenceBps < MIN_REF_DIVERGENCE_BPS || ref.maxDivergenceBps > MAX_BPS) {
                revert Errors.InvalidConfig();
            }
            if (ref.maxRefAge == 0 || ref.maxRefAge > MAX_REF_AGE) revert Errors.InvalidConfig();
        }
        _s().refs[id] = ref;
        emit ReferenceFeedConfigured(id, ref);
    }

    // ------------------------------------------------------------------ push

    /// @notice Publish one observation per feed and re-aggregate each.
    /// @param publishTime Source timestamp shared by the batch (unix seconds).
    function pushPrices(
        bytes32[] calldata ids,
        int256[] calldata prices,
        int256[] calldata confidences,
        uint64 publishTime
    ) external onlyRole(Roles.PUBLISHER_ROLE) whenNotPaused {
        if (ids.length != prices.length || ids.length != confidences.length) {
            revert Errors.InvalidConfig();
        }
        OracleStorage storage $ = _s();
        if (publishTime > block.timestamp) revert Errors.StaleOracle();
        for (uint256 i = 0; i < ids.length; ++i) {
            bytes32 id = ids[i];
            FeedConfig memory cfg = $.feeds[id];
            if (!cfg.listed) revert Errors.UnknownFeed(id);
            if (!cfg.active) revert Errors.InvalidConfig();
            if (prices[i] <= 0 || confidences[i] < 0) revert Errors.InvalidPrice();
            M.bound128(prices[i]);
            M.bound128(confidences[i]);
            if (block.timestamp - publishTime > cfg.maxAge) revert Errors.StaleOracle();
            Observation storage prev = $.observations[id][msg.sender];
            if (publishTime <= prev.publishTime) revert Errors.StaleOracle();
            $.observations[id][msg.sender] = Observation(prices[i], confidences[i], publishTime);
            emit ObservationPushed(id, msg.sender, prices[i], confidences[i], publishTime);
            _aggregate(id, cfg);
        }
    }

    function _aggregate(bytes32 id, FeedConfig memory cfg) private {
        OracleStorage storage $ = _s();
        uint256 n = $.publishers.length;
        int256[] memory prices = new int256[](n);
        uint256 count = 0;
        int256 maxConfidence = 0;
        uint64 oldest = type(uint64).max;
        for (uint256 i = 0; i < n; ++i) {
            Observation memory o = $.observations[id][$.publishers[i]];
            if (o.publishTime == 0 || block.timestamp - o.publishTime > cfg.maxAge) continue;
            prices[count++] = o.price;
            if (o.confidence > maxConfidence) maxConfidence = o.confidence;
            if (o.publishTime < oldest) oldest = o.publishTime;
        }
        if (count < cfg.minPublishers) {
            emit PriceUpdateSkipped(id, SkipReason.QuorumNotMet, int256(count));
            return;
        }

        _sort(prices, count);
        int256 median = count % 2 == 1
            ? prices[count / 2]
            : M.add(prices[count / 2 - 1], prices[count / 2]) / 2;

        int256 maxSpread = M.applyBps(median, cfg.maxSpreadBps);
        for (uint256 i = 0; i < count; ++i) {
            if (M.abs(M.sub(prices[i], median)) > maxSpread) {
                emit PriceUpdateSkipped(id, SkipReason.SpreadTooWide, median);
                return;
            }
        }

        OracleSnapshot memory prev = $.snapshots[id];
        if (oldest < prev.publishTime) {
            emit PriceUpdateSkipped(id, SkipReason.NotMonotonic, median);
            return;
        }
        if (cfg.maxJumpBps != 0 && prev.price > 0) {
            if (M.abs(M.sub(median, prev.price)) > M.applyBps(prev.price, cfg.maxJumpBps)) {
                emit PriceUpdateSkipped(id, SkipReason.JumpTooLarge, median);
                return;
            }
        }

        ReferenceFeed memory ref = $.refs[id];
        if (ref.enabled) {
            (bool ok, int256 refPrice) = _readReference(ref);
            if (!ok) {
                if (ref.required) {
                    emit PriceUpdateSkipped(id, SkipReason.ReferenceUnavailable, median);
                    return;
                }
            } else if (M.abs(M.sub(median, refPrice)) > M.applyBps(refPrice, ref.maxDivergenceBps)) {
                emit PriceUpdateSkipped(id, SkipReason.ReferenceDiverged, median);
                return;
            }
        }

        $.snapshots[id] = OracleSnapshot({
            price: median,
            confidence: maxConfidence,
            publishTime: oldest,
            writeTime: uint64(block.timestamp),
            source: ORACLE_SOURCE_QUORUM,
            sourceCount: uint8(count)
        });
        emit PriceUpdated(id, median, maxConfidence, oldest, uint64(block.timestamp), uint8(count));
    }

    /// @dev Never reverts: an unreadable, non-positive or stale answer is `ok = false`.
    function _readReference(ReferenceFeed memory ref) private view returns (bool ok, int256 price) {
        // A call to an address without code reverts before `try` can catch it.
        if (ref.aggregator.code.length == 0) return (false, 0);
        AggregatorV3Interface agg = AggregatorV3Interface(ref.aggregator);
        uint8 dec;
        try agg.decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return (false, 0);
        }
        if (dec > 18) return (false, 0);
        try agg.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt > block.timestamp) return (false, 0);
            if (block.timestamp - updatedAt > ref.maxRefAge) return (false, 0);
            if (answer > M.I128_MAX / int256(10 ** (18 - dec))) return (false, 0);
            return (true, answer * int256(10 ** (18 - dec)));
        } catch {
            return (false, 0);
        }
    }

    function _sort(int256[] memory a, uint256 n) private pure {
        for (uint256 i = 1; i < n; ++i) {
            int256 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = key;
        }
    }

    // ----------------------------------------------------------------- reads

    /// @notice A validated price. Reverts if stale, too uncertain or inactive.
    /// @param maxAge Freshness bound in seconds; 0 uses the feed default.
    /// @param maxConfidenceBps Confidence bound; 0 uses the feed default.
    function getPrice(bytes32 id, uint32 maxAge, uint16 maxConfidenceBps)
        external
        view
        returns (OracleSnapshot memory snap)
    {
        FeedConfig memory cfg = _s().feeds[id];
        if (!cfg.listed) revert Errors.UnknownFeed(id);
        if (!cfg.active) revert Errors.InvalidConfig();
        snap = _s().snapshots[id];
        if (snap.source != ORACLE_SOURCE_QUORUM) revert Errors.StaleOracle();
        _validate(
            snap,
            maxAge == 0 ? cfg.maxAge : maxAge,
            maxConfidenceBps == 0 ? cfg.maxConfidenceBps : maxConfidenceBps
        );
    }

    /// @notice The raw stored aggregate, unvalidated. For monitoring.
    function latest(bytes32 id) external view returns (OracleSnapshot memory) {
        return _s().snapshots[id];
    }

    function observation(bytes32 id, address publisher) external view returns (Observation memory) {
        return _s().observations[id][publisher];
    }

    function feed(bytes32 id) external view returns (FeedConfig memory) {
        return _s().feeds[id];
    }

    function referenceFeed(bytes32 id) external view returns (ReferenceFeed memory) {
        return _s().refs[id];
    }

    /// @notice Current reference price, if readable and fresh.
    function referencePrice(bytes32 id) external view returns (bool ok, int256 price) {
        ReferenceFeed memory ref = _s().refs[id];
        if (!ref.enabled) return (false, 0);
        return _readReference(ref);
    }

    function publishers() external view returns (address[] memory) {
        return _s().publishers;
    }

    function feedIds() external view returns (bytes32[] memory) {
        return _s().feedIds;
    }

    /// @dev Port of `OracleSnapshot::validate`.
    function _validate(OracleSnapshot memory s, uint32 maxAge, uint16 maxConfidenceBps) private view {
        if (s.price <= 0) revert Errors.InvalidPrice();
        if (s.publishTime > block.timestamp || s.writeTime > block.timestamp) {
            revert Errors.StaleOracle();
        }
        if (
            block.timestamp - s.publishTime > maxAge || block.timestamp - s.writeTime > maxAge
        ) revert Errors.StaleOracle();
        if (s.confidence < 0) revert Errors.InvalidPrice();
        if (s.confidence > M.applyBps(s.price, maxConfidenceBps)) {
            revert Errors.OracleConfidenceTooWide();
        }
    }
}
