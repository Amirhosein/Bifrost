import { ethers } from "hardhat";

/**
 * Demo: mint on Arbitrum Sepolia (or any Arbitrum L2 network) using the deployed
 * GTokenL2Arb contract.
 *
 * Usage (example):
 *   L2_GTOKEN=0x... npx hardhat run scripts/demo_l2_arbitrum_mint.ts --network arbitrumSepolia
 *
 * Optional env overrides:
 *   EPOCH_INDEX=202540
 *   TYPE_CODE=1
 *   QTY_KWH=100
 *   POLICY_NONCE=0
 *   EXPIRY_SECONDS=3600
 *   HIDDEN_COMMITMENT=0x... (32-byte hex)
 *
 * Notes:
 * - The issuer signature uses the first Hardhat signer (PRIVATE_KEY in .env).
 * - Your DemoIssuerVerifier MUST be deployed with that signer as the issuer.
 */

function envOrDefault(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (!v) return fallback;
  // allow decimal or 0x
  return v.startsWith("0x") ? BigInt(v) : BigInt(v);
}

function parseNumberEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  return Number(v);
}

async function main() {
  const l2GTokenAddr = process.env.L2_GTOKEN;
  if (!l2GTokenAddr) {
    throw new Error("Missing env var L2_GTOKEN (address of deployed GTokenL2Arb)");
  }

  const [defaultSigner] = await ethers.getSigners();
  const holder = defaultSigner;
  const issuer = defaultSigner;

  const epochIndex = parseNumberEnv("EPOCH_INDEX", 202540);
  const typeCode = parseNumberEnv("TYPE_CODE", 1);
  const qtyKWh = parseBigIntEnv("QTY_KWH", 100n);
  const policyNonce = parseBigIntEnv("POLICY_NONCE", 0n);
  const expirySeconds = parseNumberEnv("EXPIRY_SECONDS", 3600);

  const hiddenCommitment = envOrDefault(
    "HIDDEN_COMMITMENT",
    ethers.keccak256(ethers.toUtf8Bytes("demo-hidden-commitment"))
  );
  const expiry = Math.floor(Date.now() / 1000) + expirySeconds;

  const network = await ethers.provider.getNetwork();
  console.log("--- Arbitrum L2 Mint Demo ---");
  console.log("network:", network.name, "chainId:", network.chainId.toString());
  console.log("holder:", await holder.getAddress());
  console.log("issuer:", await issuer.getAddress());
  console.log("L2_GTOKEN:", l2GTokenAddr);

  const gtoken = await ethers.getContractAt("GTokenL2Arb", l2GTokenAddr);
  const verifierAddr = await gtoken.verifier();
  const l1AnchorAddr = await gtoken.l1Anchor();

  console.log("verifier:", verifierAddr);
  console.log("l1Anchor (configured in L2):", l1AnchorAddr);

  const verifier = await ethers.getContractAt("DemoIssuerVerifier", verifierAddr);

  // Compute the exact digest the contract will verify.
  const digest = await verifier.computeDigest(
    await holder.getAddress(),
    epochIndex,
    typeCode,
    qtyKWh,
    policyNonce,
    hiddenCommitment,
    expiry
  );

  const sig = await issuer.signMessage(ethers.getBytes(digest));

  console.log("epochIndex:", epochIndex);
  console.log("typeCode:", typeCode);
  console.log("qtyKWh:", qtyKWh.toString());
  console.log("policyNonce:", policyNonce.toString());
  console.log("hiddenCommitment:", hiddenCommitment);
  console.log("expiry:", expiry);
  console.log("digest:", digest);

  const tx = await gtoken.connect(holder).mintWithProof(
    epochIndex,
    typeCode,
    qtyKWh,
    policyNonce,
    hiddenCommitment,
    expiry,
    sig
  );

  console.log("mint tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("status:", receipt?.status);

  // Parse key events.
  const iface = gtoken.interface;
  for (const log of receipt!.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Minted") {
        console.log("Minted:", parsed.args);
      }
      if (parsed?.name === "L2ToL1Message") {
        console.log("L2ToL1Message:", parsed.args);
        console.log(
          "NOTE: On real Arbitrum, L1 anchoring happens only after this message is executed on L1 (Outbox)."
        );
      }
    } catch {
      // ignore unrelated logs
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
