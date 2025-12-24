import { ethers } from "hardhat";

/**
 * Configure a deployed GTokenAnchorArb.
 *
 * Env vars:
 *  - L1_ANCHOR_ADDRESS : address
 *  - L2_GTOKEN_ADDRESS : address
 */
async function main() {
  const anchorAddr = process.env.L1_ANCHOR_ADDRESS;
  const l2GToken = process.env.L2_GTOKEN_ADDRESS;
  if (!anchorAddr || !l2GToken) {
    throw new Error(
      "Missing L1_ANCHOR_ADDRESS or L2_GTOKEN_ADDRESS in .env (see .env.example)"
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("GTokenAnchorArb:", anchorAddr);
  console.log("Authorize L2 sender:", l2GToken);

  const anchor = await ethers.getContractAt("GTokenAnchorArb", anchorAddr);
  const tx = await anchor.setConfig(l2GToken);
  console.log("setConfig tx:", tx.hash);
  await tx.wait();

  console.log("configured:", await anchor.configured());
  console.log("l2GToken:", await anchor.l2GToken());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
