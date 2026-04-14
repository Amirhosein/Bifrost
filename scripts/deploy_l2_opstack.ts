import { ethers } from "hardhat";

/**
 * Deploy GTokenL2 (OP Stack messenger version) to an L2 chain
 * (e.g., Optimism Sepolia or Base Sepolia).
 *
 * Env vars:
 *  - L2_CROSS_DOMAIN_MESSENGER : address
 *  - L1_ANCHOR_ADDRESS : address (GTokenAnchor deployed on L1)
 *  - REGISTRY_ADMIN : address (optional; defaults to deployer)
 */
async function main() {
  const l2Messenger = process.env.L2_CROSS_DOMAIN_MESSENGER;
  const l1Anchor = process.env.L1_ANCHOR_ADDRESS;
  if (!l2Messenger || !l1Anchor) {
    throw new Error(
      "Missing L2_CROSS_DOMAIN_MESSENGER or L1_ANCHOR_ADDRESS in .env (see .env.example)"
    );
  }

  const [deployer] = await ethers.getSigners();
  const registryAdmin = process.env.REGISTRY_ADMIN ?? deployer.address;

  console.log("Deployer:", deployer.address);
  console.log("Registry admin:", registryAdmin);
  console.log("L2 messenger:", l2Messenger);
  console.log("L1 anchor:", l1Anchor);

  // Demo verifier (ECDSA-based) used by the repo tests/demo.
  const Verifier = await ethers.getContractFactory("DemoIssuerVerifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("DemoIssuerVerifier:", verifierAddr);

  const GTokenL2 = await ethers.getContractFactory("GTokenL2");
  const gt = await GTokenL2.deploy(
    "GreenToken",
    "GT",
    verifierAddr,
    l2Messenger,
    l1Anchor,
    registryAdmin
  );
  await gt.waitForDeployment();

  console.log("GTokenL2:", await gt.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
