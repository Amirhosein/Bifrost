import { ethers } from "hardhat";

/**
 * Configure a deployed GTokenAnchor (OP Stack messenger version).
 *
 * Env vars:
 *  - L1_ANCHOR_ADDRESS : address
 *  - L1_CROSS_DOMAIN_MESSENGER : address (L1 CrossDomainMessenger)
 *  - L2_GTOKEN_ADDRESS : address (authorized L2 sender)
 */
async function main() {
  const anchorAddr = process.env.L1_ANCHOR_ADDRESS;
  const messengerAddr = process.env.L1_CROSS_DOMAIN_MESSENGER;
  const l2GToken = process.env.L2_GTOKEN_ADDRESS;
  if (!anchorAddr || !messengerAddr || !l2GToken) {
    throw new Error(
      "Missing L1_ANCHOR_ADDRESS, L1_CROSS_DOMAIN_MESSENGER, or L2_GTOKEN_ADDRESS in .env (see .env.example)"
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const anchor = await ethers.getContractAt("GTokenAnchor", anchorAddr);
  const tx = await anchor.setConfig(messengerAddr, l2GToken);
  console.log("setConfig tx:", tx.hash);
  await tx.wait();
  console.log("Configured GTokenAnchor. Authorized L2 sender:", l2GToken);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
