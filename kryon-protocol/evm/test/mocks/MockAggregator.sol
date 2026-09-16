// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Chainlink AggregatorV3 stand-in.
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "broken");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
