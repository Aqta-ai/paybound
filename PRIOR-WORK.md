# Prior work

This public repository starts from one snapshot commit (`e7f0dbc`, 25 November
2026, during the event); later commits are event work. The full commit history,
with a `pre-hackathon-2026-11-25` tag on the last commit before the event, is
kept in a private repository and is available to the organisers on request. The
commit identifiers in the tables below refer to that private history.

The vault and its tests were written before the BNB Bangkok Developer Track
build period, which opened at 14:00 Bangkok time (07:00 UTC) on 25 November
2026 and closes at 09:00 on 27 November. Independent of the history, the chain
itself dates the event work: the testnet vault was deployed and the first proof
ran at 07:47 to 07:48 UTC on 25 November, after the window opened (see
`evidence/wp1-deploy-*.json` and `evidence/wp2-core-proof-*.json`).

## Existing before 25 November 2026

| Commit | Date (UTC) | What |
|---|---|---|
| `feee791` | 2026-11-18 20:02 | `SpendGuardVault` contract; Solidity unit, attack, fuzz and invariant tests; TypeScript SDK; `guard` CLI; example agent with an offline mock model; multi-agent attack simulation (local); BSC testnet deploy and key-generation scripts; README with threat model |
| `85577bb` | 2026-11-18 20:03 | Simulation accepts upper-case addresses proposed by models |
| `e2c079e`, `e600288` | 2026-11-18 20:46 | This file and the build plan |
| `e5d6e10` | 2026-11-18 21:26 | Example agent reads Thai payment instructions; demo scenarios (Thai shop paying a Vietnamese supplier; family remittance with a daily limit), English and Thai |
| `53ea641` | 2026-11-18 21:26 | Demo page and server: split screen (agent inbox and decisions on the left, vault events from the chain on the right, refusals in red with plain reasons), one-tap guardian freeze, English/Thai toggle, `npm run stage`; runs offline on a local chain, with a BSC testnet switch that has not been run against testnet yet |

Contract features already present: EIP-712 approvals covering agent, token,
recipient, per-transfer maximum, cumulative cap, number of uses and expiry;
registered agents; recipient allowlist; daily limit per token; timelock for
large transfers with guardian cancel; M-of-N approvers for large approvals;
guardian freeze with owner-only unfreeze; approval revocation; on-chain
refusal log with reason codes.

Testing already done: 58 Solidity tests and 9 SDK tests pass locally; the
contract was also exercised in simulated runs on local chains (no testnet,
no mainnet).

Also prepared before the event, outside the repository: a 60-second backup
screen recording of the demo page on a local chain.

Not done before the event: no BSC testnet deployment, no testnet
transactions, no contract verification on BscScan, no sponsor integrations,
no browser-wallet signing on the page, no signed records of agent requests.

## Built during the event (from 25 November, 14:00 Bangkok time)

| Commit | What |
|---|---|
| `cd6c1de` | BSC testnet: separate approver, agent and guardian keys (all on one demo laptop); deploy with checks and a readback; three-transaction proof (changed wallet refused, supplier paid once, repeat refused) |
| `6878e02`, `bab1214` | Stage demo against testnet: a judge pastes their own wallet into a fake support message; "Supplier paid once" result screen |
| `ab09e0d` | Phone approval: the person signs the approval in their own wallet; only a listed approver's signature is accepted |
| `d74384a`, `ee58bb5` | CoinMarketCap and Atlas: a live stablecoin price check before every payment that holds the payment if the price is off or unreadable; approval amount shown in baht |
| `590755c` | Docker quickstart, architecture and user-journey diagrams |
| `ec602b2`, `b937d00` | Passkey approver (fingerprint, face or device PIN) through the unchanged vault, with contract and end-to-end tests, run against the testnet vault with a test passkey |
| `28b2cad` | Simplified Chinese alongside English and Thai |
| `c47b2c1` | QR code to the judge's own refused attack on BscScan |
| `a1eb0c6` | Stage security: a token for every stage control, testnet approvals only from a person, the judge's attack must come first, price simulation can only hold |
| `fecc20e` | Per-attempt market evidence on testnet: the quotes, the agent's decision and the transaction or its absence |
| `a40e45a` | Stage mode (`?stage=1`): four steps and a status line, larger text |
| `9557873`, `24a443b`, `91cf57b` | README for judges; CoinMarketCap and Atlas write-up |
| `6694448` | Demo server falls back to other testnet RPC endpoints |
| `92a444f`, `42ea9bd` | Baht drift hold: the agent checks the baht value again before paying and holds if it moved more than 2% since approval; the simulation can only hold |
| `3a30b63`, `5a76864`, `c2303c9`, `1a58178`, `b90ccc8`, `27ed41a` | Design passes: calm theme, logo mark, Lucide icons, result card, projector-scale text, phone and passkey pages in the same design |
| `5e9c24a`, `a1dc424`, `8174723`, `4b07669`, `8ebc93a` | Fixes from review: server crash on a directory request, stream errors scrubbed, passkey approver bounds its JSON indices, CoinMarketCap quotes Tether by id 825, constant-time stage token, wording and threat-model limits |
| `3ef3091` | Product frame with Mai's shop; optional real local model with warm-up and timeout |
| `5e1a2ea` | Rón explains each vault decision in plain words |
| `226cd19` | On-chain attempt counter; the real model is asked for JSON, and a prose reply never crashes a run |
| `3fea97c` | The page says "test USD", with no token ticker |
| `e47f086` | The agent reads amounts with separators and currency words |
| `a4da930` | The page shows what the AI wrote for each decision |
| `678e252`, `dba334b`, `07d4507` | Navy and teal theme; dark stage theme with a live vault scene and a light or dark toggle |
| `bbbce0f`, `12ef8cf`, `8f52920`, `2d2843d` | npm and Python client libraries for the vault, tested end to end on a local chain, with a readable result card |
| `4bf35da` | Plain mascot image; NOTICE excludes the artwork and marks from the licence |
| `09cd11b`, `9966ce1` | Working message names the network; plainer result labels and larger counters on stage |

Smaller wording and clean-up commits are not listed. An optional presenter theme loader
(`1dcc4e5`) is in the private history only and is removed from the public copy;
it changes appearance only.

The vault contract itself (`SpendGuardVault.sol`) is unchanged since 18 November.

