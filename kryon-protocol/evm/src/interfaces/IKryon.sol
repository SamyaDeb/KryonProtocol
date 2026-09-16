// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    AccountHealth,
    FundingConfig,
    FundingState,
    MarketParams,
    OracleSnapshot,
    Position
} from "../libraries/Types.sol";

interface IVault {
    function balanceOf(address account) external view returns (int256);
    function applyPnl(address account, int256 amount) external;
    function transferInternal(address from, address to, int256 amount, bytes32 reason) external;
    function withdrawTo(address to, uint256 amount6) external;
    function depositFor(address beneficiary, uint256 amount6) external;
    function totalLedger() external view returns (int256);
}

interface IEngine {
    function applyFill(
        address trader,
        uint32 marketId,
        bool isBuy,
        int256 size,
        int256 price,
        int256 fillNotional,
        bool reduceOnly
    ) external returns (bool increasedExposure);
    function requireMargin(address trader, bool increasedExposure) external view;
    function accountHealth(address trader) external view returns (AccountHealth memory);
    function validateWithdrawal(address trader, int256 withdrawalValue)
        external
        view
        returns (AccountHealth memory);
    function liquidationTransfer(
        address trader,
        address receiver,
        uint32 marketId,
        int256 size,
        int256 price
    ) external returns (int256 traderRealizedPnl);
    function adlTransfer(
        address backstop,
        address counterparty,
        uint32 marketId,
        int256 size,
        int256 price
    ) external returns (int256 counterpartyRealizedPnl);
    function planLiquidationSize(address trader, uint32 marketId, uint256 partialBps)
        external
        view
        returns (int256 closeSize, AccountHealth memory health);
    function getPosition(address trader, uint32 marketId) external view returns (Position memory);
    function positionCount(address trader) external view returns (uint256);
    function indexPrice(uint32 marketId) external view returns (int256);
    function netCostBasis() external view returns (int256);
}

interface IRiskParams {
    function market(uint32 marketId) external view returns (MarketParams memory);
    function fundingConfig(uint32 marketId) external view returns (FundingConfig memory);
    function oiPolicyBps(uint32 marketId) external view returns (uint256);
    function marketIds() external view returns (uint32[] memory);
}

interface IOracleAdapter {
    function getPrice(bytes32 id, uint32 maxAge, uint16 maxConfidenceBps)
        external
        view
        returns (OracleSnapshot memory);
    function latest(bytes32 id) external view returns (OracleSnapshot memory);
}

interface IInsurance {
    function effectiveBalance() external view returns (int256);
    function badDebt() external view returns (int256);
    function unfundedShortfall() external view returns (int256);
    function settleBadDebt(address trader) external returns (int256 covered);
}

interface IFeeRouter {
    function chargeFill(
        uint32 marketId,
        address maker,
        address taker,
        int256 fillNotional,
        address makerReferrer,
        address takerReferrer
    ) external returns (int256 makerFee, int256 takerFee, uint8 makerTier, uint8 takerTier);
    function accrueLiquidationFee(uint32 marketId, address payer, int256 amount) external;
}

/// @notice Chainlink Data Feeds (subset).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @notice Uniswap Permit2 SignatureTransfer (subset).
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}
