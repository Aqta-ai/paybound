// SPDX-License-Identifier: Apache-2.0
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { approvalDigest, newApproval, signApproval, type SignedApproval } from "../../sdk/index.js";
import { paymentTool } from "../../sdk/agent-tool.js";

const T = (n: string) => parseUnits(n, 18);

describe("pay_invoice agent tool", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, approver, guardian, agent, supplier, attacker] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();
  let tool: ReturnType<typeof paymentTool>;
  let token: Awaited<ReturnType<typeof viem.deployContract<"TestToken">>>;

  before(async () => {
    token = await viem.deployContract("TestToken");
    const vault = await viem.deployContract("SpendGuardVault", [owner.account.address, guardian.account.address, [approver.account.address], 1n, 0n]);
    await token.write.mint([vault.address, T("10000")]);
    await vault.write.setAgent([agent.account.address, true]);
    const now = Number((await publicClient.getBlock()).timestamp);
    const approval = newApproval({ agent: agent.account.address, token: token.address, recipient: supplier.account.address, amount: T("3400"), now });
    const signed: SignedApproval = {
      vault: vault.address, chainId, approval,
      signatures: [await signApproval(approver, vault.address, chainId, approval)],
      digest: approvalDigest(vault.address, chainId, approval),
    };
    tool = paymentTool({ wallet: agent, client: publicClient, approvals: [signed] });
  });

  it("exposes a function-calling definition", () => {
    assert.equal(tool.definition.function.name, "pay_invoice");
    assert.deepEqual(tool.definition.function.parameters.required, ["recipient", "amount"]);
  });

  it("refuses a recipient the person never approved", async () => {
    const r = await tool.handle({ recipient: attacker.account.address, amount: "3400" });
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "RecipientMismatch");
    assert.equal(await token.read.balanceOf([attacker.account.address]), 0n);
  });

  it("refuses more than the approved ceiling", async () => {
    const r = await tool.handle({ recipient: supplier.account.address, amount: "3900" });
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "AmountAboveApproval");
  });

  it("rejects malformed arguments before touching the chain", async () => {
    assert.equal((await tool.handle({ recipient: "not-an-address", amount: "1" })).status, "invalid");
    assert.equal((await tool.handle({ recipient: supplier.account.address, amount: "-5" })).status, "invalid");
  });

  it("pays the approved invoice once, then refuses a replay", async () => {
    const paid = await tool.handle({ recipient: supplier.account.address, amount: "3400" });
    assert.equal(paid.status, "paid");
    assert.equal(await token.read.balanceOf([supplier.account.address]), T("3400"));
    const again = await tool.handle({ recipient: supplier.account.address, amount: "3400" });
    assert.equal(again.status, "refused");
    assert.equal(again.reason, "UsesExhausted");
  });
});
