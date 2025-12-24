// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";

/**
 * @title GTokenAnchor (L1)
 * @notice Records an L2 mint on L1 through a CrossDomainMessenger.
 *
 * The Hardhat tests in this repo simulate an Optimism-style flow:
 *  - L2 GToken calls messenger.sendMessage(..., recordMint(...))
 *  - messenger calls this contract on L1
 *  - this contract checks:
 *      (1) msg.sender == messenger
 *      (2) messenger.xDomainMessageSender() == authorized L2 GToken
 *  - then stores the mint info and emits an event.
 */
contract GTokenAnchor is AccessControl {
    // ----------------------
    // Errors (match tests)
    // ----------------------
    error NotFromMessenger();
    error NotFromAuthorizedL2Sender();
    error AlreadyAnchored(bytes32 dtHash);

    // ----------------------
    // Types / Storage
    // ----------------------
    struct AnchorInfo {
        address to;
        uint256 gtAmount;
        uint64 epochIndex;
        uint16 typeCode;
        uint256 qtyKWh;
        uint256 timestamp;
    }

    /// @notice L1 messenger (e.g., Optimism CrossDomainMessenger)
    ICrossDomainMessenger public messenger;

    /// @notice Authorized L2 sender (set via setConfig)
    address public l2GToken;

    /// @notice Explicit config flag: tests expect that even if a value is passed in the
    /// constructor, messages should be rejected until setConfig is called.
    bool public configured;

    mapping(bytes32 => AnchorInfo) private _anchors;

    // ----------------------
    // Events
    // ----------------------
    event MintAnchored(
        bytes32 indexed dtHash,
        address indexed to,
        uint256 gtAmount,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh
    );

    // ----------------------
    // Constructor / Config
    // ----------------------

    /// @param messenger_ Address of the L1 CrossDomainMessenger (mocked in tests)
    /// @param _unused    Kept for backward-compat with earlier drafts/tests; ignored.
    constructor(address messenger_, address _unused) {
        _unused; // silence unused var warning

        messenger = ICrossDomainMessenger(messenger_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // Explicitly start “unconfigured” (tests rely on this).
        configured = false;
        l2GToken = address(0);
    }

    /// @notice Set messenger + authorized L2 sender.
    /// @dev Single (non-overloaded) setter to avoid ethers v6 overload ambiguity in tests.
    function setConfig(address messenger_, address l2GToken_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        messenger = ICrossDomainMessenger(messenger_);
        l2GToken = l2GToken_;
        configured = true;
    }

    // ----------------------
    // Views
    // ----------------------

    function isAnchored(bytes32 dtHash) external view returns (bool) {
        return _anchors[dtHash].timestamp != 0;
    }

    function anchorInfo(bytes32 dtHash) external view returns (AnchorInfo memory) {
        return _anchors[dtHash];
    }

    // ----------------------
    // Recording
    // ----------------------

    /// @notice Record a mint. Must be called by messenger; x-domain sender must be authorized L2.
    function recordMint(
        bytes32 dtHash,
        address to,
        uint256 gtAmount,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh
    ) external {
        if (msg.sender != address(messenger)) revert NotFromMessenger();

        // Require that setConfig ran AND the x-domain sender matches.
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
