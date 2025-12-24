/* eslint-disable no-console */

/**
 * Local gas + calldata sizing report for V2.
 *
 * Goals:
 *  1) Measure the *L2-side mint* cost without counting the L1 anchor execution.
 *  2) Measure the *L1 anchor relay* cost separately.
 *  3) Provide a combined end-to-end number for reference.
 *
 * Why this matters:
 *  In the unit tests, our MockCrossDomainMessenger calls the L1 anchor
 *  synchronously in the same transaction (for deterministic testing). That
 *  inflates the “gas used by mint” relative to real L2s where L1 execution
 *  happens later as a separate L1 transaction.
 *
 * Run:
 *   npx hardhat run scripts/gas_report_v2_local.ts
 */

import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

type GasRow = {
  label: string;
  gasUsed: string; // decimal string for JSON portability
  calldataBytes?: number;
  notes?: string;
};

async function gasOf(label: string, txPromise: Promise<any>, notes?: string): Promise<GasRow> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  // ethers v6: gasUsed is bigint
  const gasUsed = receipt.gasUsed as bigint;
  const data = (tx.data ?? "0x") as string;
  const calldataBytes = Math.max(0, (data.length - 2) / 2);
  return { label, gasUsed: gasUsed.toString(), calldataBytes, notes };
}

function writeJson(rows: GasRow[]) {
  const out = path.join(process.cwd(), "docs", "gas_report_v2_local.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\nWrote: ${out}`);
}

function print(rows: GasRow[]) {
  console.log("\n=== V2 Gas Report (Local) ===");
  console.table(
    rows.map((r) => ({
      label: r.label,
      gasUsed: r.gasUsed,
      calldataBytes: r.calldataBytes ?? "",
      notes: r.notes ?? "",
    }))
  );
}

async function main() {
  const [deployer, ra, holder, issuer] = await ethers.getSigners();

  // Shared mint parameters (same shapes as the unit test)
  const epochIndex = 202540;
  const typeCode = 1;
  const qtyKWh = 100;
  const policyNonce = 1;
  const hiddenCommitment = ethers.keccak256(ethers.toUtf8Bytes("hidden"));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const dtHash = ethers.solidityPackedKeccak256(
    ["uint64", "uint16", "uint256", "uint128"],
    [epochIndex, typeCode, qtyKWh, policyNonce]
  );

  // -------------------------------
  // (A) L2 mint cost WITHOUT L1 execution
  // -------------------------------
  const rows: GasRow[] = [];

  const Verifier = await ethers.getContractFactory("DemoIssuerVerifier");
  const verifier = await Verifier.deploy(await issuer.getAddress());
  await verifier.waitForDeployment();

  const NoopMessenger = await ethers.getContractFactory("MockCrossDomainMessengerNoop");
  const noopMessenger = await NoopMessenger.deploy();
  await noopMessenger.waitForDeployment();

  const Anchor = await ethers.getContractFactory("GTokenAnchor");
  const anchorNoop = await Anchor.deploy(await noopMessenger.getAddress(), ethers.ZeroAddress);
  await anchorNoop.waitForDeployment();

  const GTokenL2 = await ethers.getContractFactory("GTokenL2");
  const l2Noop = await GTokenL2.deploy(
    "GreenToken",
    "GT",
    await verifier.getAddress(),
    await noopMessenger.getAddress(),
    await anchorNoop.getAddress(),
    await ra.getAddress()
  );
  await l2Noop.waitForDeployment();

  const digestNoop = await verifier.computeDigest(
    await holder.getAddress(),
    dtHash,
    hiddenCommitment,
    epochIndex,
    typeCode,
    qtyKWh,
    policyNonce,
    expiry
  );
  const sigNoop = await issuer.signMessage(ethers.getBytes(digestNoop));

  rows.push(
    await gasOf(
      "L2 mintWithProof (no L1 relay)",
      l2Noop
        .connect(holder)
        .mintWithProof(epochIndex, typeCode, qtyKWh, policyNonce, hiddenCommitment, expiry, sigNoop),
      "Includes: duplicate-guard + ERC20 mint + sendMessage() event"
    )
  );

  // Optional: show isolated verifier gas via estimateGas (not a transaction)
  const estVerify = await verifier.verify.estimateGas(
    await holder.getAddress(),
    dtHash,
    hiddenCommitment,
    epochIndex,
    typeCode,
    qtyKWh,
    policyNonce,
    expiry,
    sigNoop
  );
  rows.push({
    label: "DemoIssuerVerifier.verify (estimateGas)",
    gasUsed: estVerify.toString(),
    notes: "EVM gas estimate for ECDSA-path verifier only",
  });

  // -------------------------------
  // (B) L1 anchor relay cost (separate tx)
  // -------------------------------
  const Messenger = await ethers.getContractFactory("MockCrossDomainMessenger");
  const messenger = await Messenger.deploy();
  await messenger.waitForDeployment();

  const anchor = await Anchor.deploy(await messenger.getAddress(), ethers.ZeroAddress);
  await anchor.waitForDeployment();

  const L2Sender = await ethers.getContractFactory("L2SenderMock");
  const l2Sender = await L2Sender.deploy();
  await l2Sender.waitForDeployment();

  // Configure the anchor to accept messages from l2Sender
  rows.push(
    await gasOf(
      "L1 anchor setConfig(messenger, l2Sender)",
      anchor.connect(deployer).setConfig(await messenger.getAddress(), await l2Sender.getAddress()),
      "One-time admin config"
    )
  );

  const payload = anchor.interface.encodeFunctionData("recordMint", [
    dtHash,
    await holder.getAddress(),
    qtyKWh,
    epochIndex,
    typeCode,
    qtyKWh,
  ]);

  rows.push(
    await gasOf(
      "L1 relay: messenger.sendMessage -> recordMint",
      l2Sender.connect(deployer).send(await messenger.getAddress(), await anchor.getAddress(), payload, 1_000_000),
      "Models the later L1 execution (separate tx on real rollups)"
    )
  );

  // -------------------------------
  // (C) Combined end-to-end (test-style, single tx)
  // -------------------------------
  const messenger2 = await Messenger.deploy();
  await messenger2.waitForDeployment();

  const anchor2 = await Anchor.deploy(await messenger2.getAddress(), ethers.ZeroAddress);
  await anchor2.waitForDeployment();

  const l2Combined = await GTokenL2.deploy(
    "GreenToken",
    "GT",
    await verifier.getAddress(),
    await messenger2.getAddress(),
    await anchor2.getAddress(),
    await ra.getAddress()
  );
  await l2Combined.waitForDeployment();

  // Configure anchor to accept messages from l2Combined
  await anchor2.connect(deployer).setConfig(await messenger2.getAddress(), await l2Combined.getAddress());

  const digest2 = await verifier.computeDigest(
    await holder.getAddress(),
    dtHash,
    hiddenCommitment,
    epochIndex,
    typeCode,
    qtyKWh,
    policyNonce,
    expiry
  );
  const sig2 = await issuer.signMessage(ethers.getBytes(digest2));

  rows.push(
    await gasOf(
      "Combined mintWithProof (includes immediate L1 recordMint)",
      l2Combined
        .connect(holder)
        .mintWithProof(epochIndex, typeCode, qtyKWh, policyNonce, hiddenCommitment, expiry, sig2),
      "This matches unit test behaviour; NOT representative of real L2 tx"
    )
  );

  print(rows);
  writeJson(rows);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
