// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {GTokenRetirable} from "../l2/GTokenRetirable.sol";

/// @notice Test token: retirement logic with an admin mint, so retirement tests need no BBS proofs.
contract MockRetirableToken is GTokenRetirable {
    constructor(address ra_) ERC20("Retirable Test", "RT") GTokenRetirable("Retirable Test", ra_) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function mint(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _mint(to, amount);
    }
}
