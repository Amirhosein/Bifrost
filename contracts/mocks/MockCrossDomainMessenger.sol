// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";

/// @notice Minimal messenger for local tests.
/// @dev Simulates OP-style cross-domain messenger by:
///  - capturing `msg.sender` as the xDomain sender
///  - calling the target contract with the provided calldata
contract MockCrossDomainMessenger is ICrossDomainMessenger {
    address private _xDomainSender;

    event MessageSent(address indexed from, address indexed target, bytes message, uint32 gasLimit);

    function sendMessage(address target, bytes calldata message, uint32 gasLimit) external {
        _xDomainSender = msg.sender;
        emit MessageSent(msg.sender, target, message, gasLimit);

        // We ignore gasLimit in the mock.
        (bool ok, bytes memory ret) = target.call(message);
        if (!ok) {
            // bubble up revert reason if possible
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        // Clear sender after delivery to reduce accidental re-use.
        _xDomainSender = address(0);
    }

    function xDomainMessageSender() external view returns (address) {
        return _xDomainSender;
    }
}
