// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// @notice Demo verifier that treats `proof` as an ECDSA signature from the issuer.
/// @dev The issuer signs a digest over:
///  (domain, to, dtHash, hiddenCommitment, epochIndex, typeCode, qtyKWh, policyNonce, expiry).
///
/// This *approximates* the Verifiable Credential + selective disclosure pipeline:
/// - hidden fields are inside `hiddenCommitment`
/// - disclosed fields are (epochIndex, typeCode, qtyKWh, policyNonce)
/// - the issuer's signature stands in for (BBS+ signature / SNARK)
contract DemoIssuerVerifier is IProofVerifier {
    // OZ v5 moved helpers like `toEthSignedMessageHash` into MessageHashUtils.
    using MessageHashUtils for bytes32;
    using ECDSA for bytes32;

    bytes32 public constant DOMAIN = keccak256("GREEN_CRED_VC_DEMO_V1");

    address public issuerSigner;

    constructor(address issuerSigner_) {
        require(issuerSigner_ != address(0), "issuer=0");
        issuerSigner = issuerSigner_;
    }

    function setIssuerSigner(address issuerSigner_) external {
        // In a real deployment, this must be AccessControlled + timelocked.
        require(issuerSigner_ != address(0), "issuer=0");
        issuerSigner = issuerSigner_;
    }

    function digest(
        address to,
        bytes32 dtHash,
        bytes32 hiddenCommitment,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint128 policyNonce,
        uint64 expiry
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN,
                to,
                dtHash,
                hiddenCommitment,
                epochIndex,
                typeCode,
                qtyKWh,
                policyNonce,
                expiry
            )
        );
    }

    /**
     * @notice Compatibility helper expected by the Hardhat V2 tests.
     * @dev The test suite calls `verifier.computeDigest(...)` when preparing
     *      the issuer signature. We keep `digest(...)` as the canonical helper
     *      and expose this alias to avoid breaking existing code.
     */
    function computeDigest(
        address to,
        bytes32 dtHash,
        bytes32 hiddenCommitment,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint128 policyNonce,
        uint64 expiry
    ) external pure returns (bytes32) {
        return digest(to, dtHash, hiddenCommitment, epochIndex, typeCode, qtyKWh, policyNonce, expiry);
    }

    function verify(
        address to,
        bytes32 dtHash,
        bytes32 hiddenCommitment,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint128 policyNonce,
        uint64 expiry,
        bytes calldata proof
    ) external view override returns (bool) {
        if (block.timestamp > expiry) return false;
        bytes32 d = digest(to, dtHash, hiddenCommitment, epochIndex, typeCode, qtyKWh, policyNonce, expiry);
        // Ethereum signed message prefix (EIP-191) for wallet signatures.
        bytes32 ethSigned = d.toEthSignedMessageHash();
        address recovered = ethSigned.recover(proof);
        return recovered == issuerSigner;
    }
}
