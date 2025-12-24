import { ethers } from "hardhat";

/**
 * Deploy GTokenL2Arb to Arbitrum (e.g., Arbitrum Sepolia).
 *
 * Env vars:
 *  - L1_ANCHOR_ADDRESS : address (GTokenAnchorArb deployed on L1)
 *  - REGISTRY_ADMIN : address (optional; defaults to deployer)
 */
async function main() {
  const l1Anchor = process.env.L1_ANCHOR_ADDRESS;
  if (!l1Anchor) {
    throw new Error("Missing L1_ANCHOR_ADDRESS in .env (see .env.example)");
  }

  const [deployer] = await ethers.getSigners();
  const registryAdmin = process.env.REGISTRY_ADMIN ?? deployer.address;

  console.log("Network:", (await ethers.provider.getNetwork()).name);
  console.log("Deployer:", deployer.address);
  console.log("RegistryAdmin:", registryAdmin);

  // Deploy demo verifier (ECDSA-based, used for testnet demos)
  const Verifier = await ethers.getContractFactory("DemoIssuerVerifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("DemoIssuerVerifier:", verifierAddr);

  const Token = await ethers.getContractFactory("GTokenL2Arb");
  const token = await Token.deploy(
    "GreenToken",
    "GT",
    verifierAddr,
    l1Anchor,
    registryAdmin
  );
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  console.log("GTokenL2Arb:", tokenAddr);
  console.log("Next: set L2_GTOKEN_ADDRESS=" + tokenAddr + " and run configure_l1_anchor_arbitrum.ts on L1");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
