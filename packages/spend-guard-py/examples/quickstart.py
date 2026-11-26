# SPDX-License-Identifier: Apache-2.0
"""Spend Guard in five minutes (Python): an agent pays one approved invoice, and
three attempts to stretch that approval are refused on chain.

    npx hardhat node            # or anvil; any local chain on :8545
    pip install aqta-spend-guard
    python quickstart.py
"""
import os
from web3 import Web3
from eth_account import Account
from aqta_spend_guard import deploy_vault, new_approval, sign_approval, submit, request_for, print_result, token_abi, token_bytecode, _send

# Well-known local development keys (Hardhat/Anvil accounts 0-3). Never use them on a public network.
DEV = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
       "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"]
OWNER, APPROVER, AGENT, GUARDIAN = [os.environ.get(n, DEV[i]) for i, n in enumerate(["OWNER_KEY", "APPROVER_KEY", "AGENT_KEY", "GUARDIAN_KEY"])]
SUPPLIER, SCAMMER, E = "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", 10**18

w3 = Web3(Web3.HTTPProvider(os.environ.get("RPC_URL", "http://127.0.0.1:8545")))
token = _send(w3, OWNER, w3.eth.contract(abi=token_abi, bytecode=token_bytecode).constructor()).contractAddress
vault = deploy_vault(w3, OWNER, Account.from_key(GUARDIAN).address, [Account.from_key(APPROVER).address], [Account.from_key(AGENT).address],
                     policy={"token": token, "daily_limit": 100_000 * E, "timelock_above": 100_000 * E, "multi_approver_above": 100_000 * E})
_send(w3, OWNER, w3.eth.contract(address=token, abi=token_abi).functions.mint(vault, 10_000 * E))
print(f"vault {vault} holds 10,000 test USD\n")

approval = new_approval(Account.from_key(AGENT).address, SUPPLIER, 3400 * E, token=token)
signed = {"approval": approval, "signatures": [sign_approval(APPROVER, vault, w3.eth.chain_id, approval)]}

for label, request in [("A scam email changes the wallet", {**request_for(approval), "recipient": SCAMMER}),
                       ("The agent asks for more", request_for(approval, 5000 * E)),
                       ("The real invoice", request_for(approval)),
                       ("The same invoice again", request_for(approval))]:
    print(label)
    print_result(submit(w3, AGENT, vault, signed, request), request, approval)
    print()
