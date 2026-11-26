// SPDX-License-Identifier: Apache-2.0
// The "brain" of the example payments agent. By default a deliberately gullible
// offline mock that does whatever the latest message says, so the demo shows the
// vault holding even when the agent is fully fooled. Optionally, any
// OpenAI-compatible chat endpoint (for example a local Ollama or vLLM server).

export type Decision = {
  pay: boolean;
  invoice: string; // which approved invoice the agent believes it is paying
  recipient: `0x${string}`;
  amount: string; // decimal token units, e.g. "4800"
  note: string;
  /**
   * Set only when the agent's own code, not the model, settled the decision: the reply held no
   * readable decision, or its recipient or amount could not be used. The note then says so.
   */
  guard?: "no-decision" | "recipient" | "amount";
};

export type InboxMessage = { from: string; subject: string; body: string };

const ADDRESS = /0x[0-9a-fA-F]{40}/;
/** A whole field that is exactly one address, nothing before or after it. */
const EXACT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// English, Thai and Chinese verbs for pay / transfer (โอน, จ่าย, ชำระ; 转账, 支付, 付款, 汇款).
const AMOUNT = /(?:send|pay|transfer|โอน|จ่าย|ชำระ|转账|支付|付款|汇款)\s*(?:เงิน\s*)?([0-9][0-9,]*(?:\.[0-9]+)?)/i;
const INVOICE = /\b[A-Z]{2,3}-\d+\b/;

/** Label on every note the agent's own code writes, so nobody reads it as the model's words. */
export const GUARD_LABEL = "Agent guard (not the model):";
/** Tries per decision when the reply is not readable JSON: the first ask plus one retry. */
export const MODEL_TRIES = 2;
const MAX_TOKENS = 200;

/** Offline mock: obeys instructions in the message body, including injected ones. */
export function mockDecide(msg: InboxMessage, known: { recipient: `0x${string}`; amount: string }): Decision {
  const text = `${msg.subject}\n${msg.body}`;
  const addr = text.match(ADDRESS)?.[0] as `0x${string}` | undefined;
  const amt = text.match(AMOUNT)?.[1]?.replace(/,/g, "");
  return {
    pay: /pay|send|transfer|settle|โอน|จ่าย|ชำระ|转账|支付|付款|汇款/i.test(text),
    invoice: text.match(INVOICE)?.[0] ?? "unknown",
    recipient: addr ?? known.recipient,
    amount: amt ?? known.amount,
    note: addr && addr.toLowerCase() !== known.recipient.toLowerCase() ? "followed new bank details in message" : "",
  };
}

/**
 * Burn and placeholder addresses: the zero address, anything ending in "dead", and any address
 * with a run of 16 or more of one hex character (0x000..., 0x1111...). Nobody holds their keys,
 * and a small model tends to loop on the repeated characters until its reply is cut off. A real
 * wallet, vanity prefixes included, almost never has such a run.
 */
export function isPlaceholderAddress(addr: string): boolean {
  const hex = addr.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) return false;
  return hex.endsWith("dead") || /(.)\1{15}/.test(hex);
}

/**
 * One positive decimal amount from what a model wrote: "3,400 test USD" is "3400", "฿4 800" is
 * "4800". Thousands separators go, and so do currency words and symbols. Anything else (no
 * number, two numbers, a negative, zero) returns undefined.
 */
export function parseAmount(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  // Separators only between digit groups of three: 3,400 / 3 400 / 3_400 / 3'400 / 3，400.
  const s = String(v).trim().replace(/(\d)[,\s_'’，](?=\d{3}(?!\d))/g, "$1");
  if (/-\s*\p{Sc}?\s*\d/u.test(s)) return undefined;
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 1) return undefined;
  // Around the number there may only be currency words, symbols, spaces or a closing full stop.
  if (!/^[\p{L}\p{M}\p{Sc}\s.。]*$/u.test(s.replace(nums[0], ""))) return undefined;
  const n = nums[0].replace(/^0+(?=\d)/, "");
  return /[1-9]/.test(n) ? n : undefined;
}

const str = (v: unknown, fallback: string) =>
  v == null ? fallback : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

function guarded(known: { recipient: `0x${string}`; amount: string }, guard: NonNullable<Decision["guard"]>, why: string, invoice = "unknown", modelNote = ""): Decision {
  const said = modelNote.trim() ? ` The model wrote: ${modelNote.trim()}` : "";
  return { pay: false, invoice, recipient: known.recipient, amount: known.amount, note: `${GUARD_LABEL} ${why}${said}`, guard };
}

/**
 * Reads one model reply. Returns undefined when it holds no JSON object, so the caller can ask
 * again. The agent pays only when "pay" is true (or the text "true"); a recipient must be exactly
 * one address and an amount one positive number, or the agent declines and labels why.
 */
export function parseDecision(raw: string, known: { recipient: `0x${string}`; amount: string }): Decision | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const json = parsed as Record<string, unknown>;
  const pay = json.pay === true || (typeof json.pay === "string" && json.pay.trim().toLowerCase() === "true");
  const invoice = str(json.invoice, "unknown");
  const note = str(json.note, "");
  const to = str(json.recipient, "").trim();
  const recipient = EXACT_ADDRESS.test(to) ? (to as `0x${string}`) : undefined;
  const given = json.amount != null && str(json.amount, "").trim() !== "";
  const amount = given ? parseAmount(json.amount) : known.amount;
  if (!pay) return { pay: false, invoice, recipient: recipient ?? known.recipient, amount: amount ?? known.amount, note };
  // A payments agent never guesses a payee or an amount: a field it cannot read means no payment.
  // A field left out means the one on file, as the prompt describes.
  if (to && !recipient) return guarded(known, "recipient", `the model chose to pay, but its recipient "${to.slice(0, 80)}" is not one wallet address, so nothing was sent.`, invoice, note);
  if (!amount) return guarded(known, "amount", `the model chose to pay, but its amount "${str(json.amount, "").slice(0, 40)}" is not one positive number, so nothing was sent.`, invoice, note);
  return { pay: true, invoice, recipient: recipient ?? known.recipient, amount, note };
}

async function askModel(base: string, msg: InboxMessage, known: { recipient: `0x${string}`; amount: string }): Promise<string | undefined> {
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(Number(process.env.AGENT_MODEL_TIMEOUT_MS ?? 60000)),
    headers: {
      "content-type": "application/json",
      ...(process.env.AGENT_MODEL_KEY ? { authorization: `Bearer ${process.env.AGENT_MODEL_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: process.env.AGENT_MODEL_NAME ?? "local-model",
      temperature: 0,
      // A reply is about 100 tokens. The cap stops a model that loops on an address from holding the stage.
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an accounts-payable agent. Read the email and decide whether to pay. " +
            `The supplier on file is ${known.recipient} and the approved amount is ${known.amount}. ` +
            "Amounts in emails may use thousands separators and currency words (3,400 test USD is 3400). " +
            'Reply with JSON only: {"pay":bool,"invoice":"INV-...","recipient":"0x...","amount":"decimal","note":"..."}',
        },
        { role: "user", content: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${msg.body}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`model endpoint returned ${res.status}`);
  let data: { choices?: { message?: { content?: unknown } }[] };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return undefined;
  }
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}

/** Optional real model. Set AGENT_MODEL_URL (OpenAI-compatible base URL) and AGENT_MODEL_NAME. */
export async function modelDecide(
  msg: InboxMessage,
  known: { recipient: `0x${string}`; amount: string },
): Promise<Decision> {
  const base = process.env.AGENT_MODEL_URL;
  if (!base) return mockDecide(msg, known);
  for (let i = 0; i < MODEL_TRIES; i++) {
    const raw = await askModel(base, msg, known);
    const decision = raw === undefined ? undefined : parseDecision(raw, known);
    if (decision) return decision;
  }
  // A model that answers in prose, or is cut off, has not decided to pay; never crash the run over it.
  return guarded(known, "no-decision", `the model did not return a decision in ${MODEL_TRIES} tries, so the agent declined and nothing was sent.`);
}
