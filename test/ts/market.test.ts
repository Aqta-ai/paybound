// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, type TestContext } from "node:test";
import { encodeAbiParameters, parseUnits, toFunctionSelector, toHex } from "viem";
import { ATLAS_FEED, ATLAS_MAX_AGE_MS } from "../../agent/atlas.js";
import { checkPaymentMarket, simulatePegPrice } from "../../agent/market.js";

const rpc = "https://atlas.invalid/";
const hash = `0x${"a".repeat(64)}`;
const one = 10n ** 18n;
type Fixture = {
  chainId?: number; decimals?: number; description?: string; round?: bigint; answeredInRound?: bigint;
  answer?: bigint; atlasAge?: number; blockAge?: number; cmcPrice?: number; cmcAge?: number; cmcId?: number;
  failedRpc?: boolean;
};

describe("market preflight", () => {
  const cwd = process.cwd();
  const saved = { cmc: process.env.CMC_API_KEY, atlas: process.env.ATLAS_BSC_RPC_URL };
  let tmp: string;
  let now = Date.UTC(2026, 10, 25, 8, 0);

  before(() => {
    // Only disposable fixture evidence is written by the normal CMC logging path.
    tmp = mkdtempSync(join(tmpdir(), "guard-market-"));
    process.chdir(tmp);
  });
  after(() => {
    process.chdir(cwd);
    rmSync(tmp, { recursive: true, force: true });
    if (saved.cmc === undefined) delete process.env.CMC_API_KEY;
    else process.env.CMC_API_KEY = saved.cmc;
    if (saved.atlas === undefined) delete process.env.ATLAS_BSC_RPC_URL;
    else process.env.ATLAS_BSC_RPC_URL = saved.atlas;
  });
  beforeEach(() => {
    // A fresh CMC cache interval per fixture.
    now += 120_000;
    process.env.CMC_API_KEY = "test-fixture";
    process.env.ATLAS_BSC_RPC_URL = rpc;
  });
  afterEach(() => simulatePegPrice(null));

  function mockFeeds(t: TestContext, f: Fixture = {}) {
    t.mock.timers.enable({ apis: ["Date"], now });
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("https://pro-api.coinmarketcap.com/")) {
        calls.push("cmc");
        return Response.json({ data: { USDT: [{ id: f.cmcId ?? 825, symbol: "USDT", quote: {
          USD: { price: f.cmcPrice ?? 1, last_updated: new Date(now - (f.cmcAge ?? 1000)).toISOString() },
        } }] }, status: { error_code: 0 } });
      }
      assert.equal(url, rpc);
      if (f.failedRpc) throw Error("private endpoint failure");
      const { id, method, params } = JSON.parse(String(init?.body));
      calls.push(method);
      let result: unknown;
      const blockTime = BigInt((now - (f.blockAge ?? 0)) / 1000);
      const update = BigInt((now - (f.atlasAge ?? 60_000)) / 1000);
      if (method === "eth_chainId") result = toHex(f.chainId ?? 56);
      else if (method === "eth_getBlockByNumber") result = { number: "0x1a", hash, timestamp: toHex(blockTime), transactions: [] };
      else {
        assert.equal(method, "eth_call");
        assert.equal(params[0].to.toLowerCase(), ATLAS_FEED);
        assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true });
        switch (params[0].data) {
          case toFunctionSelector("description()"):
            result = encodeAbiParameters([{ type: "string" }], [f.description ?? "SingleFeed USDT/USD"]); break;
          case toFunctionSelector("decimals()"):
            result = encodeAbiParameters([{ type: "uint8" }], [f.decimals ?? 18]); break;
          case toFunctionSelector("latestRoundData()"):
            result = encodeAbiParameters(
              [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
              [f.round ?? 1n, f.answer ?? one, update - 1n, update, f.answeredInRound ?? 1n],
            ); break;
          default: throw new Error("Unexpected Atlas method");
        }
      }
      return Response.json({ id, jsonrpc: "2.0", result });
    });
    return calls;
  }

  it("leaves the offline demo independent of market data", async t => {
    delete process.env.CMC_API_KEY;
    delete process.env.ATLAS_BSC_RPC_URL;
    const calls = mockFeeds(t);
    assert.deepEqual(await checkPaymentMarket("USDT", 0.01), { hold: false });
    assert.deepEqual(calls, []);
  });
  it("retains CMC-only mode when Atlas was not selected", async t => {
    delete process.env.ATLAS_BSC_RPC_URL;
    const calls = mockFeeds(t);
    const gate = await checkPaymentMarket("USDT", 0.01);
    assert.equal(gate.hold, false);
    assert.deepEqual(gate.market?.quotes.map(q => q.source), ["CoinMarketCap"]);
    assert.deepEqual(calls, ["cmc"]);
  });
  it("returns canonical block and exact answer alongside both sources", async t => {
    mockFeeds(t, { answer: parseUnits("1.005", 18) });
    const gate = await checkPaymentMarket("USDT", 0.01);
    assert.equal(gate.hold, false, gate.note ?? "expected a healthy pair");
    const q = gate.market!.quotes[1];
    assert.ok(q.source === "Atlas");
    assert.deepEqual([q.chainId, q.feed, q.round, q.block, q.blockHash, q.answer], [56, ATLAS_FEED, "1", "26", hash, "1005000000000000000"]);
    assert.equal(Date.parse(gate.market!.checkedAt) - Date.parse(q.lastUpdated), 60_000);
  });
  it("retains an available Atlas observation when CMC credentials are missing", async t => {
    delete process.env.CMC_API_KEY;
    const calls = mockFeeds(t);
    const gate = await checkPaymentMarket("USDT", 0.01);
    assert.equal(gate.hold, true);
    assert.deepEqual(gate.market?.quotes.map(q => q.source), ["Atlas"]);
    assert.equal(calls.includes("cmc"), false);
  });

  const failures: [string, Fixture, RegExp][] = [
    ["wrong RPC chain", { chainId: 97 }, /wrong chain/],
    ["wrong feed description", { description: "SingleFeed USDC/USD" }, /identity/],
    ["wrong decimals", { decimals: 8 }, /identity/],
    ["zero answer", { answer: 0n }, /round/],
    ["negative answer", { answer: -1n }, /round/],
    ["incomplete round", { round: 2n }, /round/],
    ["future round timestamp", { atlasAge: -1000 }, /round/],
    ["stale RPC head", { blockAge: 180_000, atlasAge: 240_000 }, /block time/],
    ["stale Atlas", { atlasAge: ATLAS_MAX_AGE_MS + 1000 }, /Atlas timestamp/],
    ["stale CMC", { cmcAge: 300_001 }, /CoinMarketCap timestamp/],
    ["future CMC", { cmcAge: -1000 }, /CoinMarketCap timestamp/],
    ["different CMC token sharing the USDT symbol", { cmcId: 999 }, /CoinMarketCap quote/],
    ["off-peg Atlas by one smallest feed unit", { answer: parseUnits("1.01", 18) + 1n, cmcPrice: 1.01 }, /Atlas price/],
    ["off-peg CMC", { cmcPrice: 0.98 }, /CoinMarketCap price/],
    ["two individually in-band sources that disagree by one unit over the limit", { answer: parseUnits("0.995", 18) - 1n }, /differ/],
    ["RPC failure", { failedRpc: true }, /Atlas RPC/],
  ];
  for (const [name, fixture, reason] of failures) {
    it(`holds for ${name}`, async t => {
      mockFeeds(t, fixture);
      const gate = await checkPaymentMarket("USDT", 0.01);
      assert.equal(gate.hold, true);
      assert.match(gate.note ?? "", reason);
      assert.doesNotMatch(JSON.stringify(gate), /test-fixture|atlas\.invalid|private endpoint/);
    });
  }
  it("keeps a simulated depeg fully offline and labels its source", async t => {
    const calls = mockFeeds(t);
    simulatePegPrice(0.97);
    const gate = await checkPaymentMarket("USDT", 0.01);
    assert.equal(gate.hold, true);
    assert.deepEqual(gate.market?.quotes.map(q => q.source), ["Stage simulation"]);
    assert.deepEqual(calls, []);
  });
  it("ignores a simulated healthy price: the live sources still run, so a simulation can only hold", async t => {
    const calls = mockFeeds(t);
    simulatePegPrice(1);
    const gate = await checkPaymentMarket("USDT", 0.01);
    assert.equal(gate.hold, false);
    assert.ok(calls.length > 0);
    assert.ok(!gate.market?.quotes.some(q => q.source === "Stage simulation"));
  });
  it("holds on a simulated depeg even with no market source configured", async t => {
    mockFeeds(t);
    delete process.env.ATLAS_BSC_RPC_URL;
    const key = process.env.CMC_API_KEY;
    delete process.env.CMC_API_KEY;
    try {
      simulatePegPrice(0.97);
      assert.equal((await checkPaymentMarket("USDT", 0.01)).hold, true);
    } finally {
      if (key !== undefined) process.env.CMC_API_KEY = key;
    }
  });
  it("rejects a different symbol and invalid tolerance before making any calls", async t => {
    const calls = mockFeeds(t);
    assert.equal((await checkPaymentMarket("USDC", 0.01)).hold, true);
    assert.equal((await checkPaymentMarket("USDT", NaN)).hold, true);
    assert.deepEqual(calls, []);
  });
});
