// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal interface for the Arbitrum L1 Bridge contract.
/// @dev The bridge exposes the currently active Outbox executing L2->L1 messages.
interface IBridge {
    function activeOutbox() external view returns (address);
}
