// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";
import {IGTokenAnchor} from "../interfaces/IGTokenAnchor.sol";
import {IArbSys} from "../arbitrum/IArbSys.sol";

/**
 * @title GTokenL2Arb (Arbitrum)
 * @notice L2 ERC-20 minting contract for Arbitrum chains.
 *
 * Compared to GTokenL2 (OP Stack messenger), this variant uses the ArbSys
 * precompile (address(100)) to create an L2->L1 message calling the L1 anchor.
 *
 * NOTE: On Arbitrum, L2->L1 messages are executed on L1 after finality by redeeming
 * the message from the Outbox. The anchoring on L1 is therefore asynchronous.
 */
contract GTokenL2Arb is ERC20, AccessControl {
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");

    // --- errors ---
    error DuplicateDT();
    error Expired();
    error BadProof();

    // Arbitrum Nitro ArbSys precompile address
    address private constant ARBSYS = address(0x0000000000000000000000000000000000000064);

    // --- config ---
    IProofVerifier public verifier;
    IGTokenAnchor public l1Anchor;

    // --- duplicate guard ---
    mapping(bytes32 => bool) private _usedDT;

    // --- events ---
    event Minted(
        address indexed to,
        bytes32 indexed dtHash,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint256 gtAmount
    );

    /// @dev Emitted with the Arbitrum L2->L1 message number returned by ArbSys.
    event L2ToL1Message(uint256 indexed msgNum, address indexed l1Target);

    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        address l1Anchor_,
        address ra_
    ) ERC20(name_, symbol_) {
        verifier = IProofVerifier(verifier_);
        l1Anchor = IGTokenAnchor(l1Anchor_);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRY_ADMIN_ROLE, ra_);
    }

    function isDTUsed(bytes32 dtHash) external view returns (bool) {
        return _usedDT[dtHash];
    }

    function _dtHash(
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint128 policyNonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint64(epochIndex), uint16(typeCode), uint256(qtyKWh), uint128(policyNonce)));
    }

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

        // All state updates happen before any external interaction.
        _usedDT[dtHash] = true;

        uint256 gtAmount = qtyKWh; // alpha=1 in the MVP
        _mint(msg.sender, gtAmount);

        // Create the L2->L1 message (executed later via the Outbox).
        bytes memory payload = abi.encodeCall(
            IGTokenAnchor.recordMint,
            (dtHash, msg.sender, gtAmount, epochIndex, typeCode, qtyKWh)
        );

        uint256 msgNum = IArbSys(ARBSYS).sendTxToL1(address(l1Anchor), payload);
        emit L2ToL1Message(msgNum, address(l1Anchor));

        emit Minted(msg.sender, dtHash, epochIndex, typeCode, qtyKWh, gtAmount);
    }
}
