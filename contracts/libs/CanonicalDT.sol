// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Canonical encoding + hashing for the Disclosure Tuple (DT).
/// @dev This is the *duplicate-guard* primitive. Keep it simple and deterministic.
library CanonicalDT {
    /// @dev Encodes DT using fixed-width integers and hashes with keccak256.
    function hashDT(
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh,
        uint128 policyNonce
    ) internal pure returns (bytes32) {
        // IMPORTANT: use abi.encode (not encodePacked) to preserve type boundaries.
        return keccak256(abi.encode(epochIndex, typeCode, qtyKWh, policyNonce));
    }
}
