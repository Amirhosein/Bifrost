// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";

contract MetReg is Ownable {
    struct Meter { bytes32 certHash; bool active; }
    mapping(bytes32 => Meter) public meters;
    event MeterRegistered(bytes32 indexed meterHash, bytes32 certHash, bool active);
    event MeterStatusUpdated(bytes32 indexed meterHash, bool active);
    constructor(address initialOwner) Ownable(initialOwner) {}
    function registerMeter(bytes32 meterHash, bytes calldata cert, bool active_) external onlyOwner {
        meters[meterHash] = Meter({certHash: keccak256(cert), active: active_});
        emit MeterRegistered(meterHash, keccak256(cert), active_);
    }
    function updateMeterStatus(bytes32 meterHash, bool active_) external onlyOwner {
        require(meters[meterHash].certHash != bytes32(0), "unknown");
        meters[meterHash].active = active_;
        emit MeterStatusUpdated(meterHash, active_);
    }
    function verifyMeter(bytes32 meterHash, bytes calldata cert) external view returns (bool) {
        Meter memory m = meters[meterHash];
        if (!m.active) return false;
        return m.certHash == keccak256(cert);
    }
}
