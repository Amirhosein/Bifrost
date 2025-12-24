import { readFileSync } from "fs";
import { ethers } from "hardhat";

async function main() {
  const tokenAddr = process.env.GTOKEN;
  if (!tokenAddr) throw new Error("Set GTOKEN=<address>");
  const GToken = await ethers.getContractFactory("GToken");
  const token = GToken.attach(tokenAddr);

  const { discBytes, proof } = JSON.parse(readFileSync("dataset/proof.json", "utf-8"));

  const tx = await token.mint(proof, discBytes);
  const rc = await tx.wait();
  console.log("Mint tx:", rc?.hash);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
