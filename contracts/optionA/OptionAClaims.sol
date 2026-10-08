// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BbsHash} from "../bbs/BbsHash.sol";

/// @notice Shared by the Option A registry (L1) and tokens (L2).
/// @dev Credentials for Option A are chain-agnostic: the RA signs the header
///      (SYSTEM_TAG, L1 chain id, registry address), so a credential works with this registry and the
///      chains it routes to, and the producer picks the chain at mint time. The message layout is the
///      same as the bound tokens: 3 hidden fields, then the 5 disclosed fields below.
library OptionAClaims {
    bytes32 internal constant SYSTEM_TAG = keccak256("GTOKEN_BBS_SYSTEM_V1");
    /// @dev Presentation header tag for A1 (proof checked by the registry on L1).
    bytes32 internal constant REGISTRY_MINT_TAG = keccak256("GTOKEN_BBS_REGISTRY_MINT_V1");
    /// @dev Presentation header tag for A2 (proof checked by the token on the chosen L2).
    bytes32 internal constant L2_MINT_TAG = keccak256("GTOKEN_BBS_MINT_V1");

    uint256 internal constant MESSAGE_COUNT = 8;
    uint256 private constant FIRST_DISCLOSED = 3;
    uint256 private constant DISCLOSED_COUNT = 5;

    struct Claims {
        uint16 reTypeCode;
        uint256 qtyKWh;
        uint64 readingTimestamp;
        bytes32 serial;
        uint64 expiry;
    }

    function systemHeader(uint256 l1ChainId, address registry) internal pure returns (bytes memory) {
        return abi.encode(SYSTEM_TAG, l1ChainId, registry);
    }

    function disclosedIndexes() internal pure returns (uint256[] memory idx) {
        idx = new uint256[](DISCLOSED_COUNT);
        for (uint256 k = 0; k < DISCLOSED_COUNT; ++k) {
            idx[k] = FIRST_DISCLOSED + k;
        }
    }

    function disclosedScalars(Claims calldata c) internal pure returns (uint256[] memory s) {
        s = new uint256[](DISCLOSED_COUNT);
        s[0] = BbsHash.messageToScalar(abi.encode(uint256(c.reTypeCode)));
        s[1] = BbsHash.messageToScalar(abi.encode(c.qtyKWh));
        s[2] = BbsHash.messageToScalar(abi.encode(uint256(c.readingTimestamp)));
        s[3] = BbsHash.messageToScalar(abi.encode(c.serial));
        s[4] = BbsHash.messageToScalar(abi.encode(uint256(c.expiry)));
    }
}
