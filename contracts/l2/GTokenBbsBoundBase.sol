// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {BbsHash} from "../bbs/BbsHash.sol";
import {IBbsBls12381Verifier} from "../interfaces/IBbsBls12381Verifier.sol";

/// @title GTokenBbsBoundBase
/// @notice Green-token minting from a real BBS proof that is bound to one mint action and
///         one designated ledger.
/// @dev Closes the replay and double-issuance gaps of the paper's token request:
///      - Presentation header `ph` = (MINT_TAG, chainid, this, recipient, amount, nullifier, deadline)
///        is rebuilt on-chain, so a proof copied from the mempool cannot be redirected to
///        another recipient, contract or chain, and expires at `deadline`.
///      - The issuer signs the BBS header (LEDGER_TAG, chainid, token) into the credential, so the
///        holder cannot derive an acceptable proof for any other ledger.
///      - Dedup uses the issuer-assigned random serial (nullifier) under a fixed disclosure policy,
///        instead of H(disclosed data) with caller-chosen indexes.
///      Because the proof fixes the recipient, anyone may submit the mint (e.g. a relayer paying gas
///      for a fresh, unfunded pseudonym address).
abstract contract GTokenBbsBoundBase is ERC20, AccessControl {
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");
    bytes32 public constant LEDGER_TAG = keccak256("GTOKEN_BBS_LEDGER_V1");
    bytes32 public constant MINT_TAG = keccak256("GTOKEN_BBS_MINT_V1");

    /// @notice Credential layout: ownerID, meterID, siteID (hidden) | reTypeCode, qtyKWh,
    ///         readingTimestamp, serial, expiry (disclosed at indexes 3..7).
    uint256 public constant MESSAGE_COUNT = 8;
    uint256 private constant FIRST_DISCLOSED = 3;
    uint256 private constant DISCLOSED_COUNT = 5;

    /// @notice Disclosed credential fields. Each is signed as one 32-byte ABI word.
    struct BoundClaims {
        uint16 reTypeCode;
        uint256 qtyKWh;
        uint64 readingTimestamp;
        bytes32 serial;
        uint64 expiry;
    }

    error ZeroRecipient();
    error DeadlinePassed();
    error Expired();
    error NullifierAlreadyUsed(bytes32 nullifier);
    error InvalidProof();

    event BoundMint(
        address indexed recipient,
        bytes32 indexed nullifier,
        bytes32 indexed claimId,
        address submitter,
        uint16 reTypeCode,
        uint256 qtyKWh,
        uint64 readingTimestamp
    );

    IBbsBls12381Verifier public immutable verifier;

    /// @notice calculate_domain(issuer PK, generators, issuer header) for this ledger.
    uint256 public immutable issuerDomain;

    mapping(bytes32 => bool) private _nullifierUsed;

    constructor(string memory name_, string memory symbol_, address verifier_, address registryAdmin_)
        ERC20(name_, symbol_)
    {
        require(verifier_ != address(0), "verifier=0");
        IBbsBls12381Verifier v = IBbsBls12381Verifier(verifier_);
        require(v.messageCount() == MESSAGE_COUNT, "verifier L mismatch");

        verifier = v;
        issuerDomain = v.domainFor(_issuerHeader());

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (registryAdmin_ != address(0)) {
            _grantRole(REGISTRY_ADMIN_ROLE, registryAdmin_);
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice BBS header the issuer must sign into credentials meant for this ledger.
    function designatedHeader() public view returns (bytes memory) {
        return abi.encode(LEDGER_TAG, block.chainid, address(this));
    }

    /// @notice Presentation header the holder must bind the proof to.
    function presentationHeader(address recipient, uint256 amount, bytes32 nullifier, uint64 deadline)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(MINT_TAG, block.chainid, address(this), recipient, amount, nullifier, deadline);
    }

    function isNullifierUsed(bytes32 nullifier) external view returns (bool) {
        return _nullifierUsed[nullifier];
    }

    function computeClaimId(BoundClaims calldata claims) public pure returns (bytes32) {
        return keccak256(abi.encode(claims.serial, claims.reTypeCode, claims.qtyKWh, claims.readingTimestamp));
    }

    // ------------------------------------------------------------------
    // Mint
    // ------------------------------------------------------------------

    /// @notice Mints `claims.qtyKWh` tokens to `recipient` from a bound BBS proof.
    /// @param recipient Address the proof's presentation header commits to (any caller may submit).
    /// @param claims Disclosed credential fields; mapped to scalars on-chain.
    /// @param deadline Last timestamp at which this proof may be used.
    /// @param proof BBS proof derived with `presentationHeader(recipient, qtyKWh, serial, deadline)`.
    function mintBound(
        address recipient,
        BoundClaims calldata claims,
        uint64 deadline,
        IBbsBls12381Verifier.Proof calldata proof
    ) external returns (bytes32 claimId) {
        if (recipient == address(0)) revert ZeroRecipient();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (block.timestamp > claims.expiry) revert Expired();

        bytes32 nullifier = claims.serial;
        if (_nullifierUsed[nullifier]) revert NullifierAlreadyUsed(nullifier);

        bool ok = verifier.verifyProof(
            issuerDomain,
            presentationHeader(recipient, claims.qtyKWh, nullifier, deadline),
            _disclosedIndexes(),
            _disclosedScalars(claims),
            proof
        );
        if (!ok) revert InvalidProof();

        _nullifierUsed[nullifier] = true;
        _mint(recipient, claims.qtyKWh);

        claimId = computeClaimId(claims);
        _afterBoundMint(claimId, recipient, claims);

        emit BoundMint(
            recipient, nullifier, claimId, msg.sender, claims.reTypeCode, claims.qtyKWh, claims.readingTimestamp
        );
    }

    // ------------------------------------------------------------------
    // Hooks and internals
    // ------------------------------------------------------------------

    /// @dev BBS header this ledger accepts. Production ledgers use the designated header.
    function _issuerHeader() internal view virtual returns (bytes memory) {
        return designatedHeader();
    }

    /// @dev Called after a successful mint (e.g. to anchor the claim on L1).
    function _afterBoundMint(bytes32 claimId, address recipient, BoundClaims calldata claims) internal virtual {}

    function _disclosedIndexes() private pure returns (uint256[] memory idx) {
        idx = new uint256[](DISCLOSED_COUNT);
        for (uint256 k = 0; k < DISCLOSED_COUNT; ++k) {
            idx[k] = FIRST_DISCLOSED + k;
        }
    }

    function _disclosedScalars(BoundClaims calldata claims) private pure returns (uint256[] memory s) {
        s = new uint256[](DISCLOSED_COUNT);
        s[0] = BbsHash.messageToScalar(abi.encode(uint256(claims.reTypeCode)));
        s[1] = BbsHash.messageToScalar(abi.encode(claims.qtyKWh));
        s[2] = BbsHash.messageToScalar(abi.encode(uint256(claims.readingTimestamp)));
        s[3] = BbsHash.messageToScalar(abi.encode(claims.serial));
        s[4] = BbsHash.messageToScalar(abi.encode(uint256(claims.expiry)));
    }
}
