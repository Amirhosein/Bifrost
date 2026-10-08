// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IInbox} from "../arbitrum/IInbox.sol";
import {AddressAlias} from "../libs/AddressAlias.sol";

/// @notice Stands in for the L2 side of an aliased L1 sender. Its runtime code is copied (hardhat_setCode)
///         to alias(L1 sender), so the target sees msg.sender == alias(L1 sender), exactly as on Arbitrum.
contract ArbAliasExecutor {
    address public immutable inbox;

    constructor(address inbox_) {
        inbox = inbox_;
    }

    function execute(address to, bytes calldata data, uint256 gasLimit) external returns (bool ok) {
        require(msg.sender == inbox, "only inbox");
        (ok,) = to.call{gas: gasLimit}(data);
    }
}

/// @title MockArbInbox
/// @notice Single-chain model of Arbitrum retryable tickets (L1 Inbox + the L2 redeem), for local tests.
/// @dev Lifecycle, as on Arbitrum:
///   1. `createRetryableTicket` on L1, prepaid: msg.value >= l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas.
///   2. The sequencer tries an automatic redeem with the ticket's gasLimit (`autoRedeem` here).
///   3. If that fails (e.g. gasLimit too low), anyone can redeem it manually with more gas (`redeem`),
///      for 7 days. After that the ticket expires and the call never happens.
contract MockArbInbox is IInbox {
    uint64 public constant LIFETIME = 7 days;

    struct Ticket {
        address from;
        address to;
        uint256 l2CallValue;
        uint256 maxSubmissionCost;
        uint256 gasLimit;
        uint256 maxFeePerGas;
        uint256 deposit;
        uint64 createdAt;
        bool redeemed;
        bytes data;
    }

    error InsufficientDeposit(uint256 required, uint256 paid);
    error TicketExpired(uint256 ticketId);
    error AlreadyRedeemed(uint256 ticketId);
    error NoExecutorAtAlias(address aliasAddress);

    event TicketCreated(uint256 indexed ticketId, address indexed from, address indexed to, uint256 deposit, bytes data);
    event RedeemAttempt(uint256 indexed ticketId, bool success, bool automatic);

    Ticket[] private _tickets;

    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address,
        address,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256 ticketId) {
        uint256 required = l2CallValue + maxSubmissionCost + gasLimit * maxFeePerGas;
        if (msg.value < required) revert InsufficientDeposit(required, msg.value);
        ticketId = _tickets.length;
        _tickets.push(
            Ticket(msg.sender, to, l2CallValue, maxSubmissionCost, gasLimit, maxFeePerGas, msg.value, uint64(block.timestamp), false, data)
        );
        emit TicketCreated(ticketId, msg.sender, to, msg.value, data);
    }

    /// @notice The sequencer's automatic attempt, with the gas limit the sender paid for.
    function autoRedeem(uint256 ticketId) external returns (bool) {
        return _redeem(ticketId, _tickets[ticketId].gasLimit, true);
    }

    /// @notice A manual redeem by anyone (ArbRetryableTx.redeem on Arbitrum), with more gas if needed.
    function redeem(uint256 ticketId, uint256 gasLimit) external returns (bool) {
        return _redeem(ticketId, gasLimit, false);
    }

    function ticket(uint256 ticketId) external view returns (Ticket memory) {
        return _tickets[ticketId];
    }

    function ticketCount() external view returns (uint256) {
        return _tickets.length;
    }

    function _redeem(uint256 ticketId, uint256 gasLimit, bool automatic) private returns (bool ok) {
        Ticket storage t = _tickets[ticketId];
        if (t.redeemed) revert AlreadyRedeemed(ticketId);
        if (block.timestamp > t.createdAt + LIFETIME) revert TicketExpired(ticketId);
        address aliasAddress = AddressAlias.applyL1ToL2Alias(t.from);
        if (aliasAddress.code.length == 0) revert NoExecutorAtAlias(aliasAddress);
        ok = ArbAliasExecutor(aliasAddress).execute(t.to, t.data, gasLimit);
        if (ok) t.redeemed = true;
        emit RedeemAttempt(ticketId, ok, automatic);
    }
}
