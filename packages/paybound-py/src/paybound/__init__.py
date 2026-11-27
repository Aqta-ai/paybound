# SPDX-License-Identifier: Apache-2.0
"""Let AI agents pay on BNB Smart Chain without giving them unlimited authority.

A person approves one exact payment (recipient, amount, uses, expiry). The vault
contract pays only that; anything else is refused on chain with a public event.
Python client for the SpendGuardVault contract, built on web3.py.
"""
from __future__ import annotations

import json
import os
import time
from importlib import resources
from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data, _hash_eip191_message
from web3 import Web3

__all__ = [
    "REASONS", "ALLOWED_CHAIN_IDS", "ZERO_ADDRESS", "vault_abi", "vault_bytecode", "token_abi", "token_bytecode",
    "new_approval", "approval_digest", "sign_approval", "request_for", "check_request", "submit",
    "read_log", "deploy_vault",
]

REASONS = [
    "Ok", "Paused", "NotAgent", "BadSignature", "NotEnoughApprovers", "Expired", "Revoked", "UsesExhausted",
    "TokenMismatch", "RecipientMismatch", "RecipientNotAllowed", "ZeroAmount", "AmountAboveApproval",
    "CapExceeded", "DailyLimitExceeded", "InsufficientBalance",
]
OUTCOMES = ["Executed", "Queued", "Refused"]
ALLOWED_CHAIN_IDS = {97, 31337}
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

_C = json.loads(resources.files(__package__).joinpath("contracts.json").read_text())
vault_abi, vault_bytecode = _C["vaultAbi"], _C["vaultBytecode"]
token_abi, token_bytecode = _C["tokenAbi"], _C["tokenBytecode"]

_TYPES = {
    "EIP712Domain": [
        {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
    ],
    "Approval": [
        {"name": "agent", "type": "address"}, {"name": "token", "type": "address"},
        {"name": "recipient", "type": "address"}, {"name": "maxAmount", "type": "uint256"},
        {"name": "cap", "type": "uint256"}, {"name": "maxUses", "type": "uint32"},
        {"name": "expiry", "type": "uint64"}, {"name": "salt", "type": "bytes32"},
    ],
}


def _assert_chain(chain_id: int) -> None:
    if chain_id not in ALLOWED_CHAIN_IDS:
        raise ValueError(f"chain {chain_id} is not allowed: BSC testnet (97) or a local chain (31337) only")


def new_approval(agent: str, recipient: str, amount: int, token: str = ZERO_ADDRESS, max_uses: int = 1,
                 cap: int | None = None, valid_for_seconds: int = 86_400, salt: str | None = None,
                 now: int | None = None) -> dict[str, Any]:
    """Build an approval. Amounts are in the token's smallest unit (wei)."""
    now = int(time.time()) if now is None else now
    return {
        "agent": Web3.to_checksum_address(agent), "token": Web3.to_checksum_address(token),
        "recipient": Web3.to_checksum_address(recipient), "maxAmount": int(amount),
        "cap": int(cap if cap is not None else amount * max_uses), "maxUses": int(max_uses),
        "expiry": now + valid_for_seconds, "salt": salt or "0x" + os.urandom(32).hex(),
    }


def _typed(vault: str, chain_id: int, approval: dict[str, Any]) -> dict[str, Any]:
    return {
        "types": _TYPES, "primaryType": "Approval",
        "domain": {"name": "SpendGuardVault", "version": "1", "chainId": chain_id,
                   "verifyingContract": Web3.to_checksum_address(vault)},
        "message": {**approval, "salt": bytes.fromhex(approval["salt"][2:])},
    }


def approval_digest(vault: str, chain_id: int, approval: dict[str, Any]) -> str:
    """EIP-712 digest of an approval; identical to the TypeScript SDK and the contract."""
    return "0x" + _hash_eip191_message(encode_typed_data(full_message=_typed(vault, chain_id, approval))).hex()


def sign_approval(private_key: str, vault: str, chain_id: int, approval: dict[str, Any]) -> dict[str, str]:
    """An approver signs the exact approval."""
    signed = Account.sign_message(encode_typed_data(full_message=_typed(vault, chain_id, approval)), private_key)
    return {"signer": Account.from_key(private_key).address, "signature": "0x" + signed.signature.hex().removeprefix("0x")}


def request_for(approval: dict[str, Any], amount: int | None = None) -> dict[str, Any]:
    return {"token": approval["token"], "recipient": approval["recipient"],
            "amount": approval["maxAmount"] if amount is None else int(amount)}


def _args(signed: dict[str, Any], request: dict[str, Any]):
    a = signed["approval"]
    approval = (a["agent"], a["token"], a["recipient"], a["maxAmount"], a["cap"], a["maxUses"], a["expiry"],
                bytes.fromhex(a["salt"][2:]))
    sigs = sorted(signed["signatures"], key=lambda s: int(s["signer"], 16))
    sigs = [(Web3.to_checksum_address(s["signer"]), bytes.fromhex(s["signature"][2:])) for s in sigs]
    req = (Web3.to_checksum_address(request["token"]), Web3.to_checksum_address(request["recipient"]), int(request["amount"]))
    return approval, sigs, req


def check_request(w3: Web3, vault: str, caller: str, signed: dict[str, Any], request: dict[str, Any]) -> str:
    """Dry run: the reason this caller's request would be refused, or "Ok"."""
    c = w3.eth.contract(address=Web3.to_checksum_address(vault), abi=vault_abi)
    reason, _ = c.functions.check(Web3.to_checksum_address(caller), *_args(signed, request)).call()
    return REASONS[reason]


def _send(w3: Web3, private_key: str, fn) -> Any:
    acct = Account.from_key(private_key)
    tx = fn.build_transaction({"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address), "chainId": w3.eth.chain_id})
    raw = acct.sign_transaction(tx).raw_transaction
    receipt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(raw))
    if receipt.status != 1:
        raise RuntimeError(f"transaction {receipt.transactionHash.hex()} reverted")
    return receipt


def submit(w3: Web3, agent_key: str, vault: str, signed: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    """The agent asks the vault to pay. Returns outcome, reason and tx hash."""
    _assert_chain(w3.eth.chain_id)
    c = w3.eth.contract(address=Web3.to_checksum_address(vault), abi=vault_abi)
    receipt = _send(w3, agent_key, c.functions.execute(*_args(signed, request)))
    tx = "0x" + receipt.transactionHash.hex().removeprefix("0x")
    for name in ("SpendExecuted", "SpendQueued", "SpendRefused"):
        evs = getattr(c.events, name)().process_receipt(receipt, errors=_DISCARD)
        if evs:
            if name == "SpendRefused":
                return {"outcome": "Refused", "reason": REASONS[evs[0]["args"]["reason"]], "tx_hash": tx}
            return {"outcome": "Executed" if name == "SpendExecuted" else "Queued", "reason": "Ok", "tx_hash": tx}
    raise RuntimeError(f"no spend event found in {tx}")


def read_log(w3: Web3, vault: str, from_block: int = 0) -> list[dict[str, Any]]:
    """Every vault event (approvals, payments, refusals), decoded."""
    c = w3.eth.contract(address=Web3.to_checksum_address(vault), abi=vault_abi)
    logs = w3.eth.get_logs({"address": c.address, "fromBlock": from_block, "toBlock": "latest"})
    out = []
    for log in logs:
        for ev in c.events:
            try:
                d = ev().process_log(log)
            except Exception:
                continue
            out.append({"event": d["event"], "block": d["blockNumber"], "tx_hash": "0x" + d["transactionHash"].hex().removeprefix("0x"), "args": dict(d["args"])})
            break
    return out


def deploy_vault(w3: Web3, owner_key: str, guardian: str, approvers: list[str], agents: list[str],
                 required_approvals: int = 1, timelock_seconds: int = 0, policy: dict[str, Any] | None = None) -> str:
    """Deploy a vault, set an optional token policy and register agents. Returns the vault address."""
    _assert_chain(w3.eth.chain_id)
    owner = Account.from_key(owner_key).address
    factory = w3.eth.contract(abi=vault_abi, bytecode=vault_bytecode)
    receipt = _send(w3, owner_key, factory.constructor(owner, Web3.to_checksum_address(guardian),
                    [Web3.to_checksum_address(a) for a in approvers], required_approvals, timelock_seconds))
    vault = receipt.contractAddress
    c = w3.eth.contract(address=vault, abi=vault_abi)
    if policy:
        _send(w3, owner_key, c.functions.setPolicy(Web3.to_checksum_address(policy["token"]), policy["daily_limit"],
                                                   policy["timelock_above"], policy["multi_approver_above"]))
    for a in agents:
        _send(w3, owner_key, c.functions.setAgent(Web3.to_checksum_address(a), True))
    return vault


from web3.logs import DISCARD as _DISCARD  # noqa: E402


# --------------------------------------------------------------------- result card
# Presentation only; same layout as the npm package. Plain ASCII frame, colour on a TTY, NO_COLOR respected.
import sys as _sys

REASON_TEXT = {
    "Ok": "Matches the approval", "Paused": "The vault is frozen", "NotAgent": "Not a registered agent",
    "BadSignature": "Signature is not from an approver", "NotEnoughApprovers": "Not enough approvers",
    "Expired": "Approval has expired", "Revoked": "Approval was revoked", "UsesExhausted": "Approval already used",
    "TokenMismatch": "Token is not the one approved", "RecipientMismatch": "Recipient is not the one approved",
    "RecipientNotAllowed": "Recipient is not on the allowlist", "ZeroAmount": "Amount is zero",
    "AmountAboveApproval": "Amount is above the approval", "CapExceeded": "Total approved amount used up",
    "DailyLimitExceeded": "Daily limit reached", "InsufficientBalance": "Not enough funds in the vault",
}
_W, _L = 76, 15


def _short(a: str) -> str:
    return f"{a[:6]}…{a[-4:]}" if len(a) > 14 else a


def _amt(v: int, d: int = 18) -> str:
    whole, frac = divmod(int(v), 10 ** d)
    f = str(frac).rjust(d, "0").rstrip("0")[:2]
    return f"{whole:,}" + (f".{f}" if f else "")


def _line(label: str, value: str) -> str:
    room = _W - 4 - _L - 1
    v = value if len(value) <= room else value[: room - 1] + "…"
    return f"| {label.ljust(_L)} {v.ljust(room)} |"


def format_result(result: dict[str, Any], request: dict[str, Any], approval: dict[str, Any] | None = None, decimals: int = 18) -> str:
    """A card describing what the vault decided for one request."""
    paid = result["outcome"] == "Executed"
    status = "Paid" if paid else ("Queued" if result["outcome"] == "Queued" else "Refused")
    colour = "32" if paid else ("33" if status == "Queued" else "31")
    shown = f"\x1b[1;{colour}m{status}\x1b[0m" if _sys.stdout.isatty() and not os.environ.get("NO_COLOR") else status
    rule = "+" + "-" * (_W - 2) + "+"
    head = f"| Spend Guard{' ' * (_W - 4 - len('Spend Guard') - len(status))}{shown} |"
    rows = [_line("Decision", REASON_TEXT.get(result["reason"], result["reason"])), _line("Code", result["reason"]),
            _line("Paid" if paid else "Tried to pay", f"{_amt(request['amount'], decimals)} to {_short(request['recipient'])}")]
    if approval:
        uses = "1 use" if approval["maxUses"] == 1 else f"{approval['maxUses']} uses"
        rows.append(_line("Approved", f"{_amt(approval['maxAmount'], decimals)} to {_short(approval['recipient'])}, {uses}"))
    rows.append(_line("Money moved", _amt(request["amount"], decimals) if paid else "none"))
    rows.append(_line("Evidence", f"{_short(result['tx_hash'])} on chain"))
    return "\n".join([rule, head, rule, *rows, rule])


def print_result(*args: Any, **kw: Any) -> None:
    print(format_result(*args, **kw))


__all__ += ["REASON_TEXT", "format_result", "print_result"]
