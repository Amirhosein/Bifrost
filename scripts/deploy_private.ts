import { ethers } from "hardhat";

async function main() {
  const [ga, ra, oracle] = await ethers.getSigners();
  console.log("GA:", ga.address);
  console.log("RA:", ra.address);
  console.log("Oracle:", oracle.address);

  const MetReg = await ethers.getContractFactory("MetReg", ga);
  const metreg = await MetReg.deploy(await ga.getAddress());
  await metreg.waitForDeployment();
  console.log("MetReg:", await metreg.getAddress());

  const DataVer = await ethers.getContractFactory("DataVer", ra);
  const dataver = await DataVer.deploy(await ra.getAddress(), await oracle.getAddress());
  await dataver.waitForDeployment();
  console.log("DataVer:", await dataver.getAddress());
}

main().catch((e) => { console.error(e); process.exit(1); });
