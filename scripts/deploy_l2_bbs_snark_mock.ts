import { ethers } from "hardhat";

async function main() {
  const l2Messenger = process.env.L2_CROSS_DOMAIN_MESSENGER;
  const l1Anchor = process.env.L1_ANCHOR_ADDRESS;
  if (!l2Messenger || !l1Anchor) {
    throw new Error("Missing L2_CROSS_DOMAIN_MESSENGER or L1_ANCHOR_ADDRESS");
  }

  const [deployer] = await ethers.getSigners();
  const issuer = process.env.ISSUER_ADDR ?? deployer.address;
  const registryAdmin = process.env.REGISTRY_ADMIN ?? deployer.address;

  console.log("Network:", (await ethers.provider.getNetwork()).name);
  console.log("Deployer:", deployer.address);
  console.log("Issuer:", issuer);
  console.log("RegistryAdmin:", registryAdmin);

  const Verifier = await ethers.getContractFactory("MockBbsSnarkVerifier");
  const verifier = await Verifier.deploy(issuer);
  await verifier.waitForDeployment();
  console.log("MockBbsSnarkVerifier:", await verifier.getAddress());

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

