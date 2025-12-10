import { expect } from "chai";
import { ethers } from "hardhat";
import { AbiCoder, keccak256, getBytes } from "ethers";

function packProof(vcHash: string, discBytes: string, signature: string) {
  const coder = new AbiCoder();
  return coder.encode(["bytes32","bytes"], [vcHash, signature]);
}

describe("GToken end-to-end", function () {
  it("mints once and rejects duplicate", async function () {
    const [deployer] = await ethers.getSigners();
    const issuer = deployer;

    const Verifier = await ethers.getContractFactory("BBSPlusDemoVerifier");
    const verifier = await Verifier.deploy(issuer.address, deployer.address);
    await verifier.waitForDeployment();

    const GToken = await ethers.getContractFactory("GToken");
    const token = await GToken.deploy("GreenToken", "GT");
    await token.waitForDeployment();

    await (await token.setAllowedType(0, true)).wait();
    await (await token.setVerifier(await verifier.getAddress())).wait();

    const disc = { epochIndex: 202540, typeCode: 0, quantityKWh: 100n, policyNonce: 0n };
    const coder = new AbiCoder();
    const discBytes = coder.encode(["tuple(uint64,uint16,uint256,uint128)"], [[disc.epochIndex, disc.typeCode, disc.quantityKWh, disc.policyNonce]]);
    const discHash = keccak256(discBytes);

    const vcHash = keccak256(getBytes("0xdeadbeef"));
    const message = keccak256(Buffer.concat([getBytes(vcHash), getBytes(discHash)]));
    const sig = await issuer.signMessage(getBytes(message));
    const proof = packProof(vcHash, discBytes, sig);

    await expect(token.mint(proof, discBytes)).to.emit(token, "Minted");

    await expect(token.mint(proof, discBytes)).to.be.reverted; // duplicate
  });
});
