import { expect } from "chai";
import { ethers } from "hardhat";

describe("DemoIssuerVerifier admin hardening", function () {
  it("only owner can rotate issuer signer", async function () {
    const [deployer, issuer, attacker] = await ethers.getSigners();

    const Verifier = await ethers.getContractFactory("DemoIssuerVerifier");
    const verifier = await Verifier.connect(deployer).deploy(issuer.address);
    await verifier.waitForDeployment();

    await expect(verifier.connect(attacker).setIssuerSigner(attacker.address)).to.be.reverted;

    await expect(verifier.connect(deployer).setIssuerSigner(attacker.address)).to.not.be.reverted;
    expect(await verifier.issuerSigner()).to.equal(attacker.address);
  });
});

