// SPDX-License-Identifier: Apache-2.0
// Deploys a PasskeyApprover for one device's passkey on BSC testnet and makes it a vault approver.
// Get x, y and the host from demo page /passkey.html ("Register this device").
// Run: npm run add-passkey -- 0x<x> 0x<y> localhost
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { spendGuardVaultAbi } from "../sdk/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const [x, y, rpId] = process.argv.slice(2);
const word = /^0x[0-9a-fA-F]{64}$/;
if (!word.test(x ?? "") || !word.test(y ?? "") || !rpId) throw new Error("usage: npm run add-passkey -- 0x<x> 0x<y> <host>");
const rpIdHash = `0x${createHash("sha256").update(rpId).digest("hex")}` as Hex;

const file = "deployments/bsc-testnet.local.json";
const m = JSON.parse(readFileSync(file, "utf8"));
const art = JSON.parse(readFileSync("artifacts/contracts/PasskeyApprover.sol/PasskeyApprover.json", "utf8"));
const transport = http(process.env.BSC_TESTNET_RPC_URL);
const pub = createPublicClient({ chain: bscTestnet, transport });
if ((await pub.getChainId()) !== 97) throw new Error("BSC testnet only");
const owner = createWalletClient({ chain: bscTestnet, transport, account: privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex) });

const deployHash = await owner.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [x, y, rpIdHash] });
const r1 = await pub.waitForTransactionReceipt({ hash: deployHash });
if (r1.status !== "success" || !r1.contractAddress) throw new Error(`deploy failed: ${deployHash}`);
const approver = r1.contractAddress;
console.log(`passkey approver ${approver} for ${rpId}: https://testnet.bscscan.com/tx/${deployHash}`);

const setHash = await owner.writeContract({ address: m.vault, abi: spendGuardVaultAbi, functionName: "setApprover", args: [approver, true] });
const r2 = await pub.waitForTransactionReceipt({ hash: setHash });
if (r2.status !== "success") throw new Error(`setApprover reverted: ${setHash}`);
console.log(`added as vault approver: https://testnet.bscscan.com/tx/${setHash}`);

m.passkeyApprovers = { ...(m.passkeyApprovers ?? {}), [rpId]: approver };
writeFileSync(file, JSON.stringify(m, null, 2));
