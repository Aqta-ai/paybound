// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @title PasskeyApprover
/// @notice An approver that is a passkey (fingerprint or face on the person's own device),
///         for SpendGuardVault. The vault already accepts contract approvers through ERC-1271,
///         so this contract is added with `setApprover(address(this), true)` and the vault
///         itself does not change.
/// @dev The passkey signs the vault's EIP-712 approval digest as its WebAuthn challenge.
///      Verification uses OpenZeppelin's WebAuthn library (P-256, user verification required,
///      so a fingerprint or face check must have happened on the device). The relying party
///      is fixed at deployment, so the same passkey used on another site cannot approve.
///      The public key and relying party are immutable: to change device, deploy a new
///      approver and swap it in the vault.
contract PasskeyApprover is IERC1271 {
    bytes32 public immutable qx;
    bytes32 public immutable qy;
    /// @notice sha256 of the WebAuthn relying party id (e.g. "localhost" or the approval page's host).
    bytes32 public immutable rpIdHash;

    error BadKey();

    constructor(bytes32 qx_, bytes32 qy_, bytes32 rpIdHash_) {
        if (qx_ == bytes32(0) || qy_ == bytes32(0) || rpIdHash_ == bytes32(0)) revert BadKey();
        qx = qx_;
        qy = qy_;
        rpIdHash = rpIdHash_;
    }

    /// @inheritdoc IERC1271
    /// @param hash The vault's approval digest.
    /// @param signature `abi.encode(WebAuthn.WebAuthnAuth)` from the device's assertion.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _valid(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function _valid(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        WebAuthn.WebAuthnAuth memory auth;
        try this.decode(signature) returns (WebAuthn.WebAuthnAuth memory decoded) {
            auth = decoded;
        } catch {
            return false;
        }
        if (auth.authenticatorData.length < 37) return false;
        uint256 jsonLength = bytes(auth.clientDataJSON).length;
        if (auth.typeIndex >= jsonLength || auth.challengeIndex >= jsonLength) return false;
        if (bytes32(_slice32(auth.authenticatorData)) != rpIdHash) return false;
        return WebAuthn.verify(abi.encodePacked(hash), auth, qx, qy, true);
    }

    /// @dev External so a malformed encoding can be caught instead of reverting the vault's check.
    function decode(bytes calldata signature) external pure returns (WebAuthn.WebAuthnAuth memory) {
        return abi.decode(signature, (WebAuthn.WebAuthnAuth));
    }

    function _slice32(bytes memory b) private pure returns (bytes32 out) {
        assembly ("memory-safe") {
            out := mload(add(b, 32))
        }
    }
}
