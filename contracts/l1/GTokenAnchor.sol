// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";

/**
 * @title GTokenAnchor (L1)
 * @notice Records an L2 mint on L1 through a CrossDomainMessenger.
 *
 * Matches the Hardhat tests:
 *  - constructor(messenger, <unused>)
 *  - ONLY setConfig(messenger, l2GToken) (no overloads -> no ethers ambiguity)
 *  - recordMint can ONLY be called by messenger
 *  - msg.sender != messenger => NotFromMessenger
 *  - wrong xDomain sender OR not configured => NotFromAuthorizedL2Sender
 *  - view helpers: isAnchored(dtHash), anchorInfo(dtHash)
 */
contract GTokenAnchor is AccessControl {
    // --- Custom errors expected by tests ---
    error NotFromMessenger();
    error NotFromAuthorizedL2Sender();
    error AlreadyAnchored(bytes32 dtHash);

    // --- Config ---
    ICrossDomainMessenger public messenger;
    address public l2GToken; // authorized L2 sender
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

    constructor(address messenger_, address /*unused*/) {
        messenger = ICrossDomainMessenger(messenger_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // Start unconfigured; tests expect NotFromAuthorizedL2Sender before setConfig()
        configured = false;
        l2GToken = address(0);
    }

    /**
     * @notice Set messenger + authorized L2 sender (ONLY version; avoids ethers overload ambiguity)
     */
    function setConfig(address messenger_, address l2GToken_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        messenger = ICrossDomainMessenger(messenger_);
        l2GToken = l2GToken_;
        configured = true;
    }

    function isAnchored(bytes32 dtHash) external view returns (bool) {
        return _anchors[dtHash].timestamp != 0;
    }

    function anchorInfo(bytes32 dtHash) external view returns (AnchorInfo memory) {
        return _anchors[dtHash];
    }

    /**
     * @notice Called by the L1 messenger as the final step of an L2 mint.
     */
    function recordMint(
        bytes32 dtHash,
        address to,
        uint256 gtAmount,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh
    ) external {
        if (msg.sender != address(messenger)) revert NotFromMessenger();

        // Must be configured and must come from authorized L2 sender.
        if (!configured || messenger.xDomainMessageSender() != l2GToken) {
            revert NotFromAuthorizedL2Sender();
        }

        if (_anchors[dtHash].timestamp != 0) revert AlreadyAnchored(dtHash);

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
