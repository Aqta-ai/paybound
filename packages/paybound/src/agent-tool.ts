// SPDX-License-Identifier: Apache-2.0
// A drop-in payment tool for any function-calling AI agent.
// The model fills in recipient and amount. It never chooses which approval
// applies or whether the payment is allowed: the vault decides on chain, and
// every refusal is written to the chain with its reason.
import { getAddress, isAddress, parseUnits, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { assertAllowedChain, submit, type SignedApproval } from "./index.js";

export type PaymentToolOptions = {
  wallet: WalletClient;
  client: PublicClient;
  /** Approvals a person has signed for this agent. */
  approvals: SignedApproval[];
  /** Token decimals for parsing the model's amount. Default 18. */
  decimals?: number;
  /** Explorer base for transaction links, e.g. https://testnet.bscscan.com/tx/ */
  explorerTx?: string;
};

export type PaymentToolResult = {
  status: "paid" | "queued" | "refused" | "invalid";
  reason: string;
  tx?: Hex;
  link?: string;
};

/** JSON Schema tool definition, in the shape OpenAI-compatible and most agent frameworks accept. */
export const payInvoiceTool = {
  type: "function",
  function: {
    name: "pay_invoice",
    description:
      "Pay a supplier from the payment vault. Only payments a person approved will go through; anything else is refused on chain and the reason is returned.",
    parameters: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Wallet address to pay (0x...)" },
        amount: { type: "string", description: "Amount in token units, e.g. \"3400\"" },
      },
      required: ["recipient", "amount"],
      additionalProperties: false,
    },
  },
} as const;

/** Returns the tool definition and a handler to run when the model calls it. */
export function paymentTool(opts: PaymentToolOptions) {
  if (!opts.approvals.length) throw new Error("paymentTool needs at least one signed approval");
  const decimals = opts.decimals ?? 18;
  async function handle(args: { recipient?: unknown; amount?: unknown }): Promise<PaymentToolResult> {
    if (typeof args.recipient !== "string" || !isAddress(args.recipient)) return { status: "invalid", reason: "recipient is not an address" };
    if (typeof args.amount !== "string" || !/^\d+(\.\d+)?$/.test(args.amount)) return { status: "invalid", reason: "amount is not a positive number" };
    const recipient = getAddress(args.recipient) as Address;
    const amount = parseUnits(args.amount, decimals);
    if (amount === 0n) return { status: "invalid", reason: "amount is zero" };
    // Prefer an approval for this recipient. If none exists, submit against the first
    // approval anyway: the vault refuses it (RecipientMismatch) and the attempt is on record.
    const signed = opts.approvals.find((s) => s.approval.recipient.toLowerCase() === recipient.toLowerCase()) ?? opts.approvals[0];
    assertAllowedChain(signed.chainId);
    const r = await submit(opts.wallet, opts.client, signed.vault, signed, { token: signed.approval.token, recipient, amount });
    const status = r.outcome === "Executed" ? "paid" : r.outcome === "Queued" ? "queued" : "refused";
    return { status, reason: r.reason, tx: r.txHash, link: opts.explorerTx ? opts.explorerTx + r.txHash : undefined };
  }
  return { definition: payInvoiceTool, handle };
}
