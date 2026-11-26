// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only token with open minting. Never deploy outside a local chain or testnet.
contract TestToken is ERC20 {
    constructor() ERC20("Test USD", "tUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
