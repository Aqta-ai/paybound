// SPDX-License-Identifier: Apache-2.0
// The server-side passkey encoder against the real contract: a P-256 key made with Node's
// crypto signs a browser-shaped WebAuthn assertion over a vault approval digest.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { network } from "hardhat";
import { parseUnits, type Hex } from "viem";
import { approvalDigest, newApproval, requestFor, submit } from "../../sdk/index.js";
import { encodePasskeySignature, ERC1271_MAGIC } from "../../demo/passkey.js";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64url = (b: Buffer) => b.toString("base64url");

function devicePasskey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = `0x${Buffer.from(jwk.x, "base64url").toString("hex")}` as Hex;
  const y = `0x${Buffer.from(jwk.y, "base64url").toString("hex")}` as Hex;
  // What navigator.credentials.get returns, for this digest and relying party.
  const assert = (digest: Hex, rpId: string, flags = 0x05) => {
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.from([0, 0, 0, 7])]);
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(Buffer.from(digest.slice(2), "hex")), origin: `http://${rpId}:8799`, crossOrigin: false });
    const der = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
    return { authenticatorData: `0x${authData.toString("hex")}` as Hex, clientDataJSON, signature: `0x${der.toString("hex")}` as Hex };
  };
  return { x, y, assert };
}

describe("passkey approval end to end", async () => {
  const { viem } = await network.create();
  const pub = await viem.getPublicClient();
  const [owner, guardian, agent, supplierW, attackerW] = await viem.getWalletClients();
  const chainId = await pub.getChainId();
  const T = (n: string) => parseUnits(n, 18);
  const device = devicePasskey();

  const approver = await viem.deployContract("PasskeyApprover", [device.x, device.y, `0x${sha256("localhost").toString("hex")}`]);
  const token = await viem.deployContract("TestToken");
  const vault = await viem.deployContract("SpendGuardVault", [owner.account.address, guardian.account.address, [approver.address], 1n, 3600n]);
  await token.write.mint([vault.address, T("100000")]);
  await vault.write.setAgent([agent.account.address, true]);
  await vault.write.setPolicy([token.address, T("200000"), T("10000"), T("10000")]);

  const block = await pub.getBlock();
  const approval = newApproval({ agent: agent.account.address, token: token.address, recipient: supplierW.account.address, amount: T("3400"), now: Number(block.timestamp) });
  const digest = approvalDigest(vault.address, chainId, approval);

  it("accepts the encoded assertion and the vault pays once", async () => {
    const sig = encodePasskeySignature(device.assert(digest, "localhost"));
    assert.equal(await approver.read.isValidSignature([digest, sig]), ERC1271_MAGIC);
    const signed = { approval, signatures: [{ signer: approver.address, signature: sig }] };
    const bad = await submit(agent, pub, vault.address, signed, { ...requestFor(approval), recipient: attackerW.account.address });
    assert.equal(bad.reason, "RecipientMismatch");
    const ok = await submit(agent, pub, vault.address, signed, requestFor(approval));
    assert.equal(ok.outcome, "Executed");
    const again = await submit(agent, pub, vault.address, signed, requestFor(approval));
    assert.equal(again.reason, "UsesExhausted");
  });

  it("rejects another site, no fingerprint, and a tampered client data", async () => {
    assert.notEqual(await approver.read.isValidSignature([digest, encodePasskeySignature(device.assert(digest, "evil.example"))]), ERC1271_MAGIC);
    assert.notEqual(await approver.read.isValidSignature([digest, encodePasskeySignature(device.assert(digest, "localhost", 0x01))]), ERC1271_MAGIC);
    const a = device.assert(digest, "localhost");
    const tampered = { ...a, clientDataJSON: a.clientDataJSON.replace("8799", "8800") };
    assert.notEqual(await approver.read.isValidSignature([digest, encodePasskeySignature(tampered)]), ERC1271_MAGIC);
  });
});
