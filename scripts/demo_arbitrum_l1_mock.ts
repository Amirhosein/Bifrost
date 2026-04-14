import { ethers } from "hardhat";

/**
 * Demo: Arbitrum-style L2 -> L1 anchoring (mocked locally)
 *
 * This demo runs entirely on the local Hardhat network (no ETH required).
 *
 * What it demonstrates:
 *  - L1 anchor only accepts calls executed via the Outbox
 *  - L1 anchor only accepts calls that originate from the configured L2 sender
 *  - dtHash is write-once (duplicate anchoring is rejected)
 */
async function main() {
  const [deployer, holder, attacker] = await ethers.getSigners();

  console.log("--- Arbitrum L2->L1 Anchor Demo (Mock) ---");
  console.log("Deployer:", deployer.address);
  console.log("Holder  :", holder.address);
  console.log("Attacker:", attacker.address);

  // 1) Deploy mocks: Outbox + Bridge
  const MockArbOutbox = await ethers.getContractFactory("MockArbOutbox");
  const outbox = await MockArbOutbox.connect(deployer).deploy();
  await outbox.waitForDeployment();

  const MockArbBridge = await ethers.getContractFactory("MockArbBridge");
  const bridge = await MockArbBridge.connect(deployer).deploy(await outbox.getAddress());
  await bridge.waitForDeployment();

  // 2) Deploy L1 anchor
  const Anchor = await ethers.getContractFactory("GTokenAnchorArb");
  const anchor = await Anchor.connect(deployer).deploy(await bridge.getAddress(), ethers.ZeroAddress);
  await anchor.waitForDeployment();

  // Configure an authorized L2 sender address (simulated)
  const l2GToken = deployer.address;
  await (await anchor.connect(deployer).setConfig(l2GToken)).wait();

  console.log("Outbox :", await outbox.getAddress());
  console.log("Bridge :", await bridge.getAddress());
  console.log("Anchor :", await anchor.getAddress());
  console.log("L2 sender (authorized):", l2GToken);

  // Inputs for anchoring
  const dtHash = ethers.keccak256(ethers.toUtf8Bytes("demo-dtHash"));
  const to = holder.address;
  const gtAmount = 100n;
  const epochIndex = 202540;
  const typeCode = 1;
  const qtyKWh = 100n;

  console.log("\n1) Direct call from EOA (should revert)");
  try {
    await anchor.connect(holder).recordMint(dtHash, to, gtAmount, epochIndex, typeCode, qtyKWh);
    console.log("Unexpected: direct call succeeded");
  } catch (e: any) {
    console.log("Reverted as expected:", e?.shortMessage ?? e?.message);
  }

  // Build calldata for the Outbox to execute
  const payload = anchor.interface.encodeFunctionData("recordMint", [
    dtHash,
    to,
    gtAmount,
    epochIndex,
    typeCode,
    qtyKWh,
  ]);

  console.log("\n2) Outbox call but wrong L2 sender (should revert)");
  try {
    await outbox.execute(await anchor.getAddress(), payload, attacker.address);
    console.log("Unexpected: outbox call with wrong sender succeeded");
  } catch (e: any) {
    console.log("Reverted as expected:", e?.shortMessage ?? e?.message);
  }

  console.log("\n3) Outbox call with authorized L2 sender (should succeed)");
  const tx = await outbox.execute(await anchor.getAddress(), payload, l2GToken);
  const rcpt = await tx.wait();
  console.log("Tx:", rcpt?.hash);
  console.log("Anchored?", await anchor.isAnchored(dtHash));
  console.log("Anchor info:", await anchor.anchorInfo(dtHash));

  console.log("\n4) Duplicate anchor attempt (should revert)");
  try {
    await outbox.execute(await anchor.getAddress(), payload, l2GToken);
    console.log("Unexpected: duplicate anchoring succeeded");
  } catch (e: any) {
    console.log("Reverted as expected:", e?.shortMessage ?? e?.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
