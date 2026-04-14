// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {BbsTypes} from "../interfaces/IBbsTypes.sol";
import {IBbsL2Verifier} from "../interfaces/IBbsL2Verifier.sol";

/// @notice Local/testing verifier for the Stylus-native path.
/// @dev In production this role is fulfilled by the Stylus Rust verifier contract.
contract MockBbsStylusNativeVerifier is IBbsL2Verifier, Ownable {
    bytes32 public constant DOMAIN = keccak256("BBS_STYLUS_NATIVE_MOCK_V1");

    mapping(bytes32 => bool) public approvedDigests;

    event DigestApprovalSet(bytes32 indexed digest, bool approved);

    constructor() Ownable(msg.sender) {}

    function digest(
        address to,
        BbsTypes.BbsDisclosedClaims calldata claims,
        bytes calldata bbsProof
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN,
                    to,
                    claims.reTypeCode,
                    claims.qtyKWh,
                    claims.readingTimestamp,
                    claims.credentialIdHash,
                    claims.expiry,
                    keccak256(bbsProof)
                )
            );
    }

    function setDigestApproval(bytes32 digest_, bool approved) external onlyOwner {
        approvedDigests[digest_] = approved;
        emit DigestApprovalSet(digest_, approved);
    }

    function verifyForMint(
        address to,
        BbsTypes.BbsDisclosedClaims calldata claims,
        bytes calldata bbsProof,
        bytes calldata /* zkSeal */
    ) external view override returns (bool) {
        if (bbsProof.length == 0) return false;
        return approvedDigests[digest(to, claims, bbsProof)];
    }
}

