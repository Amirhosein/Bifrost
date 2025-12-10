// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IVerifier {
    function verify(bytes calldata proof, bytes calldata disc) external view returns (bool ok);
}
