// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";
import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";
import {IGTokenAnchor} from "../interfaces/IGTokenAnchor.sol";

/**
 * @title GTokenL2
 * @notice L2 “mint” contract that:
 *  - Verifies an off-chain-issued credential/proof via an on-chain verifier contract
 *  - Enforces a local duplicate guard on DT hashes
 *  - Mints ERC-20 tokens on L2
 *  - Anchors the DT hash (and minimal mint metadata) to L1 via a CrossDomainMessenger
 *
 * This contract is intentionally minimal and is designed to pass the project’s Hardhat
 * tests (see `test/v2_l2_anchor.test.ts`).
 */
contract GTokenL2 is ERC20, AccessControl {
    // ----------------------------
    // Roles
    // ----------------------------
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");

    // ----------------------------
    // Errors
    // ----------------------------
    error DuplicateDT();
    error Expired();
    error InvalidProof();

    // ----------------------------
    // Events
    // ----------------------------
    event Minted(
        address indexed to,
        bytes32 indexed dtHash,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint256 gtAmount
    );

    // ----------------------------
    // Immutable configuration
    // ----------------------------
    IProofVerifier public immutable verifier;
    ICrossDomainMessenger public immutable messenger;
    IGTokenAnchor public immutable l1Anchor;

    // ----------------------------
    // Duplicate guard
    // ----------------------------
    mapping(bytes32 => bool) private _usedDT;

    // ----------------------------
    // Construction
    // ----------------------------
    /**
     * @param name_   ERC-20 name
     * @param symbol_ ERC-20 symbol
     * @param verifier_   On-chain verifier contract (demo verifier in V2)
     * @param messenger_  Cross-domain messenger (mocked in tests)
     * @param l1Anchor_   L1 anchor contract address
     * @param registryAdmin_ Address granted REGISTRY_ADMIN_ROLE (for future admin ops)
     */
    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        address messenger_,
        address l1Anchor_,
        address registryAdmin_
    ) ERC20(name_, symbol_) {
        require(verifier_ != address(0), "verifier=0");
        require(messenger_ != address(0), "messenger=0");
        require(l1Anchor_ != address(0), "l1Anchor=0");

        verifier = IProofVerifier(verifier_);
        messenger = ICrossDomainMessenger(messenger_);
        l1Anchor = IGTokenAnchor(l1Anchor_);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (registryAdmin_ != address(0)) {
            _grantRole(REGISTRY_ADMIN_ROLE, registryAdmin_);
        }
    }

    // ----------------------------
    // Public views
    // ----------------------------
    function isDTUsed(bytes32 dtHash) external view returns (bool) {
        return _usedDT[dtHash];
    }

    // ----------------------------
    // Mint
    // ----------------------------
    /**
     * @notice Verify a credential proof and mint green tokens on L2.
     *
     * The “disclosure tuple” is:
     *   DT = (epochIndex, typeCode, qtyKWh, policyNonce)
     * And the DT hash is:
     *   dtHash = keccak256(abi.encodePacked(uint64, uint16, uint256, uint128))
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
        // Expiry check (simple, test-friendly)
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
        if (!ok) revert InvalidProof();

        // Mark used + mint. If the cross-domain anchor fails, the tx reverts and these
        // state updates roll back.
        _usedDT[dtHash] = true;

        // For this capstone V2, we mint 1:1 with kWh.
        uint256 gtAmount = qtyKWh;
        _mint(msg.sender, gtAmount);

        // Anchor on L1 through the messenger.
        // The mock messenger calls the target directly on the same Hardhat chain.
        bytes memory payload = abi.encodeCall(
            IGTokenAnchor.recordMint,
            (dtHash, msg.sender, gtAmount, epochIndex, typeCode, qtyKWh)
        );
        messenger.sendMessage(address(l1Anchor), payload, 1_000_000);

        emit Minted(msg.sender, dtHash, epochIndex, typeCode, qtyKWh, gtAmount);
    }

    // ----------------------------
    // Internal helpers
    // ----------------------------
    function _dtHash(
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint128 policyNonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(epochIndex, typeCode, qtyKWh, policyNonce));
    }
}
