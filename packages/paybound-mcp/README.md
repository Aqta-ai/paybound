# paybound-mcp

An MCP server that lets any MCP agent (Claude, Cursor and other MCP clients) work with Paybound on BNB Smart Chain testnet. Read-only: no keys, no transactions.

| Tool | What it does |
|---|---|
| `paybound_check` | Asks the vault contract whether it would pay a request under the public test approval (Kowloon Ceramics, up to 3,400 test USD, once). Try another wallet, a bigger amount or a forged signature. |
| `paybound_decisions` | Lists the vault's real decisions from BNB testnet, with reason, BscScan link and Seal record id. |
| `paybound_verify_record` | Checks a Seal record: it names the transaction, its argument hash matches, and it is in Seal's public transparency log. |

## Use it

From this repository: `cd packages/paybound-mcp && npm install`, then add to your MCP client config:

```json
{ "mcpServers": { "paybound": { "command": "node", "args": ["/path/to/paybound/packages/paybound-mcp/server.mjs"] } } }
```

Then ask your agent: "Would the Paybound vault pay 3,900 to Kowloon Ceramics?" or "Show me the refused payments and verify one Seal record."

Testnet only, not audited. Settings: `PAYBOUND_RPC_URL` (default `https://bsc-prebsc-dataseed.bnbchain.org`), `PAYBOUND_LIVE_URL` (default `https://paybound-eight.vercel.app`).
