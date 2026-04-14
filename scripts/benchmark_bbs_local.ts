/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

type Row = {
  path: string;
  operation: string;
  gasUsed: string;
  calldataBytes?: number;
  notes?: string;
};

function calldataBytes(tx: any): number {
  const data = (tx?.data ?? "0x") as string;
  return Math.max(0, (data.length - 2) / 2);
}

async function gasOf(pathLabel: string, operation: string, txPromise: Promise<any>, notes?: string): Promise<Row> {
  const tx = await txPromise;
  const rc = await tx.wait();
  return {
    path: pathLabel,
    operation,
    gasUsed: rc.gasUsed.toString(),
    calldataBytes: calldataBytes(tx),
    notes,
  };
}

async function main() {
  const [deployer, ra, issuer, holder, recipient] = await ethers.getSigners();
  const rows: Row[] = [];

  const claims = {
    reTypeCode: 1,
    qtyKWh: 100n,
    readingTimestamp: 1_740_873_600,
    credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes("vc:bench:2025-03-24")),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const bbsProof = ethers.toUtf8Bytes("bbs-proof-local-benchmark");

  // ---------------------------------------------------------------------------
  // SNARK-wrapped path (mock verifier)
  // ---------------------------------------------------------------------------
  const NoopMessenger = await ethers.getContractFactory("MockCrossDomainMessengerNoop");
  const noopMessengerA = await NoopMessenger.connect(deployer).deploy();
  await noopMessengerA.waitForDeployment();

  const Anchor = await ethers.getContractFactory("GTokenAnchor");
  const anchorA = await Anchor.connect(deployer).deploy(await noopMessengerA.getAddress(), ethers.ZeroAddress);
  await anchorA.waitForDeployment();

  const SnarkVerifier = await ethers.getContractFactory("MockBbsSnarkVerifier");
  const snarkVerifier = await SnarkVerifier.connect(deployer).deploy(issuer.address);
  await snarkVerifier.waitForDeployment();

  const Token = await ethers.getContractFactory("GTokenL2BbsSnark");
  const tokenA = await Token.connect(deployer).deploy(
    "GreenToken",
    "GT",
    await snarkVerifier.getAddress(),
    await noopMessengerA.getAddress(),
    await anchorA.getAddress(),
    ra.address
  );
  await tokenA.waitForDeployment();

  const digestA = await snarkVerifier.digest(holder.address, claims, bbsProof);
  const sealA = await issuer.signMessage(ethers.getBytes(digestA));

  const verifyGasA = await snarkVerifier.verifyForMint.estimateGas(holder.address, claims, bbsProof, sealA);
  rows.push({
    path: "solidity-snark",
    operation: "verifyForMint (estimateGas)",
    gasUsed: verifyGasA.toString(),
    notes: "Mock SNARK verifier estimate",
  });

  rows.push(
    await gasOf(
      "solidity-snark",
      "mintWithBbsProof (no relay)",
      tokenA.connect(holder).mintWithBbsProof(claims, bbsProof, sealA),
      "L2 mint only; messenger is noop"
    )
  );
  rows.push(
    await gasOf(
      "solidity-snark",
      "transfer",
      tokenA.connect(holder).transfer(recipient.address, 10n),
      "Post-mint transfer"
    )
  );

  // ---------------------------------------------------------------------------
  // Stylus-native semantics path (sim verifier)
  // ---------------------------------------------------------------------------
  const noopMessengerB = await NoopMessenger.connect(deployer).deploy();
  await noopMessengerB.waitForDeployment();

  const anchorB = await Anchor.connect(deployer).deploy(await noopMessengerB.getAddress(), ethers.ZeroAddress);
  await anchorB.waitForDeployment();

  const StylusVerifier = await ethers.getContractFactory("MockBbsStylusNativeVerifier");
  const stylusVerifier = await StylusVerifier.connect(deployer).deploy();
  await stylusVerifier.waitForDeployment();

  const tokenB = await Token.connect(deployer).deploy(
    "GreenToken",
    "GT",
    await stylusVerifier.getAddress(),
    await noopMessengerB.getAddress(),
    await anchorB.getAddress(),
    ra.address
  );
  await tokenB.waitForDeployment();

  const digestB = await stylusVerifier.digest(holder.address, claims, bbsProof);
  rows.push(
    await gasOf(
      "stylus-native-sim",
      "setDigestApproval",
      stylusVerifier.connect(deployer).setDigestApproval(digestB, true),
      "Simulates native verifier allowing proof digest"
    )
  );

  const verifyGasB = await stylusVerifier.verifyForMint.estimateGas(holder.address, claims, bbsProof, "0x");
  rows.push({
    path: "stylus-native-sim",
    operation: "verifyForMint (estimateGas)",
    gasUsed: verifyGasB.toString(),
    notes: "Simulated Stylus verifier estimate",
  });

  rows.push(
    await gasOf(
      "stylus-native-sim",
      "mintWithBbsProof (no relay)",
      tokenB.connect(holder).mintWithBbsProof(claims, bbsProof, "0x"),
      "L2 mint only; messenger is noop"
    )
  );
  rows.push(
    await gasOf(
      "stylus-native-sim",
      "transfer",
      tokenB.connect(holder).transfer(recipient.address, 10n),
      "Post-mint transfer"
    )
  );

  // ---------------------------------------------------------------------------
  // L1 relay execution (common)
  // ---------------------------------------------------------------------------
  const Messenger = await ethers.getContractFactory("MockCrossDomainMessenger");
  const messenger = await Messenger.connect(deployer).deploy();
  await messenger.waitForDeployment();
  const anchor = await Anchor.connect(deployer).deploy(await messenger.getAddress(), ethers.ZeroAddress);
  await anchor.waitForDeployment();
  const L2Sender = await ethers.getContractFactory("L2SenderMock");
  const l2Sender = await L2Sender.connect(deployer).deploy();
  await l2Sender.waitForDeployment();

  rows.push(
    await gasOf(
      "common",
      "anchor.setConfig",
      anchor.connect(deployer).setConfig(await messenger.getAddress(), await l2Sender.getAddress()),
      "One-time config"
    )
  );

  const claimId = ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint16", "uint256", "uint64"],
      [claims.credentialIdHash, claims.reTypeCode, claims.qtyKWh, claims.readingTimestamp]
    )
  );
  const payload = anchor.interface.encodeFunctionData("recordMint", [
    claimId,
    holder.address,
    claims.qtyKWh,
    claims.readingTimestamp,
    claims.reTypeCode,
    claims.qtyKWh,
  ]);

  rows.push(
    await gasOf(
      "common",
      "L1 relay: messenger.sendMessage -> recordMint",
      l2Sender.connect(deployer).send(await messenger.getAddress(), await anchor.getAddress(), payload, 1_000_000),
      "Models asynchronous L1 execution cost"
    )
  );

  console.table(rows);

  const outPath = path.join(process.cwd(), "docs", "bench_bbs_l2_local.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        network: "hardhat",
        claims: {
          reTypeCode: claims.reTypeCode,
          qtyKWh: claims.qtyKWh.toString(),
          readingTimestamp: claims.readingTimestamp,
          credentialIdHash: claims.credentialIdHash,
        },
        rows,
      },
      null,
      2
    )
  );
  console.log("Wrote:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

