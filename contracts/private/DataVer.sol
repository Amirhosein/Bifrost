// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title DataVer (Data Verification Index)
/// @notice Private-side directory contract that stores commitments, oracle verdicts, and VC anchors.
/// @dev This contract is intentionally lightweight: it stores hashes only (no raw readings / PII).
///
/// The Hardhat tests in this repo assume:
///  - constructor(ra, oracle)
///  - commitReading(readingHash) emits ReadingCommitted(readingHash, from)
///  - postVerdict(readingHash, valid) emits OracleVerdictPosted(readingHash, valid, <bytes>)
///  - anchorVC(vcHash, readingHash) emits VCAnchored(vcHash, readingHash)
///  - vcToReading(vcHash) returns readingHash
contract DataVer is AccessControl {
    // --- Roles ---
    bytes32 public constant RA_ROLE = keccak256("RA_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // --- Data ---
    struct OracleVerdict {
        bool valid;
        bytes oracleSig;
        uint64 verifiedAt;
    }

    /// @notice readingHash => has it been committed?
    mapping(bytes32 => bool) public committedReadings;

    /// @notice readingHash => oracle verdict
    mapping(bytes32 => OracleVerdict) public verdicts;

    /// @notice vcHash => readingHash
    mapping(bytes32 => bytes32) private _vcToReading;

    // --- Events (expected by tests) ---
    event ReadingCommitted(bytes32 indexed readingHash, address indexed from);
    event OracleVerdictPosted(bytes32 indexed readingHash, bool valid, bytes oracleSig);
    event VCAnchored(bytes32 indexed vcHash, bytes32 indexed readingHash);

    // --- Errors ---
    error DuplicateCommit(bytes32 readingHash);
    error NotCommitted(bytes32 readingHash);
    error VerdictMissing(bytes32 readingHash);
    error VerdictInvalid(bytes32 readingHash);
    error VCAlreadyAnchored(bytes32 vcHash);

    constructor(address ra, address oracle) {
        // For this MVP, RA is also the admin.
        _grantRole(DEFAULT_ADMIN_ROLE, ra);
        _grantRole(RA_ROLE, ra);
        _grantRole(ORACLE_ROLE, oracle);
    }

    // ---------------------------------------------------------------------
    // Core API (used by tests)
    // ---------------------------------------------------------------------

    /// @notice Store a commitment (hash) to a meter reading.
    function commitReading(bytes32 readingHash) public {
        if (committedReadings[readingHash]) revert DuplicateCommit(readingHash);
        committedReadings[readingHash] = true;
        emit ReadingCommitted(readingHash, msg.sender);
    }

    /// @notice Oracle posts the verification result (2-arg overload used by tests).
    function postVerdict(bytes32 readingHash, bool valid) public onlyRole(ORACLE_ROLE) {
        postVerdict(readingHash, valid, bytes(""));
    }

    /// @notice Oracle posts the verification result including an optional signature blob.
    function postVerdict(bytes32 readingHash, bool valid, bytes memory oracleSig) public onlyRole(ORACLE_ROLE) {
        if (!committedReadings[readingHash]) revert NotCommitted(readingHash);

        verdicts[readingHash] = OracleVerdict({valid: valid, oracleSig: oracleSig, verifiedAt: uint64(block.timestamp)});
        emit OracleVerdictPosted(readingHash, valid, oracleSig);
    }

    /// @notice Registry admin anchors a VC hash to a verified reading hash.
    function anchorVC(bytes32 vcHash, bytes32 readingHash) public onlyRole(RA_ROLE) {
        OracleVerdict storage v = verdicts[readingHash];
        if (v.verifiedAt == 0) revert VerdictMissing(readingHash);
        if (!v.valid) revert VerdictInvalid(readingHash);

        if (_vcToReading[vcHash] != bytes32(0)) revert VCAlreadyAnchored(vcHash);

        _vcToReading[vcHash] = readingHash;
        emit VCAnchored(vcHash, readingHash);
    }

    // ---------------------------------------------------------------------
    // View helpers (used by tests / scripts)
    // ---------------------------------------------------------------------

    /// @notice Get the readingHash linked to a given vcHash (0x0 if none).
    function vcToReading(bytes32 vcHash) external view returns (bytes32) {
        return _vcToReading[vcHash];
    }

    /// @notice True if the oracle has posted a valid verdict for readingHash.
    function hasValidVerdict(bytes32 readingHash) external view returns (bool) {
        OracleVerdict storage v = verdicts[readingHash];
        return v.verifiedAt != 0 && v.valid;
    }

    /// @notice True if vcHash is anchored in this contract.
    function isVCAnchored(bytes32 vcHash) external view returns (bool) {
        return _vcToReading[vcHash] != bytes32(0);
    }

    // ---------------------------------------------------------------------
    // Backward-compatibility aliases (safe to keep; some earlier drafts used them)
    // ---------------------------------------------------------------------

    /// @notice Alias for commitReading() (kept for compatibility with earlier drafts).
    function submitRECommitment(bytes32 readingHash) external {
        commitReading(readingHash);
    }

    /// @notice Alias for postVerdict() (kept for compatibility with earlier drafts).
    function submitOracleVerification(bytes32 readingHash, bool valid, bytes calldata oracleSig) external {
        postVerdict(readingHash, valid, oracleSig);
    }

    /// @notice Alias for anchorVC() (kept for compatibility with earlier drafts).
    function storeVCCommitment(bytes32 vcHash, bytes32 readingHash) external {
        anchorVC(vcHash, readingHash);
    }
}
