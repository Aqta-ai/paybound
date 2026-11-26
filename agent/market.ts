// SPDX-License-Identifier: Apache-2.0
// Off-chain checks on the USDT reference value before the agent submits a test-token payment.
// CoinMarketCap also supplies the display-only fiat conversion. Its HTTP response metadata is
// recorded in evidence/cmc-calls.jsonl. Market readings cannot modify a vault approval.
import { appendFileSync, mkdirSync } from "node:fs";
import { parseUnits } from "viem";
import { AtlasDataError, ATLAS_MAX_AGE_MS, readAtlasQuote, type AtlasQuote } from "./atlas.js";

const BASE = "https://pro-api.coinmarketcap.com";
const LOG = "evidence/cmc-calls.jsonl";
const CACHE_MS = 60_000;

export type Quote = { symbol: string; price: number; lastUpdated: string; source: "CoinMarketCap" | "Stage simulation"; simulated?: boolean };
export type PegResult = Quote & { ok: boolean; deviation: number; tolerance: number };
export type FiatValue = { amountUsd: number; fiat: string; value: number; lastUpdated: string; source: "CoinMarketCap" };

const cache = new Map<string, { at: number; value: unknown }>();
let simulatedPrice: number | null = null;

/** Stage control: pretend the stablecoin trades at this price (labelled "simulated" everywhere). null clears it. */
export function simulatePegPrice(price: number | null) {
  simulatedPrice = price;
}
export function simulatedPeg(): number | null {
  return simulatedPrice;
}

export function cmcEnabled(): boolean {
  return Boolean(process.env.CMC_API_KEY?.trim());
}

export function atlasRpc(): string | undefined {
  return process.env.ATLAS_BSC_RPC_URL?.trim() || undefined;
}

export function marketEnabled(): boolean {
  return cmcEnabled() || Boolean(atlasRpc());
}

async function cmc(path: string, params: Record<string, string>): Promise<any> {
  const key = process.env.CMC_API_KEY?.trim();
  if (!key) throw new Error("CMC_API_KEY is not set");
  const qs = new URLSearchParams(params).toString();
  const cacheKey = `${path}?${qs}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { "X-CMC_PRO_API_KEY": key, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as any;
  try {
    mkdirSync("evidence", { recursive: true });
    appendFileSync(
      LOG,
      JSON.stringify({
        at: new Date().toISOString(),
        endpoint: path,
        params,
        http: res.status,
        errorCode: body?.status?.error_code ?? null,
        creditCount: body?.status?.credit_count ?? null,
        cmcTimestamp: body?.status?.timestamp ?? null,
      }) + "\n",
    );
  } catch {
    // logging must never break a payment check
  }
  if (!res.ok || body?.status?.error_code) throw new Error(`CoinMarketCap: ${body?.status?.error_message ?? res.status}`);
  cache.set(cacheKey, { at: Date.now(), value: body });
  return body;
}

/** Latest USD quote. For USDT select the Tether asset (CMC ID 825), since symbols are shared. */
async function liveQuote(symbol: string): Promise<Quote> {
  const body = await cmc("/v2/cryptocurrency/quotes/latest", symbol === "USDT" ? { id: "825", convert: "USD" } : { symbol, convert: "USD" });
  const byId = symbol === "USDT" ? body.data?.["825"] : undefined;
  const rows = byId ? (Array.isArray(byId) ? byId : [byId]) : body.data?.[symbol];
  const d = Array.isArray(rows) ? rows.find(asset => asset?.symbol === symbol && (symbol !== "USDT" || asset.id === 825)) : undefined;
  const usd = d?.quote?.USD;
  if (typeof usd?.price !== "number" || !Number.isFinite(usd.price) || usd.price <= 0 || typeof usd.last_updated !== "string" || !Number.isFinite(Date.parse(usd.last_updated))) {
    throw new Error("CoinMarketCap returned an invalid USD quote");
  }
  return { symbol, price: usd.price, lastUpdated: usd.last_updated, source: "CoinMarketCap" };
}

function stageQuote(symbol: string, price: number): Quote {
  return { symbol, price, lastUpdated: new Date().toISOString(), source: "Stage simulation", simulated: true };
}

export async function quote(symbol: string): Promise<Quote> {
  return simulatedPrice !== null ? stageQuote(symbol, simulatedPrice) : liveQuote(symbol);
}

export async function pegCheck(symbol: string, tolerance = 0.01): Promise<PegResult> {
  const q = await quote(symbol);
  return { ...q, deviation: Math.abs(q.price - 1), tolerance, ok: q.price >= 1 - tolerance && q.price <= 1 + tolerance };
}

const CMC_MAX_AGE_MS = 300_000;
const ONE_DOLLAR = 10n ** 18n;
const MAX_SOURCE_SPREAD = ONE_DOLLAR / 200n; // Half a cent per USDT.
// CMC supplies JSON numbers. Compare in the feed's 18 decimal units so one wei past the
// threshold cannot be rounded back inside it when converted to a JavaScript number.
const decimal = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 18 });
const usdUnits = (value: number) => parseUnits(decimal.format(value), 18);
type MarketQuote = Quote | AtlasQuote;
export type MarketCheck = {
  symbol: string;
  mode: "CoinMarketCap" | "CoinMarketCap + Atlas";
  checkedAt: string;
  tolerance: number;
  quotes: MarketQuote[];
  reasons: string[];
};
type Gate = { hold: boolean; market?: MarketCheck; note?: string };

export async function checkPaymentMarket(symbol: string, tolerance: number): Promise<Gate> {
  // A stage simulation may only ever hold a payment. A simulated price inside the band is ignored and
  // the live sources run as usual, so a simulation can never replace a real check with a pass.
  const sim = simulatedPrice !== null && Math.abs(simulatedPrice - 1) > tolerance ? simulatedPrice : null;
  if (!marketEnabled() && sim === null) return { hold: false };
  const rpc = atlasRpc();
  const quotes: MarketQuote[] = [];
  const reasons: string[] = [];
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 1) reasons.push("Invalid peg tolerance");
  if (rpc && symbol !== "USDT") reasons.push("Atlas is configured for USDT/USD only");

  if (reasons.length === 0 && sim !== null) {
    quotes.push(stageQuote(symbol, sim));
    reasons.push("Stage simulation: the price is outside the band");
    if (rpc) reasons.push("Clear the simulation to run both live sources");
  } else if (reasons.length === 0) {
    const reads: Promise<MarketQuote>[] = [liveQuote(symbol)];
    if (rpc) reads.push(readAtlasQuote(rpc));
    const results = await Promise.allSettled(reads);
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") quotes.push(result.value);
      else if (index === 0) reasons.push("CoinMarketCap quote missing or invalid");
      else reasons.push(result.reason instanceof AtlasDataError ? result.reason.message : "Atlas RPC or feed unavailable");
    }
  }

  const now = Date.now();
  const prices = quotes.map(q => q.source === "Atlas" ? BigInt(q.answer) : usdUnits(q.price));
  for (const [index, q] of quotes.entries()) {
    const age = now - Date.parse(q.lastUpdated);
    const maxAge = q.source === "Atlas" ? ATLAS_MAX_AGE_MS : CMC_MAX_AGE_MS;
    if (!Number.isFinite(age) || age < 0 || age > maxAge) reasons.push(`${q.source} timestamp is missing, stale or in the future`);
    const limit = usdUnits(tolerance);
    if (prices[index] < ONE_DOLLAR - limit || prices[index] > ONE_DOLLAR + limit) {
      reasons.push(`${q.source} price is outside the ${tolerance * 100}% peg tolerance`);
    }
  }
  if (prices.length === 2 && (prices[0] - prices[1] > MAX_SOURCE_SPREAD || prices[1] - prices[0] > MAX_SOURCE_SPREAD)) {
    reasons.push("CoinMarketCap and Atlas differ by more than $0.005 per USDT");
  }
  const market: MarketCheck = { symbol, mode: rpc ? "CoinMarketCap + Atlas" : "CoinMarketCap", checkedAt: new Date(now).toISOString(), tolerance, quotes, reasons };
  return reasons.length ? { hold: true, market, note: reasons.join(". ") } : { hold: false, market };
}

/** A USD amount in another fiat currency, at CoinMarketCap's conversion rate. */
export async function fiatValue(amountUsd: number, fiat: string): Promise<FiatValue> {
  const body = await cmc("/v2/tools/price-conversion", { amount: String(amountUsd), symbol: "USD", convert: fiat });
  const d = Array.isArray(body.data) ? body.data[0] : body.data;
  const q = d?.quote?.[fiat];
  if (!q?.price) throw new Error(`CoinMarketCap returned no ${fiat} conversion`);
  return { amountUsd, fiat, value: q.price, lastUpdated: q.last_updated, source: "CoinMarketCap" };
}
