// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {BbsHash} from "../../bbs/BbsHash.sol";
import {IBbsBls12381Verifier} from "../../interfaces/IBbsBls12381Verifier.sol";

/// @title GTokenBbsPaperBaseline
/// @notice ATTACK-DEMO ONLY. Do not deploy as a production ledger.
/// @dev Faithful model of the token request in Nabi & Safavi-Naini (WTSC'25), Sec. 4.3 step 3,
///      using the same real BBS verifier as the hardened ledger:
///        (i)  compute H(M_disclosed) and reject it if already stored;
///        (ii) verify the BBS+ proof; if valid, issue tokens to the requester.
///      The proof is not bound to a recipient, ledger or deadline, and the requester chooses which
///      messages to disclose. The attack tests use this contract to show each gap concretely.
contract GTokenBbsPaperBaseline is ERC20 {
    /// @notice Index of the signed energy quantity in the credential layout.
    uint256 public constant QTY_INDEX = 4;

    error DuplicateRequest(bytes32 requestHash);
    error InvalidProof();
    error QuantityNotDisclosed();

    event TokenIssued(address indexed requester, bytes32 indexed requestHash, uint256 amount);

    IBbsBls12381Verifier public immutable verifier;
    uint256 public immutable issuerDomain;

    mapping(bytes32 => bool) public seenRequest;

    constructor(address verifier_) ERC20("Green Token (paper baseline)", "GT-P") {
        IBbsBls12381Verifier v = IBbsBls12381Verifier(verifier_);
        verifier = v;
        issuerDomain = v.domainFor(""); // the paper's credentials carry no ledger binding
    }

    /// @param disclosedIndexes Message indexes the requester chose to reveal.
    /// @param disclosedMessages Revealed messages (32-byte ABI words).
    /// @param nonce Prover-chosen presentation nonce; not interpreted by the contract.
    function requestGToken(
        uint256[] calldata disclosedIndexes,
        bytes[] calldata disclosedMessages,
        bytes calldata nonce,
        IBbsBls12381Verifier.Proof calldata proof
    ) external {
        bytes32 requestHash = keccak256(abi.encode(disclosedMessages)); // H(M_disclosed)
        if (seenRequest[requestHash]) revert DuplicateRequest(requestHash);

        uint256[] memory scalars = new uint256[](disclosedMessages.length);
        uint256 amount;
        bool qtyFound;
        for (uint256 k = 0; k < disclosedMessages.length; ++k) {
            scalars[k] = BbsHash.messageToScalar(disclosedMessages[k]);
            if (k < disclosedIndexes.length && disclosedIndexes[k] == QTY_INDEX) {
                amount = abi.decode(disclosedMessages[k], (uint256));
                qtyFound = true;
            }
        }
        if (!qtyFound) revert QuantityNotDisclosed();

        if (!verifier.verifyProof(issuerDomain, nonce, disclosedIndexes, scalars, proof)) revert InvalidProof();

        seenRequest[requestHash] = true;
        _mint(msg.sender, amount);
        emit TokenIssued(msg.sender, requestHash, amount);
    }
}
