// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControlEnumerableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {KryonErrors as Errors} from "../libraries/Errors.sol";
import {Roles} from "./Roles.sol";

/// @notice Shared base for every UUPS protocol contract: enumerable roles (so
///         deployment verification can prove no EOA holds an admin role),
///         a time-bounded guardian pause, a timelock-only indefinite pause and
///         unpause, and timelock-only upgrades.
/// @dev All state lives in ERC-7201 namespaces (OZ's own, this base's and one
///      per contract), so inheriting from this base never shifts a storage
///      slot. The reentrancy guard uses transient storage (EIP-1153) and holds
///      no slot. OZ's `_paused` flag is never set: `paused()` is derived from
///      this base's namespace, and `whenNotPaused` reads `paused()`.
abstract contract KryonUpgradeable is
    Initializable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    UUPSUpgradeable
{
    /// Longer than the 48h timelock delay, so governance can schedule
    /// `pauseIndefinitely` before a real emergency pause lapses.
    uint256 public constant GUARDIAN_PAUSE_DURATION = 72 hours;
    /// After a guardian pause ends (expiry or unpause), the guardian must wait
    /// this long before pausing again, so a hostile guardian cannot keep user
    /// funds locked while governance revokes its role.
    uint256 public constant GUARDIAN_PAUSE_COOLDOWN = 24 hours;

    /// @custom:storage-location erc7201:kryon.storage.KryonUpgradeable
    struct PauseStorage {
        /// End of the current or most recent guardian pause (0 = never paused).
        uint64 guardianPauseExpiry;
        /// Set by the timelock; ends only through `unpause`.
        bool indefinite;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.KryonUpgradeable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PAUSE_STORAGE_LOCATION =
        0x5bc9875af04617076e90a0145eac97c0ae215a74e3d64d9d91405185e99be900;

    event GuardianPaused(address indexed guardian, uint64 expiry, uint64 cooldownEndsAt);
    event PausedIndefinitely(address indexed by);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _pauseStorage() private pure returns (PauseStorage storage $) {
        assembly ("memory-safe") {
            $.slot := PAUSE_STORAGE_LOCATION
        }
    }

    function __KryonUpgradeable_init(address admin) internal onlyInitializing {
        if (admin == address(0)) revert Errors.ZeroAddress();
        __AccessControlEnumerable_init();
        __Pausable_init();
        _grantRole(Roles.DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Guardian fast path: stop the contract for GUARDIAN_PAUSE_DURATION.
    /// @dev Cannot be renewed while active or within GUARDIAN_PAUSE_COOLDOWN of
    ///      the previous guardian pause ending. A longer stop is a governance
    ///      decision (`pauseIndefinitely`).
    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        if (paused()) revert EnforcedPause();
        PauseStorage storage $ = _pauseStorage();
        uint256 last = $.guardianPauseExpiry;
        if (last != 0 && block.timestamp < last + GUARDIAN_PAUSE_COOLDOWN) {
            revert Errors.PauseCooldownActive();
        }
        uint64 expiry = uint64(block.timestamp + GUARDIAN_PAUSE_DURATION);
        $.guardianPauseExpiry = expiry;
        emit Paused(_msgSender());
        emit GuardianPaused(_msgSender(), expiry, uint64(expiry + GUARDIAN_PAUSE_COOLDOWN));
    }

    /// @notice Governance pause with no expiry. Ends only through `unpause`.
    function pauseIndefinitely() external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        PauseStorage storage $ = _pauseStorage();
        if ($.indefinite) revert EnforcedPause();
        $.indefinite = true;
        emit Paused(_msgSender());
        emit PausedIndefinitely(_msgSender());
    }

    /// @notice Restarting is a governance decision, so it inherits the timelock
    ///         delay. Clears both the indefinite and the guardian pause. A
    ///         guardian pause ended early still starts the guardian cooldown.
    function unpause() external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (!paused()) revert ExpectedPause();
        PauseStorage storage $ = _pauseStorage();
        $.indefinite = false;
        if ($.guardianPauseExpiry > block.timestamp) $.guardianPauseExpiry = uint64(block.timestamp);
        emit Unpaused(_msgSender());
    }

    /// @notice True during an indefinite pause or an unexpired guardian pause.
    ///         A guardian pause lapses without an `Unpaused` event.
    function paused() public view override returns (bool) {
        PauseStorage storage $ = _pauseStorage();
        return $.indefinite || block.timestamp < $.guardianPauseExpiry;
    }

    /// @return guardianPauseExpiry End of the current or last guardian pause (0 = never).
    /// @return indefinite Whether a governance pause is in force.
    /// @return guardianCooldownEndsAt When the guardian may pause again (0 = now).
    function pauseState()
        external
        view
        returns (uint64 guardianPauseExpiry, bool indefinite, uint64 guardianCooldownEndsAt)
    {
        PauseStorage storage $ = _pauseStorage();
        guardianPauseExpiry = $.guardianPauseExpiry;
        indefinite = $.indefinite;
        guardianCooldownEndsAt =
            guardianPauseExpiry == 0 ? 0 : uint64(guardianPauseExpiry + GUARDIAN_PAUSE_COOLDOWN);
    }

    function _authorizeUpgrade(address) internal override onlyRole(Roles.UPGRADER_ROLE) {}

    /// @dev No `receive`, and a non-payable fallback: every native-value
    ///      transfer or unknown call reverts. Custody is ERC-20 only.
    fallback() external {
        revert Errors.NativeValueRejected();
    }
}
