<p align="center">
  <img src="https://aqta.ai/brand/seal-mark-512.png" alt="Seal" width="88" height="88" />
</p>

# paybound (Python)

**Let AI agents pay on BNB Smart Chain without giving them unlimited authority.**

> Your agent makes the payment decisions. It cannot pay out of the vault beyond the approval you signed: this recipient, up to this amount, this many times. (This covers funds held in the vault; keep the agent's own wallet to gas only.)

[![License Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE) ![BNB Smart Chain testnet](https://img.shields.io/badge/BNB%20Smart%20Chain-testnet-F0B90B.svg) ![web3.py](https://img.shields.io/badge/built%20on-web3.py-3776AB.svg) ![npm twin](https://img.shields.io/badge/also%20on-npm-CB3837.svg)

A person approves one exact payment; the vault pays only that and records every refusal on chain. Python client for the same `SpendGuardVault` contract as the npm package `paybound`; approval digests are identical across both.

```sh
pip install paybound
```

```python
from web3 import Web3
from paybound import deploy_vault, new_approval, sign_approval, submit, request_for

w3 = Web3(Web3.HTTPProvider("https://data-seed-prebsc-1-s1.bnbchain.org:8545"))  # BSC testnet
vault = deploy_vault(w3, OWNER_KEY, guardian=GUARDIAN, approvers=[APPROVER], agents=[AGENT])
approval = new_approval(agent=AGENT, token=STABLECOIN, recipient=SUPPLIER, amount=3400 * 10**18)
signed = {"approval": approval, "signatures": [sign_approval(APPROVER_KEY, vault, 97, approval)]}

submit(w3, AGENT_KEY, vault, signed, {**request_for(approval), "recipient": SCAMMER})  # Refused: RecipientMismatch
submit(w3, AGENT_KEY, vault, signed, request_for(approval))                            # Executed
submit(w3, AGENT_KEY, vault, signed, request_for(approval))                            # Refused: UsesExhausted
```

Also: `approval_digest`, `check_request` (dry run), `read_log`, `REASONS`. BSC testnet (97) and local chains only; testnet software, not audited. Apache-2.0. Built by Aqta, aqta.ai/seal.

What you see when you run the quickstart ([examples/quickstart](examples/)):

```text
vault 0x… holds 10,000 test USD

A scam email changes the wallet
+--------------------------------------------------------------------------+
| Spend Guard                                                      Refused |
+--------------------------------------------------------------------------+
| Decision        Recipient is not the one approved                        |
| Code            RecipientMismatch                                        |
| Tried to pay    3,400 to 0x2222…2222                                     |
| Approved        3,400 to 0x1111…1111, 1 use                              |
| Money moved     none                                                     |
| Evidence        0x297e…8c09 on chain                                     |
+--------------------------------------------------------------------------+

The agent asks for more
+--------------------------------------------------------------------------+
| Spend Guard                                                      Refused |
+--------------------------------------------------------------------------+
| Decision        Amount is above the approval                             |
| Code            AmountAboveApproval                                      |
| Tried to pay    5,000 to 0x1111…1111                                     |
| Approved        3,400 to 0x1111…1111, 1 use                              |
| Money moved     none                                                     |
| Evidence        0x8708…1222 on chain                                     |
+--------------------------------------------------------------------------+

The real invoice
```
