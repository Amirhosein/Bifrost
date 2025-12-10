// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./IVerifier.sol";

contract BBSPlusDemoVerifier is IVerifier, Ownable {
    using ECDSA for bytes32;
    address public issuer;
    event IssuerSet(address indexed issuer);

    constructor(address _issuer, address initialOwner) Ownable(initialOwner) {
        issuer = _issuer;
        emit IssuerSet(_issuer);
    }
    function setIssuer(address _issuer) external onlyOwner {
        issuer = _issuer;
        emit IssuerSet(_issuer);
    }

    // proof = abi.encode(bytes32 vcHash, bytes signature)
    function verify(bytes calldata proof, bytes calldata disc) external view override returns (bool ok) {
        (bytes32 vcHash, bytes memory signature) = abi.decode(proof, (bytes32, bytes));
        bytes32 discHash = keccak256(disc);
        bytes32 msgHash = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encodePacked(vcHash, discHash)));
        address signer = ECDSA.recover(msgHash, signature);
        return signer == issuer;
    }
}
