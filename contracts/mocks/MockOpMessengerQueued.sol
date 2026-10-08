// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";

/// @title MockOpMessengerQueued
/// @notice Single-chain model of the OP Stack messengers: `sendMessage` is the L1CrossDomainMessenger
///         (queues a deposit), `relayMessage` is the L2CrossDomainMessenger delivering it later.
/// @dev As on OP Stack: during delivery xDomainMessageSender() returns the original L1 sender; a failed
///      delivery (e.g. not enough gas, or the target reverts) is recorded and anyone can replay it later.
///      Unlike MockCrossDomainMessenger, delivery is a separate step, so delay and failures can be shown.
contract MockOpMessengerQueued is ICrossDomainMessenger {
    address private constant DEFAULT_SENDER = 0x000000000000000000000000000000000000dEaD;

    struct Message {
        address sender;
        address target;
        uint32 minGasLimit;
        bool relayed;
        bytes message;
    }

    event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit);
    event RelayedMessage(uint256 indexed messageNonce);
    event FailedRelayedMessage(uint256 indexed messageNonce);

    Message[] private _messages;
    address private _xSender = DEFAULT_SENDER;

    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external {
        _messages.push(Message(msg.sender, target, minGasLimit, false, message));
        emit SentMessage(target, msg.sender, message, _messages.length - 1, minGasLimit);
    }

    /// @notice Delivers (or re-delivers) a queued message on "L2". The first attempt normally uses
    ///         minGasLimit; a replay can bring more gas.
    function relayMessage(uint256 messageNonce, uint256 gasForCall) external returns (bool ok) {
        Message storage m = _messages[messageNonce];
        require(!m.relayed, "already relayed");
        _xSender = m.sender;
        (ok,) = m.target.call{gas: gasForCall}(m.message);
        _xSender = DEFAULT_SENDER;
        if (ok) {
            m.relayed = true;
            emit RelayedMessage(messageNonce);
        } else {
            emit FailedRelayedMessage(messageNonce);
        }
    }

    function xDomainMessageSender() external view returns (address) {
        require(_xSender != DEFAULT_SENDER, "xDomainMessageSender is not set");
        return _xSender;
    }

    function getMessage(uint256 messageNonce) external view returns (Message memory) {
        return _messages[messageNonce];
    }

    /// @notice Nonce the next message will get (OP's L1CrossDomainMessenger.messageNonce()).
    function messageNonce() external view returns (uint256) {
        return _messages.length;
    }

    function messageCount() external view returns (uint256) {
        return _messages.length;
    }
}
