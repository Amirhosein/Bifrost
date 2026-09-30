// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title MockArbSys
 * @notice Local stand-in for the ArbSys precompile. Tests install its runtime code at
 *         address(100) with hardhat_setCode so *Arb L2 contracts can run on Hardhat.
 * @dev Records each L2->L1 message; tests replay it through MockArbOutbox.
 */
contract MockArbSys {
    event SendTxToL1(uint256 indexed msgNum, address indexed sender, address indexed destination, bytes data);

    uint256 public messageCount;

    function sendTxToL1(address destination, bytes calldata calldataForL1) external payable returns (uint256 msgNum) {
        msgNum = messageCount++;
        emit SendTxToL1(msgNum, msg.sender, destination, calldataForL1);
    }
}
