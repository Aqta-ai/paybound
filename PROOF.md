# Proof

Every claim Paybound makes, with a link you can open. BNB Smart Chain testnet (chain 97). Test funds only.

Vault: [`0x190d9e1a4d9193371aa7b884db61bd93e71ae146`](https://testnet.bscscan.com/address/0x190d9e1a4d9193371aa7b884db61bd93e71ae146) · Test token: [`0x3b6875dac9c9a42958f63cd541f8f410fb777595`](https://testnet.bscscan.com/address/0x3b6875dac9c9a42958f63cd541f8f410fb777595)

A refusal is a successful transaction that emits `SpendRefused` with a reason code; open the event log on BscScan to see it.

## Four attacks, zero sent (27 November)

| Attack | Result | Transaction |
|---|---|---|
| Changed recipient | Refused, `RecipientMismatch` | [0x12fe98c5…](https://testnet.bscscan.com/tx/0x12fe98c57fec81b356f3eabcbae99c3307935c3e77dbf93bde084765f19e41a2) |
| Raised amount, 3,900 against an approval of up to 3,400 | Refused, `AmountAboveApproval` | [0x80e8d761…](https://testnet.bscscan.com/tx/0x80e8d7613e0d37d3e62ed24f6e3a7ec7f39ce5c5b30f274210e9a0c072eed9d3) |
| Approval forged with the agent's key (simulated theft) | Refused, `BadSignature` | [0xf4388989…](https://testnet.bscscan.com/tx/0xf4388989cb388e9f3e5d1ff7dc71cfd7fd76d23a1b59a2c786e101d30692260f) |
| Real invoice | Paid once, 3,400 test dollars | [0xa24e2be0…](https://testnet.bscscan.com/tx/0xa24e2be0859a465e1b943af9527ce166c1296a67ba2d48a9c2f685a4d6d42794) |
| Same invoice again | Refused, `UsesExhausted` | [0xf0d84267…](https://testnet.bscscan.com/tx/0xf0d8426719cabe99e0d19cdaaa196355f9d3873a226fb528012c187bec5ba584) |

Evidence: [`evidence/wp9-four-attacks-testnet-2026-11-27.json`](evidence/wp9-four-attacks-testnet-2026-11-27.json)

## A real AI, fooled (26 November)

A local open model read a fake "payout wallet updated" message and wrote a payment to a fresh scammer wallet.

| Step | Result | Transaction |
|---|---|---|
| AI pays a new wallet | Refused, `RecipientMismatch` | [0xc7aca06e…](https://testnet.bscscan.com/tx/0xc7aca06e38fa998ef560676453cb1d37531135ff0b72a93c71fdd6c33e79dd7e) |
| Real invoice | Paid once | [0xfe02abb1…](https://testnet.bscscan.com/tx/0xfe02abb1c3c24d4ea7b99ecea870e17147400e3a918198e8d0974e6eab6ac6b7) |
| Same invoice again | Refused, `UsesExhausted` | [0x3b915383…](https://testnet.bscscan.com/tx/0x3b9153836a214f0732f61338e5a0a8bed02097286eca74300013fa81838b8dca) |

Evidence, including the model's own message: [`evidence/wp6-real-ai-testnet-2026-11-26.json`](evidence/wp6-real-ai-testnet-2026-11-26.json)

## Approved by a person in Phantom (27 November)

| Step | Result | Transaction |
|---|---|---|
| Phantom address added as an approver | Done | [0x51091b95…](https://testnet.bscscan.com/tx/0x51091b95f385d889a1db48a254c8ed91019434ca9bda9a2afe29e3a204d36133) |
| Attack: pay a fresh wallet | Refused, `RecipientMismatch` | [0xaf103152…](https://testnet.bscscan.com/tx/0xaf103152c00674de1c39bd46bc3bd44d29182792b612d1e3e50231cab84a742f) |
| Real invoice, under the Phantom approval | Paid | [0xdb589fcb…](https://testnet.bscscan.com/tx/0xdb589fcbd431ba9fbda016aef764788f4f455c9380be5c1dd23f818133b29397) |

Phantom signs on BSC testnet only in its Testnet Mode. Evidence: [`evidence/wp11-phantom-approval-testnet-2026-11-27.json`](evidence/wp11-phantom-approval-testnet-2026-11-27.json)

## Eight decisions, eight Seal records

Aqta's Seal signed an ACTION-v1 record (Ed25519) of each vault decision in the first two runs. Each binds the transaction hash, block, reason and event bytes by SHA-256 and sits in Seal's public transparency log (leaves 5718 to 5721 and 5728 to 5731).

```sh
npm run verify:seal   # 8 of 8: args hash, signature against Aqta's published key, log inclusion
```

Records: [`wp10`](evidence/wp10-seal-records-testnet-2026-11-27.json), [`wp10b`](evidence/wp10b-seal-records-real-ai-testnet-2026-11-26.json)

## CoinMarketCap and Atlas

Every live CoinMarketCap call is logged in [`evidence/cmc-calls.jsonl`](evidence/cmc-calls.jsonl) (`/v2/cryptocurrency/quotes/latest`, `/v2/tools/price-conversion`). The price-check run against the Atlas USDT/USD feed on BSC is [`evidence/wp5-market-proof-2026-11-25T10-47-33-163Z.json`](evidence/wp5-market-proof-2026-11-25T10-47-33-163Z.json).

## Tests

```sh
npm ci && npm run build && npm test   # 114 passing: 64 Solidity, 50 Node.js (about a minute)
```

## Limits

Testnet only, not audited. The scripts and SDKs refuse mainnet; the contract has no chain guard. The vault owner is a single key today. A refusal event records the agent's request, not proof that a matching approval existed. The vault binds a payment to an approval; it does not prove an invoice is genuine.
