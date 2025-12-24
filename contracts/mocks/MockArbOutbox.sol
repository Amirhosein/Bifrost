// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title MockArbOutbox
 * @notice Minimal Arbitrum Outbox mock for local Hardhat tests.
 *
 * In Arbitrum, L2->L1 messages are executed on L1 by the Outbox.
 * The Outbox exposes l2ToL1Sender() so L1 contracts can authenticate
 * the originating L2 sender.
 */
contract MockArbOutbox {
    address public l2Sender;

    /// @notice Mirror of Arbitrum Outbox API.
    function l2ToL1Sender() external view returns (address) {
        return l2Sender;
    }

    /**
     * @notice Execute a call as if it were being executed by the Outbox.
     * @dev Bubbles up revert data from the target so tests can assert
     *      custom errors from the target contract.
     */
    function execute(address target, bytes calldata data, address l2Sender_) external returns (bytes memory) {
        l2Sender = l2Sender_;
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}
