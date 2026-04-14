import { ethers } from "hardhat";

async function main() {
  const l2Messenger = process.env.L2_CROSS_DOMAIN_MESSENGER;
  const l1Anchor = process.env.L1_ANCHOR_ADDRESS;
  const receiptVerifier = process.env.RISC0_GROTH16_VERIFIER;
  const imageId = process.env.RISC0_IMAGE_ID;
  if (!l2Messenger || !l1Anchor || !receiptVerifier || !imageId) {
    throw new Error(
      "Missing one of: L2_CROSS_DOMAIN_MESSENGER, L1_ANCHOR_ADDRESS, RISC0_GROTH16_VERIFIER, RISC0_IMAGE_ID"
    );
  }

  const [deployer] = await ethers.getSigners();
  const registryAdmin = process.env.REGISTRY_ADMIN ?? deployer.address;

  console.log("Network:", (await ethers.provider.getNetwork()).name);
  console.log("Deployer:", deployer.address);
  console.log("RegistryAdmin:", registryAdmin);
  console.log("RiscZero verifier:", receiptVerifier);
  console.log("RiscZero imageId:", imageId);

  const Verifier = await ethers.getContractFactory("RiscZeroBbsL2Verifier");
  const verifier = await Verifier.deploy(receiptVerifier, imageId as `0x${string}`);
  await verifier.waitForDeployment();
  console.log("RiscZeroBbsL2Verifier:", await verifier.getAddress());

  const Token = await ethers.getContractFactory("GTokenL2BbsSnark");
  const token = await Token.deploy(
    "GreenToken",
    "GT",
    await verifier.getAddress(),
    l2Messenger,
    l1Anchor,
    registryAdmin
  );
  await token.waitForDeployment();
  console.log("GTokenL2BbsSnark:", await token.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

