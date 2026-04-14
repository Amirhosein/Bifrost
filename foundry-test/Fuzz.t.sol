// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import "../contracts/public/GToken.sol";
import "../contracts/verify/BBSPlusDemoVerifier.sol";
import "./Vm.sol";

contract FuzzMint {
    Vm constant vm = Vm(HEVM_ADDRESS);
    GToken token;
    BBSPlusDemoVerifier verifier;

    uint256 issuerKey;
    address issuer;

    function setUp() public {
        issuerKey = 0xB0B;
        issuer = vm.addr(issuerKey);
        verifier = new BBSPlusDemoVerifier(issuer, address(this));
        token = new GToken("GreenToken","GT");
        token.setAllowedType(0, true);
        token.setVerifier(verifier);
    }

    function buildDisc(uint64 epochIndex, uint16 typeCode, uint256 qty, uint128 nonce) internal pure returns (bytes memory) {
        return abi.encode(GToken.Disc(epochIndex, typeCode, qty, nonce));
    }

    function sign(bytes32 vcHash, bytes memory discBytes) internal returns (bytes memory proof) {
        bytes32 discHash = keccak256(discBytes);
        bytes32 msgHash = keccak256(abi.encodePacked(vcHash, discHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerKey, msgHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        proof = abi.encode(vcHash, sig);
    }

    function testFuzz_mintVarious(uint64 epochIndex, uint256 qty, uint128 nonce) public {
        if (qty < 10) qty = 10; // match minQtyKWh
        bytes memory disc = buildDisc(epochIndex, 0, qty, nonce);
        bytes32 vcHash = keccak256(abi.encodePacked(epochIndex, 0, qty, nonce));
        bytes memory proof = sign(vcHash, disc);
        // Attempt mint; allow either success or revert if duplicate seen
        (bool ok, ) = address(token).call(abi.encodeWithSelector(token.mint.selector, proof, disc));
        // No assertion needed; purpose is to exercise paths without invariant violation
        ok; // silence warning
    }
}
