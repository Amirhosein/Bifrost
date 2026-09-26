// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {GTokenBbsBoundBase} from "./GTokenBbsBoundBase.sol";
import {IGTokenAnchor} from "../interfaces/IGTokenAnchor.sol";
import {IArbSys} from "../arbitrum/IArbSys.sol";

/// @title GTokenL2BbsBoundArb
/// @notice Arbitrum GToken with bound BBS minting (real on-chain verifier) and L2->L1 anchoring.
/// @dev The anchor payload keeps the GTokenAnchorArb schema; the claim id is keyed by the nullifier.
contract GTokenL2BbsBoundArb is GTokenBbsBoundBase {
    // Arbitrum Nitro ArbSys precompile address
    address private constant ARBSYS = address(0x0000000000000000000000000000000000000064);

    event L2ToL1Message(uint256 indexed msgNum, address indexed l1Target);

    IGTokenAnchor public immutable l1Anchor;

    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        address l1Anchor_,
        address registryAdmin_
    ) GTokenBbsBoundBase(name_, symbol_, verifier_, registryAdmin_) {
        require(l1Anchor_ != address(0), "l1Anchor=0");
        l1Anchor = IGTokenAnchor(l1Anchor_);
    }

    function _afterBoundMint(bytes32 claimId, address recipient, BoundClaims calldata claims) internal override {
        bytes memory payload = abi.encodeCall(
            IGTokenAnchor.recordMint,
            (
                claimId,
                recipient,
                claims.qtyKWh,
                claims.readingTimestamp, // mapped to epochIndex field on the anchor schema
                claims.reTypeCode,
                claims.qtyKWh
            )
        );
        uint256 msgNum = IArbSys(ARBSYS).sendTxToL1(address(l1Anchor), payload);
        emit L2ToL1Message(msgNum, address(l1Anchor));
    }
}
