# Seal Spend Guard: CoinMarketCap and Atlas write-up

BNB Bangkok 2026, CoinMarketCap x Atlas Challenge. Team: Aqta. Contact: hello@aqta.ai.

## Problem and audience

Businesses are starting to let AI agents pay supplier invoices in stablecoins. Two things can go wrong at the moment of payment. First, the agent can be tricked into paying the wrong wallet or amount, for example by a "the supplier's wallet changed" message. Second, the stablecoin itself can slip off its peg.

The audience is finance leads at small businesses that pay overseas suppliers, and the developers who build their payment agents.

## What it does

1. A person approves one payment: the recipient, the token, a maximum amount, a number of uses and an expiry. On the approval screen the amount is also shown in Thai baht at the CoinMarketCap rate, so the person sees what they are signing in their own currency.
2. Before every payment the agent reads USDT/USD from two separate sources: CoinMarketCap's API and an Atlas price feed on BNB Smart Chain. The agent holds the payment and sends no transaction when either of these is true:
   - either price is more than 1% from $1;
   - the two prices differ by more than $0.005, a reading is stale, or a source cannot be read.
3. The vault on BSC testnet checks the request against the signed approval. A changed wallet, a raised amount or a repeat is refused, and the refusal is recorded on chain with its reason.

Market data can hold a payment; it can never authorise one. The vault does not read prices. Its decision depends only on the person's signed approval. The payment token is a test dollar that stands for USDT, which is the reference price checked.

## Endpoints and feeds, and why

| Source | Used for | Why |
|---|---|---|
| CoinMarketCap `/v2/cryptocurrency/quotes/latest` (USDT, CMC id 825) | Live peg check before each payment | An off-chain market price, with its own update time |
| CoinMarketCap `/v2/tools/price-conversion` (USD to THB) | The amount in baht on the approval, and again just before paying | The person approving thinks in their own currency. If the baht value moved more than 2% since approval, the agent holds and asks again |
| Atlas USDT/USD feed on BSC mainnet, `0x9fc000fc9c17578b49853278a517e357201d01e4`, read at a pinned block | Second, on-chain source; cross-checked against CMC | An on-chain reading that does not depend on the API. Read only, no transaction |

Each CoinMarketCap call is logged in `evidence/cmc-calls.jsonl`: time, endpoint, HTTP status, credits used and CMC's timestamp, never the key. The key stays on the server and is never in the page or the repository.

## BNB Chain contracts and data

- BSC testnet (chain 97): `SpendGuardVault` [`0x190d9e1a4d9193371aa7b884db61bd93e71ae146`](https://testnet.bscscan.com/address/0x190d9e1a4d9193371aa7b884db61bd93e71ae146), test token [`0x3b6875dac9c9a42958f63cd541f8f410fb777595`](https://testnet.bscscan.com/address/0x3b6875dac9c9a42958f63cd541f8f410fb777595).
- BSC mainnet (chain 56): the Atlas feed above, read only.

## What the data changed: one run, quotes and decisions side by side

From `evidence/wp5-market-proof-2026-11-25T10-47-33-163Z.json` (`npm run proof:market`):

| Attempt | Quotes read | Agent | Vault |
|---|---|---|---|
| Live quotes | CMC $0.99859, Atlas $0.99868 | submitted | [paid 3,400 test dollars once](https://testnet.bscscan.com/tx/0xc7a1d88418b12bf2d2073c38972a1bc9690edc0ed3280ce5fe92806f0e704485) |
| Simulated depeg at $0.97 (labelled as a simulation) | stage simulation | held | no transaction sent |
| Live quotes, same request again | CMC $0.99859, Atlas $0.99868 | submitted | [refused: approval already used](https://testnet.bscscan.com/tx/0x8177ae59a0a9a6146605f03e3d66f1e4e9a27686607170351529047523771fdb) |

A simulated price can only hold a payment. A healthy simulated price is ignored, and the live sources run as usual.

## What next

- Tie the CMC asset to the BSC USDT contract with `/v2/cryptocurrency/info`.
- More stablecoins and more local currencies (VND, SGD, EUR).
- Seal's signed records for this build, checkable offline.
