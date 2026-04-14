import { ethers } from "hardhat";

/**
 * Deploy GTokenAnchorArb (Arbitrum Outbox authenticated) to L1 (e.g., Sepolia).
 *
 * Env vars:
 *  - ARBITRUM_L1_BRIDGE : address (Arbitrum bridge contract on L1)
 *  - L2_GTOKEN_ADDRESS : address (optional; if provided, contract is immediately configured)
 */
async function main() {
  const bridge = process.env.ARBITRUM_L1_BRIDGE;
  if (!bridge) {
    throw new Error(
      "Missing ARBITRUM_L1_BRIDGE in .env (see .env.example)"
    );
  }

  const l2GToken = process.env.L2_GTOKEN_ADDRESS ?? ethers.ZeroAddress;

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Arbitrum L1 Bridge:", bridge);
  console.log("L2 GToken (optional):", l2GToken);

  const Anchor = await ethers.getContractFactory("GTokenAnchorArb");
  const anchor = await Anchor.deploy(bridge, l2GToken);
  await anchor.waitForDeployment();

  console.log("GTokenAnchorArb:", await anchor.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
