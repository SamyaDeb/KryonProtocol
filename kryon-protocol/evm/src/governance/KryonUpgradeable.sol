// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControlEnumerableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Errors} from "../libraries/Errors.sol";
import {Roles} from "./Roles.sol";

/// @notice Shared base for every UUPS protocol contract: enumerable roles (so
///         deployment verification can prove no EOA holds an admin role),
///         guardian pause, timelock-only unpause, timelock-only upgrades.
/// @dev All state lives in ERC-7201 namespaces (OZ's own plus one per contract),
///      so inheriting from this base never shifts a storage slot. The
///      reentrancy guard uses transient storage (EIP-1153) and holds no slot.
abstract contract KryonUpgradeable is
    Initializable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    UUPSUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function __KryonUpgradeable_init(address admin) internal onlyInitializing {
        if (admin == address(0)) revert Errors.ZeroAddress();
        __AccessControlEnumerable_init();
        __Pausable_init();
        _grantRole(Roles.DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Guardian fast path: stop the contract immediately.
    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        _pause();
    }

    /// @notice Restarting is a governance decision, so it inherits the timelock
    ///         delay. A compromised guardian can halt the protocol, never restart it.
    function unpause() external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyRole(Roles.UPGRADER_ROLE) {}

    receive() external payable {
        revert Errors.NativeValueRejected();
    }

    fallback() external payable {
        revert Errors.NativeValueRejected();
    }
}
