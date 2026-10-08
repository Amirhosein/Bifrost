// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DataBlob} from "../bbs/DataBlob.sol";

/// @title StorageBench
/// @notice Gas harness only: the different ways a registry could keep a used-credential tag, or a whole
///         credential, on-chain, versus keeping only an IPFS pointer on-chain.
contract StorageBench {
    /// @notice One slot per tag: who registered it, for which chain, and when.
    struct TagRecord {
        uint32 chainKey;
        address registrant;
        uint64 registeredAt;
    }

    mapping(bytes32 => bool) public tagUsed;
    mapping(bytes32 => TagRecord) public tagRecord;
    mapping(bytes32 => bytes) private _blob;
    mapping(bytes32 => address) public blobPointer;
    mapping(bytes32 => bytes32) public cidDigest;
    mapping(bytes32 => bytes) private _cid;

    event CredentialLogged(bytes32 indexed key, bytes data);

    // ---- tags --------------------------------------------------------------

    function storeTag(bytes32 tag) external {
        tagUsed[tag] = true;
    }

    function storeTagRecord(bytes32 tag, uint32 chainKey) external {
        tagRecord[tag] = TagRecord(chainKey, msg.sender, uint64(block.timestamp));
    }

    // ---- whole credential on-chain ------------------------------------------

    /// @notice Plain contract storage: one 32-byte slot per 32 bytes of data.
    function storeBytes(bytes32 key, bytes calldata data) external {
        _blob[key] = data;
    }

    /// @notice SSTORE2: the data becomes the code of a new contract; only its address is stored.
    function storeAsCode(bytes32 key, bytes calldata data) external {
        blobPointer[key] = DataBlob.write(data);
    }

    /// @notice Event log only: cheapest, but contracts can never read it back.
    function logCredential(bytes32 key, bytes calldata data) external {
        emit CredentialLogged(key, data);
    }

    // ---- IPFS pointer only ----------------------------------------------------

    /// @notice The sha2-256 digest of a CIDv1 (raw codec): the fixed CID prefix is implied.
    function storeCidDigest(bytes32 key, bytes32 digest) external {
        cidDigest[key] = digest;
    }

    /// @notice The full binary CIDv1 (36 bytes), for when the codec or hash may vary.
    function storeCidBytes(bytes32 key, bytes calldata cid) external {
        _cid[key] = cid;
    }

    // ---- reads (measured with estimateGas) -----------------------------------

    function readBytes(bytes32 key) external view returns (bytes memory) {
        return _blob[key];
    }

    function readAsCode(bytes32 key, uint256 size) external view returns (bytes memory) {
        return DataBlob.read(blobPointer[key], 0, size);
    }
}
