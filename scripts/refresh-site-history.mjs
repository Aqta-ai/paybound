// Regenerates site/history.js: every SpendExecuted and SpendRefused event of the Paybound vault
// on BSC testnet up to the current head, so /api/events only has to read the newest blocks live.
// Read-only, no keys. Usage: node scripts/refresh-site-history.mjs
import { writeFileSync } from "node:fs";
import HIST from "../site/history.js";
const RPC = process.env.RPC_URL || "https://bsc-prebsc-dataseed.bnbchain.org";
const VAULT = "0x190d9e1a4d9193371aa7b884db61bd93e71ae146";
const CHUNK = 5000;
const T_EXEC = "0x956921cde5479120cb06d2311b81dab58237a2966828047963ae4a89254b5448";
const T_REF = "0xf20bba9b3164b676fc624b091d5399791077605c97be6f33081ce1581a867a36";
async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const j = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
      if (!j.error) return j.result;
    } catch {}
    await new Promise((s) => setTimeout(s, 500 * (i + 1)));
  }
  throw new Error(method + " failed");
}
const head = parseInt(await rpc("eth_blockNumber", []), 16);
const from = HIST.upTo + 1;
const fresh = [];
for (let b = from; b <= head; b += CHUNK * 6) {
  const ranges = [];
  for (let c = b; c < Math.min(b + CHUNK * 6, head + 1); c += CHUNK) ranges.push([c, Math.min(c + CHUNK - 1, head)]);
  const parts = await Promise.all(ranges.map(([x, y]) => rpc("eth_getLogs", [{ address: VAULT, fromBlock: "0x" + x.toString(16), toBlock: "0x" + y.toString(16), topics: [[T_EXEC, T_REF]] }])));
  for (const l of parts.flat()) fresh.push({
    kind: l.topics[0] === T_EXEC ? "paid" : "refused",
    tx: l.transactionHash, block: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16),
    digest: l.topics[1], agent: "0x" + l.topics[2].slice(26), recipient: "0x" + l.topics[3].slice(26),
    amount: BigInt("0x" + l.data.slice(66, 130)).toString(),
    reason: l.topics[0] === T_REF ? parseInt(l.data.slice(130, 194), 16) : 0,
  });
}
const seen = new Set(HIST.events.map((e) => e.tx + ":" + e.logIndex));
const events = [...fresh.filter((e) => !seen.has(e.tx + ":" + e.logIndex)), ...HIST.events].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
writeFileSync(new URL("../site/history.js", import.meta.url), "export default " + JSON.stringify({ upTo: head, events }) + ";\n");
console.log(`history.js: ${events.length} events (${events.length - HIST.events.length} new), indexed to block ${head}`);
