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
export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const recipient = String(q.recipient || "").trim();
    const amountStr = String(q.amount || "").trim();
    if (!isAddress(recipient)) return res.status(400).json({ error: "Enter a wallet address (0x…)." });
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amountStr)) return res.status(400).json({ error: "Enter an amount, for example 3400." });
    const a = TRY.approval;
    const approval = { agent: a.agent, token: a.token, recipient: a.recipient, maxAmount: BigInt(a.maxAmount), cap: BigInt(a.cap), maxUses: Number(a.maxUses), expiry: BigInt(a.expiry), salt: a.salt };
    let sig = TRY.signatures[0].signature;
    if (q.forge === "1") sig = sig.slice(0, 10) + (sig[10] === "a" ? "b" : "a") + sig.slice(11);
    const [reason] = await client.readContract({ address: TRY.vault, abi: ABI, functionName: "check",
      args: [TRY.agent, approval, [{ signer: TRY.signatures[0].signer, signature: sig }], { token: TRY.token, recipient: getAddress(recipient), amount: parseUnits(amountStr, 18) }] });
    res.setHeader("cache-control", "no-store");
    res.status(200).json({ reason: REASONS[reason] ?? String(reason), wouldPay: reason === 0 });
  } catch (e) {
    res.status(502).json({ error: "The vault could not be reached right now. Try again." });
  }
}
