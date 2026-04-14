import { expect } from "chai";
import { ethers } from "hardhat";

describe("V2 BBS+ L2 mint (Stylus-native semantics via sim verifier)", function () {
  async function deployStylusSimFixture() {
    const [deployer, ra, holder] = await ethers.getSigners();

    const MockXDM = await ethers.getContractFactory("MockCrossDomainMessenger");
    const messenger = await MockXDM.connect(deployer).deploy();
    await messenger.waitForDeployment();

    const Anchor = await ethers.getContractFactory("GTokenAnchor");
    const anchor = await Anchor.connect(deployer).deploy(await messenger.getAddress(), ethers.ZeroAddress);
    await anchor.waitForDeployment();

    const Verifier = await ethers.getContractFactory("MockBbsStylusNativeVerifier");
    const verifier = await Verifier.connect(deployer).deploy();
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

    return { deployer, holder, verifier, token, anchor };
  }

  function sampleClaims(expiry: bigint) {
    return {
      reTypeCode: 2,
      qtyKWh: 77n,
      readingTimestamp: 1_740_873_600, // 2025-03-24 00:00:00 UTC
      credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes("vc:owner789:2025-03-24:wind")),
      expiry,
    };
  }

  it("mints with approved digest and rejects tampering", async function () {
    const { deployer, holder, verifier, token, anchor } = await deployStylusSimFixture();

    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const claims = sampleClaims(expiry);
    const bbsProof = ethers.toUtf8Bytes("stylus-native-proof");

    const digest = await verifier.digest(holder.address, claims, bbsProof);
    await (await verifier.connect(deployer).setDigestApproval(digest, true)).wait();

    const claimId = await token.computeClaimId(claims);
    await expect(token.connect(holder).mintWithBbsProof(claims, bbsProof, "0x")).to.emit(token, "MintedBbs");
    expect(await anchor.isAnchored(claimId)).to.equal(true);

    const tampered = {
      ...claims,
      readingTimestamp: claims.readingTimestamp + 3600,
      credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes("vc:owner789:tampered")),
    };
    await expect(token.connect(holder).mintWithBbsProof(tampered, bbsProof, "0x")).to.be.revertedWithCustomError(
      token,
      "InvalidProof"
    );
  });

  it("parity: same claim yields same claimId and amount across SNARK + Stylus sim paths", async function () {
    const [deployer, ra, issuer, holder] = await ethers.getSigners();

    const claims = {
      reTypeCode: 1,
      qtyKWh: 123n,
      readingTimestamp: 1_740_873_600,
      credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes("vc:parity:2025-03-24")),
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const bbsProof = ethers.toUtf8Bytes("parity-bbs-proof");

    // --- SNARK-wrapped mock path ---
    const Messenger = await ethers.getContractFactory("MockCrossDomainMessenger");
    const messengerA = await Messenger.connect(deployer).deploy();
    await messengerA.waitForDeployment();
    const Anchor = await ethers.getContractFactory("GTokenAnchor");
    const anchorA = await Anchor.connect(deployer).deploy(await messengerA.getAddress(), ethers.ZeroAddress);
    await anchorA.waitForDeployment();
    const SnarkVerifier = await ethers.getContractFactory("MockBbsSnarkVerifier");
    const snarkVerifier = await SnarkVerifier.connect(deployer).deploy(issuer.address);
    await snarkVerifier.waitForDeployment();
    const Token = await ethers.getContractFactory("GTokenL2BbsSnark");
    const tokenA = await Token.connect(deployer).deploy(
      "GreenToken",
      "GT",
      await snarkVerifier.getAddress(),
      await messengerA.getAddress(),
      await anchorA.getAddress(),
      ra.address
    );
    await tokenA.waitForDeployment();
    await (await anchorA.connect(deployer).setConfig(await messengerA.getAddress(), await tokenA.getAddress())).wait();

    const digestA = await snarkVerifier.digest(holder.address, claims, bbsProof);
    const sealA = await issuer.signMessage(ethers.getBytes(digestA));
    await (await tokenA.connect(holder).mintWithBbsProof(claims, bbsProof, sealA)).wait();
    const claimIdA = await tokenA.computeClaimId(claims);

    // --- Stylus-native sim path ---
    const messengerB = await Messenger.connect(deployer).deploy();
    await messengerB.waitForDeployment();
    const anchorB = await Anchor.connect(deployer).deploy(await messengerB.getAddress(), ethers.ZeroAddress);
    await anchorB.waitForDeployment();
    const StylusVerifier = await ethers.getContractFactory("MockBbsStylusNativeVerifier");
    const stylusVerifier = await StylusVerifier.connect(deployer).deploy();
    await stylusVerifier.waitForDeployment();
    const tokenB = await Token.connect(deployer).deploy(
      "GreenToken",
      "GT",
      await stylusVerifier.getAddress(),
      await messengerB.getAddress(),
      await anchorB.getAddress(),
      ra.address
    );
    await tokenB.waitForDeployment();
    await (await anchorB.connect(deployer).setConfig(await messengerB.getAddress(), await tokenB.getAddress())).wait();

    const digestB = await stylusVerifier.digest(holder.address, claims, bbsProof);
    await (await stylusVerifier.connect(deployer).setDigestApproval(digestB, true)).wait();
    await (await tokenB.connect(holder).mintWithBbsProof(claims, bbsProof, "0x")).wait();
    const claimIdB = await tokenB.computeClaimId(claims);

    expect(claimIdA).to.equal(claimIdB);
    expect(await tokenA.balanceOf(holder.address)).to.equal(claims.qtyKWh);
    expect(await tokenB.balanceOf(holder.address)).to.equal(claims.qtyKWh);
  });
});
