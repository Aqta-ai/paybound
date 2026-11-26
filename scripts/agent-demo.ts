// SPDX-License-Identifier: Apache-2.0
// End-to-end demo on Hardhat's in-process chain: a person approves one invoice,
// a fooled agent tries the injected requests, a stolen agent key tries to drain,
// the guardian freezes the vault, and the log is read back.
// Run: npm run demo   (offline mock agent; set AGENT_MODEL_URL for a real model)
import { network } from "hardhat";
import { formatUnits, parseUnits, type Address } from "viem";
import {
  approvalDigest,
  newApproval,
  readLog,
  requestFor,
  signApproval,
  submit,
  type SignedApproval,
} from "../sdk/index.js";
import { inbox } from "../agent/inbox.js";
import { modelDecide } from "../agent/model.js";

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner, approverA, approverB, guardian, agent, supplierW, attackerW] = await viem.getWalletClients();
const supplier = supplierW.account.address;
const attacker = attackerW.account.address;
const chainId = await publicClient.getChainId();

const token = await viem.deployContract("TestToken");
const vault = await viem.deployContract("SpendGuardVault", [
  owner.account.address,
  guardian.account.address,
  [approverA.account.address, approverB.account.address],
  2n,
  3600n,
]);
const T = (n: string) => parseUnits(n, 18);
await token.write.mint([vault.address, T("100000")]);
await vault.write.setAgent([agent.account.address, true]);
await vault.write.setPolicy([token.address, T("20000"), T("10000"), T("10000")]);
await vault.write.setAllowlistEnabled([true]);
await vault.write.setRecipientAllowed([supplier, true]);

const line = (s = "") => console.log(s);
line("Agent spend guard demo (local chain, synthetic data)");
line(`vault ${vault.address}  chain ${chainId}`);
line(`policy: daily limit 20,000 tUSD, timelock above 10,000, two approvers above 10,000, allowlist on`);
line();

// 1. A person approves exactly one invoice.
const block = await publicClient.getBlock();
const approval = newApproval({
  agent: agent.account.address,
  token: token.address,
  recipient: supplier,
  amount: T("4800"),
  now: Number(block.timestamp),
});
const signed: SignedApproval = {
  vault: vault.address,
  chainId,
  approval,
  signatures: [await signApproval(approverA, vault.address, chainId, approval)],
  digest: approvalDigest(vault.address, chainId, approval),
};
line(`approver signed INV-1042: 4,800 tUSD to ${short(supplier)}, one use, valid 24 hours`);
line();

const rows: [string, string, string, string][] = [];
const known = { recipient: supplier, amount: "4800" };

for (const { label, msg } of inbox(attacker)) {
  const d = await modelDecide(msg, known);
  if (!d.pay) {
    rows.push([label, "agent declined", "-", "-"]);
    continue;
  }
  const req = { ...requestFor(approval, T(d.amount)), recipient: d.recipient };
  const res = await submit(agent, publicClient, vault.address, signed, req);
  rows.push([label, `${d.amount} to ${short(d.recipient)}`, res.outcome, res.reason]);
}

// 2. Someone steals the agent's hot key and signs their own approval.
{
  const forged = newApproval({
    agent: agent.account.address,
    token: token.address,
    recipient: attacker,
    amount: T("50000"),
    now: Number(block.timestamp),
  });
  const res = await submit(
    agent,
    publicClient,
    vault.address,
    { approval: forged, signatures: [await signApproval(attackerW, vault.address, chainId, forged)] },
    requestFor(forged),
  );
  rows.push(["Stolen agent key, forged approval", `50000 to ${short(attacker)}`, res.outcome, res.reason]);
}

// 3. One stolen approver key is not enough for a large approval.
{
  const big = newApproval({
    agent: agent.account.address,
    token: token.address,
    recipient: supplier,
    amount: T("15000"),
    now: Number(block.timestamp),
  });
  const res = await submit(
    agent,
    publicClient,
    vault.address,
    { approval: big, signatures: [await signApproval(approverA, vault.address, chainId, big)] },
    requestFor(big),
  );
  rows.push(["Large spend, one approver only", `15000 to ${short(supplier)}`, res.outcome, res.reason]);

  const both = [
    await signApproval(approverA, vault.address, chainId, big),
    await signApproval(approverB, vault.address, chainId, big),
  ];
  const res2 = await submit(agent, publicClient, vault.address, { approval: big, signatures: both }, requestFor(big));
  rows.push(["Large spend, two approvers", `15000 to ${short(supplier)}`, res2.outcome, `${res2.reason}, held 1 hour`]);
}

// 4. The guardian freezes the vault; nothing moves until the owner unfreezes.
{
  await vault.write.freeze({ account: guardian.account });
  const again = newApproval({
    agent: agent.account.address,
    token: token.address,
    recipient: supplier,
    amount: T("100"),
    now: Number(block.timestamp),
  });
  const res = await submit(
    agent,
    publicClient,
    vault.address,
    { approval: again, signatures: [await signApproval(approverA, vault.address, chainId, again)] },
    requestFor(again),
  );
  rows.push(["After guardian freeze", `100 to ${short(supplier)}`, res.outcome, res.reason]);
}

const w = [34, 26, 10, 26];
line(pad(["Request", "Agent tried", "Outcome", "Reason"], w));
line(w.map((n) => "-".repeat(n)).join("  "));
for (const r of rows) line(pad(r, w));
line();

const log = await readLog(publicClient, vault.address);
const count = (e: string) => log.filter((x) => x.event === e).length;
line(`on-chain log: ${count("SpendExecuted")} executed, ${count("SpendQueued")} queued, ${count("SpendRefused")} refused`);
const paid = await token.read.balanceOf([supplier]);
const stolen = await token.read.balanceOf([attacker]);
line(`supplier received ${formatUnits(paid, 18)} tUSD; attacker received ${formatUnits(stolen, 18)} tUSD`);

function short(a: Address | string) {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}
function pad(cols: string[], widths: number[]) {
  return cols.map((c, i) => c.padEnd(widths[i])).join("  ");
}
