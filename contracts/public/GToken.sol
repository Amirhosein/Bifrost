// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../verify/IVerifier.sol";

contract GToken is ERC20, Pausable, ReentrancyGuard, Ownable {
    struct Disc {
        uint64 epochIndex;
        uint16 typeCode;
        uint256 quantityKWh;
        uint128 policyNonce;
    }

    IVerifier public verifier;
    uint64  public epochSeconds;
    uint64  public t0;
    uint256 public minQtyKWh;
    uint256 public alpha;

    mapping(uint16 => bool) public allowedType;
    mapping(bytes32 => bool) public seenDT;

    event Minted(address indexed to, bytes32 indexed dtHash, uint64 epochIndex, uint16 typeCode, uint256 quantityKWh, uint256 gtAmount);
    event Refused(bytes32 indexed dtHash, uint8 reasonCode);
    event VerifierSet(address indexed verifier);
    event ParamsUpdated(uint64 epochSeconds, uint64 t0, uint256 minQtyKWh, uint256 alpha);
    event TypeAllowed(uint16 indexed typeCode, bool allowed);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) Ownable(msg.sender) {
        epochSeconds = 7 days;
        t0 = 1735689600; // 2025-01-01T00:00:00Z
        minQtyKWh = 10;
        alpha = 1;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setVerifier(IVerifier v) external onlyOwner {
        verifier = v;
        emit VerifierSet(address(v));
    }

    function setParams(uint64 _epochSeconds, uint64 _t0, uint256 _minQtyKWh, uint256 _alpha) external onlyOwner {
        epochSeconds = _epochSeconds;
        t0 = _t0;
        minQtyKWh = _minQtyKWh;
        alpha = _alpha;
        emit ParamsUpdated(_epochSeconds, _t0, _minQtyKWh, _alpha);
    }

    function setAllowedType(uint16 typeCode, bool allowed) external onlyOwner {
        allowedType[typeCode] = allowed;
        emit TypeAllowed(typeCode, allowed);
    }

    function dtHash(Disc memory d) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(d.epochIndex, d.typeCode, d.quantityKWh, d.policyNonce));
    }

    function mint(bytes calldata proof, bytes calldata discBytes) external whenNotPaused nonReentrant {
        Disc memory d = abi.decode(discBytes, (Disc));
        bytes32 h = dtHash(d);

        if (seenDT[h]) { emit Refused(h, 1); revert(); }              // 1 DUPLICATE
        if (!allowedType[d.typeCode]) { emit Refused(h, 2); revert(); } // 2 TYPE_NOT_ALLOWED
        if (d.quantityKWh < minQtyKWh) { emit Refused(h, 3); revert(); } // 3 BELOW_MIN
        if (address(verifier) == address(0) || !verifier.verify(proof, discBytes)) { emit Refused(h, 4); revert(); } // 4 BAD_PROOF

        seenDT[h] = true;                      // Effects
        uint256 gtAmount = alpha * d.quantityKWh;
        _mint(msg.sender, gtAmount);           // Interactions

        emit Minted(msg.sender, h, d.epochIndex, d.typeCode, d.quantityKWh, gtAmount);
    }
}
