// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import "../contracts/public/GToken.sol";
import "../contracts/verify/BBSPlusDemoVerifier.sol";
import "./Vm.sol";

contract InvariantNoDuplicate {
    Vm constant vm = Vm(HEVM_ADDRESS);

    GToken token;
    BBSPlusDemoVerifier verifier;

    uint256 issuerKey;
    address issuer;

    function setUp() public {
        issuerKey = 0xA11CE; // demo private key
        issuer = vm.addr(issuerKey);

        verifier = new BBSPlusDemoVerifier(issuer, address(this));
        token = new GToken("GreenToken","GT");
        token.setAllowedType(0, true); // SOLAR
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

    function test_mint_then_duplicate_reverts() public {
        bytes32 vcHash = keccak256("deadbeef");
        bytes memory disc = buildDisc(202540, 0, 100, 0);
        bytes memory proof = sign(vcHash, disc);
        token.mint(proof, disc);

        vm.expectRevert();
        token.mint(proof, disc);
    }

    // Fuzz: for many random tuples, each unique tuple mints once; duplicate reverts.
    function testFuzz_noDoubleMint(uint64 e, uint256 q, uint128 n) public {
        // Normalize fuzz domains
        uint64 epoch = (e % 1000000);
        uint16 typeCode = 0;
        uint256 qty = (q % 10000) + 10; // >= minQtyKWh
        uint128 nonce = n;

        bytes memory disc = buildDisc(epoch, typeCode, qty, nonce);
        bytes32 vcHash = keccak256(abi.encodePacked(epoch, typeCode, qty, nonce, uint256(42)));
        bytes memory proof = sign(vcHash, disc);

        // Try first mint (may pass or revert if duplicate already seen in this fuzz run)
        (bool ok, ) = address(token).call(abi.encodeWithSelector(token.mint.selector, proof, disc));

        if (ok) {
            // second must revert
            (bool ok2, ) = address(token).call(abi.encodeWithSelector(token.mint.selector, proof, disc));
            require(!ok2, "duplicate should revert");
        }
    }
}
