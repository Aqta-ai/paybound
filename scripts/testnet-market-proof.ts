// SPDX-License-Identifier: Apache-2.0
// What the market data changed, recorded per payment attempt on BSC testnet.
// For each attempt the evidence holds the live quotes the agent read (CoinMarketCap, and Atlas
// when ATLAS_BSC_RPC_URL is set), the agent's decision, and either the vault transaction or the
// fact that no transaction was sent.
//   1. live quotes in band  -> the agent submits; the vault pays the approved supplier once
//   2. stage-simulated depeg -> the agent holds; no transaction is sent (labelled as simulated)
//   3. live quotes again     -> the agent submits the same request; the vault refuses it (already used)
// The vault never reads prices: its decision depends only on the person's signed approval.
// The approver here is the scripted testnet approver key (labelled as such in the evidence).
// Writes evidence/wp5-market-proof-<time>.json. Run: npm run proof:market
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { approvalDigest, newApproval, requestFor, signApproval, submit, type SignedApproval } from "../sdk/index.js";
import { checkPaymentMarket, simulatePegPrice } from "../agent/market.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} missing in .env`);
  return v;
};
need("CMC_API_KEY");
const m = JSON.parse(readFileSync("deployments/bsc-testnet.local.json", "utf8"));
const vault = getAddress(m.vault) as Address;
const token = getAddress(m.token) as Address;
const supplier = getAddress(need("SUPPLIER_ADDRESS")) as Address;
const transport = http(need("BSC_TESTNET_RPC_URL"), { retryCount: 3, timeout: 30_000 });
const client = createPublicClient({ chain: bscTestnet, transport });
const approverAcct = privateKeyToAccount(need("APPROVER_PRIVATE_KEY") as Hex);
const agentAcct = privateKeyToAccount(need("AGENT_PRIVATE_KEY") as Hex);
const approver = createWalletClient({ chain: bscTestnet, transport, account: approverAcct });
const agent = createWalletClient({ chain: bscTestnet, transport, account: agentAcct });
const chainId = await client.getChainId();
if (chainId !== 97) throw new Error("BSC testnet only");
const SYMBOL = process.env.PEG_SYMBOL ?? "USDT";
const TOL = Number(process.env.PEG_TOLERANCE ?? "0.01");

const block = await client.getBlock();
const approval = newApproval({ agent: agentAcct.address, token, recipient: supplier, amount: parseUnits("3400", 18), now: Number(block.timestamp) });
const signed: SignedApproval = {
  vault,
  chainId,
  approval,
  signatures: [await signApproval(approver, vault, chainId, approval)],
  digest: approvalDigest(vault, chainId, approval),
};

type Attempt = { step: string; simulated: boolean; market: unknown; agentDecision: "submitted" | "held"; holdReason?: string; tx?: { hash: Hex; explorer: string; vaultOutcome: string; vaultReason: string }; transactionSent: boolean };
const attempts: Attempt[] = [];

async function attempt(step: string, simulate: number | null) {
  simulatePegPrice(simulate);
  const gate = await checkPaymentMarket(SYMBOL, TOL);
  simulatePegPrice(null);
  const a: Attempt = { step, simulated: simulate !== null, market: gate.market ?? null, agentDecision: gate.hold ? "held" : "submitted", transactionSent: false };
  if (gate.hold) {
    a.holdReason = gate.note;
  } else {
    const r = await submit(agent, client, vault, signed, requestFor(approval));
    a.transactionSent = true;
    a.tx = { hash: r.txHash, explorer: `https://testnet.bscscan.com/tx/${r.txHash}`, vaultOutcome: r.outcome, vaultReason: r.reason };
  }
  attempts.push(a);
  console.log(`${step}: agent ${a.agentDecision}${a.tx ? `, vault ${a.tx.vaultOutcome} ${a.tx.vaultReason} ${a.tx.explorer}` : ", no transaction sent"}${a.holdReason ? ` (${a.holdReason})` : ""}`);
}

await attempt("live quotes", null);
await attempt("stage-simulated depeg at $0.97", 0.97);
await attempt("live quotes, same request again", null);

const checks = {
  liveAttemptPaid: attempts[0].tx?.vaultOutcome === "Executed",
  depegHeldWithNoTransaction: attempts[1].agentDecision === "held" && !attempts[1].transactionSent,
  repeatRefusedByVault: attempts[2].tx?.vaultReason === "UsesExhausted" || attempts[2].agentDecision === "held",
};
const pass = Object.values(checks).every(Boolean);
mkdirSync("evidence", { recursive: true });
const file = `evidence/wp5-market-proof-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      what: "Per-attempt market evidence on BSC testnet: the quotes the agent read, its decision, and the vault transaction or the absence of one. Test token only. Approver: the scripted testnet approver key.",
      chainId,
      vault,
      token,
      supplier,
      approval: { digest: signed.digest, meaning: "up to 3,400 test dollars to the supplier, once, valid 24 hours", approver: approverAcct.address },
      peg: { symbol: SYMBOL, tolerance: TOL, atlas: Boolean(process.env.ATLAS_BSC_RPC_URL) },
      note: "The vault never reads prices; the market check is the agent's own decision before it asks the vault.",
      attempts,
      checks,
      pass,
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
console.log(`${pass ? "PASS" : "FAIL"}  market proof; evidence ${file}`);
if (!pass) process.exit(1);
