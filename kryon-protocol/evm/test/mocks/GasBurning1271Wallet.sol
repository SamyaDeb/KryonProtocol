// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Smart-contract wallet that spends (almost) all the gas it is given
///         in `isValidSignature`. With `approve` it then returns the magic
///         value if gas remains, modelling the most expensive valid wallet;
///         without it, a griefer trying to starve a settlement batch.
contract GasBurning1271Wallet {
    bool public approve;
    uint256 public keep;

    constructor(bool approve_, uint256 keep_) {
        approve = approve_;
        keep = keep_;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        uint256 floor = keep;
        while (gasleft() > floor) {}
        return approve ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
