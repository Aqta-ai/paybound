// SPDX-License-Identifier: Apache-2.0
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, zeroAddress } from "viem";
import {
  approvalDigest,
  assertAllowedChain,
  checkRequest,
  fromJson,
  newApproval,
  readLog,
  requestFor,
  signApproval,
  sortSignatures,
  submit,
  toJson,
  type SignedApproval,
} from "../../sdk/index.js";
import { mockDecide } from "../../agent/model.js";
import { SCENARIOS } from "../../demo/scenarios.js";
import { inbox } from "../../agent/inbox.js";

const T = (n: string) => parseUnits(n, 18);

describe("SDK against a local chain", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, approverA, approverB, guardian, agent, supplierW, attackerW] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();
  let vault: Awaited<ReturnType<typeof viem.deployContract<"SpendGuardVault">>>;
  let token: Awaited<ReturnType<typeof viem.deployContract<"TestToken">>>;
  let signed: SignedApproval;

  before(async () => {
    token = await viem.deployContract("TestToken");
    vault = await viem.deployContract("SpendGuardVault", [
      owner.account.address,
      guardian.account.address,
      [approverA.account.address, approverB.account.address],
      1n,
      0n,
    ]);
    await token.write.mint([vault.address, T("10000")]);
    await vault.write.setAgent([agent.account.address, true]);
    const now = Number((await publicClient.getBlock()).timestamp);
    const approval = newApproval({
      agent: agent.account.address,
      token: token.address,
      recipient: supplierW.account.address,
      amount: T("4800"),
      now,
    });
    signed = {
      vault: vault.address,
      chainId,
      approval,
      signatures: [await signApproval(approverA, vault.address, chainId, approval)],
      digest: approvalDigest(vault.address, chainId, approval),
    };
  });

  it("computes the same digest as the contract", async () => {
    assert.equal(await vault.read.approvalDigest([signed.approval]), signed.digest);
  });

  it("dry-runs requests with the on-chain reason", async () => {
    const ok = await checkRequest(publicClient, vault.address, agent.account.address, signed, requestFor(signed.approval));
    assert.equal(ok, "Ok");
    const bad = await checkRequest(publicClient, vault.address, agent.account.address, signed, {
      ...requestFor(signed.approval),
      recipient: attackerW.account.address,
    });
    assert.equal(bad, "RecipientMismatch");
    const raised = await checkRequest(
      publicClient,
      vault.address,
      agent.account.address,
      signed,
      requestFor(signed.approval, T("4801")),
    );
    assert.equal(raised, "AmountAboveApproval");
  });

  it("records a refusal on-chain, then executes, then refuses a replay", async () => {
    const r1 = await submit(agent, publicClient, vault.address, signed, {
      ...requestFor(signed.approval),
      recipient: attackerW.account.address,
    });
    assert.equal(r1.outcome, "Refused");
    assert.equal(r1.reason, "RecipientMismatch");
    const r2 = await submit(agent, publicClient, vault.address, signed, requestFor(signed.approval));
    assert.equal(r2.outcome, "Executed");
    const r3 = await submit(agent, publicClient, vault.address, signed, requestFor(signed.approval));
    assert.equal(r3.reason, "UsesExhausted");
    assert.equal(await token.read.balanceOf([attackerW.account.address]), 0n);
  });

  it("reads the approval and incident log", async () => {
    const log = await readLog(publicClient, vault.address);
    const refused = log.filter((e) => e.event === "SpendRefused");
    assert.equal(refused.length, 2);
    assert.deepEqual(
      refused.map((e) => e.args.reason),
      ["RecipientMismatch", "UsesExhausted"],
    );
    const executed = log.filter((e) => e.event === "SpendExecuted");
    assert.equal(executed.length, 1);
    assert.equal(executed[0].args.digest, signed.digest);
  });

  it("round-trips approvals through JSON", () => {
    const back = fromJson(toJson(signed));
    assert.deepEqual(back, signed);
  });

  it("sorts signatures by address", () => {
    const s = sortSignatures([
      { signer: "0xffffffffffffffffffffffffffffffffffffffff", signature: "0x01" },
      { signer: "0x0000000000000000000000000000000000000001", signature: "0x02" },
    ]);
    assert.equal(s[0].signature, "0x02");
  });
});

describe("helpers", () => {
  it("refuses BNB Smart Chain mainnet", () => {
    assert.throws(() => assertAllowedChain(56));
    assertAllowedChain(97);
  });

  it("the mock agent follows injected wallet changes (so the vault has to hold)", () => {
    const attacker = "0x000000000000000000000000000000000000bad1";
    const known = { recipient: "0x0000000000000000000000000000000000005001" as const, amount: "4800" };
    const injected = inbox(attacker).find((m) => m.label === "Injected new wallet")!;
    const d = mockDecide(injected.msg, known);
    assert.equal(d.recipient, attacker);
    assert.equal(d.pay, true);
    assert.notEqual(zeroAddress, d.recipient);
  });

  it("the mock agent reads Thai payment instructions in the demo scenarios", () => {
    const attacker = "0x000000000000000000000000000000000000bad1";
    const sme = SCENARIOS.find((s) => s.id === "sme")!;
    const known = { recipient: "0x0000000000000000000000000000000000005001" as const, amount: sme.approval.amount };
    const byId = (id: string) => sme.emails(attacker).find((e) => e.id === id)!;
    const th = (id: string) => ({ from: byId(id).from, subject: byId(id).subject.th, body: byId(id).body.th });
    const injected = mockDecide(th("sme-injected"), known);
    assert.deepEqual([injected.pay, injected.recipient, injected.amount, injected.invoice], [true, attacker, "3400", "HK-2041"]);
    const raised = mockDecide(th("sme-raised"), known);
    assert.deepEqual([raised.recipient, raised.amount], [known.recipient, "3900"]);
  });
});
