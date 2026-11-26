// Seal signs a record of each vault decision in an evidence run.
// For every transaction, the on-chain receipt is read first; the vault's own
// event (topics and data, exactly as emitted) becomes the action arguments.
// Seal binds those arguments by SHA-256 hash into a signed ACTION-v1 record.
// Usage: SEAL_API_KEY=... node --env-file=.env --import tsx scripts/seal-record-vault-decisions.ts evidence/wp9-four-attacks-testnet-2026-11-27.json
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SEAL = process.env.SEAL_API_URL || "https://api.aqta.ai";
const KEY = (process.env.SEAL_API_KEY || "").trim();
const RPC = process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
if (!KEY) { console.error("SEAL_API_KEY is not set"); process.exit(1); }
const input = process.argv[2];
if (!input) { console.error("pass an evidence file"); process.exit(1); }
const raw = JSON.parse(readFileSync(input, "utf8"));
// wp6-style runs list steps; keep only steps with a vault transaction.
const run = raw.transactions ? raw : { ...raw, transactions: (raw.steps || []).filter((s: any) => s.tx).map((s: any) => ({ attack: s.step, outcome: s.outcome, reason: s.reason || "", tx: s.tx })) };
const vault = String(run.vault).toLowerCase();

// Canonical JSON for an object of strings and arrays of strings: sorted keys, no spaces.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error || !j.result) throw new Error(`${method} failed`);
  return j.result;
}

const out: any[] = [];
for (const t of run.transactions) {
  const rc = await rpc("eth_getTransactionReceipt", [t.tx]);
  if (rc.status !== "0x1" || String(rc.to).toLowerCase() !== vault) throw new Error(`unexpected receipt for ${t.tx}`);
  const logs = rc.logs.filter((l: any) => String(l.address).toLowerCase() === vault);
  if (!logs.length) throw new Error(`no vault event in ${t.tx}`);
  const ev = logs[logs.length - 1];
  const args = {
    chain_id: "97",
    vault,
    tx_hash: t.tx,
    block_number: BigInt(rc.blockNumber).toString(),
    block_hash: rc.blockHash,
    log_index: BigInt(ev.logIndex).toString(),
    event_topics: ev.topics,
    event_data: ev.data,
    vault_outcome: t.outcome,
    vault_reason: t.reason || "",
    attack: t.attack,
  };
  const res = await fetch(`${SEAL}/v1/actions/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ tool: "bnb.vault.record_decision", agent: "paybound-agent/1.0", args }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.record) throw new Error(`Seal returned ${res.status} for ${t.tx}`);
  const local = sha256(canonical(args));
  if (body.record.args_hash !== local) throw new Error(`args hash mismatch for ${t.tx}`);
  out.push({ attack: t.attack, vault_outcome: t.outcome, vault_reason: t.reason || "", args, args_hash_recomputed: local, seal_outcome: body.outcome, record: body.record });
  console.log(`${t.attack}: vault ${t.outcome}${t.reason ? " " + t.reason : ""}; Seal record ${body.record.action_id}`);
  await new Promise((r) => setTimeout(r, 13_000)); // stay under 5 calls a minute per key
}

const file = process.argv[3] || input.replace(/wp9-four-attacks/, "wp10-seal-records").replace(/\.json$/, "") + ".json";
writeFileSync(file, JSON.stringify({
  what: "Seal-signed ACTION-v1 records of each vault decision in " + input.split("/").pop(),
  how: "args are the vault's on-chain event, read from the receipt; Seal signs SHA-256 of their canonical JSON as args_hash",
  verify: [
    "npx aqta-verify-receipt <record.json> --profile action-1 --key <key from https://api.aqta.ai/v1/attestation/public-key>",
    "recompute sha256 of the canonical args and compare with record.args_hash",
    "GET https://api.aqta.ai/v1/public/transparency/proof/<action_id> for log inclusion",
  ],
  seal_api: SEAL,
  records: out,
}, null, 2) + "\n");
console.log(`wrote ${file}`);
