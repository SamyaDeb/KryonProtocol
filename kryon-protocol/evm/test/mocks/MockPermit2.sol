// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISignatureTransfer} from "../../src/interfaces/IKryon.sol";

/// @notice Minimal Permit2 stand-in: checks the signature is `owner`'s marker
///         and pulls the tokens (the real Permit2 verifies an EIP-712 sig).
contract MockPermit2 {
    mapping(address => mapping(uint256 => bool)) public used;

    function permitTransferFrom(
        ISignatureTransfer.PermitTransferFrom memory permit,
        ISignatureTransfer.SignatureTransferDetails calldata details,
        address owner,
        bytes calldata signature
    ) external {
        require(keccak256(signature) == keccak256(abi.encode(owner, permit.nonce)), "bad sig");
        require(block.timestamp <= permit.deadline, "expired");
        require(!used[owner][permit.nonce], "nonce");
        require(details.requestedAmount <= permit.permitted.amount, "amount");
        used[owner][permit.nonce] = true;
        IERC20(permit.permitted.token).transferFrom(owner, details.to, details.requestedAmount);
    }
}
