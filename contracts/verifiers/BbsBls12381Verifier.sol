// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BLS12381} from "../bbs/BLS12381.sol";
import {BbsHash} from "../bbs/BbsHash.sol";
import {DataBlob} from "../bbs/DataBlob.sol";
import {IBbsBls12381Verifier} from "../interfaces/IBbsBls12381Verifier.sol";

/// @title BbsBls12381Verifier
/// @notice Real on-chain BBS proof verification (draft-irtf-cfrg-bbs-signatures-06,
///         ciphersuite BLS12-381-SHA-256) using the EIP-2537 precompiles.
/// @dev One verifier instance is bound to one issuer (Registry Administrator) key and one
///      message count L. The message generators are derived on-chain in the constructor
///      (create_generators via hash_to_curve), so only the issuer key is a deployment input.
///
///      Verification (CoreProofVerify):
///        T1 = Bbar*c + Abar*e^ + D*r1^
///        T2 = (P1 + Q1*domain + sum H_i*msg_i)*c + D*r3^ + sum H_j*m^_j
///        c ?= hash_to_scalar(R || (i, msg_i)... || Abar || Bbar || D || T1 || T2 || domain || len(ph) || ph)
///        e(Abar, W) * e(Bbar, -BP2) ?= 1
contract BbsBls12381Verifier is IBbsBls12381Verifier {
    // P1 of the BLS12-381-SHA-256 ciphersuite (EIP-2537 words).
    uint256 private constant P1_X_HI = 0x08ce256102840821a3e94ea9025e4662;
    uint256 private constant P1_X_LO = 0xb205762f9776b3a766c872b948f1fd225e7c59698588e70d11406d161b4e28c9;
    uint256 private constant P1_Y_HI = 0x10a711acd16ff43e30b3373b7b6a9233;
    uint256 private constant P1_Y_LO = 0x945ec74adf00b0481fbcd5e3b1e342e7a105b4966195e6a678857a0e0493d5b1;

    // -BP2: negated G2 base point (EIP-2537 words, x.c0 || x.c1 || y.c0 || y.c1).
    uint256 private constant NEG_BP2_X0_HI = 0x024aa2b2f08f0a91260805272dc51051;
    uint256 private constant NEG_BP2_X0_LO = 0xc6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8;
    uint256 private constant NEG_BP2_X1_HI = 0x13e02b6052719f607dacd3a088274f65;
    uint256 private constant NEG_BP2_X1_LO = 0x596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e;
    uint256 private constant NEG_BP2_Y0_HI = 0x0d1b3cc2c7027888be51d9ef691d77bc;
    uint256 private constant NEG_BP2_Y0_LO = 0xb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa;
    uint256 private constant NEG_BP2_Y1_HI = 0x13fa4d4a0ad8b1ce186ed5061789213d;
    uint256 private constant NEG_BP2_Y1_LO = 0x993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed;

    uint256 private constant MAX_MESSAGES = 64;

    error InvalidMessageCount();
    error InvalidPublicKey();

    /// @inheritdoc IBbsBls12381Verifier
    uint256 public immutable messageCount;

    /// @dev DataBlob layout: domainPrefix || Q1 || H_1..H_L (EIP-2537 G1) || W (EIP-2537 G2)
    ///      domainPrefix = PK || I2OSP(L, 8) || Q1 || H_1..H_L (compressed) || api_id
    address private immutable _params;
    uint256 private immutable _prefixLength;

    /// @param messageCount_ L, the number of signed messages per credential.
    /// @param issuerPublicKey_ Issuer key W as an EIP-2537 G2 point (256 bytes).
    constructor(uint256 messageCount_, bytes memory issuerPublicKey_) {
        if (messageCount_ == 0 || messageCount_ > MAX_MESSAGES) revert InvalidMessageCount();
        if (!BLS12381.isValidG2(issuerPublicKey_)) revert InvalidPublicKey();

        BLS12381.G1Point[] memory gens = BbsHash.createGenerators(messageCount_ + 1);

        bytes memory compressed = abi.encodePacked(BLS12381.compressG2(issuerPublicKey_), uint64(messageCount_));
        bytes memory raw = new bytes(gens.length * BLS12381.G1_BYTES);
        for (uint256 i = 0; i < gens.length; ++i) {
            compressed = abi.encodePacked(compressed, BLS12381.compressG1(gens[i]));
            BLS12381.G1Point memory g = gens[i];
            assembly ("memory-safe") {
                let dst := add(add(raw, 32), mul(i, 128))
                mstore(dst, mload(g))
                mstore(add(dst, 32), mload(add(g, 32)))
                mstore(add(dst, 64), mload(add(g, 64)))
                mstore(add(dst, 96), mload(add(g, 96)))
            }
        }
        bytes memory prefix = abi.encodePacked(compressed, BbsHash.API_ID);

        messageCount = messageCount_;
        _prefixLength = prefix.length;
        _params = DataBlob.write(abi.encodePacked(prefix, raw, issuerPublicKey_));
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @inheritdoc IBbsBls12381Verifier
    function issuerPublicKey() external view returns (bytes memory) {
        return DataBlob.read(_params, 0, 96);
    }

    /// @notice Message generators Q1, H_1..H_L as concatenated EIP-2537 G1 points.
    function generators() external view returns (bytes memory) {
        return DataBlob.read(_params, _prefixLength, (messageCount + 1) * BLS12381.G1_BYTES);
    }

    /// @inheritdoc IBbsBls12381Verifier
    function domainFor(bytes calldata header) public view returns (uint256) {
        bytes memory prefix = DataBlob.read(_params, 0, _prefixLength);
        return BbsHash.hashToScalar(abi.encodePacked(prefix, uint64(header.length), header), BbsHash.H2S_DST);
    }

    /// @inheritdoc IBbsBls12381Verifier
    function messageToScalar(bytes calldata message) external pure returns (uint256) {
        return BbsHash.messageToScalar(message);
    }

    /// @notice Convenience wrapper that computes the domain from a signature header.
    function verifyProofWithHeader(
        bytes calldata header,
        bytes calldata ph,
        uint256[] calldata disclosedIndexes,
        uint256[] calldata disclosedScalars,
        Proof calldata proof
    ) external view returns (bool) {
        return verifyProof(domainFor(header), ph, disclosedIndexes, disclosedScalars, proof);
    }

    /// @inheritdoc IBbsBls12381Verifier
    function verifyProof(
        uint256 domain,
        bytes calldata ph,
        uint256[] calldata disclosedIndexes,
        uint256[] calldata disclosedScalars,
        Proof calldata proof
    ) public view returns (bool) {
        if (!_checkShape(disclosedIndexes, disclosedScalars, proof)) return false;
        return _verifyCore(
            domain,
            ph,
            _disclosedOctets(disclosedIndexes, disclosedScalars),
            _messageTermScalars(disclosedIndexes, disclosedScalars, proof),
            proof
        );
    }

    /// @dev T1/T2 reconstruction, challenge comparison and pairing check.
    function _verifyCore(
        uint256 domain,
        bytes calldata ph,
        bytes memory disclosed,
        uint256[] memory terms,
        Proof calldata proof
    ) internal view returns (bool) {
        bytes memory params = _loadCurveParams();

        (bool ok, BLS12381.G1Point memory t1) = _computeT1(proof);
        if (!ok) return false;

        BLS12381.G1Point memory t2;
        (ok, t2) = _computeT2(params, domain, terms, proof);
        if (!ok) return false;

        if (_challenge(domain, ph, disclosed, proof, t1, t2) != proof.challenge) return false;

        return _pairing(params, proof);
    }

    // ------------------------------------------------------------------
    // Verification stages (internal so a gas-profiling harness can time each one)
    // ------------------------------------------------------------------

    /// @dev Deserialization checks from ProofVerifyInit and octets_to_proof.
    function _checkShape(
        uint256[] calldata disclosedIndexes,
        uint256[] calldata disclosedScalars,
        Proof calldata proof
    ) internal view returns (bool) {
        uint256 r = disclosedIndexes.length;
        if (r != disclosedScalars.length || r + proof.commitments.length != messageCount) return false;

        for (uint256 k = 0; k < r; ++k) {
            if (disclosedIndexes[k] >= messageCount) return false;
            if (k > 0 && disclosedIndexes[k] <= disclosedIndexes[k - 1]) return false;
            if (disclosedScalars[k] >= BLS12381.R) return false;
        }

        if (!_isProofScalar(proof.eHat) || !_isProofScalar(proof.r1Hat) || !_isProofScalar(proof.r3Hat)) return false;
        if (!_isProofScalar(proof.challenge)) return false;
        for (uint256 j = 0; j < proof.commitments.length; ++j) {
            if (!_isProofScalar(proof.commitments[j])) return false;
        }

        BLS12381.G1Point memory aBar = proof.aBar;
        BLS12381.G1Point memory bBar = proof.bBar;
        BLS12381.G1Point memory d = proof.d;
        return !BLS12381.isIdentity(aBar) && !BLS12381.isIdentity(bBar) && !BLS12381.isIdentity(d);
    }

    /// @dev Q1 || H_1..H_L || W
    function _loadCurveParams() internal view returns (bytes memory) {
        uint256 size = (messageCount + 1) * BLS12381.G1_BYTES + BLS12381.G2_BYTES;
        return DataBlob.read(_params, _prefixLength, size);
    }

    /// @dev T1 = Bbar*c + Abar*e^ + D*r1^ (one 3-point MSM; also subgroup-checks Abar, Bbar, D).
    function _computeT1(Proof calldata proof) internal view returns (bool, BLS12381.G1Point memory) {
        bytes memory buf = new bytes(3 * BLS12381.MSM_PAIR_BYTES);
        BLS12381.writeMsmPair(buf, 0, proof.bBar, proof.challenge);
        BLS12381.writeMsmPair(buf, 160, proof.aBar, proof.eHat);
        BLS12381.writeMsmPair(buf, 320, proof.d, proof.r1Hat);
        return BLS12381.g1Msm(buf);
    }

    /// @dev Scalar paired with H_i in T2: msg_i*c for disclosed messages, m^_j for hidden ones.
    function _messageTermScalars(
        uint256[] calldata disclosedIndexes,
        uint256[] calldata disclosedScalars,
        Proof calldata proof
    ) internal view returns (uint256[] memory terms) {
        uint256 c = proof.challenge;
        terms = new uint256[](messageCount);
        uint256 next = 0; // cursor into disclosedIndexes
        uint256 u = 0; // cursor into commitments
        for (uint256 i = 0; i < terms.length; ++i) {
            if (next < disclosedIndexes.length && disclosedIndexes[next] == i) {
                terms[i] = mulmod(disclosedScalars[next], c, BLS12381.R);
                ++next;
            } else {
                terms[i] = proof.commitments[u];
                ++u;
            }
        }
    }

    /// @dev T2 = P1*c + Q1*(domain*c) + D*r3^ + sum H_i*terms[i] (one (L+3)-point MSM).
    function _computeT2(bytes memory params, uint256 domain, uint256[] memory terms, Proof calldata proof)
        internal
        view
        returns (bool, BLS12381.G1Point memory)
    {
        bytes memory buf = new bytes((terms.length + 3) * BLS12381.MSM_PAIR_BYTES);
        BLS12381.writeMsmPair(buf, 0, BLS12381.G1Point(P1_X_HI, P1_X_LO, P1_Y_HI, P1_Y_LO), proof.challenge);
        BLS12381.writeMsmPairRaw(buf, 160, params, 0, mulmod(domain, proof.challenge, BLS12381.R));
        BLS12381.writeMsmPair(buf, 320, proof.d, proof.r3Hat);
        for (uint256 i = 0; i < terms.length; ++i) {
            BLS12381.writeMsmPairRaw(
                buf, (i + 3) * BLS12381.MSM_PAIR_BYTES, params, (i + 1) * BLS12381.G1_BYTES, terms[i]
            );
        }
        return BLS12381.g1Msm(buf);
    }

    /// @dev serialize(R, i1, msg_i1, ..., iR, msg_iR)
    function _disclosedOctets(uint256[] calldata disclosedIndexes, uint256[] calldata disclosedScalars)
        internal
        pure
        returns (bytes memory out)
    {
        out = abi.encodePacked(uint64(disclosedIndexes.length));
        for (uint256 k = 0; k < disclosedIndexes.length; ++k) {
            out = abi.encodePacked(out, uint64(disclosedIndexes[k]), disclosedScalars[k]);
        }
    }

    /// @dev ProofChallengeCalculate.
    function _challenge(
        uint256 domain,
        bytes calldata ph,
        bytes memory disclosed,
        Proof calldata proof,
        BLS12381.G1Point memory t1,
        BLS12381.G1Point memory t2
    ) internal pure returns (uint256) {
        bytes memory points = abi.encodePacked(
            BLS12381.compressG1(proof.aBar),
            BLS12381.compressG1(proof.bBar),
            BLS12381.compressG1(proof.d),
            BLS12381.compressG1(t1),
            BLS12381.compressG1(t2)
        );
        return BbsHash.hashToScalar(
            abi.encodePacked(disclosed, points, domain, uint64(ph.length), ph), BbsHash.H2S_DST
        );
    }

    /// @dev e(Abar, W) * e(Bbar, -BP2) == 1
    function _pairing(bytes memory params, Proof calldata proof) internal view returns (bool) {
        uint256 wOffset = (messageCount + 1) * BLS12381.G1_BYTES;
        bytes memory w = new bytes(BLS12381.G2_BYTES);
        assembly ("memory-safe") {
            let src := add(add(params, 32), wOffset)
            let dst := add(w, 32)
            for { let k := 0 } lt(k, 256) { k := add(k, 32) } { mstore(add(dst, k), mload(add(src, k))) }
        }
        bytes memory negBp2 = abi.encode(
            NEG_BP2_X0_HI, NEG_BP2_X0_LO, NEG_BP2_X1_HI, NEG_BP2_X1_LO,
            NEG_BP2_Y0_HI, NEG_BP2_Y0_LO, NEG_BP2_Y1_HI, NEG_BP2_Y1_LO
        );
        return BLS12381.pairingCheck2(proof.aBar, w, proof.bBar, negBp2);
    }

    function _isProofScalar(uint256 s) private pure returns (bool) {
        return s != 0 && s < BLS12381.R;
    }
}
