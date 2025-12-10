import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const issuer = process.env.ISSUER_ADDR || deployer.address;

  const Verifier = await ethers.getContractFactory("BBSPlusDemoVerifier");
  const verifier = await Verifier.deploy(issuer, await deployer.getAddress());
  await verifier.waitForDeployment();
  console.log("Verifier:", await verifier.getAddress());

  const GToken = await ethers.getContractFactory("GToken");
  const token = await GToken.deploy("GreenToken", "GT");
  await token.waitForDeployment();
  console.log("GToken:", await token.getAddress());

  await (await token.setAllowedType(0, true)).wait(); // SOLAR
  await (await token.setAllowedType(1, true)).wait(); // WIND
  await (await token.setAllowedType(2, true)).wait(); // HYDRO
  await (await token.setVerifier(await verifier.getAddress())).wait();

  console.log("Public deployment complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
