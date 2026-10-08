// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IBbsBls12381Verifier} from "../interfaces/IBbsBls12381Verifier.sol";
import {GTokenRetirable} from "../l2/GTokenRetirable.sol";
import {OptionAClaims} from "./OptionAClaims.sol";

/// @title GTokenOptionABase (Option A, experimental)
/// @notice Green token on one L2 that takes orders only from the shared registry on Ethereum.
/// @dev The registry reaches this contract through the chain's own bridge; each subclass implements
///      `_onlyRegistry()` with that bridge's sender check. Two entry points from the registry:
///        - `mintFromRegistry` (A1): the registry already verified the BBS proof on L1, so this only
///          mints. Repeats are ignored (not reverted) so a re-sent message cannot fail or mint twice.
///        - `authorizeSerial` (A2): marks a serial as registered for this chain; the producer then calls
///          `mintBound` here with the full BBS proof.
///      Tokens support reversible (2,2) retirement.
abstract contract GTokenOptionABase is GTokenRetirable {
    error NotFromRegistry();
    error NotAuthorized(bytes32 serial);
    error AlreadyMinted(bytes32 serial);
    error ZeroRecipient();
    error DeadlinePassed();
    error Expired();
    error InvalidProof();

    event SerialAuthorized(bytes32 indexed serial);
    event RegistryMint(bytes32 indexed serial, address indexed recipient, uint256 amount);
    event DuplicateIgnored(bytes32 indexed serial);
    event BoundMint(bytes32 indexed serial, address indexed recipient, uint256 amount, address submitter);

    /// @notice The registry contract on Ethereum (an L1 address).
    address public immutable l1Registry;
    IBbsBls12381Verifier public immutable verifier;
    /// @notice calculate_domain for the system header (L1 chain id, registry); used by A2 mints.
    uint256 public immutable issuerDomain;

    mapping(bytes32 => bool) public authorized;
    mapping(bytes32 => bool) public minted;

    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        uint256 l1ChainId,
        address l1Registry_,
        address ra_
    ) ERC20(name_, symbol_) GTokenRetirable(name_, ra_) {
        IBbsBls12381Verifier v = IBbsBls12381Verifier(verifier_);
        require(v.messageCount() == OptionAClaims.MESSAGE_COUNT, "verifier L mismatch");
        verifier = v;
        l1Registry = l1Registry_;
        issuerDomain = v.domainFor(OptionAClaims.systemHeader(l1ChainId, l1Registry_));
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ------------------------------------------------------------------
    // Called by the registry, through the bridge
    // ------------------------------------------------------------------

    function mintFromRegistry(bytes32 serial, address recipient, uint256 amount) external {
        _onlyRegistry();
        if (minted[serial]) {
            emit DuplicateIgnored(serial);
            return;
        }
        minted[serial] = true;
        _mint(recipient, amount);
        emit RegistryMint(serial, recipient, amount);
    }

    function authorizeSerial(bytes32 serial) external {
        _onlyRegistry();
        authorized[serial] = true;
        emit SerialAuthorized(serial);
    }

    // ------------------------------------------------------------------
    // A2 mint: full BBS proof on this chain
    // ------------------------------------------------------------------

    function presentationHeader(address recipient, uint256 amount, bytes32 serial, uint64 deadline)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(OptionAClaims.L2_MINT_TAG, block.chainid, address(this), recipient, amount, serial, deadline);
    }

    function mintBound(
        address recipient,
        OptionAClaims.Claims calldata claims,
        uint64 deadline,
        IBbsBls12381Verifier.Proof calldata proof
    ) external {
        if (recipient == address(0)) revert ZeroRecipient();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (block.timestamp > claims.expiry) revert Expired();
        if (!authorized[claims.serial]) revert NotAuthorized(claims.serial);
        if (minted[claims.serial]) revert AlreadyMinted(claims.serial);

        bool ok = verifier.verifyProof(
            issuerDomain,
            presentationHeader(recipient, claims.qtyKWh, claims.serial, deadline),
            OptionAClaims.disclosedIndexes(),
            OptionAClaims.disclosedScalars(claims),
            proof
        );
        if (!ok) revert InvalidProof();

        minted[claims.serial] = true;
        _mint(recipient, claims.qtyKWh);
        emit BoundMint(claims.serial, recipient, claims.qtyKWh, msg.sender);
    }

    /// @dev Reverts unless the current call came from `l1Registry` through this chain's bridge.
    function _onlyRegistry() internal view virtual;
}
