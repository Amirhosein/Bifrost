import { expect } from "chai";
import { ethers } from "hardhat";

describe("V2 BBS+ L2 mint (SNARK-wrapped path)", function () {
  async function deployFixture() {
    const [deployer, ra, issuer, holder, recipient] = await ethers.getSigners();

    const MockXDM = await ethers.getContractFactory("MockCrossDomainMessenger");
    const messenger = await MockXDM.connect(deployer).deploy();
    await messenger.waitForDeployment();

    const Anchor = await ethers.getContractFactory("GTokenAnchor");
    const anchor = await Anchor.connect(deployer).deploy(await messenger.getAddress(), ethers.ZeroAddress);
    await anchor.waitForDeployment();

    const Verifier = await ethers.getContractFactory("MockBbsSnarkVerifier");
    const verifier = await Verifier.connect(deployer).deploy(issuer.address);
    await verifier.waitForDeployment();

    const Token = await ethers.getContractFactory("GTokenL2BbsSnark");
    const token = await Token.connect(deployer).deploy(
      "GreenToken",
      "GT",
      await verifier.getAddress(),
      await messenger.getAddress(),
      await anchor.getAddress(),
      ra.address
    );
    await token.waitForDeployment();

    await (await anchor.connect(deployer).setConfig(await messenger.getAddress(), await token.getAddress())).wait();

    return { deployer, issuer, holder, recipient, verifier, token, anchor };
  }

  function sampleClaims(expiry: bigint) {
    return {
      reTypeCode: 1,
      qtyKWh: 100n,
      readingTimestamp: 1_740_787_200, // 2025-03-23 00:00:00 UTC
      credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes("vc:owner789:2025-03-23:solar")),
      expiry,
    };
  }

  it("mints once, anchors claimId, blocks duplicate credential, and allows transfer", async function () {
    const { issuer, holder, recipient, verifier, token, anchor } = await deployFixture();

    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const claims = sampleClaims(expiry);
    const bbsProof = ethers.toUtf8Bytes("bbs-proof-valid");

    const digest = await verifier.digest(holder.address, claims, bbsProof);
    const zkSeal = await issuer.signMessage(ethers.getBytes(digest));

    const claimId = await token.computeClaimId(claims);

    await expect(token.connect(holder).mintWithBbsProof(claims, bbsProof, zkSeal))
      .to.emit(token, "MintedBbs")
      .withArgs(holder.address, claimId, claims.credentialIdHash, claims.reTypeCode, claims.qtyKWh, claims.readingTimestamp, claims.qtyKWh);

    expect(await token.balanceOf(holder.address)).to.equal(claims.qtyKWh);
    expect(await token.isCredentialUsed(claims.credentialIdHash)).to.equal(true);

    expect(await anchor.isAnchored(claimId)).to.equal(true);

    // transfer is part of the benchmarked lifecycle
    await expect(token.connect(holder).transfer(recipient.address, 10n)).to.not.be.reverted;
    expect(await token.balanceOf(recipient.address)).to.equal(10n);

    await expect(token.connect(holder).mintWithBbsProof(claims, bbsProof, zkSeal)).to.be.revertedWithCustomError(
      token,
      "DuplicateCredential"
    );
  });

  it("rejects tampered disclosed fields and expired claims", async function () {
    const { issuer, holder, verifier, token } = await deployFixture();

    const validExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const claims = sampleClaims(validExpiry);
    const bbsProof = ethers.toUtf8Bytes("bbs-proof-valid");

    const digest = await verifier.digest(holder.address, claims, bbsProof);
    const zkSeal = await issuer.signMessage(ethers.getBytes(digest));

    const tamperedClaims = { ...claims, qtyKWh: 101n };
    await expect(token.connect(holder).mintWithBbsProof(tamperedClaims, bbsProof, zkSeal)).to.be.revertedWithCustomError(
      token,
      "InvalidProof"
    );

    const expiredClaims = sampleClaims(BigInt(Math.floor(Date.now() / 1000) - 1));
    await expect(token.connect(holder).mintWithBbsProof(expiredClaims, bbsProof, zkSeal)).to.be.revertedWithCustomError(
      token,
      "Expired"
    );
  });

  it("keeps L1 anchor as mint-disabled (no mint entrypoint)", async function () {
    const { anchor } = await deployFixture();
    const hasMint = anchor.interface.fragments.some((f) => f.type === "function" && f.name === "mint");
    const hasMintWithProof = anchor.interface.fragments.some((f) => f.type === "function" && f.name === "mintWithProof");
    expect(hasMint).to.equal(false);
    expect(hasMintWithProof).to.equal(false);
  });
});
