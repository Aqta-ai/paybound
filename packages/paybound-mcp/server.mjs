#!/usr/bin/env node
// Paybound MCP server: read-only tools for any MCP agent. No keys, no transactions.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, getAddress, isAddress, parseUnits } from "viem";
import { bscTestnet } from "viem/chains";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const here = (f) => new URL(f, import.meta.url);
const RECORDS = JSON.parse(readFileSync(here("./records.json"), "utf8"));
const TRY = JSON.parse(readFileSync(here("./try-approval.json"), "utf8"));
const RPC = process.env.PAYBOUND_RPC_URL || "https://bsc-prebsc-dataseed.bnbchain.org";
const LIVE = process.env.PAYBOUND_LIVE_URL || "https://paybound-eight.vercel.app";
const SEAL = "https://api.aqta.ai";
const REASONS = ["Ok","Paused","NotAgent","BadSignature","NotEnoughApprovers","Expired","Revoked","UsesExhausted","TokenMismatch","RecipientMismatch","RecipientNotAllowed","ZeroAmount","AmountAboveApproval","CapExceeded","DailyLimitExceeded","InsufficientBalance"];
const CHECK_ABI = [{ type: "function", name: "check", stateMutability: "view",
  inputs: [{ name: "caller", type: "address" },
    { name: "a", type: "tuple", components: [{ name: "agent", type: "address" }, { name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "maxAmount", type: "uint256" }, { name: "cap", type: "uint256" }, { name: "maxUses", type: "uint32" }, { name: "expiry", type: "uint64" }, { name: "salt", type: "bytes32" }] },
    { name: "sigs", type: "tuple[]", components: [{ name: "signer", type: "address" }, { name: "signature", type: "bytes" }] },
    { name: "r", type: "tuple", components: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }] }],
  outputs: [{ name: "reason", type: "uint8" }, { name: "digest", type: "bytes32" }] }];
const client = createPublicClient({ chain: bscTestnet, transport: http(RPC) });
const canonical = (v) => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v);
const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "paybound", version: "0.1.0" });

server.tool("paybound_check",
  "Ask the Paybound vault on BNB Smart Chain testnet whether it would pay this request under the public test approval (pay Kowloon Ceramics 0xc2177666CF501222986A3c447f03327F9D366cc6 up to 3,400 test USD, once). Read-only eth_call: nothing is sent.",
  { recipient: z.string().describe("Wallet to pay, 0x…"), amount: z.string().describe("Amount in test USD, e.g. \"3400\""), forge_signature: z.boolean().optional().describe("Tamper with the approval signature to see a forged approval refused") },
  async ({ recipient, amount, forge_signature }) => {
    if (!isAddress(recipient)) return text({ error: "recipient is not an address" });
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount)) return text({ error: "amount must be a number like 3400" });
    const a = TRY.approval;
    let sig = TRY.signatures[0].signature;
    if (forge_signature) sig = sig.slice(0, 10) + (sig[10] === "a" ? "b" : "a") + sig.slice(11);
    const [reason] = await client.readContract({ address: TRY.vault, abi: CHECK_ABI, functionName: "check",
      args: [TRY.agent, { agent: a.agent, token: a.token, recipient: a.recipient, maxAmount: BigInt(a.maxAmount), cap: BigInt(a.cap), maxUses: Number(a.maxUses), expiry: BigInt(a.expiry), salt: a.salt },
        [{ signer: TRY.signatures[0].signer, signature: sig }], { token: TRY.token, recipient: getAddress(recipient), amount: parseUnits(amount, 18) }] });
    return text({ wouldPay: reason === 0, reason: REASONS[reason], vault: TRY.vault, network: "BSC testnet (97)", note: "Read-only check by the vault contract itself; no transaction was sent." });
  });

server.tool("paybound_decisions",
  "List the Paybound vault's real decisions (paid or refused, with reason and BscScan link), read from BNB Smart Chain testnet.",
  { kind: z.enum(["all", "paid", "refused"]).optional(), limit: z.number().int().min(1).max(100).optional() },
  async ({ kind = "all", limit = 20 }) => {
    const r = await fetch(LIVE + "/api/events").then((x) => x.json());
    if (r.error) return text({ error: r.error });
    const list = r.events.filter((e) => kind === "all" || e.kind === kind).slice(0, limit).map((e) => ({
      outcome: e.kind, reason: e.kind === "refused" ? REASONS[e.reason] : "Ok", recipient: e.recipient, amountTestUsd: Number(BigInt(e.amount) / 10n ** 16n) / 100,
      block: e.block, tx: e.tx, bscscan: "https://testnet.bscscan.com/tx/" + e.tx, sealRecord: RECORDS.find((x) => x.tx === e.tx.toLowerCase())?.record.action_id ?? null }));
    return text({ total: r.events.length, shown: list.length, decisions: list });
  });

server.tool("paybound_verify_record",
  "Verify the Seal record of a vault decision: the record binds that transaction, the SHA-256 of its arguments matches the signed hash, and it is in Seal's public transparency log. Pass a transaction hash or a Seal action id.",
  { id: z.string().describe("Transaction hash (0x…) or Seal action id") },
  async ({ id }) => {
    const key = id.trim().toLowerCase();
    const r = RECORDS.find((x) => x.tx === key || x.record.action_id === key);
    if (!r) return text({ error: "No Seal record for that id. Records exist for the ten decisions listed in PROOF.md." });
    const hashOk = createHash("sha256").update(canonical(r.args)).digest("hex") === r.record.args_hash;
    const proof = await fetch(SEAL + "/v1/public/transparency/proof/" + encodeURIComponent(r.record.action_id)).then((x) => x.json()).catch(() => ({}));
    return text({ actionId: r.record.action_id, tx: r.args.tx_hash, vaultOutcome: r.args.vault_outcome, vaultReason: r.args.vault_reason || null,
      checks: { recordNamesThisTransaction: true, argsHashMatches: hashOk, inPublicLog: Number.isInteger(proof.leaf_index), logLeaf: proof.leaf_index ?? null },
      signature: "Ed25519, verify offline: npx aqta-verify-receipt record.json --profile action-1 --key 9Y3Eiq6V8QjRDUM5nPqSwKIOPQaoEU4SbagfYFdvWa4",
      record: r.record });
  });

await server.connect(new StdioServerTransport());
