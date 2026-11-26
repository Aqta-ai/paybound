// SPDX-License-Identifier: Apache-2.0
// guard: command-line front end to the SDK.
//
//   npm run guard -- approve --vault 0x.. --agent 0x.. --token 0x.. --recipient 0x.. --amount 4800 [--uses 1] [--cap 4800] [--hours 24] [--decimals 18]
//   npm run guard -- cosign <approval.json>
//   npm run guard -- check <approval.json> [--amount 4800] [--recipient 0x..]
//   npm run guard -- submit <approval.json> [--amount 4800] [--recipient 0x..]
//   npm run guard -- log --vault 0x.. [--from-block N]
//
// Environment (never commit these): RPC_URL (default http://127.0.0.1:8545),
// APPROVER_PRIVATE_KEY for approve/cosign, AGENT_PRIVATE_KEY for check/submit.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseUnits, defineChain, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import {
  approvalDigest,
  assertAllowedChain,
  checkRequest,
  fromJson,
  newApproval,
  readLog,
  requestFor,
  signApproval,
  submit,
  toJson,
  type SignedApproval,
} from "../sdk/index.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const probe = createPublicClient({ transport: http(rpc) });
const chainId = await probe.getChainId();
assertAllowedChain(chainId);
const chain =
  chainId === 97
    ? bscTestnet
    : defineChain({
        id: chainId,
        name: "local",
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      });
const client = createPublicClient({ chain, transport: http(rpc) });

function key(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
}
function wallet(name: string) {
  return createWalletClient({ account: privateKeyToAccount(key(name)), chain, transport: http(rpc) });
}
function need(name: string): string {
  const v = flags[name];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}
function loadSigned(): SignedApproval {
  return fromJson(readFileSync(positional[0] ?? need("file"), "utf8"));
}
function requestFromFlags(s: SignedApproval) {
  const decimals = Number(flags.decimals ?? 18);
  const req = requestFor(s.approval, flags.amount ? parseUnits(flags.amount, decimals) : undefined);
  if (flags.recipient) req.recipient = flags.recipient as Address;
  return req;
}

switch (cmd) {
  case "approve": {
    const w = wallet("APPROVER_PRIVATE_KEY");
    const vault = need("vault") as Address;
    const decimals = Number(flags.decimals ?? 18);
    const now = Number((await client.getBlock()).timestamp);
    const uses = Number(flags.uses ?? 1);
    const amount = parseUnits(need("amount"), decimals);
    const approval = newApproval({
      agent: need("agent") as Address,
      token: (flags.token ?? "0x0000000000000000000000000000000000000000") as Address,
      recipient: need("recipient") as Address,
      amount,
      cap: flags.cap ? parseUnits(flags.cap, decimals) : amount * BigInt(uses),
      maxUses: uses,
      validForSeconds: Number(flags.hours ?? 24) * 3600,
      now,
    });
    const signed: SignedApproval = {
      vault,
      chainId,
      approval,
      signatures: [await signApproval(w, vault, chainId, approval)],
      digest: approvalDigest(vault, chainId, approval),
    };
    mkdirSync("approvals", { recursive: true });
    const out = flags.out ?? `approvals/${signed.digest.slice(0, 18)}.json`;
    writeFileSync(out, toJson(signed));
    console.log(`signed approval ${signed.digest}\nwritten to ${out}`);
    break;
  }
  case "cosign": {
    const s = loadSigned();
    const w = wallet("APPROVER_PRIVATE_KEY");
    s.signatures.push(await signApproval(w, s.vault, s.chainId, s.approval));
    writeFileSync(positional[0], toJson(s));
    console.log(`${s.signatures.length} signatures on ${s.digest}`);
    break;
  }
  case "check": {
    const s = loadSigned();
    const agent = privateKeyToAccount(key("AGENT_PRIVATE_KEY")).address;
    console.log(await checkRequest(client, s.vault, agent, s, requestFromFlags(s)));
    break;
  }
  case "submit": {
    const s = loadSigned();
    const res = await submit(wallet("AGENT_PRIVATE_KEY"), client, s.vault, s, requestFromFlags(s));
    console.log(`${res.outcome} ${res.reason}${res.pendingId ? ` (queue id ${res.pendingId})` : ""}\ntx ${res.txHash}`);
    break;
  }
  case "log": {
    const entries = await readLog(client, need("vault") as Address, BigInt(flags["from-block"] ?? 0));
    for (const e of entries) {
      const a = e.args;
      const detail = ["recipient", "amount", "reason", "id", "by"]
        .filter((k) => a[k] !== undefined)
        .map((k) => `${k}=${String(a[k])}`)
        .join(" ");
      console.log(`#${e.blockNumber} ${e.event} ${detail}`);
    }
    break;
  }
  default:
    console.log("commands: approve, cosign, check, submit, log (see cli/guard.ts)");
}
