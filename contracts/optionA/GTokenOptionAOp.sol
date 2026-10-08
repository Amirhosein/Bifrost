// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";
import {GTokenOptionABase} from "./GTokenOptionABase.sol";

/// @title GTokenOptionAOp (Option A, OP Stack side)
/// @notice A deposit from the L1 registry arrives through the L2CrossDomainMessenger
///         (predeploy 0x4200000000000000000000000000000000000007 on real OP Stack chains), which reports
///         the original L1 sender in xDomainMessageSender().
contract GTokenOptionAOp is GTokenOptionABase {
    address public immutable l2Messenger;

    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        uint256 l1ChainId,
        address l1Registry_,
        address l2Messenger_,
        address ra_
    ) GTokenOptionABase(name_, symbol_, verifier_, l1ChainId, l1Registry_, ra_) {
        l2Messenger = l2Messenger_;
    }

    function _onlyRegistry() internal view override {
        if (msg.sender != l2Messenger) revert NotFromRegistry();
        if (ICrossDomainMessenger(l2Messenger).xDomainMessageSender() != l1Registry) revert NotFromRegistry();
    }
}
