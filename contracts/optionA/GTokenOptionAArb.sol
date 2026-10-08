// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AddressAlias} from "../libs/AddressAlias.sol";
import {GTokenOptionABase} from "./GTokenOptionABase.sol";

/// @title GTokenOptionAArb (Option A, Arbitrum side)
/// @notice A retryable ticket from the L1 registry arrives with msg.sender = alias(registry).
contract GTokenOptionAArb is GTokenOptionABase {
    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        uint256 l1ChainId,
        address l1Registry_,
        address ra_
    ) GTokenOptionABase(name_, symbol_, verifier_, l1ChainId, l1Registry_, ra_) {}

    function _onlyRegistry() internal view override {
        if (msg.sender != AddressAlias.applyL1ToL2Alias(l1Registry)) revert NotFromRegistry();
    }
}
