// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BLS12381} from "./BLS12381.sol";

/// @title BbsHash
/// @notice Hashing primitives of the BBS BLS12-381-SHA-256 ciphersuite
///         (draft-irtf-cfrg-bbs-signatures-06, RFC 9380 expand_message_xmd).
library BbsHash {
    /// @dev api_id = ciphersuite_id || "H2G_HM2S_"
    bytes internal constant API_ID = "BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_H2G_HM2S_";
    /// @dev api_id || "H2S_"
    bytes internal constant H2S_DST = "BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_H2G_HM2S_H2S_";
    /// @dev api_id || "MAP_MSG_TO_SCALAR_AS_HASH_"
    bytes internal constant MAP_DST = "BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_H2G_HM2S_MAP_MSG_TO_SCALAR_AS_HASH_";
    /// @dev api_id || "SIG_GENERATOR_SEED_"
    bytes internal constant SEED_DST = "BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_H2G_HM2S_SIG_GENERATOR_SEED_";
    /// @dev api_id || "SIG_GENERATOR_DST_"
    bytes internal constant GENERATOR_DST = "BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_H2G_HM2S_SIG_GENERATOR_DST_";
    /// @dev api_id || "MESSAGE_GENERATOR_SEED"
    bytes internal constant GENERATOR_SEED = "BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_H2G_HM2S_MESSAGE_GENERATOR_SEED";

    uint256 internal constant EXPAND_LEN = 48;

    /// @notice RFC 9380 expand_message_xmd with SHA-256.
    function expandMessageXmd(bytes memory message, bytes memory dst, uint256 lenInBytes)
        internal
        pure
        returns (bytes memory out)
    {
        uint256 ell = (lenInBytes + 31) / 32;
        require(ell <= 255 && dst.length <= 255, "BBS: xmd params");
        bytes memory dstPrime = abi.encodePacked(dst, uint8(dst.length));

        bytes32 b0 = sha256(abi.encodePacked(bytes32(0), bytes32(0), message, uint16(lenInBytes), uint8(0), dstPrime));
        bytes32 bi = sha256(abi.encodePacked(b0, uint8(1), dstPrime));

        out = new bytes(ell * 32);
        assembly ("memory-safe") {
            mstore(add(out, 32), bi)
        }
        for (uint256 i = 2; i <= ell; ++i) {
            bi = sha256(abi.encodePacked(b0 ^ bi, uint8(i), dstPrime));
            assembly ("memory-safe") {
                mstore(add(out, mul(i, 32)), bi)
            }
        }
        assembly ("memory-safe") {
            mstore(out, lenInBytes)
        }
    }

    /// @notice hash_to_scalar: OS2IP(expand_message_xmd(msg, dst, 48)) mod r.
    /// @dev Specialised for expand_len = 48 (ell = 2): uniform = b1 || b2[0..16].
    function hashToScalar(bytes memory message, bytes memory dst) internal pure returns (uint256) {
        bytes memory dstPrime = abi.encodePacked(dst, uint8(dst.length));
        bytes32 b0 = sha256(abi.encodePacked(bytes32(0), bytes32(0), message, uint16(EXPAND_LEN), uint8(0), dstPrime));
        bytes32 b1 = sha256(abi.encodePacked(b0, uint8(1), dstPrime));
        bytes32 b2 = sha256(abi.encodePacked(b0 ^ b1, uint8(2), dstPrime));
        return addmod(mulmod(uint256(b1), 1 << 128, BLS12381.R), uint256(b2) >> 128, BLS12381.R);
    }

    /// @notice messages_to_scalars for a single message.
    function messageToScalar(bytes memory message) internal pure returns (uint256) {
        return hashToScalar(message, MAP_DST);
    }

    /// @notice RFC 9380 hash_to_curve for BLS12381G1_XMD:SHA-256_SSWU_RO_.
    /// @dev hash_to_field yields u0, u1; clear_cofactor is linear, so
    ///      clear_cofactor(map(u0) + map(u1)) = MAP_FP_TO_G1(u0) + MAP_FP_TO_G1(u1).
    function hashToCurveG1(bytes memory message, bytes memory dst) internal view returns (BLS12381.G1Point memory) {
        bytes memory uniform = expandMessageXmd(message, dst, 128);
        bytes32 a0;
        bytes32 a1;
        bytes32 b0;
        bytes32 b1;
        assembly ("memory-safe") {
            a0 := mload(add(uniform, 32))
            a1 := mload(add(uniform, 64))
            b0 := mload(add(uniform, 96))
            b1 := mload(add(uniform, 128))
        }
        (uint256 u0Hi, uint256 u0Lo) = BLS12381.reduceModP(a0, a1);
        (uint256 u1Hi, uint256 u1Lo) = BLS12381.reduceModP(b0, b1);

        (bool ok0, BLS12381.G1Point memory q0) = BLS12381.mapFpToG1(u0Hi, u0Lo);
        (bool ok1, BLS12381.G1Point memory q1) = BLS12381.mapFpToG1(u1Hi, u1Lo);
        require(ok0 && ok1, "BBS: map_to_curve failed");
        (bool okAdd, BLS12381.G1Point memory sum) = BLS12381.g1Add(q0, q1);
        require(okAdd, "BBS: g1 add failed");
        return sum;
    }

    /// @notice create_generators(count, api_id) from draft-06 §4.1.1.
    function createGenerators(uint256 count) internal view returns (BLS12381.G1Point[] memory generators) {
        generators = new BLS12381.G1Point[](count);
        bytes memory v = expandMessageXmd(GENERATOR_SEED, SEED_DST, EXPAND_LEN);
        for (uint256 i = 1; i <= count; ++i) {
            v = expandMessageXmd(abi.encodePacked(v, uint64(i)), SEED_DST, EXPAND_LEN);
            generators[i - 1] = hashToCurveG1(v, GENERATOR_DST);
        }
    }
}
