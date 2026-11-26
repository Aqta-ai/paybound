// SPDX-License-Identifier: Apache-2.0
// Deploy and configure a SpendGuardVault from a script, without Hardhat.
import type { Address, PublicClient, WalletClient } from "viem";
import { spendGuardVaultAbi, spendGuardVaultBytecode } from "./abi.js";
import { assertAllowedChain } from "./index.js";

export type VaultSetup = {
  /** Who can change settings and unfreeze. Defaults to the deploying wallet. */
  owner?: Address;
  /** Who can freeze the vault in an emergency. Must not be the zero address. */
  guardian: Address;
  /** People whose signature counts as approval. */
  approvers: Address[];
  /** Signatures needed for large payments (see setPolicy). Default 1. */
  requiredApprovals?: bigint;
  /** Seconds a large payment waits before release. Default 0. */
  timelockSeconds?: bigint;
  /** AI agents allowed to ask the vault to pay. */
  agents: Address[];
  /** Optional per-token policy: daily limit, timelock threshold, two-approver threshold (token units). */
  policy?: { token: Address; dailyLimit: bigint; timelockAbove: bigint; multiApproverAbove: bigint };
};

/** Deploys a vault, sets its policy and registers the agents. Returns the vault address. */
export async function deployVault(wallet: WalletClient, client: PublicClient, setup: VaultSetup): Promise<Address> {
  const account = wallet.account;
  if (!account) throw new Error("wallet has no account");
  const chainId = await client.getChainId();
  assertAllowedChain(chainId);
  const owner = setup.owner ?? account.address;
  const hash = await wallet.deployContract({
    abi: spendGuardVaultAbi,
    bytecode: spendGuardVaultBytecode,
    args: [owner, setup.guardian, setup.approvers, setup.requiredApprovals ?? 1n, setup.timelockSeconds ?? 0n],
    account,
    chain: wallet.chain,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const vault = receipt.contractAddress as Address;
  if (owner.toLowerCase() === account.address.toLowerCase()) {
    if (setup.policy) {
      const p = setup.policy;
      const h = await wallet.writeContract({ address: vault, abi: spendGuardVaultAbi, functionName: "setPolicy", args: [p.token, p.dailyLimit, p.timelockAbove, p.multiApproverAbove], account, chain: wallet.chain });
      await client.waitForTransactionReceipt({ hash: h });
    }
    for (const agent of setup.agents) {
      const h = await wallet.writeContract({ address: vault, abi: spendGuardVaultAbi, functionName: "setAgent", args: [agent, true], account, chain: wallet.chain });
      await client.waitForTransactionReceipt({ hash: h });
    }
  }
  return vault;
}
