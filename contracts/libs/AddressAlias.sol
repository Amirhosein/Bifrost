// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Arbitrum's L1 -> L2 address aliasing. A message sent by L1 contract X arrives on L2 from
///         X + 0x1111000000000000000000000000000000001111, so an L2 contract can tell it apart from an
///         L2 account that happens to have the same address.
library AddressAlias {
    uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);

    function applyL1ToL2Alias(address l1Address) internal pure returns (address l2Address) {
        unchecked {
            l2Address = address(uint160(l1Address) + OFFSET);
        }
    }

    function undoL1ToL2Alias(address l2Address) internal pure returns (address l1Address) {
        unchecked {
            l1Address = address(uint160(l2Address) - OFFSET);
        }
    }
}
