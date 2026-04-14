// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {BbsTypes} from "../interfaces/IBbsTypes.sol";
import {IBbsL2Verifier} from "../interfaces/IBbsL2Verifier.sol";
import {IGTokenAnchor} from "../interfaces/IGTokenAnchor.sol";
import {IArbSys} from "../arbitrum/IArbSys.sol";

/// @title GTokenL2BbsSnarkArb
/// @notice Arbitrum-native BBS+ L2 mint contract.
/// @dev Uses ArbSys precompile for L2->L1 message creation; L1 remains anchor-only.
contract GTokenL2BbsSnarkArb is ERC20, AccessControl {
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");

    error DuplicateCredential(bytes32 credentialIdHash);
    error Expired();
    error InvalidProof();

    // Arbitrum Nitro ArbSys precompile address
    address private constant ARBSYS = address(0x0000000000000000000000000000000000000064);

    event MintedBbs(
        address indexed to,
        bytes32 indexed claimId,
        bytes32 indexed credentialIdHash,
        uint16 reTypeCode,
        uint256 qtyKWh,
        uint64 readingTimestamp,
        uint256 gtAmount
    );
    event L2ToL1Message(uint256 indexed msgNum, address indexed l1Target);

    IBbsL2Verifier public verifier;
    IGTokenAnchor public l1Anchor;

    mapping(bytes32 => bool) private _usedCredential;

    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        address l1Anchor_,
        address registryAdmin_
    ) ERC20(name_, symbol_) {
        require(verifier_ != address(0), "verifier=0");
        require(l1Anchor_ != address(0), "l1Anchor=0");

        verifier = IBbsL2Verifier(verifier_);
        l1Anchor = IGTokenAnchor(l1Anchor_);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (registryAdmin_ != address(0)) {
            _grantRole(REGISTRY_ADMIN_ROLE, registryAdmin_);
        }
    }

    function isCredentialUsed(bytes32 credentialIdHash) external view returns (bool) {
        return _usedCredential[credentialIdHash];
    }

    function computeClaimId(BbsTypes.BbsDisclosedClaims calldata claims) public pure returns (bytes32) {
        return keccak256(abi.encode(claims.credentialIdHash, claims.reTypeCode, claims.qtyKWh, claims.readingTimestamp));
    }

    function mintWithBbsProof(
        BbsTypes.BbsDisclosedClaims calldata claims,
        bytes calldata bbsProof,
        bytes calldata zkSeal
    ) external {
        if (claims.expiry < block.timestamp) revert Expired();
        if (_usedCredential[claims.credentialIdHash]) revert DuplicateCredential(claims.credentialIdHash);

        bool ok = verifier.verifyForMint(msg.sender, claims, bbsProof, zkSeal);
        if (!ok) revert InvalidProof();

        _usedCredential[claims.credentialIdHash] = true;

        uint256 gtAmount = claims.qtyKWh;
        _mint(msg.sender, gtAmount);

        bytes32 claimId = keccak256(
            abi.encode(claims.credentialIdHash, claims.reTypeCode, claims.qtyKWh, claims.readingTimestamp)
        );
        bytes memory payload = abi.encodeCall(
            IGTokenAnchor.recordMint,
            (
                claimId,
                msg.sender,
                gtAmount,
                claims.readingTimestamp, // mapped to epochIndex field on the anchor schema
                claims.reTypeCode,
                claims.qtyKWh
            )
        );

        uint256 msgNum = IArbSys(ARBSYS).sendTxToL1(address(l1Anchor), payload);
        emit L2ToL1Message(msgNum, address(l1Anchor));

        emit MintedBbs(
            msg.sender,
            claimId,
            claims.credentialIdHash,
            claims.reTypeCode,
            claims.qtyKWh,
            claims.readingTimestamp,
            gtAmount
        );
    }
}

