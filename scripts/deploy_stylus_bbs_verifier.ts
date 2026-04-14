/* eslint-disable no-console */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`);
  return value.trim();
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function normalizeAddress(name: string, value: string): `0x${string}` {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new Error(`Invalid ${name}: ${value}`);
  return ethers.getAddress(trimmed.toLowerCase()) as `0x${string}`;
}

async function main() {
  const rpc = requireEnv("ARBITRUM_SEPOLIA_RPC_URL");
  const deployerPk = requireEnv("DEPLOYER_PRIVATE_KEY");
  const deployer = new ethers.Wallet(deployerPk);

  const owner = normalizeAddress("STYLUS_OWNER", envOr("STYLUS_OWNER", deployer.address));
  const maxFeeGwei = envOr("STYLUS_MAX_FEE_GWEI", "0.1");

  const stylusDir = path.join(process.cwd(), "stylus", "bbs_verifier_stylus");
  const cargoBin = process.env.CARGO_BIN || path.join(process.env.HOME || "", ".cargo", "bin", "cargo");

  console.log("Deploying Stylus verifier from:", stylusDir);
  console.log("RPC:", rpc);
  console.log("Owner:", owner);
  console.log("Max fee (gwei):", maxFeeGwei);
  console.log("Cargo:", cargoBin);

  const args = [
    "stylus",
    "deploy",
    "--endpoint",
    rpc,
    "--private-key",
    deployerPk,
    "--max-fee-per-gas-gwei",
    maxFeeGwei,
    "--no-verify",
    "--constructor-args",
    owner,
  ];

  const run = spawnSync(cargoBin, args, {
    cwd: stylusDir,
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(cargoBin)}:${process.env.PATH || ""}`,
    },
  });

  const output = `${run.stdout || ""}\n${run.stderr || ""}`;
  const outputNoAnsi = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  if (run.status !== 0) {
    throw new Error(`cargo stylus deploy failed with status ${run.status}`);
  }

  const deployedLine = outputNoAnsi.match(/deployed code at address:\s*(0x[a-fA-F0-9]{40})/i);
  const parsedAddress = deployedLine?.[1];
  if (!parsedAddress) {
    throw new Error("Could not parse deployed Stylus verifier address from cargo output");
  }
  const deployed = normalizeAddress("deployedAddress", parsedAddress);

  const outPath = path.join(process.cwd(), "docs", "stylus_bbs_verifier_deploy.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        network: "arbitrum-sepolia",
        rpc,
        deployer: deployer.address,
        owner,
        verifier: deployed,
      },
      null,
      2
    )
  );

  console.log("Stylus verifier address:", deployed);
  console.log("Wrote:", outPath);
  console.log("Set this env for flow:");
  console.log(`STYLUS_NATIVE_VERIFIER=${deployed}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
