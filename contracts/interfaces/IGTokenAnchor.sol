// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IGTokenAnchor {
    /// @notice Called on L1 to record that a given DT hash was minted on L2.
    function recordMint(
        bytes32 dtHash,
        address to,
        uint256 gtAmount,
        uint64 epochIndex,
        uint16 typeCode,
        uint256 qtyKWh
    ) external;
}
