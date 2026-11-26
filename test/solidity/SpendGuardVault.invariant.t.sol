// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendGuardVault} from "../../contracts/SpendGuardVault.sol";
import {TestToken} from "../../contracts/test/TestToken.sol";

/// @dev Drives the vault with random sequences of legitimate payments, tampered
///      requests, stolen-agent-key forgeries, freezes, cancellations, releases and
///      time jumps. Ghost variables record what actually moved so the invariants
///      can compare it with what the approvers signed.
contract SpendGuardHandler is Test {
    SpendGuardVault public vault;
    TestToken public token;

    uint256 internal constant APPROVER_A_PK = 0xA11CE;
    uint256 internal constant APPROVER_B_PK = 0xB0B;

    address public owner;
    address public guardian;
    address public agent;
    address public supplier;
    address public attacker;

    SpendGuardVault.Approval[] internal approvals;
    mapping(uint256 => SpendGuardVault.Signature[]) internal sigsFor;

    // Ghosts
    uint256 public ghostMovedWhileFrozen;
    uint256 public ghostOverPerTransfer;
    mapping(uint256 day => uint256) public ghostOutflowOnDay;
    uint256[] public ghostDays;
    uint256 public ghostAttempts;
    uint256 public ghostRefusals;
    uint256 public ghostExecuted;
    uint256 public ghostQueued;
    uint256 public ghostReleased;
    uint256[] public pendingIds;

    constructor(SpendGuardVault v, TestToken t, address o, address g, address ag, address s, address at) {
        vault = v;
        token = t;
        owner = o;
        guardian = g;
        agent = ag;
        supplier = s;
        attacker = at;

        // Five approvals: small one-time, multi-use, large (needs two approvers),
        // large signed by one approver only (must never execute), native BNB.
        _add(1_000e18, 1_000e18, 1, address(token), false);
        _add(500e18, 3_000e18, 10, address(token), false);
        _add(8_000e18, 16_000e18, 2, address(token), true);
        _add(8_000e18, 16_000e18, 2, address(token), false);
        _add(1 ether, 3 ether, 5, address(0), false);
    }

    function approvalCount() external view returns (uint256) {
        return approvals.length;
    }

    function approvalAt(uint256 i) external view returns (SpendGuardVault.Approval memory) {
        return approvals[i];
    }

    function daysCount() external view returns (uint256) {
        return ghostDays.length;
    }

    function _add(uint256 maxAmount, uint256 cap, uint32 uses, address tkn, bool twoSigners) internal {
        SpendGuardVault.Approval memory a = SpendGuardVault.Approval({
            agent: agent,
            token: tkn,
            recipient: supplier,
            maxAmount: maxAmount,
            cap: cap,
            maxUses: uses,
            expiry: uint64(block.timestamp + 20 days),
            salt: bytes32(approvals.length + 1)
        });
        approvals.push(a);
        uint256 idx = approvals.length - 1;
        bytes32 digest = vault.approvalDigest(a);
        _pushSig(idx, APPROVER_A_PK, digest);
        if (twoSigners) _pushSig(idx, APPROVER_B_PK, digest);
        // Sort ascending by signer.
        SpendGuardVault.Signature[] storage list = sigsFor[idx];
        if (list.length == 2 && list[0].signer > list[1].signer) {
            SpendGuardVault.Signature memory tmp = list[0];
            list[0] = list[1];
            list[1] = tmp;
        }
    }

    function _pushSig(uint256 idx, uint256 pk, bytes32 digest) internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sigsFor[idx].push(SpendGuardVault.Signature({signer: vm.addr(pk), signature: abi.encodePacked(r, s, v)}));
    }

    function _recordOutflow(uint256 tokenBefore, uint256 nativeBefore) internal {
        uint256 movedToken = token.balanceOf(supplier) + token.balanceOf(attacker) - tokenBefore;
        uint256 movedNative = supplier.balance + attacker.balance - nativeBefore;
        if ((movedToken > 0 || movedNative > 0) && vault.paused()) ghostMovedWhileFrozen += movedToken + movedNative;
        if (movedToken > 0) {
            uint256 day = vault.today();
            if (ghostOutflowOnDay[day] == 0) ghostDays.push(day);
            ghostOutflowOnDay[day] += movedToken;
        }
    }

    // ------------------------------------------------------------------ actions

    /// Agent submits a request against approval `i`, possibly tampered.
    function submit(uint256 i, uint256 amount, uint8 tamper) external {
        i = bound(i, 0, approvals.length - 1);
        SpendGuardVault.Approval memory a = approvals[i];
        amount = bound(amount, 0, a.maxAmount * 2);
        SpendGuardVault.Request memory r = SpendGuardVault.Request(a.token, a.recipient, amount);
        tamper = uint8(bound(tamper, 0, 4));
        if (tamper == 1) r.recipient = attacker;
        if (tamper == 2) a.recipient = attacker; // edit the signed struct
        if (tamper == 3) a.cap = a.cap * 10; // inflate the signed cap
        if (tamper == 4) r.token = a.token == address(0) ? address(token) : address(0);

        uint256 tb = token.balanceOf(supplier) + token.balanceOf(attacker);
        uint256 nb = supplier.balance + attacker.balance;
        ghostAttempts++;
        vm.prank(agent);
        (SpendGuardVault.Outcome outcome,, uint256 id) = vault.execute(a, sigsFor[i], r);
        if (outcome == SpendGuardVault.Outcome.Refused) ghostRefusals++;
        if (outcome == SpendGuardVault.Outcome.Executed) {
            ghostExecuted++;
            if (amount > approvals[i].maxAmount) ghostOverPerTransfer++;
        }
        if (outcome == SpendGuardVault.Outcome.Queued) {
            ghostQueued++;
            pendingIds.push(id);
        }
        _recordOutflow(tb, nb);
    }

    /// Someone holding the stolen agent key tries to drain to themselves with a forged approval.
    function stolenKeyDrain(uint256 pk, uint256 amount, bool native) external {
        pk = bound(pk, 1, 1e30);
        address signer = vm.addr(pk);
        if (signer == vm.addr(APPROVER_A_PK) || signer == vm.addr(APPROVER_B_PK)) return;
        amount = bound(amount, 1, 50_000e18);
        (SpendGuardVault.Approval memory a, SpendGuardVault.Signature[] memory sigs) = _forge(pk, amount, native);
        _attempt(a, sigs, SpendGuardVault.Request(a.token, attacker, amount));
    }

    function _forge(uint256 pk, uint256 amount, bool native)
        internal
        view
        returns (SpendGuardVault.Approval memory a, SpendGuardVault.Signature[] memory sigs)
    {
        a = SpendGuardVault.Approval({
            agent: agent,
            token: native ? address(0) : address(token),
            recipient: attacker,
            maxAmount: amount,
            cap: amount,
            maxUses: 1,
            expiry: uint64(block.timestamp + 1 days),
            salt: bytes32(pk)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.approvalDigest(a));
        sigs = new SpendGuardVault.Signature[](1);
        // Half the time claim to be approver A.
        sigs[0] = SpendGuardVault.Signature({
            signer: (pk % 2 == 0) ? vm.addr(APPROVER_A_PK) : vm.addr(pk),
            signature: abi.encodePacked(r, s, v)
        });
    }

    function _attempt(
        SpendGuardVault.Approval memory a,
        SpendGuardVault.Signature[] memory sigs,
        SpendGuardVault.Request memory r
    ) internal {
        uint256 tb = token.balanceOf(supplier) + token.balanceOf(attacker);
        uint256 nb = supplier.balance + attacker.balance;
        ghostAttempts++;
        vm.prank(agent);
        (SpendGuardVault.Outcome outcome,,) = vault.execute(a, sigs, r);
        if (outcome == SpendGuardVault.Outcome.Refused) ghostRefusals++;
        _recordOutflow(tb, nb);
    }

    function freeze() external {
        vm.prank(guardian);
        vault.freeze();
    }

    function unfreeze() external {
        vm.prank(owner);
        vault.unfreeze();
    }

    function release(uint256 k) external {
        if (pendingIds.length == 0) return;
        uint256 id = pendingIds[bound(k, 0, pendingIds.length - 1)];
        uint256 tb = token.balanceOf(supplier) + token.balanceOf(attacker);
        uint256 nb = supplier.balance + attacker.balance;
        vm.prank(agent);
        try vault.release(id) {
            ghostReleased++;
        } catch {}
        _recordOutflow(tb, nb);
    }

    function cancel(uint256 k) external {
        if (pendingIds.length == 0) return;
        uint256 id = pendingIds[bound(k, 0, pendingIds.length - 1)];
        vm.prank(guardian);
        try vault.cancel(id) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }
}

contract SpendGuardVaultInvariantTest is Test {
    SpendGuardVault internal vault;
    TestToken internal token;
    SpendGuardHandler internal handler;

    uint256 internal constant DAILY_LIMIT = 12_000e18;
    uint256 internal constant START_TOKEN = 1_000_000e18;
    uint256 internal constant START_NATIVE = 100 ether;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal agent = makeAddr("agent");
    address internal supplier = makeAddr("supplier");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        vm.warp(1_800_000_000);
        address[] memory approvers = new address[](3);
        approvers[0] = vm.addr(0xA11CE);
        approvers[1] = vm.addr(0xB0B);
        approvers[2] = vm.addr(0xC0C);
        vault = new SpendGuardVault(owner, guardian, approvers, 2, 1 days);
        token = new TestToken();
        token.mint(address(vault), START_TOKEN);
        vm.deal(address(vault), START_NATIVE);
        vm.startPrank(owner);
        vault.setAgent(agent, true);
        vault.setPolicy(address(token), DAILY_LIMIT, 5_000e18, 10_000e18);
        vault.setAllowlistEnabled(true);
        vault.setRecipientAllowed(supplier, true);
        vm.stopPrank();

        handler = new SpendGuardHandler(vault, token, owner, guardian, agent, supplier, attacker);
        targetContract(address(handler));
    }

    /// The attacker never receives anything: not via a stolen agent key, a
    /// changed recipient or an edited approval.
    function invariant_attackerNeverPaid() public view {
        assertEq(token.balanceOf(attacker), 0);
        assertEq(attacker.balance, 0);
    }

    /// No approval ever pays out more than its cap or more often than its uses.
    function invariant_approvalLimitsHold() public view {
        uint256 total;
        for (uint256 i = 0; i < handler.approvalCount(); i++) {
            SpendGuardVault.Approval memory a = handler.approvalAt(i);
            (uint32 uses,, uint256 spent) = vault.usage(vault.approvalDigest(a));
            assertLe(spent, a.cap, "cap");
            assertLe(uses, a.maxUses, "uses");
            if (a.token == address(token)) total += spent;
        }
        // What the supplier holds can only come from those approvals.
        assertLe(token.balanceOf(supplier), total);
    }

    /// The single-approver copy of the large approval never moves funds (M-of-N).
    function invariant_singleSignerLargeApprovalNeverUsed() public view {
        (uint32 uses,, uint256 spent) = vault.usage(vault.approvalDigest(handler.approvalAt(3)));
        assertEq(uses, 0);
        assertEq(spent, 0);
    }

    function invariant_noTransferWhileFrozen() public view {
        assertEq(handler.ghostMovedWhileFrozen(), 0);
    }

    function invariant_noTransferAbovePerTransferMax() public view {
        assertEq(handler.ghostOverPerTransfer(), 0);
    }

    function invariant_dailyOutflowWithinLimit() public view {
        for (uint256 i = 0; i < handler.daysCount(); i++) {
            assertLe(handler.ghostOutflowOnDay(handler.ghostDays(i)), DAILY_LIMIT);
        }
    }

    /// Nothing is created or lost: vault plus recipients equals what was deposited.
    function invariant_conservation() public view {
        assertEq(token.balanceOf(address(vault)) + token.balanceOf(supplier) + token.balanceOf(attacker), START_TOKEN);
        assertEq(address(vault).balance + supplier.balance + attacker.balance, START_NATIVE);
    }
}
