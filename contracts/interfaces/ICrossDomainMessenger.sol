// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal interface compatible with OP‑Stack style cross-domain messenger.
/// @dev For local testing we provide a Mock messenger that matches this interface.
interface ICrossDomainMessenger {
    function sendMessage(address target, bytes calldata message, uint32 gasLimit) external;

    /// @notice Returns original L2 sender for the *current* cross-domain message.
    /// @dev On OP Stack this is `xDomainMessageSender()`.
    function xDomainMessageSender() external view returns (address);
}
