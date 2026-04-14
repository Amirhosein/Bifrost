/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { ethers } from "ethers";

type Claims = {
  reTypeCode: number;
  qtyKWh: bigint;
  readingTimestamp: number;
  credentialIdHash: `0x${string}`;
  expiry: bigint;
};

type TxRow = {
  path: string;
  operation: string;
  iteration: number;
  chainId: string;
  txHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  feeWei: string;
  notes?: string;
};

type SummaryRow = {
  path: string;
  operation: string;
  samples: number;
  avgGas: string;
  medianGas: string;
  p95Gas: string;
  avgFeeWei: string;
  avgFeeEth: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function parseNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number in ${name}: ${value}`);
  return parsed;
}

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  return BigInt(value);
}

function normalizeAddress(name: string, value: string): `0x${string}` {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new Error(`Invalid ${name}: ${value}`);
  return ethers.getAddress(trimmed.toLowerCase()) as `0x${string}`;
}

function maybeAddress(name: string): `0x${string}` | undefined {
  const value = process.env[name];
  if (!value || !value.trim()) return undefined;
  return normalizeAddress(name, value);
}

function parseAutoDeployments():
  | {
      snarkToken?: `0x${string}`;
      snarkVerifier?: `0x${string}`;
      snarkPath?: string;
      stylusToken?: `0x${string}`;
      stylusVerifier?: `0x${string}`;
      stylusPath?: string;
    }
  | undefined {
  const reportPath = path.join(process.cwd(), "docs", "bench_bbs_l2_arb_sepolia_auto.json");
  if (!fs.existsSync(reportPath)) return undefined;

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    deployments?: Array<{ path?: string; l2Token?: string; l2Verifier?: string }>;
  };
  const deployments = report.deployments ?? [];
  const snark = deployments.find((d) => d.path === "solidity-snark-mock-arb");
  const stylus =
    deployments.find((d) => d.path === "stylus-native-arb") ??
    deployments.find((d) => d.path === "stylus-native-sim-arb");
  return {
    snarkToken: snark?.l2Token ? normalizeAddress("snark.l2Token", snark.l2Token) : undefined,
    snarkVerifier: snark?.l2Verifier ? normalizeAddress("snark.l2Verifier", snark.l2Verifier) : undefined,
    snarkPath: snark?.path,
    stylusToken: stylus?.l2Token ? normalizeAddress("stylus.l2Token", stylus.l2Token) : undefined,
    stylusVerifier: stylus?.l2Verifier ? normalizeAddress("stylus.l2Verifier", stylus.l2Verifier) : undefined,
    stylusPath: stylus?.path,
  };
}

function deriveClaims(
  pathLabel: string,
  iteration: number,
  baseTimestamp: number,
  qtyKWh: bigint,
  reTypeCode: number,
  runSalt: string
): Claims {
  const readingTimestamp = baseTimestamp + iteration;
  const credentialIdHash = ethers.keccak256(
    ethers.toUtf8Bytes(`bbs-repeat-${pathLabel}-${runSalt}-${iteration}-${baseTimestamp}-${qtyKWh.toString()}`)
  ) as `0x${string}`;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600 + iteration);
  return {
    reTypeCode,
    qtyKWh,
    readingTimestamp,
    credentialIdHash,
    expiry,
  };
}

function bigintAverage(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  let sum = 0n;
  for (const v of values) sum += v;
  return sum / BigInt(values.length);
}

function bigintMedian(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

function bigintP95(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

function toEthString(wei: bigint): string {
  return ethers.formatEther(wei);
}

async function main() {
  const sepoliaRpc = requireEnv("SEPOLIA_RPC_URL");
  const arbSepoliaRpc = requireEnv("ARBITRUM_SEPOLIA_RPC_URL");
  const deployerPk = requireEnv("DEPLOYER_PRIVATE_KEY");

  const l1Provider = new ethers.JsonRpcProvider(sepoliaRpc);
  const l2Provider = new ethers.JsonRpcProvider(arbSepoliaRpc);
  const l1Network = await l1Provider.getNetwork();
  const l2Network = await l2Provider.getNetwork();

  if (l2Network.chainId !== 421614n) {
    throw new Error(`This benchmark is intended for Arbitrum Sepolia (421614). Got ${l2Network.chainId.toString()}`);
  }

  const repeatCount = parseNumberEnv("BENCH_REPEAT_COUNT", 10);
  if (repeatCount < 1) throw new Error("BENCH_REPEAT_COUNT must be >= 1");

  const runSnark = parseBoolEnv("REPEAT_RUN_SNARK", true);
  const runStylus = parseBoolEnv("REPEAT_RUN_STYLUS", true);
  if (!runSnark && !runStylus) throw new Error("Both REPEAT_RUN_SNARK and REPEAT_RUN_STYLUS are false.");

  const holderPk = envOr("HOLDER_PRIVATE_KEY", deployerPk);
  const issuerPk = envOr("ISSUER_PRIVATE_KEY", deployerPk);
  const stylusOwnerPk = envOr("STYLUS_OWNER_PRIVATE_KEY", deployerPk);

  const holder = new ethers.Wallet(holderPk, l2Provider);
  const issuer = new ethers.Wallet(issuerPk, l2Provider);
  const stylusOwner = new ethers.Wallet(stylusOwnerPk, l2Provider);

  const recipient = maybeAddress("BENCH_RECIPIENT") ?? (holder.address as `0x${string}`);
  const reTypeCode = parseNumberEnv("RE_TYPE_CODE", 1);
  const qtyKWh = parseBigIntEnv("QTY_KWH", 100n);
  const baseTimestamp = parseNumberEnv("READING_TIMESTAMP", 1_740_873_600);
  const runSalt = envOr("BENCH_RUN_SALT", Date.now().toString());

  const parsedAuto = parseAutoDeployments();
  const snarkTokenAddr = maybeAddress("REPEAT_SNARK_L2_TOKEN") ?? parsedAuto?.snarkToken;
  const snarkVerifierAddr = maybeAddress("REPEAT_SNARK_VERIFIER") ?? parsedAuto?.snarkVerifier;
  const stylusTokenAddr = maybeAddress("REPEAT_STYLUS_L2_TOKEN") ?? parsedAuto?.stylusToken;
  const stylusVerifierAddr = maybeAddress("REPEAT_STYLUS_VERIFIER") ?? parsedAuto?.stylusVerifier;
  const snarkPathLabel = parsedAuto?.snarkPath ?? "solidity-snark-mock-arb";
  const stylusPathLabel = parsedAuto?.stylusPath ?? "stylus-native-sim-arb";

  if (runSnark && (!snarkTokenAddr || !snarkVerifierAddr)) {
    throw new Error("SNARK repeat benchmark requires REPEAT_SNARK_L2_TOKEN and REPEAT_SNARK_VERIFIER (or auto report deployments).");
  }
  if (runStylus && (!stylusTokenAddr || !stylusVerifierAddr)) {
    throw new Error(
      "Stylus repeat benchmark requires REPEAT_STYLUS_L2_TOKEN and REPEAT_STYLUS_VERIFIER (or auto report deployments)."
    );
  }

  const tokenArtifact = await hre.artifacts.readArtifact("GTokenL2BbsSnarkArb");
  const snarkVerifierArtifact = await hre.artifacts.readArtifact("MockBbsSnarkVerifier");
  const stylusVerifierArtifact = await hre.artifacts.readArtifact("MockBbsStylusNativeVerifier");

  const rows: TxRow[] = [];
  const sleepMs = parseNumberEnv("BENCH_REPEAT_SLEEP_MS", 0);

  console.log("Starting repeat benchmark");
  console.log("L1 chain:", l1Network.chainId.toString(), "| L2 chain:", l2Network.chainId.toString());
  console.log("Iterations:", repeatCount);
  console.log("Holder:", holder.address);
  console.log("Issuer:", issuer.address);
  console.log("Stylus owner:", stylusOwner.address);
  console.log("Recipient:", recipient);
  console.log("Run salt:", runSalt);

  if (runSnark && snarkTokenAddr && snarkVerifierAddr) {
    const snarkToken = new ethers.Contract(snarkTokenAddr, tokenArtifact.abi, l2Provider);
    const snarkVerifier = new ethers.Contract(snarkVerifierAddr, snarkVerifierArtifact.abi, l2Provider);
    const configuredIssuer = (await snarkVerifier.issuerSigner()) as string;
    if (ethers.getAddress(configuredIssuer) !== ethers.getAddress(issuer.address)) {
      throw new Error(
        `SNARK verifier issuerSigner mismatch. Contract expects ${configuredIssuer}, but ISSUER_PRIVATE_KEY resolves to ${issuer.address}`
      );
    }

    for (let i = 0; i < repeatCount; i++) {
      const claims = deriveClaims("snark", i, baseTimestamp, qtyKWh, reTypeCode, runSalt);
      const bbsProof = ethers.toUtf8Bytes(`bbs-proof-snark-${i}-${Date.now()}`);
      const digest = (await snarkVerifier.connect(holder).digest(holder.address, claims, bbsProof)) as `0x${string}`;
      const zkSeal = await issuer.signMessage(ethers.getBytes(digest));

      const feeData = await l2Provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? 0n;
      const verifyGas = (await snarkVerifier
        .connect(holder)
        .verifyForMint.estimateGas(holder.address, claims, bbsProof, zkSeal)) as bigint;
      rows.push({
        path: snarkPathLabel,
        operation: "verifyForMint (estimateGas)",
        iteration: i,
        chainId: l2Network.chainId.toString(),
        txHash: "-",
        gasUsed: verifyGas.toString(),
        effectiveGasPrice: gasPrice.toString(),
        feeWei: (verifyGas * gasPrice).toString(),
        notes: "Estimated verification cost",
      });

      const mintTx = await snarkToken.connect(holder).mintWithBbsProof(claims, bbsProof, zkSeal);
      const mintRc = await mintTx.wait();
      if (!mintRc) throw new Error("Missing mint receipt");
      const mintGasPrice = (mintRc.gasPrice ?? 0n) as bigint;
      rows.push({
        path: snarkPathLabel,
        operation: "mintWithBbsProof",
        iteration: i,
        chainId: l2Network.chainId.toString(),
        txHash: mintTx.hash,
        gasUsed: mintRc.gasUsed.toString(),
        effectiveGasPrice: mintGasPrice.toString(),
        feeWei: (mintRc.gasUsed * mintGasPrice).toString(),
      });

      const transferTx = await snarkToken.connect(holder).transfer(recipient, 1n);
      const transferRc = await transferTx.wait();
      if (!transferRc) throw new Error("Missing transfer receipt");
      const transferGasPrice = (transferRc.gasPrice ?? 0n) as bigint;
      rows.push({
        path: snarkPathLabel,
        operation: "transfer",
        iteration: i,
        chainId: l2Network.chainId.toString(),
        txHash: transferTx.hash,
        gasUsed: transferRc.gasUsed.toString(),
        effectiveGasPrice: transferGasPrice.toString(),
        feeWei: (transferRc.gasUsed * transferGasPrice).toString(),
      });

      if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  if (runStylus && stylusTokenAddr && stylusVerifierAddr) {
    const stylusToken = new ethers.Contract(stylusTokenAddr, tokenArtifact.abi, l2Provider);
    const stylusVerifier = new ethers.Contract(stylusVerifierAddr, stylusVerifierArtifact.abi, l2Provider);

    for (let i = 0; i < repeatCount; i++) {
      const claims = deriveClaims("stylus", i, baseTimestamp + 100_000, qtyKWh, reTypeCode, runSalt);
      const bbsProof = ethers.toUtf8Bytes(`bbs-proof-stylus-${i}-${Date.now()}`);
      const digest = (await stylusVerifier.connect(holder).digest(holder.address, claims, bbsProof)) as `0x${string}`;

      const setDigestTx = await stylusVerifier.connect(stylusOwner).setDigestApproval(digest, true);
      const setDigestRc = await setDigestTx.wait();
      if (!setDigestRc) throw new Error("Missing setDigestApproval receipt");
      const setDigestGasPrice = (setDigestRc.gasPrice ?? 0n) as bigint;
      rows.push({
        path: stylusPathLabel,
        operation: "setDigestApproval",
        iteration: i,
        chainId: l2Network.chainId.toString(),
        txHash: setDigestTx.hash,
        gasUsed: setDigestRc.gasUsed.toString(),
        effectiveGasPrice: setDigestGasPrice.toString(),
        feeWei: (setDigestRc.gasUsed * setDigestGasPrice).toString(),
        notes: "Simulation-only setup cost",
      });

      const feeData = await l2Provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? 0n;
      const verifyGas = (await stylusVerifier
        .connect(holder)
        .verifyForMint.estimateGas(holder.address, claims, bbsProof, "0x")) as bigint;
      rows.push({
        path: stylusPathLabel,
        operation: "verifyForMint (estimateGas)",
        iteration: i,
        chainId: l2Network.chainId.toString(),
        txHash: "-",
        gasUsed: verifyGas.toString(),
        effectiveGasPrice: gasPrice.toString(),
        feeWei: (verifyGas * gasPrice).toString(),
        notes: "Estimated verification cost",
      });

      const mintTx = await stylusToken.connect(holder).mintWithBbsProof(claims, bbsProof, "0x");
      const mintRc = await mintTx.wait();
      if (!mintRc) throw new Error("Missing mint receipt");
      const mintGasPrice = (mintRc.gasPrice ?? 0n) as bigint;
      rows.push({
        path: stylusPathLabel,
        operation: "mintWithBbsProof",
        iteration: i,
        chainId: l2Network.chainId.toString(),
        txHash: mintTx.hash,
        gasUsed: mintRc.gasUsed.toString(),
        effectiveGasPrice: mintGasPrice.toString(),
        feeWei: (mintRc.gasUsed * mintGasPrice).toString(),
      });

      const transferTx = await stylusToken.connect(holder).transfer(recipient, 1n);
      const transferRc = await transferTx.wait();
      if (!transferRc) throw new Error("Missing transfer receipt");
      const transferGasPrice = (transferRc.gasPrice ?? 0n) as bigint;
      rows.push({
        path: stylusPathLabel,
        operation: "transfer",
        iteration: i,
        chainId: l2Network.chainId.toString(),
        txHash: transferTx.hash,
        gasUsed: transferRc.gasUsed.toString(),
        effectiveGasPrice: transferGasPrice.toString(),
        feeWei: (transferRc.gasUsed * transferGasPrice).toString(),
      });

      if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  const summary: SummaryRow[] = [];
  const byKey = new Map<string, TxRow[]>();
  for (const row of rows) {
    const key = `${row.path}::${row.operation}`;
    const curr = byKey.get(key) ?? [];
    curr.push(row);
    byKey.set(key, curr);
  }

  for (const [key, group] of byKey.entries()) {
    const [pathLabel, operation] = key.split("::");
    const gasValues = group.map((g) => BigInt(g.gasUsed));
    const feeValues = group.map((g) => BigInt(g.feeWei));
    const avgGas = bigintAverage(gasValues);
    const medGas = bigintMedian(gasValues);
    const p95Gas = bigintP95(gasValues);
    const avgFeeWei = bigintAverage(feeValues);
    summary.push({
      path: pathLabel,
      operation,
      samples: group.length,
      avgGas: avgGas.toString(),
      medianGas: medGas.toString(),
      p95Gas: p95Gas.toString(),
      avgFeeWei: avgFeeWei.toString(),
      avgFeeEth: toEthString(avgFeeWei),
    });
  }

  summary.sort((a, b) => (a.path === b.path ? a.operation.localeCompare(b.operation) : a.path.localeCompare(b.path)));

  const output = {
    generatedAt: new Date().toISOString(),
    networks: {
      l1ChainId: l1Network.chainId.toString(),
      l2ChainId: l2Network.chainId.toString(),
    },
    config: {
      repeatCount,
      runSnark,
      runStylus,
      qtyKWh: qtyKWh.toString(),
      reTypeCode,
      baseTimestamp,
      runSalt,
      recipient,
      snarkToken: snarkTokenAddr ?? null,
      snarkVerifier: snarkVerifierAddr ?? null,
      stylusToken: stylusTokenAddr ?? null,
      stylusVerifier: stylusVerifierAddr ?? null,
    },
    rows,
    summary,
  };

  const outPath = path.join(process.cwd(), "docs", "bench_bbs_l2_arb_sepolia_repeat.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("Wrote:", outPath);
  console.table(summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
