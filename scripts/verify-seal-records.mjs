// Reproduce the Seal record checks: for every record in the wp10 evidence files,
// recompute the args hash, verify the signature with the published verifier
// against Aqta's published key, and confirm the record is in the public log.
// Usage: node scripts/verify-seal-records.mjs
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = ["evidence/wp10-seal-records-testnet-2026-11-27.json", "evidence/wp10b-seal-records-real-ai-testnet-2026-11-26.json"];
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);
const keyRes = await fetch("https://api.aqta.ai/v1/attestation/public-key").then((r) => r.json());
const key = keyRes.public_key;
console.log(`Aqta published key: ${key}`);
const dir = mkdtempSync(join(tmpdir(), "seal-records-"));
let ok = 0, total = 0;
for (const f of FILES) {
  for (const r of JSON.parse(readFileSync(f, "utf8")).records) {
    total++;
    const hashOk = createHash("sha256").update(canonical(r.args)).digest("hex") === r.record.args_hash;
    const file = join(dir, `${r.record.action_id}.json`);
    writeFileSync(file, JSON.stringify(r.record));
    let sigOk = false;
    try { execFileSync("npx", ["-y", "aqta-verify-receipt@1.4.0", file, "--profile", "action-1", "--key", key], { stdio: "pipe" }); sigOk = true; } catch {}
    const proof = await fetch(`https://api.aqta.ai/v1/public/transparency/proof/${r.record.action_id}`).then((x) => x.json()).catch(() => ({}));
    const logged = Number.isInteger(proof.leaf_index);
    const pass = hashOk && sigOk && logged;
    if (pass) ok++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${r.vault_outcome.padEnd(8)} ${(r.vault_reason || "-").padEnd(20)} tx ${r.args.tx_hash.slice(0, 12)}…  args hash ${hashOk ? "ok" : "MISMATCH"}, signature ${sigOk ? "valid" : "INVALID"}, log leaf ${logged ? proof.leaf_index : "missing"}`);
  }
}
console.log(`${ok} of ${total} records verified`);
process.exit(ok === total ? 0 : 1);
