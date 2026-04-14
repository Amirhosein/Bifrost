import { ethers } from "hardhat";

async function main() {
  const l2Messenger = process.env.L2_CROSS_DOMAIN_MESSENGER;
  const l1Anchor = process.env.L1_ANCHOR_ADDRESS;
  if (!l2Messenger || !l1Anchor) {
    throw new Error("Missing L2_CROSS_DOMAIN_MESSENGER or L1_ANCHOR_ADDRESS");
  }

  const [deployer] = await ethers.getSigners();
  const registryAdmin = process.env.REGISTRY_ADMIN ?? deployer.address;

  console.log("Network:", (await ethers.provider.getNetwork()).name);
  console.log("Deployer:", deployer.address);
  console.log("RegistryAdmin:", registryAdmin);

  const Verifier = await ethers.getContractFactory("MockBbsStylusNativeVerifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  console.log("MockBbsStylusNativeVerifier:", await verifier.getAddress());

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
  console.log("GTokenL2BbsSnark (Stylus sim path):", await token.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

