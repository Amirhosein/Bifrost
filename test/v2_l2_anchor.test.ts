import { expect } from "chai";
import { ethers } from "hardhat";

function bytes32(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

describe("V2 (L2-aware) mint + L1 anchor", function () {
  it("mints once, anchors dtHash on L1, and blocks duplicates", async function () {
    const [deployer, ga, ra, oracle, issuer, holder] = await ethers.getSigners();

    const MockXDM = await ethers.getContractFactory("MockCrossDomainMessenger");
    const messenger = await MockXDM.connect(deployer).deploy();
    await messenger.waitForDeployment();

    const Anchor = await ethers.getContractFactory("GTokenAnchor");
    const anchor = await Anchor.connect(deployer).deploy(await messenger.getAddress(), ethers.ZeroAddress);
    await anchor.waitForDeployment();

    const DemoVerifier = await ethers.getContractFactory("DemoIssuerVerifier");
    const verifier = await DemoVerifier.connect(deployer).deploy(issuer.address);
    await verifier.waitForDeployment();

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

    await (await anchor.connect(deployer).setConfig(await messenger.getAddress(), await gtoken.getAddress())).wait();

    // mint inputs
    const epochIndex = 202540;
    const typeCode = 1;
    const qtyKWh = 100n;
    const policyNonce = 0n;

    const hiddenCommitment = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "bytes32", "bytes32"], [bytes32("owner"), bytes32("meter"), bytes32("site")])
    );
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const dtHash = ethers.keccak256(
      ethers.solidityPacked(["uint64", "uint16", "uint256", "uint128"], [BigInt(epochIndex), BigInt(typeCode), qtyKWh, policyNonce])
    );

    const digest = await verifier.computeDigest(
      holder.address,
      dtHash,
      hiddenCommitment,
      epochIndex,
      typeCode,
      qtyKWh,
      policyNonce,
      expiry
    );

    const sig = await issuer.signMessage(ethers.getBytes(digest));

    await expect(
      gtoken.connect(holder).mintWithProof(epochIndex, typeCode, qtyKWh, policyNonce, hiddenCommitment, expiry, sig)
    )
      .to.emit(gtoken, "Minted")
      .withArgs(holder.address, dtHash, epochIndex, typeCode, qtyKWh, qtyKWh);

    expect(await gtoken.balanceOf(holder.address)).to.equal(qtyKWh);

    // anchored on L1
    expect(await anchor.isAnchored(dtHash)).to.equal(true);
    const info = await anchor.anchorInfo(dtHash);
    expect(info.to).to.equal(holder.address);
    expect(info.gtAmount).to.equal(qtyKWh);

    // duplicate mint should revert
    await expect(
      gtoken.connect(holder).mintWithProof(epochIndex, typeCode, qtyKWh, policyNonce, hiddenCommitment, expiry, sig)
    ).to.be.revertedWithCustomError(gtoken, "DuplicateDT");
  });

  it("L1 anchor rejects direct calls that do not come from messenger", async function () {
    const [deployer, , ra, , issuer, attacker] = await ethers.getSigners();

    const MockXDM = await ethers.getContractFactory("MockCrossDomainMessenger");
    const messenger = await MockXDM.connect(deployer).deploy();
    await messenger.waitForDeployment();

    const Anchor = await ethers.getContractFactory("GTokenAnchor");
    const anchor = await Anchor.connect(deployer).deploy(await messenger.getAddress(), attacker.address);
    await anchor.waitForDeployment();

    const dtHash = ethers.keccak256(ethers.toUtf8Bytes("dt"));

    await expect(
      anchor.connect(attacker).recordMint(dtHash, attacker.address, 1n, 1, 1, 1n)
    ).to.be.revertedWithCustomError(anchor, "NotFromMessenger");

    // If messenger calls it but xDomain sender != expected L2 sender, also rejected.
    const payload = anchor.interface.encodeFunctionData("recordMint", [dtHash, attacker.address, 1n, 1, 1, 1n]);

    await expect(messenger.connect(attacker).sendMessage(await anchor.getAddress(), payload, 1_000_000)).to.be.revertedWithCustomError(
      anchor,
      "NotFromAuthorizedL2Sender"
    );

    // Reconfigure expected L2 sender to attacker, now message succeeds
    await (await anchor.connect(deployer).setConfig(await messenger.getAddress(), attacker.address)).wait();
    await expect(messenger.connect(attacker).sendMessage(await anchor.getAddress(), payload, 1_000_000))
      .to.emit(anchor, "MintAnchored")
      .withArgs(dtHash, attacker.address, 1n, 1, 1, 1n);
  });
});
