// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

library BbsTypes {
    /// @notice Disclosed fields from a BBS+ selective-disclosure presentation.
    /// @dev The credential identifier hash is used for one-time mint anti-replay.
    struct BbsDisclosedClaims {
        uint16 reTypeCode;
        uint256 qtyKWh;
        uint64 readingTimestamp;
        bytes32 credentialIdHash;
        uint64 expiry;
    }
}

