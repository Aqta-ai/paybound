<p align="center">
  <img src="https://aqta.ai/brand/seal-mark-512.png" alt="Seal" width="88" height="88" />
</p>

# paybound

**Let AI agents pay on BNB Smart Chain without giving them unlimited authority.**

> Your agent makes the payment decisions. It cannot pay out of the vault beyond the approval you signed: this recipient, up to this amount, this many times. (This covers funds held in the vault; keep the agent's own wallet to gas only.)

[![License Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE) ![BNB Smart Chain testnet](https://img.shields.io/badge/BNB%20Smart%20Chain-testnet-F0B90B.svg) ![viem](https://img.shields.io/badge/built%20on-viem-1e1e20.svg) ![Python twin](https://img.shields.io/badge/also%20in-Python-3776AB.svg)

A person approves one exact payment: this recipient, this amount, this many uses, until this time. The agent can then pay on its own, but the vault contract pays only what was approved. Anything else is refused on chain, and the refusal is a public event that records the approval used, the agent, the attempted recipient, the amount and the reason. No money moves on a refusal.

Works on BSC testnet (chain 97) and local chains. Mainnet is refused on purpose until audited.

```sh
npm install paybound viem
```


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

## Thirty-second example

```js
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deployVault, newApproval, signApproval, submit, requestFor } from "paybound";

const client = createPublicClient({ chain: bscTestnet, transport: http() });
const owner = createWalletClient({ account: privateKeyToAccount(process.env.OWNER_KEY), chain: bscTestnet, transport: http() });
const approver = createWalletClient({ account: privateKeyToAccount(process.env.APPROVER_KEY), chain: bscTestnet, transport: http() });
const agent = createWalletClient({ account: privateKeyToAccount(process.env.AGENT_KEY), chain: bscTestnet, transport: http() });

// 1. Deploy a vault and register your agent (once).
const vault = await deployVault(owner, client, {
  guardian: "0xYourGuardian",
  approvers: [approver.account.address],
  agents: [agent.account.address],
});
// Fund the vault with the stablecoin or BNB the agent may spend.

// 2. A person approves one exact payment.
const approval = newApproval({ agent: agent.account.address, token: "0xStablecoin", recipient: "0xSupplier", amount: parseUnits("3400", 18) });
const signed = { approval, signatures: [await signApproval(approver, vault, 97, approval)] };

// 3. The agent pays. A tricked agent asking for another wallet is refused on chain.
await submit(agent, client, vault, signed, { ...requestFor(approval), recipient: "0xScammer" }); // { outcome: "Refused", reason: "RecipientMismatch" }
await submit(agent, client, vault, signed, requestFor(approval));                               // { outcome: "Executed" }
await submit(agent, client, vault, signed, requestFor(approval));                               // { outcome: "Refused", reason: "UsesExhausted" }
```

## What the vault checks

| Attempt | Result |
|---|---|
| Different recipient | Refused: `RecipientMismatch` |
| Higher amount | Refused: `AmountAboveApproval` |
| Different token | Refused: `TokenMismatch` |
| Same approval again | Refused: `UsesExhausted` |
| Edited or forged approval, stolen agent key | Refused: `BadSignature` |
| Large payment with one signer | Refused: `NotEnoughApprovers` |
| Another agent's approval | Refused: `NotAgent` |
| Expired or revoked approval | Refused: `Expired` / `Revoked` |
| Vault frozen by the guardian | Refused: `Paused` |

Callers that are not registered agents are rejected outright (the transaction reverts, so no refusal event is written).

## API

- `deployVault(wallet, client, setup)`: deploy and configure a vault; returns its address.
- `newApproval({ agent, token, recipient, amount, maxUses?, cap?, validForSeconds? })`: build an approval.
- `signApproval(wallet, vault, chainId, approval)`: an approver signs it (EIP-712; any viem wallet, including injected or hardware).
- `checkRequest(client, vault, caller, signed, request)`: dry run; returns the reason a request would be refused, or `"Ok"`.
- `submit(wallet, client, vault, signed, request)`: the agent asks the vault to pay; returns `{ outcome, reason, txHash }`.
- `readLog(client, vault)`: every approval, payment and refusal event, decoded.
- `spendGuardVaultAbi`, `spendGuardVaultBytecode`, `approvalDigest`, `REASONS`.

## Command line

```sh
npx paybound approve --vault 0x.. --agent 0x.. --token 0x.. --recipient 0x.. --amount 3400
npx paybound check approval.json --recipient 0x..
npx paybound submit approval.json
npx paybound log --vault 0x..
```

Environment: `RPC_URL`, `APPROVER_PRIVATE_KEY` (approve), `AGENT_PRIVATE_KEY` (check, submit). Never commit keys.

## Status

Testnet software, not audited. Covered by the repository's contract and TypeScript tests and a simulated 1,000-agent attack run (11,100 attacks, nothing received by attackers, local chain). Source: github.com/Aqta-ai/paybound. Built by Aqta (aqta.ai/seal). Apache-2.0.
