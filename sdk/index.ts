// SPDX-License-Identifier: Apache-2.0
// TypeScript SDK for SpendGuardVault. Depends only on viem.
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  hashTypedData,
  toHex,
  zeroAddress,
} from "viem";
import { spendGuardVaultAbi } from "./abi.js";

export { spendGuardVaultAbi } from "./abi.js";

export type Approval = {
  agent: Address;
  token: Address; // zeroAddress for native BNB
  recipient: Address;
  maxAmount: bigint;
  cap: bigint;
  maxUses: number;
  expiry: bigint;
  salt: Hex;
};

export type Signature = { signer: Address; signature: Hex };

export type Request = {
  token: Address;
  recipient: Address;
  amount: bigint;
};

/** An approval plus its signatures, as passed from the approver to the agent. */
export type SignedApproval = {
  vault: Address;
  chainId: number;
  approval: Approval;
  signatures: Signature[];
  digest: Hex;
};

export const REASONS = [
  "Ok",
  "Paused",
  "NotAgent",
  "BadSignature",
  "NotEnoughApprovers",
  "Expired",
  "Revoked",
  "UsesExhausted",
  "TokenMismatch",
  "RecipientMismatch",
  "RecipientNotAllowed",
  "ZeroAmount",
  "AmountAboveApproval",
  "CapExceeded",
  "DailyLimitExceeded",
  "InsufficientBalance",
] as const;
export type ReasonName = (typeof REASONS)[number];

export const OUTCOMES = ["Executed", "Queued", "Refused"] as const;
export type OutcomeName = (typeof OUTCOMES)[number];

/** Chains this project will talk to. BNB Smart Chain mainnet (56) is refused on purpose. */
export const ALLOWED_CHAIN_IDS = new Set([97, 31337]);

export function assertAllowedChain(chainId: number): void {
  if (!ALLOWED_CHAIN_IDS.has(chainId)) {
    throw new Error(`chain ${chainId} is not allowed: this project runs on BSC testnet (97) or a local chain only`);
  }
}

export const APPROVAL_TYPES = {
  Approval: [
    { name: "agent", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "cap", type: "uint256" },
    { name: "maxUses", type: "uint32" },
    { name: "expiry", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export function domain(vault: Address, chainId: number) {
  return { name: "SpendGuardVault", version: "1", chainId, verifyingContract: vault } as const;
}

export function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Builds an approval. Defaults: one use, cap equal to the amount, valid for 24 hours. */
export function newApproval(p: {
  agent: Address;
  token?: Address;
  recipient: Address;
  amount: bigint;
  cap?: bigint;
  maxUses?: number;
  validForSeconds?: number;
  now?: number;
  salt?: Hex;
}): Approval {
  const now = p.now ?? Math.floor(Date.now() / 1000);
  return {
    agent: p.agent,
    token: p.token ?? zeroAddress,
    recipient: p.recipient,
    maxAmount: p.amount,
    cap: p.cap ?? p.amount * BigInt(p.maxUses ?? 1),
    maxUses: p.maxUses ?? 1,
    expiry: BigInt(now + (p.validForSeconds ?? 86_400)),
    salt: p.salt ?? randomSalt(),
  };
}

export function approvalDigest(vault: Address, chainId: number, approval: Approval): Hex {
  return hashTypedData({
    domain: domain(vault, chainId),
    types: APPROVAL_TYPES,
    primaryType: "Approval",
    message: approval,
  });
}

/** An approver signs. Works with any viem wallet client (local key, injected wallet, hardware wallet). */
export async function signApproval(
  wallet: WalletClient,
  vault: Address,
  chainId: number,
  approval: Approval,
  account?: Account | Address,
): Promise<Signature> {
  const acct = account ?? wallet.account;
  if (!acct) throw new Error("wallet has no account");
  const signature = await wallet.signTypedData({
    account: acct,
    domain: domain(vault, chainId),
    types: APPROVAL_TYPES,
    primaryType: "Approval",
    message: approval,
  });
  const signer = typeof acct === "string" ? acct : acct.address;
  return { signer, signature };
}

/** The vault requires signers in strictly ascending address order. */
export function sortSignatures(sigs: Signature[]): Signature[] {
  return [...sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
}

export function requestFor(approval: Approval, amount?: bigint): Request {
  return { token: approval.token, recipient: approval.recipient, amount: amount ?? approval.maxAmount };
}

/** Dry run on-chain: the reason this caller's request would be refused, or "Ok". */
export async function checkRequest(
  client: PublicClient,
  vault: Address,
  caller: Address,
  signed: { approval: Approval; signatures: Signature[] },
  request: Request,
): Promise<ReasonName> {
  const [reason] = (await client.readContract({
    address: vault,
    abi: spendGuardVaultAbi,
    functionName: "check",
    args: [caller, signed.approval, sortSignatures(signed.signatures), request],
  })) as readonly [number, Hex];
  return REASONS[reason];
}

export type SubmitResult = {
  outcome: OutcomeName;
  reason: ReasonName;
  pendingId: bigint;
  txHash: Hex;
};

/** The agent submits. A refusal is a successful transaction that writes a SpendRefused event. */
export async function submit(
  wallet: WalletClient,
  client: PublicClient,
  vault: Address,
  signed: { approval: Approval; signatures: Signature[] },
  request: Request,
): Promise<SubmitResult> {
  const account = wallet.account;
  if (!account) throw new Error("wallet has no account");
  const txHash = await wallet.writeContract({
    address: vault,
    abi: spendGuardVaultAbi,
    functionName: "execute",
    args: [signed.approval, sortSignatures(signed.signatures), request],
    account,
    chain: wallet.chain,
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`transaction ${txHash} reverted`);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: spendGuardVaultAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "SpendExecuted") return { outcome: "Executed", reason: "Ok", pendingId: 0n, txHash };
      if (ev.eventName === "SpendQueued")
        return { outcome: "Queued", reason: "Ok", pendingId: (ev.args as { id: bigint }).id, txHash };
      if (ev.eventName === "SpendRefused")
        return { outcome: "Refused", reason: REASONS[(ev.args as { reason: number }).reason], pendingId: 0n, txHash };
    } catch {
      // not one of ours
    }
  }
  throw new Error(`no spend event found in ${txHash}`);
}

export type LogEntry = {
  event: string;
  blockNumber: bigint;
  txHash: Hex;
  args: Record<string, unknown>;
};

/** Reads and decodes every vault event: the approval and incident log. */
export async function readLog(
  client: PublicClient,
  vault: Address,
  fromBlock: bigint = 0n,
  opts: { chunk?: bigint } = {},
): Promise<LogEntry[]> {
  // Public RPCs cap getLogs ranges, so read in chunks when asked (BSC testnet: 5,000 blocks).
  let logs;
  if (opts.chunk) {
    const head = await client.getBlockNumber();
    logs = [];
    for (let from = fromBlock; from <= head; from += opts.chunk) {
      const to = from + opts.chunk - 1n > head ? head : from + opts.chunk - 1n;
      logs.push(...(await client.getLogs({ address: vault, fromBlock: from, toBlock: to })));
    }
  } else {
    logs = await client.getLogs({ address: vault, fromBlock, toBlock: "latest" });
  }
  const out: LogEntry[] = [];
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: spendGuardVaultAbi, data: log.data, topics: log.topics });
      const args = { ...(ev.args as Record<string, unknown>) };
      if (ev.eventName === "SpendRefused") args.reason = REASONS[args.reason as number];
      out.push({ event: ev.eventName, blockNumber: log.blockNumber!, txHash: log.transactionHash!, args });
    } catch {
      // skip logs that are not from this ABI
    }
  }
  return out;
}

// ------------------------------------------------------------------ JSON helpers

export function toJson(signed: SignedApproval): string {
  return JSON.stringify(signed, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function fromJson(text: string): SignedApproval {
  const raw = JSON.parse(text);
  const a = raw.approval;
  return {
    vault: raw.vault,
    chainId: Number(raw.chainId),
    digest: raw.digest,
    signatures: raw.signatures,
    approval: {
      agent: a.agent,
      token: a.token,
      recipient: a.recipient,
      maxAmount: BigInt(a.maxAmount),
      cap: BigInt(a.cap),
      maxUses: Number(a.maxUses),
      expiry: BigInt(a.expiry),
      salt: a.salt,
    },
  };
}
