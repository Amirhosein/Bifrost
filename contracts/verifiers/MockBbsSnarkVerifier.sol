// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {BbsTypes} from "../interfaces/IBbsTypes.sol";
import {IBbsL2Verifier} from "../interfaces/IBbsL2Verifier.sol";

/// @notice Local/testing verifier for the SNARK-wrapped path.
/// @dev Treats `zkSeal` as an ECDSA signature by `issuerSigner` on the claim digest.
contract MockBbsSnarkVerifier is IBbsL2Verifier, Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant DOMAIN = keccak256("BBS_SNARK_L2_MOCK_V1");

    address public issuerSigner;

    constructor(address issuerSigner_) Ownable(msg.sender) {
        require(issuerSigner_ != address(0), "issuer=0");
        issuerSigner = issuerSigner_;
    }

    function setIssuerSigner(address issuerSigner_) external onlyOwner {
        require(issuerSigner_ != address(0), "issuer=0");
        issuerSigner = issuerSigner_;
    }

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

    function verifyForMint(
        address to,
        BbsTypes.BbsDisclosedClaims calldata claims,
        bytes calldata bbsProof,
        bytes calldata zkSeal
    ) external view override returns (bool) {
        if (bbsProof.length == 0 || zkSeal.length == 0) return false;
        bytes32 ethSigned = digest(to, claims, bbsProof).toEthSignedMessageHash();
        return ethSigned.recover(zkSeal) == issuerSigner;
    }
}

