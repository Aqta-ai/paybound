// SPDX-License-Identifier: Apache-2.0
// A readable result card for terminals. Presentation only: it never changes a result.
// Plain ASCII frame, colour only on a TTY, and NO_COLOR is respected.
import type { Address } from "viem";
import type { Approval, Request, SubmitResult } from "./index.js";

export const REASON_TEXT: Record<string, string> = {
  Ok: "Matches the approval",
  Paused: "The vault is frozen",
  NotAgent: "Not a registered agent",
  BadSignature: "Signature is not from an approver",
  NotEnoughApprovers: "Not enough approvers",
  Expired: "Approval has expired",
  Revoked: "Approval was revoked",
  UsesExhausted: "Approval already used",
  TokenMismatch: "Token is not the one approved",
  RecipientMismatch: "Recipient is not the one approved",
  RecipientNotAllowed: "Recipient is not on the allowlist",
  ZeroAmount: "Amount is zero",
  AmountAboveApproval: "Amount is above the approval",
  CapExceeded: "Total approved amount used up",
  DailyLimitExceeded: "Daily limit reached",
  InsufficientBalance: "Not enough funds in the vault",
};

const WIDTH = 76;
const LABEL = 15;

const useColour = () =>
  typeof process !== "undefined" && !!process.stdout?.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColour() ? `\x1b[${code}m${s}\x1b[0m` : s);

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const amount = (v: bigint, decimals: number) => {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "").slice(0, 2);
  return `${BigInt(whole).toLocaleString("en-US")}${frac ? "." + frac : ""}`;
};

function line(label: string, value: string): string {
  const inner = WIDTH - 4;
  const room = inner - LABEL - 1;
  const v = value.length > room ? value.slice(0, room - 1) + "…" : value;
  return `| ${label.padEnd(LABEL)} ${v.padEnd(room)} |`;
}

/** A card describing what the vault decided for one request. */
export function formatResult(
  result: Pick<SubmitResult, "outcome" | "reason" | "txHash">,
  request: Request,
  approval?: Approval,
  opts: { decimals?: number; explorer?: string } = {},
): string {
  const d = opts.decimals ?? 18;
  const paid = result.outcome === "Executed";
  const status = paid ? "Paid" : result.outcome === "Queued" ? "Queued" : "Refused";
  const colour = paid ? "32" : result.outcome === "Queued" ? "33" : "31";
  const rule = "+" + "-".repeat(WIDTH - 2) + "+";
  const title = "Spend Guard";
  const head = `| ${title}${" ".repeat(WIDTH - 4 - title.length - status.length)}${paint("1;" + colour, status)} |`;
  const rows = [
    line("Decision", REASON_TEXT[result.reason] ?? result.reason) + "",
    line("Code", result.reason),
    line(paid ? "Paid" : "Tried to pay", `${amount(request.amount, d)} to ${short(request.recipient)}`),
  ];
  if (approval) {
    const uses = approval.maxUses === 1 ? "1 use" : `${approval.maxUses} uses`;
    rows.push(line("Approved", `${amount(approval.maxAmount, d)} to ${short(approval.recipient)}, ${uses}`));
  }
  rows.push(line("Money moved", paid ? `${amount(request.amount, d)}` : "none"));
  rows.push(line("Evidence", `${short(result.txHash)} on chain${opts.explorer ? " · " + opts.explorer : ""}`));
  return [rule, head, rule, ...rows, rule].join("\n");
}

/** Prints the card to stdout. */
export function printResult(...args: Parameters<typeof formatResult>): void {
  console.log(formatResult(...args));
}

export type { Address };
