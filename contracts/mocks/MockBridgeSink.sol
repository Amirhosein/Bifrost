// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Benchmark-only bridge that accepts a message and does nothing else (one counter + one event),
///         so the registry's own L1 gas can be measured apart from any bridge implementation.
contract MockBridgeSink {
    uint256 public count;

    event Accepted(address indexed from, address indexed to, uint256 id, bytes data);

    function createRetryableTicket(address to, uint256, uint256, address, address, uint256, uint256, bytes calldata data)
        external
        payable
        returns (uint256 id)
    {
        id = count++;
        emit Accepted(msg.sender, to, id, data);
    }

    function sendMessage(address target, bytes calldata message, uint32) external {
        emit Accepted(msg.sender, target, count++, message);
    }

    function messageNonce() external view returns (uint256) {
        return count;
    }

    function xDomainMessageSender() external pure returns (address) {
        return address(0);
    }
}
