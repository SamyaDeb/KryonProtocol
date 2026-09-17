// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {KryonErrors as Errors} from "../libraries/Errors.sol";
import {Roles} from "./Roles.sol";

/// @notice Governance timelock. Owns every proxy and every admin role.
/// @dev OZ TimelockController with two additions carried over from the
///      Soroban governance contract:
///      - the delay can never be below 48 hours, not even by a self-call;
///      - a guardian (PAUSER_ROLE) can veto execution instantly, for at most
///        VETO_DURATION. Only the timelock itself can lift the veto early, so
///        lifting it also waits 48h.
///      Once a veto ends (expiry or lift) the guardian cannot veto again for
///      VETO_COOLDOWN, which is longer than the 48h delay: anything scheduled
///      during the veto (scheduling is never blocked), such as revoking a
///      hostile guardian, can execute in that window.
///      Not upgradeable by design.
contract KryonTimelock is TimelockController {
    uint256 public constant MIN_SAFE_DELAY = 48 hours;
    uint256 public constant VETO_DURATION = 7 days;
    uint256 public constant VETO_COOLDOWN = 3 days;

    /// End of the current or most recent veto (0 = never vetoed). A lift
    /// moves it to the lift time.
    uint64 private _vetoUntil;

    event ExecutionPaused(address indexed guardian, uint64 vetoUntil, uint64 cooldownEndsAt);
    event ExecutionUnpaused(uint64 endedAt, uint64 cooldownEndsAt);

    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address guardian
    ) TimelockController(minDelay, proposers, executors, address(0)) {
        if (minDelay < MIN_SAFE_DELAY) revert Errors.InvalidConfig();
        if (guardian == address(0)) revert Errors.ZeroAddress();
        _setRoleAdmin(Roles.PAUSER_ROLE, DEFAULT_ADMIN_ROLE);
        _grantRole(Roles.PAUSER_ROLE, guardian);
    }

    function executionPaused() public view returns (bool) {
        return block.timestamp < _vetoUntil;
    }

    function vetoUntil() external view returns (uint64) {
        return _vetoUntil;
    }

    /// @notice When the guardian may veto again (0 = never vetoed).
    function vetoCooldownEndsAt() public view returns (uint64) {
        return _vetoUntil == 0 ? 0 : uint64(_vetoUntil + VETO_COOLDOWN);
    }

    /// @notice Veto execution for VETO_DURATION. Cannot be renewed while a veto
    ///         is active or within VETO_COOLDOWN of the last one ending.
    function pauseExecution() external onlyRole(Roles.PAUSER_ROLE) {
        if (_vetoUntil != 0 && block.timestamp < vetoCooldownEndsAt()) {
            revert Errors.VetoCooldownActive();
        }
        uint64 until = uint64(block.timestamp + VETO_DURATION);
        _vetoUntil = until;
        emit ExecutionPaused(msg.sender, until, uint64(until + VETO_COOLDOWN));
    }

    /// @notice Only reachable through a scheduled operation (the timelock calls
    ///         itself). Ends an active veto now, which starts the cooldown.
    ///         Without an active veto it does nothing, so it can never be used
    ///         to hold the guardian in a cooldown.
    function unpauseExecution() external {
        if (msg.sender != address(this)) revert Errors.Unauthorized();
        if (!executionPaused()) return;
        uint64 now_ = uint64(block.timestamp);
        _vetoUntil = now_;
        emit ExecutionUnpaused(now_, uint64(now_ + VETO_COOLDOWN));
    }

    function getMinDelay() public view override returns (uint256) {
        uint256 configured = super.getMinDelay();
        return configured < MIN_SAFE_DELAY ? MIN_SAFE_DELAY : configured;
    }

    function updateDelay(uint256 newDelay) public override {
        if (newDelay < MIN_SAFE_DELAY) revert Errors.InvalidConfig();
        super.updateDelay(newDelay);
    }

    function execute(
        address target,
        uint256 value,
        bytes calldata payload,
        bytes32 predecessor,
        bytes32 salt
    ) public payable override {
        // The veto never blocks the one call that can lift it.
        if (executionPaused() && !_isUnpauseCall(target, payload)) revert Errors.ExecutionPaused();
        super.execute(target, value, payload, predecessor, salt);
    }

    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) public payable override {
        if (executionPaused()) revert Errors.ExecutionPaused();
        super.executeBatch(targets, values, payloads, predecessor, salt);
    }

    function _isUnpauseCall(address target, bytes calldata payload) private view returns (bool) {
        return target == address(this) && payload.length == 4
            && bytes4(payload) == this.unpauseExecution.selector;
    }
}
