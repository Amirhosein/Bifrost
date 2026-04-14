// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal interface for the Arbitrum L1 Outbox.
/// @dev When an L2->L1 message is executed, msg.sender at the L1 target is the Outbox.
interface IOutbox {
    function l2ToL1Sender() external view returns (address);
}
