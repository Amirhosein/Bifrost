// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title GTokenRetirable
/// @notice Reversible "(2,2)" retirement for green tokens.
/// @dev Retiring moves tokens from the holder into this contract's own balance (escrow) and records a
///      receipt. The escrow has exactly two exits, and each needs EIP-712 signatures from BOTH the
///      account that retired the tokens and an RA:
///        - `recover`: release the tokens to an address (legal correction, two-way tokenization);
///        - `finalize`: burn them for good (the retirement becomes permanent).
///      Neither party can move retired tokens alone. Anyone may submit the two signatures (e.g. a relayer).
///      The beneficiary is stored only as a commitment H(beneficiary || salt); the holder can reveal it later.
///      Tokens are fungible, so a retirement records an amount, not a specific credential.
///      Tokens sent to this contract with a plain `transfer` are not retirements and cannot be moved.
abstract contract GTokenRetirable is ERC20, AccessControl, EIP712 {
    bytes32 public constant RA_ROLE = keccak256("RA_ROLE");

    bytes32 public constant RECOVER_TYPEHASH =
        keccak256("Recover(uint256 retirementId,address to,uint256 deadline)");
    bytes32 public constant FINALIZE_TYPEHASH = keccak256("Finalize(uint256 retirementId,uint256 deadline)");

    enum Status {
        None,
        Retired,
        Recovered,
        Finalized
    }

    struct Retirement {
        address holder;
        uint64 retiredAt;
        Status status;
        uint256 amount;
        bytes32 beneficiaryCommitment;
    }

    /// @notice The two signatures a (2,2) exit needs, over the same EIP-712 digest.
    struct CoSignatures {
        address ra;
        bytes holderSig;
        bytes raSig;
    }

    error ZeroAmount();
    error ZeroAddress();
    error NotRetired(uint256 id);
    error SignatureExpired();
    error NotRA(address ra);
    error SameSigner();
    error BadHolderSignature();
    error BadRASignature();

    event Retired(uint256 indexed id, address indexed holder, uint256 amount, bytes32 beneficiaryCommitment);
    event Recovered(uint256 indexed id, address indexed to, uint256 amount, address ra);
    event Finalized(uint256 indexed id, uint256 amount, address ra);

    uint256 private _retirementCount;
    uint256 private _escrowed;
    mapping(uint256 => Retirement) private _retirements;

    constructor(string memory eip712Name, address ra_) EIP712(eip712Name, "1") {
        if (ra_ != address(0)) {
            _grantRole(RA_ROLE, ra_);
        }
    }

    // ------------------------------------------------------------------
    // Retire
    // ------------------------------------------------------------------

    /// @notice Locks `amount` of the caller's tokens as retired (claimed) and returns the receipt id.
    function retire(uint256 amount, bytes32 beneficiaryCommitment) external returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        _transfer(msg.sender, address(this), amount);

        id = ++_retirementCount;
        _retirements[id] = Retirement({
            holder: msg.sender,
            retiredAt: uint64(block.timestamp),
            status: Status.Retired,
            amount: amount,
            beneficiaryCommitment: beneficiaryCommitment
        });
        _escrowed += amount;

        emit Retired(id, msg.sender, amount, beneficiaryCommitment);
    }

    // ------------------------------------------------------------------
    // (2,2) exits
    // ------------------------------------------------------------------

    /// @notice Releases a retirement's tokens to `to`. Needs the holder's and an RA's signatures.
    function recover(uint256 id, address to, uint256 deadline, CoSignatures calldata sigs) external {
        if (to == address(0)) revert ZeroAddress();
        Retirement storage r =
            _authorize(id, keccak256(abi.encode(RECOVER_TYPEHASH, id, to, deadline)), deadline, sigs);

        r.status = Status.Recovered;
        _escrowed -= r.amount;
        _transfer(address(this), to, r.amount);

        emit Recovered(id, to, r.amount, sigs.ra);
    }

    /// @notice Burns a retirement's tokens for good. Needs the holder's and an RA's signatures.
    function finalize(uint256 id, uint256 deadline, CoSignatures calldata sigs) external {
        Retirement storage r = _authorize(id, keccak256(abi.encode(FINALIZE_TYPEHASH, id, deadline)), deadline, sigs);

        r.status = Status.Finalized;
        _escrowed -= r.amount;
        _burn(address(this), r.amount);

        emit Finalized(id, r.amount, sigs.ra);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function retirement(uint256 id) external view returns (Retirement memory) {
        return _retirements[id];
    }

    function retirementCount() external view returns (uint256) {
        return _retirementCount;
    }

    /// @notice Tokens currently locked by open (not yet recovered or finalized) retirements.
    function escrowed() public view returns (uint256) {
        return _escrowed;
    }

    /// @notice Supply that can still be traded: total supply minus locked retirements.
    function circulatingSupply() external view returns (uint256) {
        return totalSupply() - _escrowed;
    }

    function recoverDigest(uint256 id, address to, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RECOVER_TYPEHASH, id, to, deadline)));
    }

    function finalizeDigest(uint256 id, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(FINALIZE_TYPEHASH, id, deadline)));
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /// @dev Each retirement leaves `Retired` at most once, so a signature pair cannot be replayed.
    function _authorize(uint256 id, bytes32 structHash, uint256 deadline, CoSignatures calldata sigs)
        private
        view
        returns (Retirement storage r)
    {
        r = _retirements[id];
        if (r.status != Status.Retired) revert NotRetired(id);
        if (block.timestamp > deadline) revert SignatureExpired();
        if (!hasRole(RA_ROLE, sigs.ra)) revert NotRA(sigs.ra);
        if (sigs.ra == r.holder) revert SameSigner();
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!_isValidSignature(r.holder, digest, sigs.holderSig)) revert BadHolderSignature();
        if (!_isValidSignature(sigs.ra, digest, sigs.raSig)) revert BadRASignature();
    }

    /// @dev ECDSA for plain accounts, ERC-1271 for contract wallets (OZ's SignatureChecker needs solc 0.8.24).
    function _isValidSignature(address signer, bytes32 digest, bytes calldata sig) private view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, sig)));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
    }
}
