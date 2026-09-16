// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {Errors} from "../libraries/Errors.sol";
import {Roles} from "./Roles.sol";

/// @notice Governance timelock. Owns every proxy and every admin role.
/// @dev OZ TimelockController with two additions carried over from the
///      Soroban governance contract:
///      - the delay can never be below 48 hours, not even by a self-call;
///      - a guardian (PAUSER_ROLE) can veto execution instantly. Only the
///        timelock itself can lift the veto, so lifting it also waits 48h.
///      Not upgradeable by design.
contract KryonTimelock is TimelockController {
    uint256 public constant MIN_SAFE_DELAY = 48 hours;

    bool private _executionPaused;

    event ExecutionPaused(address indexed guardian);
    event ExecutionUnpaused();

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

    function executionPaused() external view returns (bool) {
        return _executionPaused;
    }

    function pauseExecution() external onlyRole(Roles.PAUSER_ROLE) {
        _executionPaused = true;
        emit ExecutionPaused(msg.sender);
    }

    /// @notice Only reachable through a scheduled operation (the timelock calls itself).
    function unpauseExecution() external {
        if (msg.sender != address(this)) revert Errors.Unauthorized();
        _executionPaused = false;
        emit ExecutionUnpaused();
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
        if (_executionPaused && !_isUnpauseCall(target, payload)) revert Errors.ExecutionPaused();
        super.execute(target, value, payload, predecessor, salt);
    }

    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) public payable override {
        if (_executionPaused) revert Errors.ExecutionPaused();
        super.executeBatch(targets, values, payloads, predecessor, salt);
    }

    function _isUnpauseCall(address target, bytes calldata payload) private view returns (bool) {
        return target == address(this) && payload.length == 4
            && bytes4(payload) == this.unpauseExecution.selector;
    }
}
