// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice The part of Arbitrum's L1 Inbox used to send an L1 -> L2 message (a retryable ticket).
interface IInbox {
    /// @param to L2 contract to call.
    /// @param l2CallValue ETH value for the L2 call.
    /// @param maxSubmissionCost Fee for keeping the ticket on L2 (depends only on calldata size).
    /// @param excessFeeRefundAddress Receives unused L2 gas fees.
    /// @param callValueRefundAddress Receives `l2CallValue` if the ticket expires or is cancelled.
    /// @param gasLimit L2 gas for the automatic redeem.
    /// @param maxFeePerGas L2 gas price bid for the automatic redeem.
    /// @param data Calldata for the L2 call.
    /// @dev msg.value must cover l2CallValue + maxSubmissionCost + gasLimit * maxFeePerGas.
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);
}
