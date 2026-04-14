// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IRiscZeroGroth16Verifier {
    /// @notice Verifies a Groth16 proof for a given image and journal digest.
    /// @dev Depending on implementation, this function may revert on failure and
    ///      return either nothing or a boolean on success.
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view returns (bool);
}

