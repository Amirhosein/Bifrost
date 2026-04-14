import { ethers } from "hardhat";

async function main() {
  const [deployer, ga, ra, oracle, issuer] = await ethers.getSigners();

  console.log("Deployer:", deployer.address);
  console.log("GA:", ga.address);
  console.log("RA:", ra.address);
  console.log("Oracle:", oracle.address);
  console.log("Issuer:", issuer.address);

  // Private-side contracts (emulated)
  const MetReg = await ethers.getContractFactory("MetReg");
  const metReg = await MetReg.connect(deployer).deploy(ga.address, ra.address);
  await metReg.waitForDeployment();

  const DataVer = await ethers.getContractFactory("DataVer");
  const dataVer = await DataVer.connect(deployer).deploy(ra.address, oracle.address);
  await dataVer.waitForDeployment();

  // Mock messenger + L1 anchor
  const MockXDM = await ethers.getContractFactory("MockCrossDomainMessenger");
  const messenger = await MockXDM.connect(deployer).deploy();
  await messenger.waitForDeployment();

  const Anchor = await ethers.getContractFactory("GTokenAnchor");
  const anchor = await Anchor.connect(deployer).deploy(await messenger.getAddress(), ethers.ZeroAddress);
  await anchor.waitForDeployment();

  // Demo verifier (issuer ECDSA)
  const DemoVerifier = await ethers.getContractFactory("DemoIssuerVerifier");
  const verifier = await DemoVerifier.connect(deployer).deploy(issuer.address);
  await verifier.waitForDeployment();

  // L2 mint contract
  const GTokenL2 = await ethers.getContractFactory("GTokenL2");
  const gtoken = await GTokenL2.connect(deployer).deploy(
    "GreenToken",
    "GT",
    await verifier.getAddress(),
    await messenger.getAddress(),
    await anchor.getAddress(),
    ra.address
  );
  await gtoken.waitForDeployment();

  // finalize anchor config to expect this L2 sender
  await (await anchor.connect(deployer).setConfig(await messenger.getAddress(), await gtoken.getAddress())).wait();

  console.log("\nDeployed:\n");
  console.log("MetReg:", await metReg.getAddress());
  console.log("DataVer:", await dataVer.getAddress());
  console.log("Messenger:", await messenger.getAddress());
  console.log("GTokenAnchor (L1):", await anchor.getAddress());
  console.log("DemoIssuerVerifier:", await verifier.getAddress());
  console.log("GTokenL2:", await gtoken.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
