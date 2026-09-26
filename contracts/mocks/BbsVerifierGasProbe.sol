// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BLS12381} from "../bbs/BLS12381.sol";
import {BbsHash} from "../bbs/BbsHash.sol";
import {BbsBls12381Verifier} from "../verifiers/BbsBls12381Verifier.sol";

/**
 * @title BbsVerifierGasProbe
 * @notice Benchmark harness: runs each BbsBls12381Verifier stage separately and reports the gas
 *         it consumed (gasleft deltas). Used only by scripts/benchmark_bbs_bound_local.ts.
 */
contract BbsVerifierGasProbe is BbsBls12381Verifier {
    struct StageGas {
        uint256 shapeChecks;
        uint256 loadParams;
        uint256 msmT1;
        uint256 msmT2;
        uint256 challenge;
        uint256 pairing;
        bool valid;
    }

    /// @dev Intermediate values kept in memory to stay within the stack limit.
    struct Work {
        bytes params;
        uint256[] terms;
        bytes disclosed;
        BLS12381.G1Point t1;
        BLS12381.G1Point t2;
        bool shapeOk;
        bool t1Ok;
        bool t2Ok;
        bool challengeOk;
        bool pairingOk;
    }

    constructor(uint256 messageCount_, bytes memory issuerPublicKey_)
        BbsBls12381Verifier(messageCount_, issuerPublicKey_)
    {}

    function profile(
        uint256 domain,
        bytes calldata ph,
        uint256[] calldata disclosedIndexes,
        uint256[] calldata disclosedScalars,
        Proof calldata proof
    ) external view returns (StageGas memory g) {
        Work memory w;
        uint256 start = gasleft();
        w.shapeOk = _checkShape(disclosedIndexes, disclosedScalars, proof);
        g.shapeChecks = start - gasleft();

        start = gasleft();
        w.params = _loadCurveParams();
        g.loadParams = start - gasleft();

        start = gasleft();
        (w.t1Ok, w.t1) = _computeT1(proof);
        g.msmT1 = start - gasleft();

        start = gasleft();
        w.terms = _messageTermScalars(disclosedIndexes, disclosedScalars, proof);
        (w.t2Ok, w.t2) = _computeT2(w.params, domain, w.terms, proof);
        g.msmT2 = start - gasleft();

        start = gasleft();
        w.disclosed = _disclosedOctets(disclosedIndexes, disclosedScalars);
        w.challengeOk = _challenge(domain, ph, w.disclosed, proof, w.t1, w.t2) == proof.challenge;
        g.challenge = start - gasleft();

        start = gasleft();
        w.pairingOk = _pairing(w.params, proof);
        g.pairing = start - gasleft();

        g.valid = w.shapeOk && w.t1Ok && w.t2Ok && w.challengeOk && w.pairingOk;
    }

    /// @notice Gas of messages_to_scalars for a batch of messages (the token-side cost).
    function profileMessageScalars(bytes[] calldata messages) external view returns (uint256 gasUsed) {
        uint256 start = gasleft();
        for (uint256 i = 0; i < messages.length; ++i) {
            BbsHash.messageToScalar(messages[i]);
        }
        gasUsed = start - gasleft();
    }
}
