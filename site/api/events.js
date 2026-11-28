// Read-only: every SpendExecuted and SpendRefused event of the Paybound vault on BSC testnet.
const RPC = "https://bsc-prebsc-dataseed.bnbchain.org";
const VAULT = "0x190d9e1a4d9193371aa7b884db61bd93e71ae146";
const START = 144750619, CHUNK = 5000;
// Each request scans at most LIVE_WINDOW blocks below the head: one eth_blockNumber plus at most
// 12 eth_getLogs calls, however far the chain moves. Everything older comes from history.js,
// which scripts/refresh-site-history.mjs regenerates. Blocks between history.upTo and the window
// are reported as a gap rather than scanned.
const LIVE_WINDOW = 12 * CHUNK;
import HIST from "../history.js";
const T_EXEC = "0x956921cde5479120cb06d2311b81dab58237a2966828047963ae4a89254b5448";
const T_REF = "0xf20bba9b3164b676fc624b091d5399791077605c97be6f33081ce1581a867a36";
async function rpc(method, params) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(RPC, { method: "POST", signal: AbortSignal.timeout(8000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (!j.error) return j.result;
    await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  throw new Error(method + " failed");
}
export default async function handler(req, res) {
  try {
    const head = parseInt(await rpc("eth_blockNumber", []), 16);
    if (!Number.isInteger(head) || head <= 0) throw new Error("bad head");
    const liveFrom = Math.max(HIST.upTo + 1, head - LIVE_WINDOW + 1);
    const ranges = [];
    for (let b = liveFrom; b <= head; b += CHUNK) ranges.push([b, Math.min(b + CHUNK - 1, head)]);
    const logs = [];
    for (let i = 0; i < ranges.length; i += 12) {
      const part = await Promise.all(ranges.slice(i, i + 12).map(([a, b]) => rpc("eth_getLogs", [{ address: VAULT, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [[T_EXEC, T_REF]] }])));
      part.forEach((p) => logs.push(...p));
    }
    const fresh = logs.map((l) => ({
      kind: l.topics[0] === T_EXEC ? "paid" : "refused",
      tx: l.transactionHash, block: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16),
      digest: l.topics[1], agent: "0x" + l.topics[2].slice(26), recipient: "0x" + l.topics[3].slice(26),
      amount: BigInt("0x" + l.data.slice(66, 130)).toString(),
      reason: l.topics[0] === T_REF ? parseInt(l.data.slice(130, 194), 16) : 0,
    }));
    const seen = new Set(HIST.events.map((e) => e.tx + ":" + e.logIndex));
    const events = [...fresh.filter((e) => !seen.has(e.tx + ":" + e.logIndex)), ...HIST.events].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
    const gap = liveFrom > HIST.upTo + 1 ? { from: HIST.upTo + 1, to: liveFrom - 1 } : null;
    res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ head, start: START, vault: VAULT, indexedTo: HIST.upTo, liveFrom, gap, events });
  } catch (e) {
    res.status(502).json({ error: "Could not read BNB testnet right now. Try again in a minute." });
  }
}
