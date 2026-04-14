// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BbsTypes} from "./IBbsTypes.sol";

interface IBbsL2Verifier {
    /// @notice Verifies that a requester is authorized to mint from a BBS+ presentation.
    /// @param to Recipient address that must be bound to the proof.
    /// @param claims Disclosed claims used by mint policy.
    /// @param bbsProof Serialized BBS+ proof/presentation bytes.
    /// @param zkSeal Optional zk receipt/seal bytes (used by SNARK-wrapped path).
    function verifyForMint(
        address to,
        BbsTypes.BbsDisclosedClaims calldata claims,
        bytes calldata bbsProof,
        bytes calldata zkSeal
    ) external view returns (bool);
}

