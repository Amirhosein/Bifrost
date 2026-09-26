// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BLS12381} from "../bbs/BLS12381.sol";

/// @notice On-chain verifier for BBS proofs (draft-irtf-cfrg-bbs-signatures-06, BLS12-381-SHA-256).
interface IBbsBls12381Verifier {
    /// @notice A BBS proof with its G1 points in EIP-2537 (uncompressed) form.
    /// @dev `commitments` are the m^_j values for the undisclosed messages, in ascending index order.
    struct Proof {
        BLS12381.G1Point aBar;
        BLS12381.G1Point bBar;
        BLS12381.G1Point d;
        uint256 eHat;
        uint256 r1Hat;
        uint256 r3Hat;
        uint256[] commitments;
        uint256 challenge;
    }

    /// @notice Number of signed messages (L) this verifier accepts.
    function messageCount() external view returns (uint256);

    /// @notice Issuer public key in compressed (96-byte) form.
    function issuerPublicKey() external view returns (bytes memory);

    /// @notice draft-06 calculate_domain for this issuer key, L and the given signature header.
    function domainFor(bytes calldata header) external view returns (uint256);

    /// @notice draft-06 messages_to_scalars for one message.
    function messageToScalar(bytes calldata message) external pure returns (uint256);

    /// @notice draft-06 CoreProofVerify with a precomputed domain.
    /// @param domain Output of `domainFor(header)`; binds the signature header.
    /// @param ph Presentation header the proof was generated with.
    /// @param disclosedIndexes Strictly increasing message indexes that are revealed.
    /// @param disclosedScalars Message scalars for `disclosedIndexes`.
    function verifyProof(
        uint256 domain,
        bytes calldata ph,
        uint256[] calldata disclosedIndexes,
        uint256[] calldata disclosedScalars,
        Proof calldata proof
    ) external view returns (bool);
}
