// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendGuardVault} from "../../contracts/SpendGuardVault.sol";
import {PasskeyApprover} from "../../contracts/PasskeyApprover.sol";
import {TestToken} from "../../contracts/test/TestToken.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @dev A passkey (P-256, user verified) approves one payment through the unchanged vault.
contract PasskeyApproverTest is Test {
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant PASSKEY_PK = 0xA55E7;
    uint256 internal constant OTHER_PK = 0xBEEF;
    bytes32 internal constant RP_ID_HASH = sha256("localhost");

    SpendGuardVault internal vault;
    TestToken internal token;
    PasskeyApprover internal passkey;
    address internal agent = address(0xA9E47);
    address internal supplier = address(0x5099);
    address internal attacker = address(0xBAD);

    function setUp() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
        passkey = new PasskeyApprover(bytes32(x), bytes32(y), RP_ID_HASH);
        address[] memory approvers = new address[](1);
        approvers[0] = address(passkey);
        vault = new SpendGuardVault(address(this), address(this), approvers, 1, 3600);
        token = new TestToken();
        token.mint(address(vault), 100_000 ether);
        vault.setAgent(agent, true);
        vault.setPolicy(address(token), 200_000 ether, 10_000 ether, 10_000 ether);
    }

    function _approval() internal view returns (SpendGuardVault.Approval memory) {
        return SpendGuardVault.Approval({
            agent: agent,
            token: address(token),
            recipient: supplier,
            maxAmount: 3_400 ether,
            cap: 3_400 ether,
            maxUses: 1,
            expiry: uint64(block.timestamp + 1 days),
            salt: keccak256("passkey-test")
        });
    }

    /// Builds what a browser returns from navigator.credentials.get with the digest as challenge.
    function _assert(uint256 pk, bytes32 digest, bytes32 rpHash, bytes1 flags) internal pure returns (bytes memory) {
        bytes memory authData = abi.encodePacked(rpHash, flags, uint32(1));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost:8799","crossOrigin":false}'
        );
        bytes32 message = sha256(abi.encodePacked(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, message);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        return abi.encode(
            WebAuthn.WebAuthnAuth({
                r: r,
                s: s,
                challengeIndex: 23,
                typeIndex: 1,
                authenticatorData: authData,
                clientDataJSON: clientDataJSON
            })
        );
    }

    function _sigs(bytes memory sig) internal view returns (SpendGuardVault.Signature[] memory s) {
        s = new SpendGuardVault.Signature[](1);
        s[0] = SpendGuardVault.Signature({signer: address(passkey), signature: sig});
    }

    function _req(address to) internal view returns (SpendGuardVault.Request memory) {
        return SpendGuardVault.Request({token: address(token), recipient: to, amount: 3_400 ether});
    }

    function test_fingerprintApprovalPaysOnceThenRefuses() public {
        SpendGuardVault.Approval memory a = _approval();
        bytes32 digest = vault.approvalDigest(a);
        SpendGuardVault.Signature[] memory sigs = _sigs(_assert(PASSKEY_PK, digest, RP_ID_HASH, 0x05));

        vm.startPrank(agent);
        (SpendGuardVault.Outcome o1, SpendGuardVault.Reason r1,) = vault.execute(a, sigs, _req(attacker));
        assertEq(uint8(o1), uint8(SpendGuardVault.Outcome.Refused));
        assertEq(uint8(r1), uint8(SpendGuardVault.Reason.RecipientMismatch));

        (SpendGuardVault.Outcome o2,,) = vault.execute(a, sigs, _req(supplier));
        assertEq(uint8(o2), uint8(SpendGuardVault.Outcome.Executed));
        assertEq(token.balanceOf(supplier), 3_400 ether);

        (, SpendGuardVault.Reason r3,) = vault.execute(a, sigs, _req(supplier));
        assertEq(uint8(r3), uint8(SpendGuardVault.Reason.UsesExhausted));
        vm.stopPrank();
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_otherDeviceKeyIsRefused() public {
        SpendGuardVault.Approval memory a = _approval();
        bytes32 digest = vault.approvalDigest(a);
        SpendGuardVault.Signature[] memory sigs = _sigs(_assert(OTHER_PK, digest, RP_ID_HASH, 0x05));
        vm.prank(agent);
        (, SpendGuardVault.Reason r,) = vault.execute(a, sigs, _req(supplier));
        assertEq(uint8(r), uint8(SpendGuardVault.Reason.BadSignature));
    }

    function test_withoutFingerprintIsRefused() public {
        // User present (0x01) but not user verified: no fingerprint or face check happened.
        SpendGuardVault.Approval memory a = _approval();
        bytes32 digest = vault.approvalDigest(a);
        SpendGuardVault.Signature[] memory sigs = _sigs(_assert(PASSKEY_PK, digest, RP_ID_HASH, 0x01));
        vm.prank(agent);
        (, SpendGuardVault.Reason r,) = vault.execute(a, sigs, _req(supplier));
        assertEq(uint8(r), uint8(SpendGuardVault.Reason.BadSignature));
    }

    function test_otherSiteIsRefused() public {
        SpendGuardVault.Approval memory a = _approval();
        bytes32 digest = vault.approvalDigest(a);
        SpendGuardVault.Signature[] memory sigs = _sigs(_assert(PASSKEY_PK, digest, sha256("evil.example"), 0x05));
        vm.prank(agent);
        (, SpendGuardVault.Reason r,) = vault.execute(a, sigs, _req(supplier));
        assertEq(uint8(r), uint8(SpendGuardVault.Reason.BadSignature));
    }

    function test_signatureForAnotherApprovalIsRefused() public {
        SpendGuardVault.Approval memory a = _approval();
        SpendGuardVault.Approval memory b = _approval();
        b.recipient = attacker;
        bytes memory sigForA = _assert(PASSKEY_PK, vault.approvalDigest(a), RP_ID_HASH, 0x05);
        vm.prank(agent);
        (, SpendGuardVault.Reason r,) = vault.execute(b, _sigs(sigForA), _req(attacker));
        assertEq(uint8(r), uint8(SpendGuardVault.Reason.BadSignature));
    }

    function test_garbageSignatureIsRefusedNotReverted() public {
        SpendGuardVault.Approval memory a = _approval();
        vm.prank(agent);
        (, SpendGuardVault.Reason r,) = vault.execute(a, _sigs(hex"1234"), _req(supplier));
        assertEq(uint8(r), uint8(SpendGuardVault.Reason.BadSignature));
    }
}
