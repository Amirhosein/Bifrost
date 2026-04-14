import { expect } from "chai";
import { ethers } from "hardhat";

describe("Private-side contracts (MetReg + DataVer)", function () {
  it("registers and verifies a meter", async function () {
    const [deployer, ga, ra] = await ethers.getSigners();

    const MetReg = await ethers.getContractFactory("MetReg");
    const metReg = await MetReg.connect(deployer).deploy(ga.address, ra.address);
    await metReg.waitForDeployment();

    const meterHash = ethers.keccak256(ethers.toUtf8Bytes("meter-123"));
    const cert = ethers.toUtf8Bytes("GA_CERT_BYTES");

    await expect(metReg.connect(ga).registerMeter(meterHash, cert, true)).to.emit(metReg, "MeterRegistered");
    expect(await metReg.isMeterActive(meterHash)).to.equal(true);

    expect(await metReg.connect(ra).verifyMeter(meterHash)).to.equal(true);

    await (await metReg.connect(ga).updateMeterStatus(meterHash, false)).wait();
    expect(await metReg.connect(ra).verifyMeter(meterHash)).to.equal(false);
  });

  it("records commitments, oracle verdicts, and anchors a VC hash", async function () {
    const [deployer, , ra, oracle, user] = await ethers.getSigners();

    const DataVer = await ethers.getContractFactory("DataVer");
    const dataVer = await DataVer.connect(deployer).deploy(ra.address, oracle.address);
    await dataVer.waitForDeployment();

    const readingHash = ethers.keccak256(ethers.toUtf8Bytes("reading"));
    await expect(dataVer.connect(user).commitReading(readingHash)).to.emit(dataVer, "ReadingCommitted");

    await expect(dataVer.connect(oracle).postVerdict(readingHash, true)).to.emit(dataVer, "OracleVerdictPosted");
    expect(await dataVer.hasValidVerdict(readingHash)).to.equal(true);

    const vcHash = ethers.keccak256(ethers.toUtf8Bytes("vc"));
    await expect(dataVer.connect(ra).anchorVC(vcHash, readingHash)).to.emit(dataVer, "VCAnchored");

    expect(await dataVer.isVCAnchored(vcHash)).to.equal(true);
    expect(await dataVer.vcToReading(vcHash)).to.equal(readingHash);
  });
});
