// SPDX-License-Identifier: Apache-2.0
// The vault owner adds an approver address (for example the person's phone wallet) on BSC testnet.
// Run: npm run add-approver -- 0xYourPhoneWalletAddress   (add --remove to take an approver off)
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { spendGuardVaultAbi } from "../sdk/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const raw = process.argv[2]?.trim();
if (!raw || !isAddress(raw, { strict: false })) throw new Error("usage: npm run add-approver -- 0xAddress");
const who = getAddress(raw.toLowerCase()) as Address;
const m = JSON.parse(readFileSync("deployments/bsc-testnet.local.json", "utf8"));
const transport = http(process.env.BSC_TESTNET_RPC_URL);
const pub = createPublicClient({ chain: bscTestnet, transport });
const owner = createWalletClient({ chain: bscTestnet, transport, account: privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex) });
if ((await pub.getChainId()) !== 97) throw new Error("BSC testnet only");

const enable = !process.argv.includes("--remove");
const now = await pub.readContract({ address: m.vault, abi: spendGuardVaultAbi, functionName: "isApprover", args: [who] });
if (now === enable) {
  console.log(`${who} is ${enable ? "already" : "not"} an approver on ${m.vault}`);
} else {
  const hash = await owner.writeContract({ address: m.vault, abi: spendGuardVaultAbi, functionName: "setApprover", args: [who, enable] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`setApprover reverted: ${hash}`);
  console.log(`${enable ? "added" : "removed"} approver ${who}: https://testnet.bscscan.com/tx/${hash}`);
}
