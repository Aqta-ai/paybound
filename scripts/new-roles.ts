// SPDX-License-Identifier: Apache-2.0
// Creates separate testnet keys for the approver, the agent and the guardian in .env
// (untracked, mode 600), plus fresh supplier and attacker addresses for the demo.
// Prints addresses only, never a key. Keeps any role that already exists.
// Run: npm run new-roles
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const path = ".env";
let text = existsSync(path) ? readFileSync(path, "utf8") : "";

function get(name: string): string | undefined {
  const m = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  const v = m?.[1].trim();
  return v ? v : undefined;
}
function set(name: string, value: string) {
  if (new RegExp(`^${name}=.*$`, "m").test(text)) text = text.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`);
  else text = `${text.trimEnd()}\n${name}=${value}\n`;
}

const keys = ["APPROVER_PRIVATE_KEY", "AGENT_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY"] as const;
for (const k of keys) {
  if (!get(k)) set(k, generatePrivateKey());
}
// Demo payees: addresses only. The supplier and attacker never sign anything.
for (const name of ["SUPPLIER_ADDRESS", "ATTACKER_ADDRESS"]) {
  if (!get(name)) set(name, privateKeyToAccount(generatePrivateKey()).address);
}
const addr = (k: string) => privateKeyToAccount(get(k) as `0x${string}`).address;
set("APPROVER_ADDRESSES", addr("APPROVER_PRIVATE_KEY"));
set("AGENT_ADDRESS", addr("AGENT_PRIVATE_KEY"));
set("GUARDIAN_ADDRESS", addr("GUARDIAN_PRIVATE_KEY"));
if (!get("REQUIRED_APPROVALS")) set("REQUIRED_APPROVALS", "1");
if (!get("TIMELOCK_SECONDS")) set("TIMELOCK_SECONDS", "3600");

writeFileSync(path, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`approver  ${get("APPROVER_ADDRESSES")}`);
console.log(`agent     ${get("AGENT_ADDRESS")}`);
console.log(`guardian  ${get("GUARDIAN_ADDRESS")}`);
console.log(`supplier  ${get("SUPPLIER_ADDRESS")}`);
console.log(`attacker  ${get("ATTACKER_ADDRESS")}`);
