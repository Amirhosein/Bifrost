// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IInbox} from "../arbitrum/IInbox.sol";
import {ICrossDomainMessenger} from "../interfaces/ICrossDomainMessenger.sol";
import {IBbsBls12381Verifier} from "../interfaces/IBbsBls12381Verifier.sol";
import {OptionAClaims} from "./OptionAClaims.sol";

/// @notice OP Stack's L1CrossDomainMessenger exposes the nonce of the next message.
interface IOpMessageNonce {
    function messageNonce() external view returns (uint256);
}

/// @notice What the registry calls on an Option A token (the L2 side of each message).
interface IOptionAToken {
    /// @notice A1: mint after the registry has checked the proof on L1.
    function mintFromRegistry(bytes32 serial, address recipient, uint256 amount) external;

    /// @notice A2: allow this serial to be minted here; the token checks the proof itself.
    function authorizeSerial(bytes32 serial) external;
}

/// @title RegistryL1 (Option A, experimental)
/// @notice One shared list of used credentials on Ethereum, so a producer can choose which chain to mint
///         on while each credential is tokenized only once. Every check happens BEFORE the mint.
/// @dev Two ways to use it, kept side by side to compare their cost:
///   A1 `registerAndMint`: the registry verifies the BBS proof on L1, records the serial, and sends
///      `mintFromRegistry` to the chosen chain. One producer transaction; the L2 does no BBS check.
///   A2 `commit` + `reveal`: the producer first commits to (serial, chain), then reveals it; the registry
///      records the serial and sends `authorizeSerial`. The producer then mints on that chain with the
///      full proof. Cheap on L1; the commitment stops a mempool observer from registering the serial for
///      another chain first, because it cannot hold a commitment older than the moment the serial appeared.
///   Messages go straight from this contract to each chain's bridge, so the L2 sees this contract as
///   the sender: Arbitrum delivers from alias(this), OP Stack via the L2 messenger with
///   xDomainMessageSender() == this.
contract RegistryL1 is AccessControl {
    enum BridgeKind {
        None,
        Arbitrum,
        OpStack
    }

    enum Mode {
        None,
        VerifyOnL1, // A1
        VerifyOnL2 // A2
    }

    /// @notice How to reach one L2 token.
    struct Route {
        BridgeKind kind;
        address bridge; // Arbitrum: L1 Inbox. OP Stack: L1CrossDomainMessenger.
        address l2Token;
    }

    /// @notice Bridge fee parameters. Arbitrum uses all three; OP Stack uses `gasLimit` as minGasLimit.
    struct BridgeFee {
        uint256 maxSubmissionCost;
        uint256 gasLimit;
        uint256 maxFeePerGas;
    }

    /// @dev Packed: one slot for A2, two for A1. The registrant is only in the `Registered` event.
    struct Registration {
        address recipient; // A1 only
        uint32 chainKey;
        Mode mode;
        uint56 registeredAt;
        uint256 amount; // A1 only
    }

    uint64 public constant MIN_COMMIT_AGE = 60; // seconds; a commitment must be at least this old to reveal
    uint64 public constant MAX_COMMIT_AGE = 1 days;

    error UnknownChain(uint32 chainKey);
    error AlreadyRegistered(bytes32 serial, uint32 chainKey);
    error ZeroRecipient();
    error DeadlinePassed();
    error Expired();
    error InvalidProof();
    error CommitmentMissing();
    error CommitmentTooNew();
    error CommitmentTooOld();
    error NotRegistered(bytes32 serial);
    error ChainAlreadyConfigured(uint32 chainKey);
    error BadRecipient();
    error UnexpectedValue();

    event RouteSet(uint32 indexed chainKey, BridgeKind kind, address bridge, address l2Token);
    event Committed(bytes32 indexed commitment, address indexed committer);
    event Registered(bytes32 indexed serial, uint32 indexed chainKey, address indexed registrant, Mode mode);
    event MessageSent(bytes32 indexed serial, uint32 indexed chainKey, BridgeKind kind, uint256 messageId, bytes payload);

    IBbsBls12381Verifier public immutable verifier;
    uint256 public immutable issuerDomain;

    mapping(uint32 => Route) public routes;
    mapping(bytes32 => Registration) public registrations;
    mapping(bytes32 => uint64) public commitments;

    constructor(address verifier_) {
        IBbsBls12381Verifier v = IBbsBls12381Verifier(verifier_);
        require(v.messageCount() == OptionAClaims.MESSAGE_COUNT, "verifier L mismatch");
        verifier = v;
        issuerDomain = v.domainFor(OptionAClaims.systemHeader(block.chainid, address(this)));
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Set once per chain: re-pointing a chain to another token would let `resend` mint twice.
    function setRoute(uint32 chainKey, BridgeKind kind, address bridge, address l2Token)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (routes[chainKey].kind != BridgeKind.None) revert ChainAlreadyConfigured(chainKey);
        routes[chainKey] = Route(kind, bridge, l2Token);
        emit RouteSet(chainKey, kind, bridge, l2Token);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice BBS header the RA signs into Option A credentials.
    function issuerHeader() external view returns (bytes memory) {
        return OptionAClaims.systemHeader(block.chainid, address(this));
    }

    /// @notice A1 presentation header: binds the proof to this registry, the chosen chain and one mint.
    function presentationHeader(uint32 chainKey, address recipient, uint256 amount, bytes32 serial, uint64 deadline)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(
            OptionAClaims.REGISTRY_MINT_TAG, block.chainid, address(this), chainKey, recipient, amount, serial, deadline
        );
    }

    /// @notice A2 commitment the producer publishes before revealing the serial.
    function commitmentOf(bytes32 serial, uint32 chainKey, address registrant, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(serial, chainKey, registrant, salt));
    }

    function isRegistered(bytes32 serial) external view returns (bool) {
        return registrations[serial].mode != Mode.None;
    }

    // ------------------------------------------------------------------
    // A1: verify on L1, mint by message
    // ------------------------------------------------------------------

    function registerAndMint(
        uint32 chainKey,
        address recipient,
        OptionAClaims.Claims calldata claims,
        uint64 deadline,
        IBbsBls12381Verifier.Proof calldata proof,
        BridgeFee calldata fee
    ) external payable returns (uint256 messageId) {
        if (recipient == address(0)) revert ZeroRecipient();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (block.timestamp > claims.expiry) revert Expired();
        Route memory route = _route(chainKey);
        if (recipient == route.l2Token) revert BadRecipient();
        _requireFree(claims.serial);

        // All business checks happen here on L1: the L2 side must never revert once the serial is used,
        // or the message would fail on every retry.
        bool ok = verifier.verifyProof(
            issuerDomain,
            presentationHeader(chainKey, recipient, claims.qtyKWh, claims.serial, deadline),
            OptionAClaims.disclosedIndexes(),
            OptionAClaims.disclosedScalars(claims),
            proof
        );
        if (!ok) revert InvalidProof();

        registrations[claims.serial] =
            Registration(recipient, chainKey, Mode.VerifyOnL1, uint56(block.timestamp), claims.qtyKWh);
        emit Registered(claims.serial, chainKey, msg.sender, Mode.VerifyOnL1);

        bytes memory payload =
            abi.encodeCall(IOptionAToken.mintFromRegistry, (claims.serial, recipient, claims.qtyKWh));
        messageId = _send(claims.serial, chainKey, route, payload, fee);
    }

    // ------------------------------------------------------------------
    // A2: commit, reveal, then verify on the chosen L2
    // ------------------------------------------------------------------

    function commit(bytes32 commitment) external {
        if (commitments[commitment] == 0) {
            commitments[commitment] = uint64(block.timestamp);
            emit Committed(commitment, msg.sender);
        }
    }

    function reveal(bytes32 serial, uint32 chainKey, bytes32 salt, BridgeFee calldata fee)
        external
        payable
        returns (uint256 messageId)
    {
        bytes32 c = commitmentOf(serial, chainKey, msg.sender, salt);
        uint64 at = commitments[c];
        if (at == 0) revert CommitmentMissing();
        if (block.timestamp < at + MIN_COMMIT_AGE) revert CommitmentTooNew();
        if (block.timestamp > at + MAX_COMMIT_AGE) revert CommitmentTooOld();
        Route memory route = _route(chainKey);
        _requireFree(serial);
        delete commitments[c];

        registrations[serial] = Registration(address(0), chainKey, Mode.VerifyOnL2, uint56(block.timestamp), 0);
        emit Registered(serial, chainKey, msg.sender, Mode.VerifyOnL2);

        messageId = _send(serial, chainKey, route, abi.encodeCall(IOptionAToken.authorizeSerial, (serial)), fee);
    }

    // ------------------------------------------------------------------
    // Recovery from a lost message
    // ------------------------------------------------------------------

    /// @notice Sends a registration's message again (e.g. the Arbitrum ticket expired or was cancelled, or
    ///         an OP message was never relayed). L1 cannot see what happened on L2, so anyone may call
    ///         this at any time; it is safe because the payload is rebuilt from the stored registration,
    ///         routes are set once, and the L2 side ignores repeats, so it can never mint twice.
    function resend(bytes32 serial, BridgeFee calldata fee) external payable returns (uint256 messageId) {
        Registration memory reg = registrations[serial];
        if (reg.mode == Mode.None) revert NotRegistered(serial);
        Route memory route = _route(reg.chainKey);
        bytes memory payload = reg.mode == Mode.VerifyOnL1
            ? abi.encodeCall(IOptionAToken.mintFromRegistry, (serial, reg.recipient, reg.amount))
            : abi.encodeCall(IOptionAToken.authorizeSerial, (serial));
        messageId = _send(serial, reg.chainKey, route, payload, fee);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _route(uint32 chainKey) private view returns (Route memory route) {
        route = routes[chainKey];
        if (route.kind == BridgeKind.None) revert UnknownChain(chainKey);
    }

    function _requireFree(bytes32 serial) private view {
        Registration storage reg = registrations[serial];
        if (reg.mode != Mode.None) revert AlreadyRegistered(serial, reg.chainKey);
    }

    function _send(bytes32 serial, uint32 chainKey, Route memory route, bytes memory payload, BridgeFee calldata fee)
        private
        returns (uint256 messageId)
    {
        if (route.kind == BridgeKind.Arbitrum) {
            // Retryable ticket: the L2 call runs from alias(this). Unused fees go back to the caller.
            messageId = IInbox(route.bridge).createRetryableTicket{value: msg.value}(
                route.l2Token, 0, fee.maxSubmissionCost, msg.sender, msg.sender, fee.gasLimit, fee.maxFeePerGas, payload
            );
        } else {
            // OP Stack deposit: the L2 messenger calls the token with xDomainMessageSender() == this.
            if (msg.value != 0) revert UnexpectedValue();
            messageId = IOpMessageNonce(route.bridge).messageNonce();
            ICrossDomainMessenger(route.bridge).sendMessage(route.l2Token, payload, uint32(fee.gasLimit));
        }
        emit MessageSent(serial, chainKey, route.kind, messageId, payload);
    }
}
