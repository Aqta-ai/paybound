// SPDX-License-Identifier: Apache-2.0
// Deploys TestToken and SpendGuardVault to BSC testnet (chain 97) or a local chain.
// Refuses any other chain. Run: npm run new-roles, then npm run deploy:bsc-testnet
// Roles come from .env: GUARDIAN_ADDRESS, APPROVER_ADDRESSES (comma-separated),
// REQUIRED_APPROVALS, TIMELOCK_SECONDS, AGENT_ADDRESS, SUPPLIER_ADDRESS. On chain 97
// every role is required and must be distinct from the deployer. Blank values count as
// missing. Every write waits for its receipt; a manifest is written after each step.
import { network } from "hardhat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { formatEther, getAddress, parseEther, parseUnits, type Address, type Hex } from "viem";
import { approvalDigest as sdkDigest, newApproval } from "../sdk/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
if (chainId !== 97 && chainId !== 31337) throw new Error(`refusing to deploy to chain ${chainId}: testnet (97) or local only`);
const testnet = chainId === 97;
const me = deployer.account.address;

// ------------------------------------------------------------------ roles
const env = (k: string) => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};
const addr = (k: string, fallback?: Address): Address => {
  const v = env(k);
  if (!v) {
    if (fallback && !testnet) return fallback;
    throw new Error(`${k} is missing; run npm run new-roles`);
  }
  return getAddress(v.toLowerCase());
};
const approvers = (env("APPROVER_ADDRESSES") ?? (testnet ? "" : me))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => getAddress(s.toLowerCase()));
if (approvers.length === 0) throw new Error("APPROVER_ADDRESSES is missing; run npm run new-roles");
const guardian = addr("GUARDIAN_ADDRESS", me);
const agent = addr("AGENT_ADDRESS", me);
const supplier = env("SUPPLIER_ADDRESS") ? addr("SUPPLIER_ADDRESS") : undefined;
const required = BigInt(env("REQUIRED_APPROVALS") ?? "1");
const delay = BigInt(env("TIMELOCK_SECONDS") ?? "3600");
if (required < 1n || required > BigInt(approvers.length)) throw new Error(`REQUIRED_APPROVALS ${required} must be 1..${approvers.length}`);
if (delay > 30n * 86_400n) throw new Error("TIMELOCK_SECONDS above 30 days");
if (testnet) {
  const all = [me, guardian, agent, ...approvers].map((a) => a.toLowerCase());
  if (new Set(all).size !== all.length) throw new Error("on testnet the deployer, guardian, agent and approvers must all be different keys");
}

// ------------------------------------------------------------------ preflight
const balance = await publicClient.getBalance({ address: me });
console.log(`deployer ${me} on chain ${chainId}, balance ${formatEther(balance)} tBNB`);
if (testnet && balance < parseEther("0.05")) throw new Error("deployer needs at least 0.05 tBNB; use the faucet");
const startBlock = await publicClient.getBlockNumber();
if (testnet) await publicClient.getLogs({ address: me, fromBlock: startBlock - 100n, toBlock: startBlock }); // RPC must serve address-filtered getLogs (the BNB seed nodes do not)

// ------------------------------------------------------------------ manifest
mkdirSync("deployments", { recursive: true });
const file = `deployments/${testnet ? "bsc-testnet" : "local"}.local.json`;
type Manifest = Record<string, unknown> & { steps: string[] };
const resume = env("RESUME") === "1" && existsSync(file);
const m: Manifest = resume ? JSON.parse(readFileSync(file, "utf8")) : { steps: [] };
Object.assign(m, { chainId, owner: me, guardian, approvers, agent, supplier: supplier ?? null, required: String(required), delay: String(delay) });
m.startBlock ??= String(startBlock);
const save = () => writeFileSync(file, JSON.stringify(m, null, 2));
const done = (s: string) => m.steps.includes(s);
const mark = (s: string, extra: Record<string, unknown> = {}) => {
  Object.assign(m, extra);
  m.steps.push(s);
  save();
  console.log(`ok  ${s}`);
};
const wait = async (hash: Hex) => {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return r;
};

const T = (n: string) => parseUnits(n, 18);

if (!done("token")) {
  const token = await viem.deployContract("TestToken");
  mark("token", { token: token.address });
}
if (!done("vault")) {
  const vault = await viem.deployContract("SpendGuardVault", [me, guardian, approvers, required, delay]);
  mark("vault", { vault: vault.address });
}
const token = await viem.getContractAt("TestToken", m.token as Address);
const vault = await viem.getContractAt("SpendGuardVault", m.vault as Address);

if (!done("mint")) {
  await wait(await token.write.mint([vault.address, T("1000000")]));
  mark("mint");
}
if (!done("policy")) {
  // Daily limit 200,000 so a full rehearsal day cannot run out; timelock and two-approver thresholds at 10,000.
  await wait(await vault.write.setPolicy([token.address, T("200000"), T("10000"), T("10000")]));
  mark("policy");
}
if (!done("agent")) {
  await wait(await vault.write.setAgent([agent, true]));
  mark("agent");
}
if (supplier && !done("allowlist")) {
  await wait(await vault.write.setRecipientAllowed([supplier, true]));
  await wait(await vault.write.setAllowlistEnabled([true]));
  mark("allowlist");
}
if (testnet && !done("gas")) {
  // The agent pays gas for every request, refusals included; the guardian needs a little for a freeze.
  for (const [who, amt] of [[agent, "0.02"], [guardian, "0.005"]] as const) {
    const have = await publicClient.getBalance({ address: who });
    if (have < parseEther(amt)) await wait(await deployer.sendTransaction({ to: who, value: parseEther(amt) - have }));
  }
  mark("gas");
}

// ------------------------------------------------------------------ readback
const read = {
  isAgent: await vault.read.isAgent([agent]),
  guardian: await vault.read.guardian(),
  requiredApprovals: String(await vault.read.requiredApprovals()),
  allowlistEnabled: await vault.read.allowlistEnabled(),
  supplierAllowed: supplier ? await vault.read.allowedRecipient([supplier]) : null,
  policy: (await vault.read.policy([token.address])).map(String),
  vaultBalance: String(await token.read.balanceOf([vault.address])),
};
const probe = newApproval({ agent, token: token.address, recipient: supplier ?? me, amount: T("1"), now: 1_800_000_000 });
const onchain = await vault.read.approvalDigest([probe]);
const local = sdkDigest(vault.address, chainId, probe);
if (onchain !== local) throw new Error(`EIP-712 digest mismatch: contract ${onchain}, sdk ${local}`);
m.readback = { ...read, digestParity: true };
save();

// Public evidence copy: addresses and readback only, no keys, no RPC URL.
if (testnet) {
  mkdirSync("evidence", { recursive: true });
  const ev = `evidence/wp1-deploy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(ev, JSON.stringify({ ...m, explorer: `https://testnet.bscscan.com/address/${vault.address}` }, null, 2));
  console.log(`evidence ${ev}`);
}
console.log(JSON.stringify(m, null, 2));
if (testnet) console.log(`explorer: https://testnet.bscscan.com/address/${vault.address}`);
