// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Engine} from "../../src/Engine.sol";
import {Vault} from "../../src/Vault.sol";

/// @notice Upgrade targets: identical storage, one new view.
contract VaultV2 is Vault {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract EngineV2 is Engine {
    function version() external pure returns (uint256) {
        return 2;
    }
}
