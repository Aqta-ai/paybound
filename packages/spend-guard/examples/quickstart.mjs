// SPDX-License-Identifier: Apache-2.0
// Spend Guard in five minutes: an agent pays one approved invoice, and three
// attempts to stretch that approval are refused on chain.
//
//   npx hardhat node                      (or anvil; any local chain on :8545)
//   npm install @aqta/spend-guard viem
//   node quickstart.mjs
//
// For BSC testnet: set RPC_URL to a testnet RPC and the four *_KEY variables
// to funded testnet keys. Mainnet is refused by the library.
import { createPublicClient, createWalletClient, http, parseUnits, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployVault, newApproval, signApproval, submit, requestFor, printResult, testTokenAbi, testTokenBytecode } from "@aqta/spend-guard";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// Well-known local development keys (Hardhat/Anvil accounts 0-3). Never use them on a public network.
const DEV = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
const key = (name, i) => process.env[name] ?? DEV[i];
const [owner, approver, agent, guardian] = ["OWNER_KEY", "APPROVER_KEY", "AGENT_KEY", "GUARDIAN_KEY"].map((n, i) => privateKeyToAccount(key(n, i)));

const probe = createPublicClient({ transport: http(rpc) });
const chain = defineChain({ id: await probe.getChainId(), name: "chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
const as = (account) => createWalletClient({ account, chain, transport: http(rpc) });
const T = (n) => parseUnits(n, 18);
const SUPPLIER = "0x1111111111111111111111111111111111111111";
const SCAMMER = "0x2222222222222222222222222222222222222222";

// 1. A test stablecoin and a vault that holds it. The agent's own key holds only gas.
const deployTx = await as(owner).deployContract({ abi: testTokenAbi, bytecode: testTokenBytecode, args: [] });
const token = (await client.waitForTransactionReceipt({ hash: deployTx })).contractAddress;
const vault = await deployVault(as(owner), client, {
  guardian: guardian.address,
  approvers: [approver.address],
  agents: [agent.address],
  policy: { token, dailyLimit: T("100000"), timelockAbove: T("100000"), multiApproverAbove: T("100000") },
});
await client.waitForTransactionReceipt({ hash: await as(owner).writeContract({ address: token, abi: testTokenAbi, functionName: "mint", args: [vault, T("10000")] }) });
console.log(`vault ${vault} holds 10,000 test USD\n`);

// 2. A person approves one exact payment: 3,400 to the supplier, once.
const approval = newApproval({ agent: agent.address, token, recipient: SUPPLIER, amount: T("3400") });
const signed = { approval, signatures: [await signApproval(as(approver), vault, chain.id, approval)] };

// 3. The agent acts. A tricked or buggy agent cannot stretch the approval.
const attempts = [
  ["A scam email changes the wallet", { ...requestFor(approval), recipient: SCAMMER }],
  ["The agent asks for more", requestFor(approval, T("5000"))],
  ["The real invoice", requestFor(approval)],
  ["The same invoice again", requestFor(approval)],
];
for (const [label, request] of attempts) {
  console.log(label);
  printResult(await submit(as(agent), client, vault, signed, request), request, approval);
  console.log();
}
