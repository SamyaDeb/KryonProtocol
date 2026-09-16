// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Role identifiers shared by every protocol contract.
/// @dev After `05_Handover`, DEFAULT_ADMIN_ROLE, UPGRADER_ROLE, RISK_ADMIN_ROLE
///      and FEE_ADMIN_ROLE are held only by the timelock.
///      `99_VerifyDeployment` fails if any EOA holds one of them.
library Roles {
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    /// Authorises UUPS upgrades.
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /// Market, oracle and liquidation parameters (bounded setters).
    bytes32 internal constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    /// Fee schedule, tiers, split and recipients (bounded setters).
    bytes32 internal constant FEE_ADMIN_ROLE = keccak256("FEE_ADMIN_ROLE");
    /// Matcher: may submit `settleFillsSigned`.
    bytes32 internal constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// Oracle keeper: may call `pushPrices`.
    bytes32 internal constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    /// Funding keeper: may call `updateFunding`.
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    /// Guardian: may pause. Unpausing needs DEFAULT_ADMIN_ROLE (the timelock).
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// Tier bot: may assign accounts to already-defined fee tiers.
    bytes32 internal constant FEE_TIER_ROLE = keccak256("FEE_TIER_ROLE");
    /// Protocol contracts allowed to move internal vault balances.
    bytes32 internal constant LEDGER_ROLE = keccak256("LEDGER_ROLE");
    /// Protocol contracts allowed to charge fees through the FeeRouter.
    bytes32 internal constant FEE_SOURCE_ROLE = keccak256("FEE_SOURCE_ROLE");
}
