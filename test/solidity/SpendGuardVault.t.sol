// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {SpendGuardVault} from "../../contracts/SpendGuardVault.sol";
import {TestToken} from "../../contracts/test/TestToken.sol";

/// @dev Recipient that tries to re-enter the vault when it receives native BNB.
contract ReentrantRecipient {
    SpendGuardVault internal vault;
    SpendGuardVault.Approval internal a;
    SpendGuardVault.Signature[] internal sigs;
    SpendGuardVault.Request internal r;

    function arm(
        SpendGuardVault v,
        SpendGuardVault.Approval memory a_,
        SpendGuardVault.Signature[] memory sigs_,
        SpendGuardVault.Request memory r_
    ) external {
        vault = v;
        a = a_;
        for (uint256 i = 0; i < sigs_.length; i++) sigs.push(sigs_[i]);
        r = r_;
    }

    receive() external payable {
        vault.execute(a, sigs, r);
    }
}

contract SpendGuardVaultTest is Test {
    SpendGuardVault internal vault;
    TestToken internal token;

    uint256 internal constant APPROVER_A_PK = 0xA11CE;
    uint256 internal constant APPROVER_B_PK = 0xB0B;
    uint256 internal constant APPROVER_C_PK = 0xC0C;
    uint256 internal constant ATTACKER_PK = 0xBAD;
    address internal approverA;
    address internal approverB;
    address internal approverC;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal agent = makeAddr("agent");
    address internal supplier = makeAddr("supplier");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        approverA = vm.addr(APPROVER_A_PK);
        approverB = vm.addr(APPROVER_B_PK);
        approverC = vm.addr(APPROVER_C_PK);
        address[] memory approvers = new address[](3);
        approvers[0] = approverA;
        approvers[1] = approverB;
        approvers[2] = approverC;
        vault = new SpendGuardVault(owner, guardian, approvers, 2, 1 days);
        token = new TestToken();
        token.mint(address(vault), 100_000e18);
        vm.deal(address(vault), 10 ether);
        vm.prank(owner);
        vault.setAgent(agent, true);
        vm.warp(1_800_000_000);
    }

    // ------------------------------------------------------------------ helpers

    function _approval(uint256 maxAmount) internal view returns (SpendGuardVault.Approval memory a) {
        a = SpendGuardVault.Approval({
            agent: agent,
            token: address(token),
            recipient: supplier,
            maxAmount: maxAmount,
            cap: maxAmount,
            maxUses: 1,
            expiry: uint64(block.timestamp + 1 days),
            salt: bytes32(uint256(1))
        });
    }

    function _sigBy(uint256 pk, SpendGuardVault.Approval memory a)
        internal
        view
        returns (SpendGuardVault.Signature memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.approvalDigest(a));
        return SpendGuardVault.Signature({signer: vm.addr(pk), signature: abi.encodePacked(r, s, v)});
    }

    function _sign(uint256 pk, SpendGuardVault.Approval memory a)
        internal
        view
        returns (SpendGuardVault.Signature[] memory sigs)
    {
        sigs = new SpendGuardVault.Signature[](1);
        sigs[0] = _sigBy(pk, a);
    }

    /// @dev Signs with two keys, sorted by signer address as the contract requires.
    function _sign2(uint256 pk1, uint256 pk2, SpendGuardVault.Approval memory a)
        internal
        view
        returns (SpendGuardVault.Signature[] memory sigs)
    {
        sigs = new SpendGuardVault.Signature[](2);
        SpendGuardVault.Signature memory s1 = _sigBy(pk1, a);
        SpendGuardVault.Signature memory s2 = _sigBy(pk2, a);
        (sigs[0], sigs[1]) = s1.signer < s2.signer ? (s1, s2) : (s2, s1);
    }

    function _request(SpendGuardVault.Approval memory a, uint256 amount)
        internal
        pure
        returns (SpendGuardVault.Request memory)
    {
        return SpendGuardVault.Request({token: a.token, recipient: a.recipient, amount: amount});
    }

    /// @dev Submits as the agent and asserts the outcome and reason.
    function _expect(
        SpendGuardVault.Approval memory a,
        SpendGuardVault.Signature[] memory sigs,
        SpendGuardVault.Request memory r,
        SpendGuardVault.Outcome wantOutcome,
        SpendGuardVault.Reason wantReason
    ) internal returns (uint256 pendingId) {
        vm.prank(agent);
        (SpendGuardVault.Outcome outcome, SpendGuardVault.Reason reason, uint256 id) = vault.execute(a, sigs, r);
        assertEq(uint8(outcome), uint8(wantOutcome), "outcome");
        assertEq(uint8(reason), uint8(wantReason), "reason");
        return id;
    }

    function _refused(
        SpendGuardVault.Approval memory a,
        SpendGuardVault.Signature[] memory sigs,
        SpendGuardVault.Request memory r,
        SpendGuardVault.Reason reason
    ) internal {
        _expect(a, sigs, r, SpendGuardVault.Outcome.Refused, reason);
    }

    function _executed(
        SpendGuardVault.Approval memory a,
        SpendGuardVault.Signature[] memory sigs,
        SpendGuardVault.Request memory r
    ) internal {
        _expect(a, sigs, r, SpendGuardVault.Outcome.Executed, SpendGuardVault.Reason.Ok);
    }

    function _queue(SpendGuardVault.Approval memory a, SpendGuardVault.Signature[] memory sigs, uint256 amount)
        internal
        returns (uint256)
    {
        return _expect(a, sigs, _request(a, amount), SpendGuardVault.Outcome.Queued, SpendGuardVault.Reason.Ok);
    }

    function _reasonNow(
        SpendGuardVault.Approval memory a,
        SpendGuardVault.Signature[] memory sigs,
        SpendGuardVault.Request memory r
    ) internal view returns (SpendGuardVault.Reason reason) {
        (reason,) = vault.check(agent, a, sigs, r);
    }

    function _refusedSelector(SpendGuardVault.Reason reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SpendGuardVault.Refused.selector, reason);
    }

    // ------------------------------------------------------------------ happy path

    function test_executesApprovedTransfer() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        bytes32 digest = vault.approvalDigest(a);

        vm.expectEmit(true, true, true, true, address(vault));
        emit SpendGuardVault.SpendExecuted(digest, agent, supplier, address(token), 4_800e18, 1, 4_800e18);
        _executed(a, sigs, _request(a, 4_800e18));

        assertEq(token.balanceOf(supplier), 4_800e18);
        (uint32 uses, bool revoked, uint256 spent) = vault.usage(digest);
        assertEq(uses, 1);
        assertFalse(revoked);
        assertEq(spent, 4_800e18);
    }

    function test_partialAmountWithinApprovalIsAllowed() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        _executed(a, _sign(APPROVER_A_PK, a), _request(a, 1_000e18));
        assertEq(token.balanceOf(supplier), 1_000e18);
    }

    function test_nativeBnbTransfer() public {
        SpendGuardVault.Approval memory a = _approval(1 ether);
        a.token = address(0);
        _executed(a, _sign(APPROVER_A_PK, a), _request(a, 1 ether));
        assertEq(supplier.balance, 1 ether);
    }

    // ------------------------------------------------------------------ 1. stolen agent hot key

    /// The attacker holds the agent's private key and calls the vault as the agent,
    /// but has no approver key. Every drain attempt is refused and logged.
    function test_stolenAgentKey_cannotDrainWithoutApproval() public {
        SpendGuardVault.Approval memory forged = _approval(100_000e18);
        forged.recipient = attacker;

        // No signature at all.
        _refused(forged, new SpendGuardVault.Signature[](0), _request(forged, 100_000e18), SpendGuardVault.Reason.BadSignature);
        // Signed with the attacker's key but listed under an approver's address.
        SpendGuardVault.Signature[] memory fake = _sign(ATTACKER_PK, forged);
        fake[0].signer = approverA;
        _refused(forged, fake, _request(forged, 100_000e18), SpendGuardVault.Reason.BadSignature);
        // Signed with the attacker's key under its own address.
        _refused(forged, _sign(ATTACKER_PK, forged), _request(forged, 100_000e18), SpendGuardVault.Reason.BadSignature);
        // Native BNB too.
        forged.token = address(0);
        _refused(forged, _sign(ATTACKER_PK, forged), _request(forged, 10 ether), SpendGuardVault.Reason.BadSignature);
        // Owner and guardian functions are out of reach of the agent key.
        vm.startPrank(agent);
        vm.expectRevert();
        vault.withdraw(address(token), attacker, 1);
        vm.expectRevert();
        vault.setAgent(attacker, true);
        vm.expectRevert(SpendGuardVault.NotAuthorised.selector);
        vault.freeze();
        vm.stopPrank();

        assertEq(token.balanceOf(attacker), 0);
        assertEq(attacker.balance, 0);
        assertEq(token.balanceOf(address(vault)), 100_000e18);
    }

    function test_stolenAgentKey_cannotReuseOrRedirectAnApproval() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        _executed(a, sigs, _request(a, 4_800e18)); // the legitimate payment

        // Replay the used approval.
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.UsesExhausted);
        // Redirect a second, unused approval to the attacker.
        SpendGuardVault.Approval memory b = _approval(4_800e18);
        b.salt = bytes32(uint256(2));
        SpendGuardVault.Signature[] memory sigsB = _sign(APPROVER_A_PK, b);
        SpendGuardVault.Request memory r = _request(b, 4_800e18);
        r.recipient = attacker;
        _refused(b, sigsB, r, SpendGuardVault.Reason.RecipientMismatch);
        // Edit the signed recipient.
        b.recipient = attacker;
        _refused(b, sigsB, _request(b, 4_800e18), SpendGuardVault.Reason.BadSignature);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_stolenAgentKey_guardianCanCutItOff() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        vm.prank(guardian);
        vault.disableAgent(agent);
        vm.prank(agent);
        vm.expectRevert(_refusedSelector(SpendGuardVault.Reason.NotAgent));
        vault.execute(a, sigs, _request(a, 4_800e18));
        // The guardian cannot re-enable it; only the owner can.
        vm.prank(guardian);
        vm.expectRevert();
        vault.setAgent(agent, true);
    }

    function test_outsiderCannotExecuteEvenWithAValidApproval() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        vm.prank(attacker);
        vm.expectRevert(_refusedSelector(SpendGuardVault.Reason.NotAgent));
        vault.execute(a, sigs, _request(a, 4_800e18));
    }

    function test_approvalBoundToAnotherRegisteredAgentIsRefused() public {
        address agent2 = makeAddr("agent2");
        vm.prank(owner);
        vault.setAgent(agent2, true);
        SpendGuardVault.Approval memory a = _approval(4_800e18); // names `agent`
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        vm.prank(agent2);
        (SpendGuardVault.Outcome outcome, SpendGuardVault.Reason reason,) = vault.execute(a, sigs, _request(a, 4_800e18));
        assertEq(uint8(outcome), uint8(SpendGuardVault.Outcome.Refused));
        assertEq(uint8(reason), uint8(SpendGuardVault.Reason.NotAgent));
    }

    // ------------------------------------------------------------------ approval tampering

    function test_refuses_changedRecipient() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Request memory r = _request(a, 4_800e18);
        r.recipient = attacker;
        _refused(a, _sign(APPROVER_A_PK, a), r, SpendGuardVault.Reason.RecipientMismatch);
    }

    function test_refuses_raisedAmount() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        _refused(a, _sign(APPROVER_A_PK, a), _request(a, 5_000e18), SpendGuardVault.Reason.AmountAboveApproval);
    }

    function test_refuses_editedApprovalAmount() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        a.maxAmount = 50_000e18;
        a.cap = 50_000e18;
        _refused(a, sigs, _request(a, 50_000e18), SpendGuardVault.Reason.BadSignature);
    }

    function test_refuses_expiredApproval() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        vm.warp(a.expiry);
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.Expired);
    }

    function test_refuses_cumulativeCapExceeded() public {
        SpendGuardVault.Approval memory a = _approval(100e18);
        a.maxUses = 5;
        a.cap = 250e18;
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        _executed(a, sigs, _request(a, 100e18));
        _executed(a, sigs, _request(a, 100e18));
        _refused(a, sigs, _request(a, 100e18), SpendGuardVault.Reason.CapExceeded);
        _executed(a, sigs, _request(a, 50e18)); // exactly reaches the cap
        _refused(a, sigs, _request(a, 1), SpendGuardVault.Reason.CapExceeded);
        assertEq(token.balanceOf(supplier), 250e18);
    }

    function test_refuses_usesExhaustedOnMultiUseApproval() public {
        SpendGuardVault.Approval memory a = _approval(10e18);
        a.maxUses = 2;
        a.cap = 1_000e18;
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        _executed(a, sigs, _request(a, 10e18));
        _executed(a, sigs, _request(a, 10e18));
        _refused(a, sigs, _request(a, 10e18), SpendGuardVault.Reason.UsesExhausted);
    }

    function test_refuses_wrongSigner() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        _refused(a, _sign(ATTACKER_PK, a), _request(a, 4_800e18), SpendGuardVault.Reason.BadSignature);
    }

    function test_refuses_malleableHighSSignature() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(APPROVER_A_PK, vault.approvalDigest(a));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        SpendGuardVault.Signature[] memory sigs = new SpendGuardVault.Signature[](1);
        sigs[0] = SpendGuardVault.Signature({
            signer: approverA,
            signature: abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27))
        });
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.BadSignature);
    }

    function test_refuses_wrongToken() public {
        SpendGuardVault.Approval memory a = _approval(1e18);
        SpendGuardVault.Request memory r = _request(a, 1e18);
        r.token = address(0);
        _refused(a, _sign(APPROVER_A_PK, a), r, SpendGuardVault.Reason.TokenMismatch);
    }

    function test_refuses_revokedApproval() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        bytes32 digest = vault.approvalDigest(a);
        vm.prank(approverB);
        vault.revoke(digest);
        _refused(a, _sign(APPROVER_A_PK, a), _request(a, 4_800e18), SpendGuardVault.Reason.Revoked);
    }

    function test_revokeIsRestricted() public {
        vm.prank(attacker);
        vm.expectRevert(SpendGuardVault.NotAuthorised.selector);
        vault.revoke(bytes32(uint256(1)));
        vm.prank(agent);
        vm.expectRevert(SpendGuardVault.NotAuthorised.selector);
        vault.revoke(bytes32(uint256(1)));
    }

    function test_refuses_afterApproverRemoved() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        vm.prank(owner);
        vault.setApprover(approverA, false);
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.BadSignature);
    }

    function test_refuses_approvalSignedForAnotherVault() public {
        address[] memory approvers = new address[](1);
        approvers[0] = approverA;
        SpendGuardVault other = new SpendGuardVault(owner, guardian, approvers, 1, 0);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(APPROVER_A_PK, other.approvalDigest(a));
        SpendGuardVault.Signature[] memory sigs = new SpendGuardVault.Signature[](1);
        sigs[0] = SpendGuardVault.Signature({signer: approverA, signature: abi.encodePacked(r, s, v)});
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.BadSignature);
    }

    function test_refuses_approvalSignedForAnotherChain() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        vm.chainId(56);
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.BadSignature);
    }

    function test_refuses_insufficientBalance() public {
        SpendGuardVault.Approval memory a = _approval(1_000_000e18);
        _refused(a, _sign(APPROVER_A_PK, a), _request(a, 1_000_000e18), SpendGuardVault.Reason.InsufficientBalance);
    }

    function test_reentrancyIsBlocked() public {
        ReentrantRecipient evil = new ReentrantRecipient();
        SpendGuardVault.Approval memory a = _approval(1 ether);
        a.token = address(0);
        a.recipient = address(evil);
        a.maxUses = 2;
        a.cap = 2 ether;
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        SpendGuardVault.Request memory r = _request(a, 1 ether);
        evil.arm(vault, a, sigs, r);
        vm.prank(agent);
        vm.expectRevert();
        vault.execute(a, sigs, r);
        assertEq(address(evil).balance, 0);
    }

    // ------------------------------------------------------------------ 6. guardian freeze

    function test_guardianFreezesInstantly_onlyOwnerUnfreezes() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);

        vm.prank(guardian);
        vault.freeze();
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.Paused);

        // A stolen guardian key can stop payments but cannot restart them.
        vm.prank(guardian);
        vm.expectRevert();
        vault.unfreeze();
        vm.prank(agent);
        vm.expectRevert(SpendGuardVault.NotAuthorised.selector);
        vault.freeze();

        vm.prank(owner);
        vault.unfreeze();
        _executed(a, sigs, _request(a, 4_800e18));
    }

    function test_guardianCannotMoveFundsOrChangeConfig() public {
        vm.startPrank(guardian);
        vm.expectRevert();
        vault.withdraw(address(token), guardian, 1);
        vm.expectRevert();
        vault.setApprover(guardian, true);
        vm.expectRevert();
        vault.setPolicy(address(token), 0, 0, 0);
        vm.expectRevert();
        vault.setRecipientAllowed(guardian, true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ 4. timelock

    function test_largeTransferIsQueued_thenReleasedAfterDelay() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 1_000e18, 0);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        uint256 id = _queue(a, _sign(APPROVER_A_PK, a), 4_800e18);
        assertEq(token.balanceOf(supplier), 0);

        vm.prank(agent);
        vm.expectRevert(SpendGuardVault.NotReleasable.selector);
        vault.release(id);

        vm.warp(block.timestamp + 1 days);
        vm.prank(attacker);
        vm.expectRevert(SpendGuardVault.NotAuthorised.selector);
        vault.release(id);

        vm.prank(agent);
        vault.release(id);
        assertEq(token.balanceOf(supplier), 4_800e18);

        vm.prank(agent);
        vm.expectRevert(SpendGuardVault.NotReleasable.selector);
        vault.release(id); // no double release
    }

    function test_smallTransferIsNotDelayed() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 1_000e18, 0);
        SpendGuardVault.Approval memory a = _approval(1_000e18);
        _executed(a, _sign(APPROVER_A_PK, a), _request(a, 1_000e18));
        assertEq(token.balanceOf(supplier), 1_000e18);
    }

    function test_guardianCancelsQueuedTransferDuringDelay() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 1_000e18, 0);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        uint256 id = _queue(a, sigs, 4_800e18);

        vm.prank(guardian);
        vault.cancel(id);
        vm.warp(block.timestamp + 2 days);
        vm.prank(agent);
        vm.expectRevert(SpendGuardVault.NotReleasable.selector);
        vault.release(id);
        assertEq(token.balanceOf(supplier), 0);
    }

    function test_cancelledQueueKeepsApprovalUsed() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 1_000e18, 0);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        uint256 id = _queue(a, sigs, 4_800e18);
        vm.prank(owner);
        vault.cancel(id);
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.UsesExhausted);
    }

    function test_frozenVaultBlocksRelease() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 1_000e18, 0);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        uint256 id = _queue(a, _sign(APPROVER_A_PK, a), 4_800e18);
        vm.warp(block.timestamp + 1 days);
        vm.prank(guardian);
        vault.freeze();
        vm.prank(agent);
        vm.expectRevert(_refusedSelector(SpendGuardVault.Reason.Paused));
        vault.release(id);
    }

    function test_disabledAgentCannotReleaseItsQueue() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 1_000e18, 0);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        uint256 id = _queue(a, _sign(APPROVER_A_PK, a), 4_800e18);
        vm.prank(guardian);
        vault.disableAgent(agent);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(SpendGuardVault.NotAuthorised.selector);
        vault.release(id);
    }

    function test_cancelIsRestricted() public {
        vm.prank(agent);
        vm.expectRevert(SpendGuardVault.NotAuthorised.selector);
        vault.cancel(1);
    }

    // ------------------------------------------------------------------ 2. recipient allowlist

    function test_allowlistRefusesUnlistedRecipientEvenWithApproval() public {
        vm.prank(owner);
        vault.setAllowlistEnabled(true);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.RecipientNotAllowed);

        vm.prank(owner);
        vault.setRecipientAllowed(supplier, true);
        _executed(a, sigs, _request(a, 4_800e18));
    }

    function test_allowlistRemovalDuringDelayBlocksRelease() public {
        vm.startPrank(owner);
        vault.setAllowlistEnabled(true);
        vault.setRecipientAllowed(supplier, true);
        vault.setPolicy(address(token), 0, 1_000e18, 0);
        vm.stopPrank();
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        uint256 id = _queue(a, _sign(APPROVER_A_PK, a), 4_800e18);
        vm.prank(owner);
        vault.setRecipientAllowed(supplier, false);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(_refusedSelector(SpendGuardVault.Reason.RecipientNotAllowed));
        vault.release(id);
    }

    // ------------------------------------------------------------------ 3. daily limit

    function test_dailyLimitAppliesAcrossSeparateApprovals() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 5_000e18, 0, 0);

        SpendGuardVault.Approval memory a = _approval(3_000e18);
        _executed(a, _sign(APPROVER_A_PK, a), _request(a, 3_000e18));

        SpendGuardVault.Approval memory b = _approval(3_000e18);
        b.salt = bytes32(uint256(2));
        b.expiry = uint64(block.timestamp + 3 days);
        SpendGuardVault.Signature[] memory sigsB = _sign(APPROVER_A_PK, b);
        _refused(b, sigsB, _request(b, 3_000e18), SpendGuardVault.Reason.DailyLimitExceeded);

        // The next UTC day the same approval goes through.
        vm.warp(block.timestamp + 1 days);
        _executed(b, sigsB, _request(b, 3_000e18));
        assertEq(token.balanceOf(supplier), 6_000e18);
    }

    /// The daily limit counts funds when they leave, so a queued transfer is
    /// checked again on release and waits for a day with room.
    function test_dailyLimitAppliesOnRelease() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 6_000e18, 1_000e18, 0);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        a.expiry = uint64(block.timestamp + 5 days);
        uint256 id = _queue(a, _sign(APPROVER_A_PK, a), 4_800e18);
        vm.warp(block.timestamp + 1 days);

        SpendGuardVault.Approval memory b = _approval(1_000e18);
        b.salt = bytes32(uint256(2));
        b.expiry = uint64(block.timestamp + 1 days);
        _executed(b, _sign(APPROVER_A_PK, b), _request(b, 1_000e18)); // 1,000 out today

        vm.prank(owner);
        vault.setPolicy(address(token), 5_000e18, 1_000e18, 0);
        vm.prank(agent);
        vm.expectRevert(_refusedSelector(SpendGuardVault.Reason.DailyLimitExceeded));
        vault.release(id); // 1,000 + 4,800 > 5,000

        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vault.release(id);
        assertEq(token.balanceOf(supplier), 5_800e18);
    }

    function test_dailyLimitIsPerToken() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 1_000e18, 0, 0);
        SpendGuardVault.Approval memory a = _approval(1 ether);
        a.token = address(0);
        _executed(a, _sign(APPROVER_A_PK, a), _request(a, 1 ether));
    }

    // ------------------------------------------------------------------ 5. M-of-N approvers

    function test_largeApprovalNeedsTwoApprovers_oneStolenKeyIsNotEnough() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 0, 10_000e18);
        SpendGuardVault.Approval memory a = _approval(50_000e18);
        a.recipient = attacker; // an attacker holding approver A's key signs a large drain

        _refused(a, _sign(APPROVER_A_PK, a), _request(a, 50_000e18), SpendGuardVault.Reason.NotEnoughApprovers);

        // Listing the same signer twice does not count twice.
        SpendGuardVault.Signature[] memory dup = new SpendGuardVault.Signature[](2);
        dup[0] = _sigBy(APPROVER_A_PK, a);
        dup[1] = _sigBy(APPROVER_A_PK, a);
        _refused(a, dup, _request(a, 50_000e18), SpendGuardVault.Reason.BadSignature);

        // Approver A plus a non-approver key is not enough either.
        _refused(a, _sign2(APPROVER_A_PK, ATTACKER_PK, a), _request(a, 50_000e18), SpendGuardVault.Reason.BadSignature);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_largeApprovalWithTwoApproversExecutes() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 0, 10_000e18);
        SpendGuardVault.Approval memory a = _approval(50_000e18);
        _executed(a, _sign2(APPROVER_A_PK, APPROVER_C_PK, a), _request(a, 50_000e18));
        assertEq(token.balanceOf(supplier), 50_000e18);
    }

    /// Splitting a large spend into small transfers does not dodge M-of-N: the
    /// threshold applies to the approval's total cap, not to each transfer.
    function test_multiApprovalAppliesToCapNotPerTransfer() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 0, 10_000e18);
        SpendGuardVault.Approval memory a = _approval(1_000e18);
        a.maxUses = 50;
        a.cap = 50_000e18;
        _refused(a, _sign(APPROVER_A_PK, a), _request(a, 1_000e18), SpendGuardVault.Reason.NotEnoughApprovers);
    }

    function test_unsortedSignersAreRefused() public {
        vm.prank(owner);
        vault.setPolicy(address(token), 0, 0, 10_000e18);
        SpendGuardVault.Approval memory a = _approval(50_000e18);
        SpendGuardVault.Signature[] memory sigs = _sign2(APPROVER_A_PK, APPROVER_B_PK, a);
        (sigs[0], sigs[1]) = (sigs[1], sigs[0]);
        _refused(a, sigs, _request(a, 50_000e18), SpendGuardVault.Reason.BadSignature);
    }

    function test_cannotSetThresholdAboveApproverCount() public {
        vm.prank(owner);
        vm.expectRevert(SpendGuardVault.BadConfig.selector);
        vault.setRequiredApprovals(4);
        vm.startPrank(owner);
        vault.setRequiredApprovals(3);
        vm.expectRevert(SpendGuardVault.BadConfig.selector);
        vault.setApprover(approverA, false);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ 7. incident log

    function test_everyRefusalFromAnAgentIsLoggedWithItsReason() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        SpendGuardVault.Request memory r = _request(a, 4_800e18);
        r.recipient = attacker;
        bytes32 digest = vault.approvalDigest(a);

        vm.expectEmit(true, true, true, true, address(vault));
        emit SpendGuardVault.SpendRefused(
            digest, agent, attacker, address(token), 4_800e18, SpendGuardVault.Reason.RecipientMismatch
        );
        _refused(a, sigs, r, SpendGuardVault.Reason.RecipientMismatch);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_incidentLogCountsAttackSequence() public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        SpendGuardVault.Request memory changed = _request(a, 4_800e18);
        changed.recipient = attacker;
        SpendGuardVault.Request memory wrongToken = _request(a, 4_800e18);
        wrongToken.token = address(0);

        vm.recordLogs();
        _refused(a, sigs, changed, SpendGuardVault.Reason.RecipientMismatch);
        _refused(a, sigs, _request(a, 9_999e18), SpendGuardVault.Reason.AmountAboveApproval);
        _refused(a, sigs, wrongToken, SpendGuardVault.Reason.TokenMismatch);
        _executed(a, sigs, _request(a, 4_800e18));
        _refused(a, sigs, _request(a, 4_800e18), SpendGuardVault.Reason.UsesExhausted);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 refusals;
        uint256 executions;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == SpendGuardVault.SpendRefused.selector) refusals++;
            if (logs[i].topics[0] == SpendGuardVault.SpendExecuted.selector) executions++;
        }
        assertEq(refusals, 4);
        assertEq(executions, 1);
    }

    function test_checkMatchesExecute() public view {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        assertEq(uint8(_reasonNow(a, sigs, _request(a, 4_800e18))), uint8(SpendGuardVault.Reason.Ok));
        assertEq(uint8(_reasonNow(a, sigs, _request(a, 4_801e18))), uint8(SpendGuardVault.Reason.AmountAboveApproval));
    }

    // ------------------------------------------------------------------ owner controls

    function test_onlyOwnerCanWithdrawOrConfigure() public {
        vm.startPrank(attacker);
        vm.expectRevert();
        vault.withdraw(address(token), attacker, 1);
        vm.expectRevert();
        vault.unfreeze();
        vm.expectRevert();
        vault.setApprover(attacker, true);
        vm.expectRevert();
        vault.setGuardian(attacker);
        vm.expectRevert();
        vault.setTimelockDelay(0);
        vm.stopPrank();
    }

    function test_timelockDelayIsBounded() public {
        vm.prank(owner);
        vm.expectRevert(SpendGuardVault.BadConfig.selector);
        vault.setTimelockDelay(31 days);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_neverPaysMoreThanApproved(uint256 amount) public {
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Signature[] memory sigs = _sign(APPROVER_A_PK, a);
        amount = bound(amount, 0, 100_000e18);
        vm.prank(agent);
        (SpendGuardVault.Outcome outcome,,) = vault.execute(a, sigs, _request(a, amount));
        if (outcome == SpendGuardVault.Outcome.Executed) {
            assertLe(amount, 4_800e18);
            assertGt(amount, 0);
        }
        assertLe(token.balanceOf(supplier), 4_800e18);
    }

    function testFuzz_anyOtherRecipientIsRefused(address to) public {
        vm.assume(to != supplier);
        SpendGuardVault.Approval memory a = _approval(4_800e18);
        SpendGuardVault.Request memory r = _request(a, 4_800e18);
        r.recipient = to;
        _refused(a, _sign(APPROVER_A_PK, a), r, SpendGuardVault.Reason.RecipientMismatch);
    }

    function testFuzz_stolenAgentKeyCannotForgeApproverSignature(uint256 attackerPk, address to, uint256 amount)
        public
    {
        attackerPk = bound(attackerPk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        address signer = vm.addr(attackerPk);
        vm.assume(signer != approverA && signer != approverB && signer != approverC);
        amount = bound(amount, 1, 100_000e18);
        SpendGuardVault.Approval memory a = _approval(amount);
        a.recipient = to;
        _refused(a, _sign(attackerPk, a), _request(a, amount), SpendGuardVault.Reason.BadSignature);
        assertEq(token.balanceOf(address(vault)), 100_000e18);
    }
}
