// Read-only: asks the real vault on BSC testnet what it would decide for a request.
// eth_call only: no transaction, no gas, no keys. The approval is public test data.
import { createPublicClient, http, getAddress, isAddress, parseUnits } from "viem";
import { bscTestnet } from "viem/chains";
import TRY from "../try-approval.js";
const REASONS = ["Ok","Paused","NotAgent","BadSignature","NotEnoughApprovers","Expired","Revoked","UsesExhausted","TokenMismatch","RecipientMismatch","RecipientNotAllowed","ZeroAmount","AmountAboveApproval","CapExceeded","DailyLimitExceeded","InsufficientBalance"];
const ABI = [{ type: "function", name: "check", stateMutability: "view",
  inputs: [{ name: "caller", type: "address" },
    { name: "a", type: "tuple", components: [{ name: "agent", type: "address" }, { name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "maxAmount", type: "uint256" }, { name: "cap", type: "uint256" }, { name: "maxUses", type: "uint32" }, { name: "expiry", type: "uint64" }, { name: "salt", type: "bytes32" }] },
    { name: "sigs", type: "tuple[]", components: [{ name: "signer", type: "address" }, { name: "signature", type: "bytes" }] },
    { name: "r", type: "tuple", components: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }] }],
  outputs: [{ name: "reason", type: "uint8" }, { name: "digest", type: "bytes32" }] }];
const client = createPublicClient({ chain: bscTestnet, transport: http("https://bsc-prebsc-dataseed.bnbchain.org") });
const bad = (res, error) => res.status(400).json({ error });
// Every parameter must appear at most once, as a plain string.
const one = (v) => (Array.isArray(v) ? null : v == null ? "" : String(v));
export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method && req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "Use GET." });
  const q = req.query || {};
  const unknown = Object.keys(q).find((k) => !["recipient", "amount", "forge"].includes(k));
  if (unknown) return bad(res, "Unknown parameter. Use recipient, amount and forge.");
  const recipient = one(q.recipient), amountStr = one(q.amount), forge = one(q.forge);
  if (recipient === null || amountStr === null || forge === null) return bad(res, "Each parameter may be given only once.");
  // forge must be absent, "0" or "1". Anything else fails closed rather than running the genuine signature.
  if (forge !== "" && forge !== "0" && forge !== "1") return bad(res, "forge must be 0 or 1.");
  const to = recipient.trim(), amt = amountStr.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(to) && !isAddress(to)) return bad(res, "That address has a bad checksum: one character was changed. Use all lowercase or the exact mixed case.");
  if (!isAddress(to)) return bad(res, "Enter a wallet address (0x followed by 40 hex characters).");
  // Up to 1,000,000,000 test USD with at most two decimals; 0 is passed on so the vault can answer ZeroAmount itself.
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(amt) || Number(amt) > 1e9) return bad(res, "Enter an amount up to 1,000,000,000, for example 3400.");
  try {
    const a = TRY.approval;
    const approval = { agent: a.agent, token: a.token, recipient: a.recipient, maxAmount: BigInt(a.maxAmount), cap: BigInt(a.cap), maxUses: Number(a.maxUses), expiry: BigInt(a.expiry), salt: a.salt };
    let sig = TRY.signatures[0].signature;
    if (forge === "1") sig = sig.slice(0, 10) + (sig[10] === "a" ? "b" : "a") + sig.slice(11);
    const [reason] = await client.readContract({ address: TRY.vault, abi: ABI, functionName: "check",
      args: [TRY.agent, approval, [{ signer: TRY.signatures[0].signer, signature: sig }], { token: TRY.token, recipient: getAddress(to), amount: parseUnits(amt, 18) }] });
    res.status(200).json({ reason: REASONS[reason] ?? String(reason), wouldPay: reason === 0 });
  } catch {
    res.status(502).json({ error: "The vault could not be reached right now. Try again." });
  }
}
