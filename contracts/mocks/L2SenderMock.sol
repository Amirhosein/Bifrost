// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";

/**
 * @title L2SenderMock
 * @notice Tiny helper contract used only for local gas / cost measurement.
 *
 * On OP Stack, the CrossDomainMessenger uses `msg.sender` as the xDomain sender
 * for a message. When estimating L1 anchor costs, we want a deterministic
 * “authorized L2 sender” address (this contract) to originate the message.
 */
contract L2SenderMock {
    function send(
        address messenger,
        address target,
        bytes calldata message,
        uint32 gasLimit
    ) external {
        ICrossDomainMessenger(messenger).sendMessage(target, message, gasLimit);
    }
}
