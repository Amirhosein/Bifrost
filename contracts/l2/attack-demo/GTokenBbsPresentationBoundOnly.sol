// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {GTokenBbsBoundBase} from "../GTokenBbsBoundBase.sol";

/// @title GTokenBbsPresentationBoundOnly
/// @notice ATTACK-DEMO / ABLATION ONLY. Do not deploy as a production ledger.
/// @dev Identical to the hardened token except that it accepts credentials with an empty issuer
///      header, i.e. it applies only the presentation-header binding (recipient, chain, contract,
///      amount, nullifier, deadline). This stops third-party front-running and replay, but a
///      credential holder can still derive fresh proofs and mint the same credential on every
///      such ledger — the cross-chain double-issuance that designated-ledger binding closes.
contract GTokenBbsPresentationBoundOnly is GTokenBbsBoundBase {
    constructor(address verifier_)
        GTokenBbsBoundBase("Green Token (ph-bound only)", "GT-PH", verifier_, address(0))
    {}

    function _issuerHeader() internal pure override returns (bytes memory) {
        return "";
    }
}
