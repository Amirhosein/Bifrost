// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";

contract DataVer is Ownable {
    address public oracle;
    mapping(bytes32 => bool) public committed;
    mapping(bytes32 => bool) public verdicts;
    mapping(bytes32 => bytes32) public anchoredVC;

    event Committed(bytes32 indexed readingHash, address indexed who);
    event Verdict(bytes32 indexed readingHash, bool valid);
    event VCAngored(bytes32 indexed vcHash, bytes32 indexed readingHash);
    event OracleUpdated(address indexed oracle);

    constructor(address initialOwner, address oracle_) Ownable(initialOwner) { oracle = oracle_; emit OracleUpdated(oracle_); }
    function setOracle(address oracle_) external onlyOwner { oracle = oracle_; emit OracleUpdated(oracle_); }

    function commitReading(bytes32 readingHash) external {
        require(!committed[readingHash], "duplicate");
        committed[readingHash] = true;
        emit Committed(readingHash, msg.sender);
    }

    function postVerdict(bytes32 readingHash, bool valid) external {
        require(msg.sender == oracle, "not oracle");
        require(committed[readingHash], "no commit");
        verdicts[readingHash] = valid;
        emit Verdict(readingHash, valid);
    }

    function anchorVC(bytes32 vcHash, bytes32 readingHash) external onlyOwner {
        require(verdicts[readingHash] == true, "no valid verdict");
        anchoredVC[vcHash] = readingHash;
        emit VCAngored(vcHash, readingHash);
    }
}
