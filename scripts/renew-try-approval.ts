// Re-signs the public test approval used by the live page's read-only check. Testnet only; never executed.
process.loadEnvFile(".env");
import { readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { newApproval, signApproval, approvalDigest } from "../sdk/index.ts";

const path = "site/try-approval.json";
const old = JSON.parse(readFileSync(path, "utf8"));
const acct = privateKeyToAccount(process.env.APPROVER_PRIVATE_KEY as Hex);
if (acct.address.toLowerCase() !== old.signatures[0].signer.toLowerCase()) throw new Error("approver key does not match the published signer");
const days = Number(process.argv[2] ?? 90);
const approval = newApproval({ agent: old.agent, token: old.token, recipient: old.supplier, amount: BigInt(old.approval.maxAmount), validForSeconds: days * 86400 });
const wallet = createWalletClient({ account: acct, chain: bscTestnet, transport: http("https://bsc-prebsc-dataseed.bnbchain.org") });
const sig = await signApproval(wallet, old.vault, old.chainId, approval);
const out = { ...old, approval: { ...approval, maxAmount: approval.maxAmount.toString(), cap: approval.cap.toString(), expiry: approval.expiry.toString() }, signatures: [sig], digest: approvalDigest(old.vault, old.chainId, approval) };
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log("expiry", new Date(Number(approval.expiry) * 1000).toISOString(), "signer", sig.signer);
