import { ethers } from "hardhat";

/**
 * Deploy GTokenAnchor (OP Stack messenger version) to an L1 chain (e.g., Sepolia).
 *
 * Env vars:
 *  - L1_CROSS_DOMAIN_MESSENGER : address
 */
async function main() {
  const messenger = process.env.L1_CROSS_DOMAIN_MESSENGER;
  if (!messenger) {
    throw new Error(
      "Missing L1_CROSS_DOMAIN_MESSENGER in .env (see .env.example)"
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("L1 CrossDomainMessenger:", messenger);

  const Anchor = await ethers.getContractFactory("GTokenAnchor");
  // constructor(address messenger_, address unused)
  const anchor = await Anchor.deploy(messenger, ethers.ZeroAddress);
  await anchor.waitForDeployment();

  const addr = await anchor.getAddress();
  console.log("GTokenAnchor deployed to:", addr);
  console.log("Next: deploy L2 contract, then run configure script on L1 to authorize the L2 sender.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
