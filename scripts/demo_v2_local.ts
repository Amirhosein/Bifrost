import { ethers } from "hardhat";

function toBytes32Hex(label: string): string {
  // deterministic pseudo-hash for demo
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

async function main() {
  const [deployer, ga, ra, oracle, issuer, holder] = await ethers.getSigners();

  // Deploy everything (same as deploy script, but we keep references here)
  const MockXDM = await ethers.getContractFactory("MockCrossDomainMessenger");
  const messenger = await MockXDM.connect(deployer).deploy();
  await messenger.waitForDeployment();

  const Anchor = await ethers.getContractFactory("GTokenAnchor");
  const anchor = await Anchor.connect(deployer).deploy(await messenger.getAddress(), ethers.ZeroAddress);
  await anchor.waitForDeployment();

  const DemoVerifier = await ethers.getContractFactory("DemoIssuerVerifier");
  const verifier = await DemoVerifier.connect(deployer).deploy(issuer.address);
  await verifier.waitForDeployment();

  const GTokenL2 = await ethers.getContractFactory("GTokenL2");
  const gtoken = await GTokenL2.connect(deployer).deploy(
    "GreenToken",
    "GT",
    await verifier.getAddress(),
    await messenger.getAddress(),
    await anchor.getAddress(),
    ra.address
  );
  await gtoken.waitForDeployment();

  await (await anchor.connect(deployer).setConfig(await messenger.getAddress(), await gtoken.getAddress())).wait();

  // --- Simulated private-side verification + VC issuance ---
  // Hidden identifiers (do not go on-chain in mint request)
  const ownerHash = toBytes32Hex("owner:alice");
  const meterHash = toBytes32Hex("meter:56789");
  const siteHash = toBytes32Hex("site:34567");

  // Publicly disclosed mint fields
  const epochIndex = 202540n;
  const typeCode = 1n; // 1 = SOLAR
  const qtyKWh = 100n;
  const policyNonce = 0n;

  // Hidden commitment (represents the signed-but-undisclosed fields)
  const hiddenCommitment = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "bytes32", "bytes32"], [ownerHash, meterHash, siteHash])
  );

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

  // Issuer computes digest exactly as verifier does and signs it
  const digest = await verifier.computeDigest(
    holder.address,
    ethers.keccak256(
      ethers.solidityPacked(
        ["uint64", "uint16", "uint256", "uint128"],
        [epochIndex, typeCode, qtyKWh, policyNonce]
      )
    ),
    hiddenCommitment,
    epochIndex,
    Number(typeCode),
    qtyKWh,
    policyNonce,
    expiry
  );

  const signature = await issuer.signMessage(ethers.getBytes(digest));

  console.log("\n--- Demo Mint ---");
  console.log("Holder:", holder.address);
  console.log("epochIndex:", epochIndex.toString());
  console.log("typeCode:", typeCode.toString());
  console.log("qtyKWh:", qtyKWh.toString());
  console.log("hiddenCommitment:", hiddenCommitment);
  console.log("digest:", digest);

  const tx = await gtoken.connect(holder).mintWithProof(
    Number(epochIndex),
    Number(typeCode),
    qtyKWh,
    policyNonce,
    hiddenCommitment,
    expiry,
    signature
  );
  const rc = await tx.wait();

  console.log("Mint tx:", rc?.hash);

  const dtHash = ethers.keccak256(
    ethers.solidityPacked(
      ["uint64", "uint16", "uint256", "uint128"],
      [epochIndex, typeCode, qtyKWh, policyNonce]
    )
  );

  const balance = await gtoken.balanceOf(holder.address);
  console.log("Holder GT balance:", balance.toString());

  const anchored = await anchor.isAnchored(dtHash);
  console.log("Anchored on L1?", anchored);

  const info = await anchor.anchorInfo(dtHash);
  console.log("Anchor info:", {
    to: info.to,
    gtAmount: info.gtAmount.toString(),
    epochIndex: info.epochIndex.toString(),
    typeCode: info.typeCode.toString(),
    qtyKWh: info.qtyKWh.toString(),
    timestamp: info.timestamp.toString()
  });

  console.log("\n--- Attempt duplicate mint (should fail) ---");
  try {
    await gtoken.connect(holder).mintWithProof(
      Number(epochIndex),
      Number(typeCode),
      qtyKWh,
      policyNonce,
      hiddenCommitment,
      expiry,
      signature
    );
  } catch (e: any) {
    console.log("Duplicate mint reverted as expected:", e.message?.slice(0, 140) + "...");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
