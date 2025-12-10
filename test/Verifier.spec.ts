import { expect } from "chai";
import { ethers } from "hardhat";
import { AbiCoder, keccak256, getBytes } from "ethers";

describe("BBSPlusDemoVerifier", function () {
  it("accepts issuer signature and rejects others", async function () {
    const [issuer, other] = await ethers.getSigners();

    const Verifier = await ethers.getContractFactory("BBSPlusDemoVerifier");
    const verifier = await Verifier.deploy(issuer.address, issuer.address);
    await verifier.waitForDeployment();

    const vcHash = keccak256(getBytes("0x1234"));
    const coder = new AbiCoder();
    const discBytes = coder.encode(["tuple(uint64,uint16,uint256,uint128)"], [[202540, 0, 100n, 0n]]);
    const discHash = keccak256(discBytes);
    const message = keccak256(Buffer.concat([getBytes(vcHash), getBytes(discHash)]));

    const goodSig = await issuer.signMessage(getBytes(message));
    const proof = coder.encode(["bytes32","bytes"], [vcHash, goodSig]);
    expect(await verifier.verify(proof, discBytes)).to.eq(true);

    const badSig = await other.signMessage(getBytes(message));
    const badProof = coder.encode(["bytes32","bytes"], [vcHash, badSig]);
    expect(await verifier.verify(badProof, discBytes)).to.eq(false);
  });
});
