// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SpendGuardVault
/// @notice Holds funds for an AI agent. The agent's own key cannot move funds on
///         its own: every transfer needs a signed approval from the vault's
///         approvers (EIP-712) naming the agent, token, recipient, per-transfer
///         amount, cumulative cap, number of uses and expiry. On top of each approval the owner sets
///         vault-wide limits: a recipient allowlist, a daily limit per token, a
///         timelock for large transfers, and M-of-N approvals for large approvals.
///         A guardian can freeze the vault at once; only the owner can unfreeze.
/// @dev Every refused request from a registered agent is recorded as a
///      `SpendRefused` event with a reason code, so monitoring can alert on it.
///      Calls from unregistered addresses revert instead, so outsiders cannot
///      flood the incident log.
contract SpendGuardVault is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    /// @notice What the approvers sign. `token == address(0)` means native BNB.
    struct Approval {
        address agent; // the only agent address allowed to use this approval
        address token; // ERC-20 token, or address(0) for native BNB
        address recipient; // where the funds may go
        uint256 maxAmount; // largest single transfer
        uint256 cap; // cumulative ceiling across all uses
        uint32 maxUses; // number of transfers allowed (1 = one-time)
        uint64 expiry; // unix seconds; unusable at or after this time
        bytes32 salt; // makes otherwise identical approvals distinct
    }

    /// @notice One approver's signature over an approval digest.
    struct Signature {
        address signer; // must be a current approver; list sorted ascending, no repeats
        bytes signature; // 65-byte ECDSA, or ERC-1271 bytes for a contract wallet approver
    }

    /// @notice What the agent asks for at execution time.
    struct Request {
        address token;
        address recipient;
        uint256 amount;
    }

    /// @notice Vault-wide limits for one token. Zero disables that limit.
    struct TokenPolicy {
        uint256 dailyLimit; // total that may leave the vault per UTC day, across all approvals (counted when funds move)
        uint256 timelockThreshold; // transfers above this wait `timelockDelay` before release
        uint256 multiApprovalThreshold; // approvals whose cap is above this need `requiredApprovals` signers
    }

    struct Usage {
        uint32 uses;
        bool revoked;
        uint256 spent;
    }

    enum PendingState {
        None,
        Queued,
        Released,
        Cancelled
    }

    struct Pending {
        bytes32 digest;
        address agent;
        address token;
        address recipient;
        uint256 amount;
        uint64 releaseAfter;
        PendingState state;
    }

    enum Outcome {
        Executed,
        Queued,
        Refused
    }

    /// @notice Why a request was refused. `Ok` means it would go ahead.
    enum Reason {
        Ok,
        Paused,
        NotAgent,
        BadSignature,
        NotEnoughApprovers,
        Expired,
        Revoked,
        UsesExhausted,
        TokenMismatch,
        RecipientMismatch,
        RecipientNotAllowed,
        ZeroAmount,
        AmountAboveApproval,
        CapExceeded,
        DailyLimitExceeded,
        InsufficientBalance
    }

    // ------------------------------------------------------------------ storage

    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "Approval(address agent,address token,address recipient,uint256 maxAmount,uint256 cap,uint32 maxUses,uint64 expiry,bytes32 salt)"
    );
    uint64 public constant MAX_TIMELOCK_DELAY = 30 days;

    address public guardian;
    bool public paused;

    mapping(address => bool) public isAgent;
    mapping(address => bool) public isApprover;
    uint256 public approverCount;
    uint256 public requiredApprovals; // M in M-of-N, used for approvals above the token's threshold

    bool public allowlistEnabled;
    mapping(address => bool) public allowedRecipient;

    mapping(address token => TokenPolicy) public policy;
    mapping(address token => mapping(uint256 day => uint256)) public spentOnDay;
    uint64 public timelockDelay;

    mapping(bytes32 digest => Usage) public usage;
    mapping(uint256 id => Pending) public pending;
    uint256 public pendingCount;

    // ------------------------------------------------------------------ events

    event SpendExecuted(
        bytes32 indexed digest,
        address indexed agent,
        address indexed recipient,
        address token,
        uint256 amount,
        uint32 useIndex,
        uint256 totalSpent
    );
    event SpendQueued(
        uint256 indexed id,
        bytes32 indexed digest,
        address indexed recipient,
        address agent,
        address token,
        uint256 amount,
        uint64 releaseAfter
    );
    event SpendReleased(uint256 indexed id, bytes32 indexed digest, address indexed recipient, address token, uint256 amount);
    event SpendCancelled(uint256 indexed id, bytes32 indexed digest, address indexed by);
    /// @notice The incident log: one event per refused request from a registered agent.
    event SpendRefused(
        bytes32 indexed digest,
        address indexed agent,
        address indexed recipient,
        address token,
        uint256 amount,
        Reason reason
    );
    event ApprovalRevoked(bytes32 indexed digest, address indexed by);
    event AgentSet(address indexed agent, bool enabled);
    event ApproverSet(address indexed approver, bool enabled);
    event RequiredApprovalsSet(uint256 required);
    event GuardianSet(address indexed previous, address indexed current);
    event AllowlistEnabled(bool enabled);
    event RecipientAllowed(address indexed recipient, bool allowed);
    event PolicySet(address indexed token, uint256 dailyLimit, uint256 timelockThreshold, uint256 multiApprovalThreshold);
    event TimelockDelaySet(uint64 delay);
    event Frozen(address indexed by);
    event Unfrozen(address indexed by);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------ errors

    error Refused(Reason reason);
    error ZeroAddress();
    error NotAuthorised();
    error BadConfig();
    error NotReleasable();

    // ------------------------------------------------------------------ setup

    constructor(
        address initialOwner,
        address initialGuardian,
        address[] memory initialApprovers,
        uint256 initialRequiredApprovals,
        uint64 initialTimelockDelay
    ) EIP712("SpendGuardVault", "1") Ownable(initialOwner) {
        if (initialGuardian == address(0)) revert ZeroAddress();
        guardian = initialGuardian;
        emit GuardianSet(address(0), initialGuardian);
        for (uint256 i = 0; i < initialApprovers.length; i++) {
            _setApprover(initialApprovers[i], true);
        }
        _setRequiredApprovals(initialRequiredApprovals);
        _setTimelockDelay(initialTimelockDelay);
    }

    receive() external payable {}

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotAuthorised();
        _;
    }

    // ------------------------------------------------------------------ views

    /// @notice EIP-712 digest of an approval for this vault and chain.
    function approvalDigest(Approval calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    APPROVAL_TYPEHASH,
                    a.agent,
                    a.token,
                    a.recipient,
                    a.maxAmount,
                    a.cap,
                    a.maxUses,
                    a.expiry,
                    a.salt
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice Signatures an approval with this cap and token needs.
    function approvalsNeeded(address token, uint256 cap) public view returns (uint256) {
        uint256 t = policy[token].multiApprovalThreshold;
        return (t != 0 && cap > t) ? requiredApprovals : 1;
    }

    /// @notice Dry run: why `caller` submitting this request now would be refused, or Ok.
    function check(address caller, Approval calldata a, Signature[] calldata sigs, Request calldata r)
        external
        view
        returns (Reason reason, bytes32 digest)
    {
        digest = approvalDigest(a);
        reason = _check(caller, a, sigs, r, digest);
    }

    // ------------------------------------------------------------------ agent

    /// @notice Ask for a transfer. A refusal does not revert: it is recorded as a
    ///         `SpendRefused` event and returned, so the incident log keeps it.
    ///         Transfers above the token's timelock threshold are queued, not sent.
    /// @return outcome Executed, Queued or Refused.
    /// @return reason Ok unless refused.
    /// @return pendingId The queue id when queued, otherwise 0.
    function execute(Approval calldata a, Signature[] calldata sigs, Request calldata r)
        external
        nonReentrant
        returns (Outcome outcome, Reason reason, uint256 pendingId)
    {
        if (!isAgent[msg.sender]) revert Refused(Reason.NotAgent);
        bytes32 digest = approvalDigest(a);
        reason = _check(msg.sender, a, sigs, r, digest);
        if (reason != Reason.Ok) {
            emit SpendRefused(digest, msg.sender, r.recipient, r.token, r.amount, reason);
            return (Outcome.Refused, reason, 0);
        }

        Usage storage u = usage[digest];
        u.uses += 1;
        u.spent += r.amount;

        uint256 lockAbove = policy[r.token].timelockThreshold;
        if (lockAbove != 0 && r.amount > lockAbove) {
            pendingId = ++pendingCount;
            uint64 releaseAfter = uint64(block.timestamp) + timelockDelay;
            pending[pendingId] = Pending({
                digest: digest,
                agent: msg.sender,
                token: r.token,
                recipient: r.recipient,
                amount: r.amount,
                releaseAfter: releaseAfter,
                state: PendingState.Queued
            });
            emit SpendQueued(pendingId, digest, r.recipient, msg.sender, r.token, r.amount, releaseAfter);
            return (Outcome.Queued, Reason.Ok, pendingId);
        }

        spentOnDay[r.token][today()] += r.amount;
        _send(r.token, r.recipient, r.amount);
        emit SpendExecuted(digest, msg.sender, r.recipient, r.token, r.amount, u.uses, u.spent);
        return (Outcome.Executed, Reason.Ok, 0);
    }

    /// @notice Send a queued transfer once its delay has passed. The queuing agent
    ///         (if still registered) or the owner can release it. The daily limit is
    ///         checked again here, on the day the funds actually leave; if today is
    ///         full, try again tomorrow.
    function release(uint256 id) external nonReentrant {
        Pending storage p = pending[id];
        if (p.state != PendingState.Queued) revert NotReleasable();
        if (msg.sender != owner() && !(msg.sender == p.agent && isAgent[msg.sender])) revert NotAuthorised();
        if (paused) revert Refused(Reason.Paused);
        if (block.timestamp < p.releaseAfter) revert NotReleasable();
        if (allowlistEnabled && !allowedRecipient[p.recipient]) revert Refused(Reason.RecipientNotAllowed);
        uint256 limit = policy[p.token].dailyLimit;
        uint256 day = today();
        if (limit != 0 && spentOnDay[p.token][day] + p.amount > limit) revert Refused(Reason.DailyLimitExceeded);
        spentOnDay[p.token][day] += p.amount;
        p.state = PendingState.Released;
        _send(p.token, p.recipient, p.amount);
        emit SpendReleased(id, p.digest, p.recipient, p.token, p.amount);
    }

    // ------------------------------------------------------------------ guardian and owner

    /// @notice Freeze the vault at once. The guardian or the owner can do this.
    function freeze() external onlyOwnerOrGuardian {
        paused = true;
        emit Frozen(msg.sender);
    }

    /// @notice Only the owner can unfreeze, so a stolen guardian key can stop
    ///         payments but cannot restart them.
    function unfreeze() external onlyOwner {
        paused = false;
        emit Unfrozen(msg.sender);
    }

    /// @notice Cancel a queued transfer during its delay. Its use of the approval stays spent.
    function cancel(uint256 id) external onlyOwnerOrGuardian {
        Pending storage p = pending[id];
        if (p.state != PendingState.Queued) revert NotReleasable();
        p.state = PendingState.Cancelled;
        emit SpendCancelled(id, p.digest, msg.sender);
    }

    /// @notice Cancel an approval before it is used up. Any approver, the guardian or the owner.
    function revoke(bytes32 digest) external {
        if (!isApprover[msg.sender] && msg.sender != guardian && msg.sender != owner()) revert NotAuthorised();
        usage[digest].revoked = true;
        emit ApprovalRevoked(digest, msg.sender);
    }

    /// @notice Remove a compromised agent key at once (guardian or owner). Only the owner can add one.
    function disableAgent(address agent) external onlyOwnerOrGuardian {
        isAgent[agent] = false;
        emit AgentSet(agent, false);
    }

    function setAgent(address agent, bool enabled) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        isAgent[agent] = enabled;
        emit AgentSet(agent, enabled);
    }

    function setApprover(address approver, bool enabled) external onlyOwner {
        _setApprover(approver, enabled);
        if (requiredApprovals > approverCount || approverCount == 0) revert BadConfig();
    }

    function setRequiredApprovals(uint256 required) external onlyOwner {
        _setRequiredApprovals(required);
    }

    function setGuardian(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, next);
        guardian = next;
    }

    function setAllowlistEnabled(bool enabled) external onlyOwner {
        allowlistEnabled = enabled;
        emit AllowlistEnabled(enabled);
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyOwner {
        allowedRecipient[recipient] = allowed;
        emit RecipientAllowed(recipient, allowed);
    }

    function setPolicy(address token, uint256 dailyLimit, uint256 timelockThreshold, uint256 multiApprovalThreshold)
        external
        onlyOwner
    {
        policy[token] = TokenPolicy(dailyLimit, timelockThreshold, multiApprovalThreshold);
        emit PolicySet(token, dailyLimit, timelockThreshold, multiApprovalThreshold);
    }

    function setTimelockDelay(uint64 delay) external onlyOwner {
        _setTimelockDelay(delay);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _send(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ------------------------------------------------------------------ internals

    function _check(
        address caller,
        Approval calldata a,
        Signature[] calldata sigs,
        Request calldata r,
        bytes32 digest
    ) internal view returns (Reason) {
        if (paused) return Reason.Paused;
        if (!isAgent[caller] || caller != a.agent) return Reason.NotAgent;
        Reason sigReason = _checkSignatures(a, sigs, digest);
        if (sigReason != Reason.Ok) return sigReason;
        if (block.timestamp >= a.expiry) return Reason.Expired;
        Usage storage u = usage[digest];
        if (u.revoked) return Reason.Revoked;
        if (u.uses >= a.maxUses) return Reason.UsesExhausted;
        if (r.token != a.token) return Reason.TokenMismatch;
        if (r.recipient != a.recipient) return Reason.RecipientMismatch;
        if (allowlistEnabled && !allowedRecipient[r.recipient]) return Reason.RecipientNotAllowed;
        if (r.amount == 0) return Reason.ZeroAmount;
        if (r.amount > a.maxAmount) return Reason.AmountAboveApproval;
        if (u.spent + r.amount > a.cap) return Reason.CapExceeded;
        uint256 limit = policy[r.token].dailyLimit;
        if (limit != 0 && spentOnDay[r.token][today()] + r.amount > limit) return Reason.DailyLimitExceeded;
        uint256 balance = r.token == address(0) ? address(this).balance : IERC20(r.token).balanceOf(address(this));
        if (balance < r.amount) return Reason.InsufficientBalance;
        return Reason.Ok;
    }

    /// @dev Every listed signer must be a current approver with a valid signature,
    ///      listed in strictly ascending address order (so none counts twice).
    function _checkSignatures(Approval calldata a, Signature[] calldata sigs, bytes32 digest)
        internal
        view
        returns (Reason)
    {
        if (sigs.length == 0) return Reason.BadSignature;
        address last = address(0);
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = sigs[i].signer;
            if (signer <= last) return Reason.BadSignature;
            if (!isApprover[signer]) return Reason.BadSignature;
            if (!SignatureChecker.isValidSignatureNow(signer, digest, sigs[i].signature)) return Reason.BadSignature;
            last = signer;
        }
        if (sigs.length < approvalsNeeded(a.token, a.cap)) return Reason.NotEnoughApprovers;
        return Reason.Ok;
    }

    function _setApprover(address approver, bool enabled) internal {
        if (approver == address(0)) revert ZeroAddress();
        if (isApprover[approver] == enabled) return;
        isApprover[approver] = enabled;
        if (enabled) approverCount += 1;
        else approverCount -= 1;
        emit ApproverSet(approver, enabled);
    }

    function _setRequiredApprovals(uint256 required) internal {
        if (required == 0 || required > approverCount) revert BadConfig();
        requiredApprovals = required;
        emit RequiredApprovalsSet(required);
    }

    function _setTimelockDelay(uint64 delay) internal {
        if (delay > MAX_TIMELOCK_DELAY) revert BadConfig();
        timelockDelay = delay;
        emit TimelockDelaySet(delay);
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            Address.sendValue(payable(to), amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
