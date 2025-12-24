// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IBridge} from "../arbitrum/IBridge.sol";
import {IOutbox} from "../arbitrum/IOutbox.sol";

/**
 * @title GTokenAnchorArb (L1, Arbitrum)
 * @notice Records an L2 mint on L1 when the call is executed via Arbitrum's active Outbox.
 *
 * Auth rules (aligned to the Hardhat tests in this repo):
 *  - msg.sender MUST equal bridge.activeOutbox()               -> NotFromBridge()
 *  - outbox.l2ToL1Sender() MUST equal configured l2GToken      -> NotFromAuthorizedL2Sender()
 *  - dtHash can only be anchored once                          -> AlreadyAnchored()
 */
contract GTokenAnchorArb is AccessControl {
    // --- Custom errors (expected by tests) ---
    error NotFromBridge();
    error NotFromAuthorizedL2Sender();
    error AlreadyAnchored();

    // --- Config ---
    /// @notice Arbitrum L1 Bridge contract (used to query activeOutbox).
    address public immutable bridge;

    /// @notice Authorized L2 sender contract (the GTokenL2 contract deployed on Arbitrum).
    address public l2GToken;

    /// @notice True once l2GToken has been configured.
    bool public configured;

    // --- Storage ---
    struct AnchorInfo {
        address to;
        uint256 gtAmount;
        uint64 epochIndex;
        uint16 typeCode;
        uint256 qtyKWh;
        uint256 timestamp;
    }

    mapping(bytes32 => AnchorInfo) private _anchors;

    // --- Events ---
    event MintAnchored(
        bytes32 indexed dtHash,
        address indexed to,
        uint256 gtAmount,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh
    );

    constructor(address bridge_, address l2GToken_) {
        bridge = bridge_;
        l2GToken = l2GToken_;
        configured = (l2GToken_ != address(0));

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Configure/rotate the authorized L2 sender.
    function setConfig(address l2GToken_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        l2GToken = l2GToken_;
        configured = true;
    }

    function isAnchored(bytes32 dtHash) external view returns (bool) {
        return _anchors[dtHash].timestamp != 0;
    }

    function anchorInfo(bytes32 dtHash) external view returns (AnchorInfo memory) {
        return _anchors[dtHash];
    }

    /// @notice Called on L1 when an Arbitrum L2->L1 message is executed.
    function recordMint(
        bytes32 dtHash,
        address to,
        uint256 gtAmount,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh
    ) external {
        address outbox = IBridge(bridge).activeOutbox();
        if (msg.sender != outbox) revert NotFromBridge();

        // Must be configured and must come from authorized L2 sender.
        if (!configured || IOutbox(outbox).l2ToL1Sender() != l2GToken) {
            revert NotFromAuthorizedL2Sender();
        }

        if (_anchors[dtHash].timestamp != 0) revert AlreadyAnchored();

        _anchors[dtHash] = AnchorInfo({
            to: to,
            gtAmount: gtAmount,
            epochIndex: epochIndex,
            typeCode: typeCode,
            qtyKWh: qtyKWh,
            timestamp: block.timestamp
        });

        emit MintAnchored(dtHash, to, gtAmount, epochIndex, typeCode, qtyKWh);
    }
}
