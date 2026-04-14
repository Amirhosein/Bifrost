// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Generic proof verifier interface.
/// @dev In V1/V2 we support a "demo" verifier (issuer ECDSA signature).
/// In a production system this could be replaced by a SNARK verifier or BBS+ verifier.
interface IProofVerifier {
    /// @param to Recipient address (the minter)
    /// @param dtHash Canonical DT hash (duplicate guard)
    /// @param hiddenCommitment Commitment to hidden fields (e.g., meter/site/owner hashes)
    /// @param expiry Unix timestamp after which the proof is invalid
    /// @param proof Opaque proof bytes
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
    ) external view returns (bool);
}
