// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {BbsTypes} from "../interfaces/IBbsTypes.sol";
import {IBbsL2Verifier} from "../interfaces/IBbsL2Verifier.sol";
import {IRiscZeroGroth16Verifier} from "../interfaces/IRiscZeroGroth16Verifier.sol";

/// @notice Adapter that validates a zk receipt proving BBS+ selective disclosure checks.
/// @dev This contract binds the receipt to the canonical claim encoding plus bbsProof hash.
contract RiscZeroBbsL2Verifier is IBbsL2Verifier, Ownable {
    address public receiptVerifier;
    bytes32 public imageId;

    event ReceiptVerifierUpdated(address indexed receiptVerifier);
    event ImageIdUpdated(bytes32 indexed imageId);

    constructor(address receiptVerifier_, bytes32 imageId_) Ownable(msg.sender) {
        receiptVerifier = receiptVerifier_;
        imageId = imageId_;
    }

    function setReceiptVerifier(address receiptVerifier_) external onlyOwner {
        receiptVerifier = receiptVerifier_;
        emit ReceiptVerifierUpdated(receiptVerifier_);
    }

    function setImageId(bytes32 imageId_) external onlyOwner {
        imageId = imageId_;
        emit ImageIdUpdated(imageId_);
    }

    function journalDigest(
        address to,
        BbsTypes.BbsDisclosedClaims calldata claims,
        bytes calldata bbsProof
    ) public pure returns (bytes32) {
        return
            sha256(
                abi.encode(
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
        if (receiptVerifier == address(0) || imageId == bytes32(0)) {
            return false;
        }

        bytes32 digest = journalDigest(to, claims, bbsProof);

        (bool ok, bytes memory ret) = receiptVerifier.staticcall(
            abi.encodeWithSelector(IRiscZeroGroth16Verifier.verify.selector, zkSeal, imageId, digest)
        );
        if (!ok) return false;

        // Support verifier contracts that either return bool or no return data.
        if (ret.length == 0) return true;
        if (ret.length >= 32) return abi.decode(ret, (bool));
        return false;
    }
}

