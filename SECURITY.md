# Security

Seal Spend Guard is a testnet build. Use it on BNB Smart Chain testnet (chain 97) or a local
chain only. The contracts have not had an external audit. Do not deploy them to mainnet or use
them with real funds.

## Reporting a vulnerability

Email **security@aqta.ai** with what you found, the steps or transaction that show it, and the
commit you tested. Please do not open a public issue for a vulnerability.

In scope: the contracts in `contracts/`, the SDK and CLI, the client libraries in `packages/`, and
the demo server. The limits already listed under "Threat model" in the [README](README.md) are
known. The test token mints to anyone by design.

## No bounty

There is no bug bounty for this repository, and no payment is offered for reports.
