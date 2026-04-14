// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal interface for the Arbitrum Nitro ArbSys precompile.
/// @dev Deployed at address(100) on Arbitrum chains.
interface IArbSys {
    /// @notice Send a transaction to L1.
    /// @param destination L1 target address.
    /// @param calldataForL1 Encoded call data for the L1 target.
    /// @return msgNum Unique ID for the L2->L1 message.
    function sendTxToL1(address destination, bytes calldata calldataForL1) external payable returns (uint256 msgNum);
}
