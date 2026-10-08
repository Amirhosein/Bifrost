// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {GTokenL2BbsBoundArb} from "./GTokenL2BbsBoundArb.sol";
import {GTokenRetirable} from "./GTokenRetirable.sol";

/// @title GTokenL2BbsBoundRetirableArb
/// @notice The Arbitrum bound-minting green token plus reversible (2,2) retirement.
contract GTokenL2BbsBoundRetirableArb is GTokenL2BbsBoundArb, GTokenRetirable {
    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        address l1Anchor_,
        address registryAdmin_,
        address ra_
    ) GTokenL2BbsBoundArb(name_, symbol_, verifier_, l1Anchor_, registryAdmin_) GTokenRetirable(name_, ra_) {}
}
