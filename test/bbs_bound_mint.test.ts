import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Log } from "ethers";

import {
  chainId,
  deployBoundLedger,
  deployVerifier,
  generateIssuerKeys,
  installMockArbSys,
  isolateChainState,
  issueDesignated,
  latestTimestamp,
  proveMint,
  sampleClaims,
} from "./helpers/bbsBound";

describe("GTokenL2BbsBoundArb — bound BBS minting with a real verifier", function () {
  isolateChainState();

  async function setup() {
    const [deployer, holder, relayer] = await ethers.getSigners();
    const arbSys = await installMockArbSys();
    const keys = await generateIssuerKeys();
    const verifier = await deployVerifier(keys);
    const { token, anchor, outbox } = await deployBoundLedger(await verifier.getAddress());
    const ledger = { chainId: await chainId(), address: await token.getAddress() };
    const deadline = (await latestTimestamp()) + 3600n;
    return { deployer, holder, relayer, arbSys, keys, verifier, token, anchor, outbox, ledger, deadline };
  }

  it("mints to the bound recipient and anchors the claim on L1", async function () {
    const { holder, arbSys, keys, token, anchor, outbox, ledger, deadline } = await setup();
    const credential = await issueDesignated(keys, ledger, await sampleClaims());
    const { claims, proof } = await proveMint({ keys, credential, token: ledger.address, recipient: holder.address, deadline });

    const claimId = await token.computeClaimId(claims);
    const tx = token.connect(holder).mintBound(holder.address, claims, deadline, proof);
    await expect(tx)
      .to.emit(token, "BoundMint")
      .withArgs(holder.address, claims.serial, claimId, holder.address, claims.reTypeCode, claims.qtyKWh, claims.readingTimestamp)
      .and.to.emit(token, "L2ToL1Message");

    expect(await token.balanceOf(holder.address)).to.equal(claims.qtyKWh);
    expect(await token.isNullifierUsed(claims.serial)).to.equal(true);

    // Replay the recorded L2->L1 message through the outbox mock into the L1 anchor.
    const receipt = await (await tx).wait();
    const arbSysAddress = (await arbSys.getAddress()).toLowerCase();
    const sent = receipt!.logs
      .filter((log: Log) => log.address.toLowerCase() === arbSysAddress)
      .map((log: Log) => arbSys.interface.parseLog(log)!)[0];
    expect(sent.args.sender).to.equal(ledger.address);
    expect(sent.args.destination).to.equal(await anchor.getAddress());
    await expect(outbox.execute(await anchor.getAddress(), sent.args.data, ledger.address)).to.emit(anchor, "MintAnchored");
    const info = await anchor.anchorInfo(claimId);
    expect(info.to).to.equal(holder.address);
    expect(info.gtAmount).to.equal(claims.qtyKWh);
  });

  it("lets a relayer submit for a fresh, unfunded pseudonym address", async function () {
    const { relayer, keys, token, ledger, deadline } = await setup();
    const pseudonym = ethers.Wallet.createRandom().address;
    expect(await ethers.provider.getBalance(pseudonym)).to.equal(0n);

    const credential = await issueDesignated(keys, ledger, await sampleClaims());
    const { claims, proof } = await proveMint({ keys, credential, token: ledger.address, recipient: pseudonym, deadline });

    await token.connect(relayer).mintBound(pseudonym, claims, deadline, proof);
    expect(await token.balanceOf(pseudonym)).to.equal(claims.qtyKWh);
    expect(await token.balanceOf(relayer.address)).to.equal(0n);
  });

  it("rejects a reused nullifier", async function () {
    const { holder, keys, token, ledger, deadline } = await setup();
    const credential = await issueDesignated(keys, ledger, await sampleClaims());
    const first = await proveMint({ keys, credential, token: ledger.address, recipient: holder.address, deadline });
    await token.mintBound(holder.address, first.claims, deadline, first.proof);

    // A fresh proof from the same credential still carries the same serial.
    const second = await proveMint({ keys, credential, token: ledger.address, recipient: holder.address, deadline });
    await expect(token.mintBound(holder.address, second.claims, deadline, second.proof))
      .to.be.revertedWithCustomError(token, "NullifierAlreadyUsed")
      .withArgs(first.claims.serial);
  });

  it("rejects altered claims, recipient or deadline", async function () {
    const { holder, relayer, keys, token, ledger, deadline } = await setup();
    const credential = await issueDesignated(keys, ledger, await sampleClaims());
    const { claims, proof } = await proveMint({ keys, credential, token: ledger.address, recipient: holder.address, deadline });

    await expect(token.mintBound(holder.address, { ...claims, qtyKWh: 1000n }, deadline, proof)).to.be.revertedWithCustomError(
      token,
      "InvalidProof"
    );
    await expect(token.mintBound(holder.address, { ...claims, reTypeCode: 2 }, deadline, proof)).to.be.revertedWithCustomError(
      token,
      "InvalidProof"
    );
    await expect(token.mintBound(relayer.address, claims, deadline, proof)).to.be.revertedWithCustomError(token, "InvalidProof");
    await expect(token.mintBound(holder.address, claims, deadline + 1n, proof)).to.be.revertedWithCustomError(
      token,
      "InvalidProof"
    );
    await expect(token.mintBound(ethers.ZeroAddress, claims, deadline, proof)).to.be.revertedWithCustomError(
      token,
      "ZeroRecipient"
    );
  });

  it("enforces the proof deadline and the credential expiry", async function () {
    const { holder, keys, token, ledger } = await setup();
    const now = await latestTimestamp();

    const credential = await issueDesignated(keys, ledger, await sampleClaims({ expiry: now + 7200n }));
    const shortDeadline = now + 60n;
    const bound = await proveMint({ keys, credential, token: ledger.address, recipient: holder.address, deadline: shortDeadline });

    await network.provider.send("evm_increaseTime", [120]);
    await network.provider.send("evm_mine");
    await expect(token.mintBound(holder.address, bound.claims, shortDeadline, bound.proof)).to.be.revertedWithCustomError(
      token,
      "DeadlinePassed"
    );

    const lateDeadline = now + 86_400n;
    const late = await proveMint({ keys, credential, token: ledger.address, recipient: holder.address, deadline: lateDeadline });
    await network.provider.send("evm_increaseTime", [7200]);
    await network.provider.send("evm_mine");
    await expect(token.mintBound(holder.address, late.claims, lateDeadline, late.proof)).to.be.revertedWithCustomError(
      token,
      "Expired"
    );
  });
});
