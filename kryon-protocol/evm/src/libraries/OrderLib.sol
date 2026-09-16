// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice A trader's signed intent. Signed once with EIP-712; every fill of
///         it is checked against these exact terms on-chain.
/// @dev Amounts: `size` in base units and `limitPrice` in USDC per unit, both
///      1e18 fixed point. Must stay byte-identical to client/lib/market/eip712.ts.
struct Order {
    address owner;
    uint32 marketId;
    bool isLong;
    uint256 size;
    uint256 limitPrice;
    bool reduceOnly;
    uint256 nonce;
    uint64 expiry;
    address referrer;
}

/// @notice Signed off-chain cancel. Can also be posted on-chain by anyone.
struct Cancel {
    address owner;
    uint256 nonce;
    uint64 deadline;
}

/// @notice One matched fill as submitted by the operator.
struct Fill {
    bytes32 fillId;
    Order maker;
    bytes makerSignature;
    Order taker;
    bytes takerSignature;
    uint256 size;
    uint256 price;
}

library OrderLib {
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,uint32 marketId,bool isLong,uint256 size,uint256 limitPrice,bool reduceOnly,uint256 nonce,uint64 expiry,address referrer)"
    );
    bytes32 internal constant CANCEL_TYPEHASH =
        keccak256("Cancel(address owner,uint256 nonce,uint64 deadline)");

    function hashStruct(Order memory o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                o.owner,
                o.marketId,
                o.isLong,
                o.size,
                o.limitPrice,
                o.reduceOnly,
                o.nonce,
                o.expiry,
                o.referrer
            )
        );
    }

    function hashStruct(Cancel memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(CANCEL_TYPEHASH, c.owner, c.nonce, c.deadline));
    }

    /// @notice EOA, EIP-7702-delegated EOA, or ERC-1271 contract signature.
    /// @dev OZ's SignatureChecker only tries ERC-1271 once the signer has code,
    ///      which rejects a 7702-delegated EOA signing with its own key. Try
    ///      ECDSA first, then fall back to ERC-1271 for any account with code.
    function isValidSignature(address signer, bytes32 digest, bytes memory signature)
        internal
        view
        returns (bool)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        if (signer.code.length == 0) return false;
        return SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
    }
}
