// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MetReg (Meter Registry)
/// @notice Private-side contract that stores certified meter records.
/// @dev In the paper, GA signs a meter certificate. In this MVP we store the certificate bytes and a status flag.
contract MetReg is AccessControl {
    bytes32 public constant GA_ROLE = keccak256("GA_ROLE");
    bytes32 public constant RA_ROLE = keccak256("RA_ROLE");

    struct MeterRecord {
        bool isActive;
        bytes cert; // cert bytes; in a real system you would store a hash or a compressed representation
        uint64 updatedAt;
    }

    mapping(bytes32 => MeterRecord) private meters; // meterIDHash -> record

    event MeterRegistered(bytes32 indexed meterIDHash, bool isActive, bytes32 certHash);
    event MeterStatusUpdated(bytes32 indexed meterIDHash, bool isActive);

    error MeterAlreadyRegistered(bytes32 meterIDHash);

    constructor(address ga, address ra) {
        _grantRole(DEFAULT_ADMIN_ROLE, ga);
        _grantRole(GA_ROLE, ga);
        _grantRole(RA_ROLE, ra);
    }

    function registerMeter(bytes32 meterIDHash, bytes calldata cert, bool isActive) external onlyRole(GA_ROLE) {
        if (meters[meterIDHash].updatedAt != 0) revert MeterAlreadyRegistered(meterIDHash);
        meters[meterIDHash] = MeterRecord({isActive: isActive, cert: cert, updatedAt: uint64(block.timestamp)});
        emit MeterRegistered(meterIDHash, isActive, keccak256(cert));
    }

    function updateMeterStatus(bytes32 meterIDHash, bool isActive) external onlyRole(GA_ROLE) {
        meters[meterIDHash].isActive = isActive;
        meters[meterIDHash].updatedAt = uint64(block.timestamp);
        emit MeterStatusUpdated(meterIDHash, isActive);
    }

    /// @notice In a production system this would verify GA's signature over the cert.
    /// In this MVP we just check active flag + non-empty cert.
    function verifyMeter(bytes32 meterIDHash) external view onlyRole(RA_ROLE) returns (bool) {
        MeterRecord storage r = meters[meterIDHash];
        return r.isActive && r.updatedAt != 0 && r.cert.length > 0;
    }
    /// @notice Convenience view helper (used by tests / dashboards).
    /// @dev Publicly callable; note that meterIDHash is already a hash.
    function isMeterActive(bytes32 meterIDHash) external view returns (bool) {
        MeterRecord storage r = meters[meterIDHash];
        return r.isActive && r.updatedAt != 0;
    }

    function getMeter(bytes32 meterIDHash) external view onlyRole(RA_ROLE) returns (MeterRecord memory) {
        return meters[meterIDHash];
    }
}
