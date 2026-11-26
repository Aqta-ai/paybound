// SPDX-License-Identifier: Apache-2.0
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { bsc } from "viem/chains";

// BSC mainnet block 135629952: the Venus Atlas adapter 0x9E6928Ec418948ceb9f1cd9872fD312b13D841D0
// returned this feed and maxStalePeriod=86700 for USDT (0x55d398326f99059fF775485246999027B3197955).
// This public client has no account and is independent of the payment chain.
export const ATLAS_FEED = "0x9fc000fc9c17578b49853278a517e357201d01e4";
export const ATLAS_MAX_AGE_MS = 86_700_000;
const abi = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

export type AtlasQuote = {
  source: "Atlas";
  symbol: "USDT";
  price: number;
  lastUpdated: string;
  chainId: 56;
  feed: typeof ATLAS_FEED;
  block: string;
  blockHash: string;
  round: string;
  answer: string;
  decimals: 18;
};

export class AtlasDataError extends Error {}

export async function readAtlasQuote(rpcUrl: string): Promise<AtlasQuote> {
  // Instantiate outside the payment client so mainnet prices can never change its chain.
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { retryCount: 0, timeout: 6000 }) });
  const chainId = await client.getChainId();
  if (chainId !== bsc.id) throw new AtlasDataError("Atlas RPC returned the wrong chain");
  const block = await client.getBlock();
  if (!/^0x[0-9a-f]{64}$/i.test(block.hash) || !block.number || !block.timestamp) {
    throw new AtlasDataError("Atlas RPC returned an incomplete block");
  }
  const now = Date.now();
  const blockTime = Number(block.timestamp) * 1000;
  if (blockTime > now + 30_000 || now - blockTime > 120_000) throw new AtlasDataError("Atlas RPC block time is out of range");
  const target = { address: ATLAS_FEED, abi, blockHash: block.hash, requireCanonical: true } as const;
  const [description, decimals, data] = await Promise.all([
    client.readContract({ ...target, functionName: "description" }),
    client.readContract({ ...target, functionName: "decimals" }),
    client.readContract({ ...target, functionName: "latestRoundData" }),
  ]);
  if (description !== "SingleFeed USDT/USD" || decimals !== 18) throw new AtlasDataError("Atlas feed identity mismatch");
  const [round, answer, started, updated, answeredInRound] = data;
  if (answer <= 0n || round === 0n || answeredInRound !== round ||
      started === 0n || started > updated || updated > block.timestamp) {
    throw new AtlasDataError("Invalid Atlas round");
  }
  return {
    source: "Atlas", symbol: "USDT", chainId, feed: ATLAS_FEED, block: String(block.number), blockHash: block.hash,
    round: String(round), answer: String(answer), decimals, price: Number(formatUnits(answer, decimals)),
    lastUpdated: new Date(Number(updated) * 1000).toISOString(),
  };
}
