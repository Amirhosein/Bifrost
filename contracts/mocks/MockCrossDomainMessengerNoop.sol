// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";

/**
 * @title MockCrossDomainMessengerNoop
 * @notice A messenger mock that only emits a MessageSent event.
 *
 * Why it exists:
 *  - In the unit tests we use MockCrossDomainMessenger which *immediately* calls
 *    the L1 target (recordMint) inside the L2 transaction. This is convenient
 *    for testing end-to-end control flow, but it merges L2 execution gas and L1
 *    execution gas into a single receipt.
 *  - For cost analysis, we want to measure the L2 mint cost separately from the
 *    later L1 relay cost. This mock provides a closer approximation of “L2 send
 *    message only”: it stores nothing long-term and never calls the target.
 */
contract MockCrossDomainMessengerNoop is ICrossDomainMessenger {
    /// @dev Non-standard helper event for local cost analysis.
    event MessageSent(address indexed from, address indexed target, bytes message, uint32 gasLimit);

    /// @dev For interface compatibility only. This mock never executes relay.
    function xDomainMessageSender() external pure returns (address) {
        return address(0);
    }

    /// @notice Emits an event but does not deliver the message.
    function sendMessage(address target, bytes calldata message, uint32 gasLimit) external {
        emit MessageSent(msg.sender, target, message, gasLimit);
    }
}
