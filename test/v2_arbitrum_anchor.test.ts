import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Arbitrum-style L2 -> L1 anchoring: this test validates the L1 side only.
 *
 * The goal is to demonstrate that the L1 anchor enforces:
 *  - calls MUST come from the active Outbox (via the Bridge)
 *  - the originating L2 sender (outbox.l2ToL1Sender()) MUST equal the configured L2 GToken
 */
describe("Arbitrum L2->L1 anchor (GTokenAnchorArb)", function () {
  it("accepts recordMint only from Outbox and only for authorized L2 sender", async function () {
    const [deployer, holder, attacker] = await ethers.getSigners();

    const MockArbOutbox = await ethers.getContractFactory("MockArbOutbox");
    const outbox = await MockArbOutbox.deploy();

    const MockArbBridge = await ethers.getContractFactory("MockArbBridge");
    const bridge = await MockArbBridge.deploy(await outbox.getAddress());

    const Anchor = await ethers.getContractFactory("GTokenAnchorArb");
    const anchor = await Anchor.deploy(await bridge.getAddress(), ethers.ZeroAddress);

    // Configure the authorized L2 sender (simulated)
    const l2GToken = deployer.address; // pick any address to represent L2 contract
    await anchor.setConfig(l2GToken);

    const dtHash = ethers.keccak256(ethers.toUtf8Bytes("dt-1"));
    const to = holder.address;
    const gtAmount = 100n;
    const epochIndex = 202540;
    const typeCode = 1;
    const qtyKWh = 100n;

    // 1) Direct call from an EOA must revert (not from outbox)
    await expect(
      anchor.connect(holder).recordMint(dtHash, to, gtAmount, epochIndex, typeCode, qtyKWh)
    ).to.be.revertedWithCustomError(anchor, "NotFromBridge");

    // 2) Call from Outbox but wrong originating L2 sender must revert
    const payload = anchor.interface.encodeFunctionData("recordMint", [
      dtHash,
      to,
      gtAmount,
      epochIndex,
      typeCode,
      qtyKWh,
    ]);

    await expect(
      outbox.execute(await anchor.getAddress(), payload, attacker.address)
    ).to.be.revertedWithCustomError(anchor, "NotFromAuthorizedL2Sender");

    // 3) Authorized sender succeeds
    await expect(outbox.execute(await anchor.getAddress(), payload, l2GToken))
      .to.emit(anchor, "MintAnchored")
      .withArgs(dtHash, to, gtAmount, epochIndex, typeCode, qtyKWh);

    // 4) Duplicate dtHash is rejected
    await expect(outbox.execute(await anchor.getAddress(), payload, l2GToken))
      .to.be.revertedWithCustomError(anchor, "AlreadyAnchored");
  });
});
