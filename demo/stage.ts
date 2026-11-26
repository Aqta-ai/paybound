// SPDX-License-Identifier: Apache-2.0
// One command for rehearsal: builds the contracts, starts a local dev chain if none
// is running on RPC_URL (Anvil if installed, otherwise Hardhat's node), then starts
// the demo server and opens the page.
//
//   npm run stage                         local chain, offline
//   npm run stage -- --network bsc-testnet   BSC testnet (needs .env and a deployment)
//   npm run stage -- --no-open            do not open a browser
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const network = args.includes("--network") ? args[args.indexOf("--network") + 1] : "local";
if (network !== "local" && network !== "bsc-testnet") throw new Error(`unknown network ${network}: use local or bsc-testnet`);
const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const port = process.env.DEMO_PORT ?? "8787";
const children: ChildProcess[] = [];
const stageToken = process.env.DEMO_STAGE_TOKEN?.trim() || (await import("node:crypto")).randomBytes(16).toString("hex");

async function rpcUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return r.ok;
  } catch {
    return false;
  }
}

const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

console.log("building contracts...");
if (spawnSync("npx", ["hardhat", "build"], { stdio: "inherit" }).status !== 0) process.exit(1);

if (network === "local" && !(await rpcUp(rpc))) {
  const port8545 = new URL(rpc).port || "8545";
  const [cmd, cargs] = has("anvil")
    ? ["anvil", ["--port", port8545, "--chain-id", "31337", "--silent"]]
    : ["npx", ["hardhat", "node", "--port", port8545]];
  console.log(`starting local chain: ${cmd} ${cargs.join(" ")}`);
  const chain = spawn(cmd, cargs as string[], { stdio: ["ignore", "ignore", "inherit"] });
  children.push(chain);
  for (let i = 0; i < 60 && !(await rpcUp(rpc)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await rpcUp(rpc))) throw new Error(`local chain did not start on ${rpc}`);
}

const server = spawn("npx", ["tsx", "demo/server.ts"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, DEMO_NETWORK: network, DEMO_PORT: port, DEMO_STAGE_TOKEN: stageToken },
});
children.push(server);
server.stdout!.on("data", (b: Buffer) => {
  const s = b.toString();
  process.stdout.write(s);
  if (s.includes("demo: http") && !args.includes("--no-open") && process.platform === "darwin") {
    // localhost, not 127.0.0.1: passkeys work on localhost but not on a bare IP address.
    spawn("open", [`http://localhost:${port}/?token=${stageToken}`], { stdio: "ignore" });
  }
});
server.on("exit", (code) => {
  for (const c of children) c.kill();
  process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => children.forEach((c) => c.kill()));
