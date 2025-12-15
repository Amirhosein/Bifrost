// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title DataVer (Private chain)
 * @notice Minimal directory/index for meter-reading verification in the capstone MVP.
 *
 * Stores:
 *  - a commitment to a meter reading (readingHash)
 *  - an oracle validity verdict for that readingHash
 *  - an anchor linking vcHash -> readingHash (only after a valid verdict)
 *
 * IMPORTANT (why your build broke):
 *  In Solidity, you cannot call an `external` function internally by name.
 *  So these "paper-style" functions are declared `public`, and the nicer wrapper
 *  functions (commitReading/postVerdict/anchorVC) call them internally.
 */
contract DataVer is AccessControl {
    bytes32 public constant RA_ROLE = keccak256("RA_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // Events (tests only check the event name, but we keep useful params)
    event ReadingCommitted(bytes32 indexed readingHash, address indexed committer);
    event OracleVerdictPosted(bytes32 indexed readingHash, bool isValid);
    event VCAnchored(bytes32 indexed vcHash, bytes32 indexed readingHash);

    // readingHash -> committed?
    mapping(bytes32 => bool) public commitments;

    // readingHash -> oracle verdict posted?
    mapping(bytes32 => bool) public oraclePosted;

    // readingHash -> oracle verdict validity (only meaningful if oraclePosted[hash] == true)
    mapping(bytes32 => bool) public oracleValid;

    // vcHash -> readingHash (0 if not anchored)
    mapping(bytes32 => bytes32) private _vcToReading;

    constructor(address ra, address oracle) {
        require(ra != address(0), "DataVer: ra=0");
        require(oracle != address(0), "DataVer: oracle=0");

        // RA is the admin + RA role holder
        _grantRole(DEFAULT_ADMIN_ROLE, ra);
        _grantRole(RA_ROLE, ra);

        // Oracle role holder (can be a bot account / relayer)
        _grantRole(ORACLE_ROLE, oracle);
    }

    // ------------------------------------------------------------------------
    // Paper-ish core API (PUBLIC so wrappers can call internally)
    // ------------------------------------------------------------------------

    /// @notice Submit a commitment to a meter reading hash (e.g., H(generationData)).
    function submitRECommitment(bytes32 readingHash) public {
        require(readingHash != bytes32(0), "DataVer: zero readingHash");
        require(!commitments[readingHash], "DataVer: already committed");

        commitments[readingHash] = true;
        emit ReadingCommitted(readingHash, msg.sender);
    }

    /// @notice Oracle posts the verification result for a committed readingHash.
    /// @dev MVP: we do not verify a cryptographic oracle signature here; trust is via ORACLE_ROLE.
    function submitOracleVerification(bytes32 readingHash, bool isValid) public onlyRole(ORACLE_ROLE) {
        require(commitments[readingHash], "DataVer: no commitment");
        require(!oraclePosted[readingHash], "DataVer: verdict already posted");

        oraclePosted[readingHash] = true;
        oracleValid[readingHash] = isValid;

        emit OracleVerdictPosted(readingHash, isValid);
    }

    /// @notice RA anchors a VC hash to a verified readingHash (only after a valid oracle verdict).
    function storeVCCommitment(bytes32 vcHash, bytes32 readingHash) public onlyRole(RA_ROLE) {
        require(vcHash != bytes32(0), "DataVer: zero vcHash");
        require(_vcToReading[vcHash] == bytes32(0), "DataVer: vc already anchored");
        require(oraclePosted[readingHash] && oracleValid[readingHash], "DataVer: no valid verdict");

        _vcToReading[vcHash] = readingHash;
        emit VCAnchored(vcHash, readingHash);
    }

    // ------------------------------------------------------------------------
    // Friendly wrapper API (what your tests/scripts call)
    // ------------------------------------------------------------------------

    function commitReading(bytes32 readingHash) external {
        submitRECommitment(readingHash);
    }

    // NOTE: your tests call postVerdict(readingHash, true) with 2 args (no signature),
    // so keep this exact signature.
    function postVerdict(bytes32 readingHash, bool valid) external onlyRole(ORACLE_ROLE) {
        submitOracleVerification(readingHash, valid);
    }

    function anchorVC(bytes32 vcHash, bytes32 readingHash) external onlyRole(RA_ROLE) {
        storeVCCommitment(vcHash, readingHash);
    }

    // ------------------------------------------------------------------------
    // View helpers
    // ------------------------------------------------------------------------

    function hasValidVerdict(bytes32 readingHash) external view returns (bool) {
        return oraclePosted[readingHash] && oracleValid[readingHash];
    }

    function isVCAnchored(bytes32 vcHash) external view returns (bool) {
        return _vcToReading[vcHash] != bytes32(0);
    }

    function vcToReading(bytes32 vcHash) external view returns (bytes32) {
        return _vcToReading[vcHash];
    }
}
