// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title BLS12381
/// @notice Wrappers over the EIP-2537 BLS12-381 precompiles plus the point
///         serialization helpers needed by the BBS verifier.
/// @dev EIP-2537 encodes an Fp element as 64 bytes (16 zero bytes || 48-byte big-endian value),
///      so every coordinate is held as two words: `hi` (top 16 bytes of the value) and `lo`.
///      G1 points are 128 bytes (x || y); G2 points are 256 bytes (x.c0 || x.c1 || y.c0 || y.c1)
///      and are handled as raw byte strings. The all-zero encoding is the point at infinity.
///      G1MSM, G2MSM and the pairing precompile perform on-curve and subgroup checks, so points
///      that pass through them need no additional validation.
library BLS12381 {
    struct G1Point {
        uint256 xHi;
        uint256 xLo;
        uint256 yHi;
        uint256 yLo;
    }

    address internal constant MODEXP = address(0x05);
    address internal constant G1ADD = address(0x0b);
    address internal constant G1MSM = address(0x0c);
    address internal constant G2MSM = address(0x0e);
    address internal constant PAIRING_CHECK = address(0x0f);
    address internal constant MAP_FP_TO_G1 = address(0x10);

    /// @dev Order of the G1/G2 subgroups (the BBS scalar field).
    uint256 internal constant R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001;

    /// @dev Base field modulus p, split into EIP-2537 words.
    uint256 internal constant P_HI = 0x1a0111ea397fe69a4b1ba7b6434bacd7;
    uint256 internal constant P_LO = 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;

    uint256 internal constant G1_BYTES = 128;
    uint256 internal constant G2_BYTES = 256;
    uint256 internal constant MSM_PAIR_BYTES = 160;

    // ------------------------------------------------------------------
    // Precompile calls
    // ------------------------------------------------------------------

    /// @notice Multi-scalar multiplication in G1.
    /// @param input Concatenation of (128-byte point || 32-byte scalar) pairs.
    function g1Msm(bytes memory input) internal view returns (bool ok, G1Point memory out) {
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x0c, add(input, 32), mload(input), out, 128)
            if iszero(eq(returndatasize(), 128)) { ok := 0 }
        }
    }

    /// @notice G1 point addition (no subgroup check; used only on precompile outputs).
    function g1Add(G1Point memory a, G1Point memory b) internal view returns (bool ok, G1Point memory out) {
        bytes memory input = abi.encode(a.xHi, a.xLo, a.yHi, a.yLo, b.xHi, b.xLo, b.yHi, b.yLo);
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x0b, add(input, 32), 256, out, 128)
            if iszero(eq(returndatasize(), 128)) { ok := 0 }
        }
    }

    /// @notice Maps a field element to G1 (simplified SWU + isogeny + cofactor clearing).
    function mapFpToG1(uint256 hi, uint256 lo) internal view returns (bool ok, G1Point memory out) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, hi)
            mstore(add(ptr, 32), lo)
            ok := staticcall(gas(), 0x10, ptr, 64, out, 128)
            if iszero(eq(returndatasize(), 128)) { ok := 0 }
        }
    }

    /// @notice Checks prod_i e(g1_i, g2_i) == 1 for two pairs.
    function pairingCheck2(
        G1Point memory a1,
        bytes memory a2,
        G1Point memory b1,
        bytes memory b2
    ) internal view returns (bool) {
        if (a2.length != G2_BYTES || b2.length != G2_BYTES) return false;
        bytes memory input = abi.encodePacked(a1.xHi, a1.xLo, a1.yHi, a1.yLo, a2, b1.xHi, b1.xLo, b1.yHi, b1.yLo, b2);
        bool ok;
        uint256 result;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x0f, add(input, 32), mload(input), 0x00, 32)
            if iszero(eq(returndatasize(), 32)) { ok := 0 }
            result := mload(0x00)
        }
        return ok && result == 1;
    }

    /// @notice Returns true when `w` is a valid, non-identity point of the G2 subgroup.
    /// @dev G2MSM rejects points that are off-curve or outside the subgroup.
    function isValidG2(bytes memory w) internal view returns (bool) {
        if (w.length != G2_BYTES || isZero(w)) return false;
        bytes memory input = abi.encodePacked(w, uint256(1));
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x0e, add(input, 32), mload(input), 0x00, 0)
            if iszero(eq(returndatasize(), 256)) { ok := 0 }
        }
        return ok;
    }

    /// @notice Reduces a 64-byte big-endian integer modulo p using the MODEXP precompile.
    function reduceModP(bytes32 a, bytes32 b) internal view returns (uint256 hi, uint256 lo) {
        bytes memory input = abi.encodePacked(
            uint256(64), uint256(1), uint256(48), a, b, uint8(1), bytes16(uint128(P_HI)), P_LO
        );
        bool ok;
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(gas(), 0x05, add(input, 32), mload(input), out, 48)
            hi := shr(128, mload(out))
            lo := mload(add(out, 16))
        }
        require(ok, "BLS: modexp failed");
    }

    // ------------------------------------------------------------------
    // Encoding helpers
    // ------------------------------------------------------------------

    function isIdentity(G1Point memory p) internal pure returns (bool) {
        return (p.xHi | p.xLo | p.yHi | p.yLo) == 0;
    }

    function isZero(bytes memory data) internal pure returns (bool) {
        for (uint256 i = 0; i < data.length; ++i) {
            if (data[i] != 0) return false;
        }
        return true;
    }

    /// @dev True when y > p - y, i.e. y is the lexicographically largest root (ZCash sign bit).
    function _isLargest(uint256 yHi, uint256 yLo) private pure returns (bool) {
        if ((yHi | yLo) == 0) return false;
        uint256 nLo;
        uint256 nHi;
        unchecked {
            nLo = P_LO - yLo;
            nHi = P_HI - yHi - (P_LO < yLo ? 1 : 0);
        }
        return yHi > nHi || (yHi == nHi && yLo > nLo);
    }

    /// @notice ZCash-style compressed serialization (48 bytes) used by BBS `point_to_octets_E1`.
    function compressG1(G1Point memory p) internal pure returns (bytes memory) {
        if (isIdentity(p)) {
            return abi.encodePacked(bytes16(0xc0000000000000000000000000000000), bytes32(0));
        }
        uint128 top = uint128(p.xHi) | (uint128(0x80) << 120);
        if (_isLargest(p.yHi, p.yLo)) top |= uint128(0x20) << 120;
        return abi.encodePacked(top, p.xLo);
    }

    /// @notice ZCash-style compressed serialization (96 bytes) of an EIP-2537 G2 point.
    /// @dev Compressed form is x.c1 || x.c0; the sign bit follows y.c1, or y.c0 when y.c1 == 0.
    function compressG2(bytes memory w) internal pure returns (bytes memory) {
        require(w.length == G2_BYTES, "BLS: bad G2 length");
        (uint256 x0Hi, uint256 x0Lo, uint256 x1Hi, uint256 x1Lo, uint256 y0Hi, uint256 y0Lo, uint256 y1Hi, uint256 y1Lo) =
            abi.decode(w, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        if (isZero(w)) {
            return abi.encodePacked(bytes16(0xc0000000000000000000000000000000), bytes32(0), bytes16(0), bytes32(0));
        }
        bool largest = (y1Hi | y1Lo) != 0 ? _isLargest(y1Hi, y1Lo) : _isLargest(y0Hi, y0Lo);
        uint128 top = uint128(x1Hi) | (uint128(0x80) << 120);
        if (largest) top |= uint128(0x20) << 120;
        return abi.encodePacked(top, x1Lo, uint128(x0Hi), x0Lo);
    }

    /// @notice Writes a G1 point (128 bytes) followed by a 32-byte scalar at `offset` in `buf`.
    function writeMsmPair(bytes memory buf, uint256 offset, G1Point memory p, uint256 scalar) internal pure {
        assembly ("memory-safe") {
            let dst := add(add(buf, 32), offset)
            mstore(dst, mload(p))
            mstore(add(dst, 32), mload(add(p, 32)))
            mstore(add(dst, 64), mload(add(p, 64)))
            mstore(add(dst, 96), mload(add(p, 96)))
            mstore(add(dst, 128), scalar)
        }
    }

    /// @notice Copies a raw 128-byte G1 point from `src[srcOffset..]` into an MSM buffer.
    function writeMsmPairRaw(bytes memory buf, uint256 offset, bytes memory src, uint256 srcOffset, uint256 scalar)
        internal
        pure
    {
        assembly ("memory-safe") {
            let dst := add(add(buf, 32), offset)
            let s := add(add(src, 32), srcOffset)
            mstore(dst, mload(s))
            mstore(add(dst, 32), mload(add(s, 32)))
            mstore(add(dst, 64), mload(add(s, 64)))
            mstore(add(dst, 96), mload(add(s, 96)))
            mstore(add(dst, 128), scalar)
        }
    }
}
