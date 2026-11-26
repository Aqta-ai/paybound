// SPDX-License-Identifier: Apache-2.0
// The core proof on BSC testnet, three transactions against one fresh approval:
//   1. the agent asks to pay a changed wallet      -> refused (RecipientMismatch), nothing moves
//   2. the agent asks to pay the approved supplier -> executed, 3,400 tUSD moves once
//   3. the agent asks for the same payment again   -> refused (UsesExhausted), nothing moves
// Order matters: the changed-wallet request comes first, because after the payment the
// vault would refuse it as UsesExhausted before it ever compared the recipient.
// Every outcome is read from the vault's events, then recounted from the chain's log.
// Writes evidence/wp2-core-proof-<time>.json (addresses and hashes only, no keys).
// Run: npm run proof:testnet   (needs npm run deploy:bsc-testnet first)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import {
  approvalDigest,
  checkRequest,
  newApproval,
  readLog,
  requestFor,
  signApproval,
  submit,
  type SignedApproval,
} from "../sdk/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} missing in .env`);
  return v;
};
const rpc = process.argv.includes("--rpc") ? process.argv[process.argv.indexOf("--rpc") + 1] : need("BSC_TESTNET_RPC_URL");
const m = JSON.parse(readFileSync("deployments/bsc-testnet.local.json", "utf8"));
const vault = getAddress(m.vault) as Address;
const token = getAddress(m.token) as Address;
const supplier = getAddress(need("SUPPLIER_ADDRESS")) as Address;
const attacker = getAddress(need("ATTACKER_ADDRESS")) as Address;

const transport = http(rpc, { retryCount: 3, timeout: 30_000 });
const client = createPublicClient({ chain: bscTestnet, transport });
const approverAcct = privateKeyToAccount(need("APPROVER_PRIVATE_KEY") as Hex);
const agentAcct = privateKeyToAccount(need("AGENT_PRIVATE_KEY") as Hex);
const approver = createWalletClient({ chain: bscTestnet, transport, account: approverAcct });
const agent = createWalletClient({ chain: bscTestnet, transport, account: agentAcct });
const chainId = await client.getChainId();
if (chainId !== 97) throw new Error(`expected chain 97, got ${chainId}`);

const T = (n: string) => parseUnits(n, 18);
const bal = (a: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const explorer = (h: string) => `https://testnet.bscscan.com/tx/${h}`;

// A person approves exactly one payment: 3,400 tUSD to the supplier, one use, valid 24 hours.
const block = await client.getBlock();
const approval = newApproval({ agent: agentAcct.address, token, recipient: supplier, amount: T("3400"), now: Number(block.timestamp) });
const signed: SignedApproval = {
  vault,
  chainId,
  approval,
  signatures: [await signApproval(approver, vault, chainId, approval)],
  digest: approvalDigest(vault, chainId, approval),
};
console.log(`approval ${signed.digest}: up to 3,400 tUSD to ${supplier}, once, signed by ${approverAcct.address}`);

const before = { supplier: await bal(supplier), attacker: await bal(attacker), vault: await bal(vault) };
const fromBlock = (await client.getBlockNumber()) + 1n;

type Step = { step: string; request: { recipient: Address; amount: string }; dryRun: string; outcome: string; reason: string; txHash: Hex; explorer: string; expected: string; pass: boolean };
const steps: Step[] = [];
async function run(step: string, recipient: Address, expected: string) {
  const req = { ...requestFor(approval), recipient };
  const dryRun = await checkRequest(client, vault, agentAcct.address, signed, req);
  const res = await submit(agent, client, vault, signed, req);
  const got = res.outcome === "Executed" ? "Executed" : `${res.outcome}:${res.reason}`;
  const s: Step = {
    step,
    request: { recipient, amount: formatUnits(req.amount, 18) },
    dryRun,
    outcome: res.outcome,
    reason: res.reason,
    txHash: res.txHash,
    explorer: explorer(res.txHash),
    expected,
    pass: got === expected,
  };
  steps.push(s);
  console.log(`${s.pass ? "PASS" : "FAIL"}  ${step}: ${got} (dry run ${dryRun})  ${s.explorer}`);
}

await run("changed wallet", attacker, "Refused:RecipientMismatch");
await run("approved supplier", supplier, "Executed");
await run("same payment again", supplier, "Refused:UsesExhausted");

const after = { supplier: await bal(supplier), attacker: await bal(attacker), vault: await bal(vault) };
const log = (await readLog(client, vault, fromBlock, { chunk: 5_000n })).filter((e) =>
  steps.some((s) => s.txHash.toLowerCase() === e.txHash.toLowerCase()),
);
const count = (e: string) => log.filter((x) => x.event === e).length;
const usage = (await client.readContract({
  address: vault,
  abi: (await import("../sdk/abi.js")).spendGuardVaultAbi,
  functionName: "usage",
  args: [signed.digest],
})) as readonly [number, boolean, bigint];

const checks = {
  allStepsAsExpected: steps.every((s) => s.pass),
  supplierPaidExactlyOnce: after.supplier - before.supplier === T("3400"),
  attackerReceivedNothing: after.attacker === before.attacker,
  vaultDownBy3400: before.vault - after.vault === T("3400"),
  logRecount: count("SpendExecuted") === 1 && count("SpendRefused") === 2,
  usesConsumed: usage[0] === 1,
};
const pass = Object.values(checks).every(Boolean);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"}  ${k}`);

mkdirSync("evidence", { recursive: true });
const file = `evidence/wp2-core-proof-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
writeFileSync(
  file,
  JSON.stringify(
    {
      what: "Core proof on BSC testnet (chain 97): changed wallet refused, supplier paid once, repeat refused. Test token only.",
      chainId,
      vault,
      token,
      approver: approverAcct.address,
      agent: agentAcct.address,
      supplier,
      changedWallet: attacker,
      approval: { ...approval, digest: signed.digest, meaning: "up to 3,400 tUSD to the supplier, once, valid 24 hours" },
      steps,
      balances: { before, after },
      log: log.map((e) => ({ event: e.event, block: e.blockNumber, tx: e.txHash, reason: e.args.reason ?? null })),
      checks,
      pass,
    },
    big,
    2,
  ),
);
console.log(`${pass ? "PASS" : "FAIL"}  core proof; evidence ${file}`);
if (!pass) process.exit(1);
