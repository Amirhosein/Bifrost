// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.6.2 <0.9.0;
interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function addr(uint256 privateKey) external returns (address);
    function expectRevert() external;
}
address constant HEVM_ADDRESS = address(uint160(uint(keccak256('hevm cheat code'))));
