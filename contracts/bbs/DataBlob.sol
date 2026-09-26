// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title DataBlob
/// @notice Stores immutable bytes as contract code and reads them back with EXTCODECOPY
///         (the SSTORE2 pattern). Reading a ~2 KB parameter blob costs a few thousand gas,
///         versus ~40k gas for the equivalent SLOADs.
library DataBlob {
    /// @dev Runtime code is 0x00 (STOP) || data so the pointer can never be called meaningfully.
    uint256 private constant DATA_OFFSET = 1;

    function write(bytes memory data) internal returns (address pointer) {
        bytes memory runtime = abi.encodePacked(hex"00", data);
        // PUSH4 len, DUP1, PUSH1 14, PUSH1 0, CODECOPY, PUSH1 0, RETURN
        bytes memory creation = abi.encodePacked(hex"63", uint32(runtime.length), hex"80600E6000396000F3", runtime);
        assembly ("memory-safe") {
            pointer := create(0, add(creation, 32), mload(creation))
        }
        require(pointer != address(0), "DataBlob: deploy failed");
    }

    function read(address pointer, uint256 start, uint256 size) internal view returns (bytes memory out) {
        out = new bytes(size);
        assembly ("memory-safe") {
            extcodecopy(pointer, add(out, 32), add(start, DATA_OFFSET), size)
        }
    }
}
