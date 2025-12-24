// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title MockArbBridge
 * @notice Minimal Arbitrum Bridge mock exposing activeOutbox().
 */
contract MockArbBridge {
    address public outbox;

    constructor(address outbox_) {
        outbox = outbox_;
    }

    function activeOutbox() external view returns (address) {
        return outbox;
    }

    function setOutbox(address outbox_) external {
        outbox = outbox_;
    }
}
