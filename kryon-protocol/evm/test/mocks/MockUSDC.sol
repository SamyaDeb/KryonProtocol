// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Stand-in for Arc USDC's ERC-20 interface: 6 decimals, EIP-2612 and a
///         blocklist whose transfers revert like Arc's protocol-level blocklist.
/// @dev OZ's ERC20Permit signs under version "1"; Arc USDC uses "2". Tests
///      always read DOMAIN_SEPARATOR() from the token, so this doesn't matter
///      here; the fork tests exercise the real domain.
contract MockUSDC is ERC20, ERC20Permit {
    mapping(address => bool) public blocked;

    error Blocklisted(address account);

    constructor() ERC20("USDC", "USDC") ERC20Permit("USDC") {}

    function version() external pure returns (string memory) {
        return "2";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocklisted(from);
        if (blocked[to]) revert Blocklisted(to);
        super._update(from, to, value);
    }
}
