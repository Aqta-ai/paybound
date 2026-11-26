// SPDX-License-Identifier: Apache-2.0
import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";

const PASSKEY_COMPILER = { version: "0.8.28", settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } } };

const config: HardhatUserConfig = {
  plugins: [hardhatViem, hardhatNodeTestRunner],
  solidity: {
    profiles: {
      // The vault keeps its original settings (the deployed bytecode must match for BscScan
      // verification). Only the passkey approver needs the IR pipeline, for OpenZeppelin's P256.
      default: {
        compilers: [{ version: "0.8.28" }],
        overrides: {
          "contracts/PasskeyApprover.sol": PASSKEY_COMPILER,
          "test/solidity/PasskeyApprover.t.sol": PASSKEY_COMPILER,
        },
      },
      production: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  paths: { tests: { solidity: "./test/solidity", nodejs: "./test/ts" } },
  networks: {
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
    // BSC testnet only (chain 97). There is deliberately no mainnet entry.
    bscTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 97,
      url: configVariable("BSC_TESTNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
};

export default config;
