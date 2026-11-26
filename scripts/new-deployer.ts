// SPDX-License-Identifier: Apache-2.0
// Creates a fresh BSC testnet deployer key in .env (untracked, mode 600) and
// prints only its address. Never prints the key. Refuses to overwrite one.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const path = ".env";
const current = existsSync(path) ? readFileSync(path, "utf8") : "";
const existing = current.match(/^DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m);
if (existing) {
  console.log(`a deployer key already exists in .env; address ${privateKeyToAccount(existing[1] as `0x${string}`).address}`);
  process.exit(0);
}
const key = generatePrivateKey();
const lines = [
  current.trimEnd(),
  "# Testnet only. Generated locally; never commit, never reuse on mainnet.",
  `DEPLOYER_PRIVATE_KEY=${key}`,
  current.includes("BSC_TESTNET_RPC_URL=") ? "" : "BSC_TESTNET_RPC_URL=https://data-seed-prebsc-1-s1.bnbchain.org:8545",
].filter(Boolean);
writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`new testnet deployer address: ${privateKeyToAccount(key).address}`);
console.log("fund it with test BNB from the BNB Chain testnet faucet, then run: npm run deploy:bsc-testnet");
