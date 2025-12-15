// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";
import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";
import {IGTokenAnchor} from "../interfaces/IGTokenAnchor.sol";

/**
 * @title GTokenL2 (L2)
 * @notice L2 ERC-20 minting contract that:
 *  - verifies a (demo) signature-based proof via IProofVerifier
 *  - prevents duplicates via dtHash guard
 *  - mints ERC-20 tokens on L2
 *  - anchors the mint on L1 by sending a message through the CrossDomainMessenger
 *
 * This contract is intentionally aligned to the repository Hardhat tests:
 *  - constructor(name, symbol, verifier, messenger, l1Anchor, ra)
 *  - mintWithProof(epoch,type,qty,policyNonce,hiddenCommitment,expiry,proofBytes)
 *  - emits Minted(to, dtHash, epochIndex, typeCode, qtyKWh, gtAmount)
 *  - view helper isDTUsed(dtHash)
 *  - reverts DuplicateDT on reuse
 */
contract GTokenL2 is ERC20, AccessControl {
    // --- roles ---
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");

    // --- errors ---
    error DuplicateDT();
    error Expired();
    error BadProof();

    // --- immutable-ish config ---
    IProofVerifier public verifier;
    ICrossDomainMessenger public messenger;
    IGTokenAnchor public l1Anchor;

    // --- duplicate guard ---
    mapping(bytes32 => bool) private _usedDT;

    // --- events (expected by tests) ---
    event Minted(
        address indexed to,
        bytes32 indexed dtHash,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint256 gtAmount
    );

    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        address messenger_,
        address l1Anchor_,
        address ra_
    ) ERC20(name_, symbol_) {
        verifier = IProofVerifier(verifier_);
        messenger = ICrossDomainMessenger(messenger_);
        l1Anchor = IGTokenAnchor(l1Anchor_);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRY_ADMIN_ROLE, ra_);
    }

    function isDTUsed(bytes32 dtHash) external view returns (bool) {
        return _usedDT[dtHash];
    }

    function _dtHash(uint64 epochIndex, uint16 typeCode, uint256 qtyKWh, uint128 policyNonce) internal pure returns (bytes32) {
        // Must match tests: solidityPackedKeccak256(["uint64","uint16","uint256","uint128"], [...])
        return keccak256(abi.encodePacked(uint64(epochIndex), uint16(typeCode), uint256(qtyKWh), uint128(policyNonce)));
    }

    /**
     * @notice Mint on L2 + anchor on L1 (through messenger).
     * @dev The "proof" is demo: a signature over a digest computed by DemoIssuerVerifier.
     */
    function mintWithProof(
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint128 policyNonce,
        bytes32 hiddenCommitment,
        uint64 expiry,
        bytes calldata proof
    ) external {
        if (expiry < block.timestamp) revert Expired();

        bytes32 dtHash = _dtHash(epochIndex, typeCode, qtyKWh, policyNonce);
        if (_usedDT[dtHash]) revert DuplicateDT();

        bool ok = verifier.verify(
            msg.sender,
            dtHash,
            hiddenCommitment,
            epochIndex,
            typeCode,
            qtyKWh,
            policyNonce,
            expiry,
            proof
        );
        if (!ok) revert BadProof();

        // Mark used + mint (all same-tx; any later revert rolls back this state)
        _usedDT[dtHash] = true;

        uint256 gtAmount = qtyKWh; // factor=1 for MVP (matches tests)
        _mint(msg.sender, gtAmount);

        // Anchor on L1 via messenger -> GTokenAnchor.recordMint(...)
        bytes memory payload = abi.encodeCall(
            IGTokenAnchor.recordMint,
            (dtHash, msg.sender, gtAmount, epochIndex, typeCode, qtyKWh)
        );

        // 1_000_000 gas matches the test harness style
        messenger.sendMessage(address(l1Anchor), payload, 1_000_000);

        emit Minted(msg.sender, dtHash, epochIndex, typeCode, qtyKWh, gtAmount);
    }
}
