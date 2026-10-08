import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Signer } from "ethers";

import {
  GTokenAnchorArb__factory,
  GTokenL2BbsBoundRetirableArb__factory,
  MockArbBridge__factory,
  MockArbOutbox__factory,
  MockRetirableToken,
  MockRetirableToken__factory,
} from "../typechain-types";

import {
  chainId,
  deployVerifier,
  generateIssuerKeys,
  installMockArbSys,
  isolateChainState,
  issueDesignated,
  latestTimestamp,
  proveMint,
  sampleClaims,
} from "./helpers/bbsBound";

const RETIRED = 1n;
const RECOVERED = 2n;
const FINALIZED = 3n;

const RECOVER_TYPES = {
  Recover: [
    { name: "retirementId", type: "uint256" },
    { name: "to", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};
const FINALIZE_TYPES = {
  Finalize: [
    { name: "retirementId", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function domainOf(token: { getAddress(): Promise<string> }, name: string) {
  return { name, version: "1", chainId: await chainId(), verifyingContract: await token.getAddress() };
}

/** Commitment to the beneficiary: only the hash goes on-chain; the holder keeps the name and salt. */
function beneficiaryCommitment(name: string, salt: string) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [name, salt]));
}

describe("GTokenRetirable — reversible (2,2) retirement", function () {
  isolateChainState();

  let token: MockRetirableToken;
  let ra: Signer, holder: Signer, other: Signer, relayer: Signer;
  let domain: Awaited<ReturnType<typeof domainOf>>;
  const commitment = beneficiaryCommitment("Acme Corp", ethers.id("salt-1"));

  async function retire(amount = 100n) {
    const tx = await token.connect(holder).retire(amount, commitment);
    await tx.wait();
    return await token.retirementCount();
  }

  async function recoverSigs(id: bigint, to: string, deadline: bigint, holderSigner = holder, raSigner = ra) {
    const value = { retirementId: id, to, deadline };
    return {
      ra: await raSigner.getAddress(),
      holderSig: await holderSigner.signTypedData(domain, RECOVER_TYPES, value),
      raSig: await raSigner.signTypedData(domain, RECOVER_TYPES, value),
    };
  }

  async function finalizeSigs(id: bigint, deadline: bigint) {
    const value = { retirementId: id, deadline };
    return {
      ra: await ra.getAddress(),
      holderSig: await holder.signTypedData(domain, FINALIZE_TYPES, value),
      raSig: await ra.signTypedData(domain, FINALIZE_TYPES, value),
    };
  }

  beforeEach(async function () {
    const [admin, s1, s2, s3, s4] = await ethers.getSigners();
    [ra, holder, other, relayer] = [s1, s2, s3, s4];
    token = await new MockRetirableToken__factory(admin).deploy(await ra.getAddress());
    await token.mint(await holder.getAddress(), 1000n);
    domain = await domainOf(token, "Retirable Test");
  });

  it("retire locks the tokens in escrow and records a receipt", async function () {
    await expect(token.connect(holder).retire(100n, commitment))
      .to.emit(token, "Retired")
      .withArgs(1n, await holder.getAddress(), 100n, commitment);

    const r = await token.retirement(1n);
    expect(r.holder).to.equal(await holder.getAddress());
    expect(r.amount).to.equal(100n);
    expect(r.beneficiaryCommitment).to.equal(commitment);
    expect(r.status).to.equal(RETIRED);

    expect(await token.balanceOf(await holder.getAddress())).to.equal(900n);
    expect(await token.balanceOf(await token.getAddress())).to.equal(100n);
    expect(await token.escrowed()).to.equal(100n);
    expect(await token.totalSupply()).to.equal(1000n);
    expect(await token.circulatingSupply()).to.equal(900n);
  });

  it("recover releases the tokens when the holder and the RA both sign (any relayer submits)", async function () {
    const id = await retire();
    const deadline = (await latestTimestamp()) + 3600n;
    const to = await other.getAddress();
    const sigs = await recoverSigs(id, to, deadline);

    await expect(token.connect(relayer).recover(id, to, deadline, sigs))
      .to.emit(token, "Recovered")
      .withArgs(id, to, 100n, await ra.getAddress());

    expect((await token.retirement(id)).status).to.equal(RECOVERED);
    expect(await token.balanceOf(to)).to.equal(100n);
    expect(await token.escrowed()).to.equal(0n);
    expect(await token.circulatingSupply()).to.equal(1000n);
  });

  it("finalize burns the tokens for good when both sign", async function () {
    const id = await retire();
    const deadline = (await latestTimestamp()) + 3600n;

    await expect(token.connect(relayer).finalize(id, deadline, await finalizeSigs(id, deadline)))
      .to.emit(token, "Finalized")
      .withArgs(id, 100n, await ra.getAddress());

    expect((await token.retirement(id)).status).to.equal(FINALIZED);
    expect(await token.totalSupply()).to.equal(900n);
    expect(await token.escrowed()).to.equal(0n);
    expect(await token.balanceOf(await token.getAddress())).to.equal(0n);
  });

  it("a retirement leaves escrow only once: no replay, no finalize after recover, no recover after finalize", async function () {
    const deadline = (await latestTimestamp()) + 3600n;
    const to = await other.getAddress();

    const a = await retire();
    const sigsA = await recoverSigs(a, to, deadline);
    await token.recover(a, to, deadline, sigsA);
    await expect(token.recover(a, to, deadline, sigsA)).to.be.revertedWithCustomError(token, "NotRetired");
    await expect(token.finalize(a, deadline, await finalizeSigs(a, deadline))).to.be.revertedWithCustomError(
      token,
      "NotRetired"
    );

    const b = await retire();
    await token.finalize(b, deadline, await finalizeSigs(b, deadline));
    await expect(token.recover(b, to, deadline, await recoverSigs(b, to, deadline))).to.be.revertedWithCustomError(
      token,
      "NotRetired"
    );
  });

  it("one party alone cannot release: missing, wrong or swapped signatures fail", async function () {
    const id = await retire();
    const deadline = (await latestTimestamp()) + 3600n;
    const to = await other.getAddress();
    const good = await recoverSigs(id, to, deadline);

    // RA signature replaced by the holder's own signature, with the holder named as RA.
    await expect(
      token.recover(id, to, deadline, { ra: await holder.getAddress(), holderSig: good.holderSig, raSig: good.holderSig })
    ).to.be.revertedWithCustomError(token, "NotRA");

    // Holder signature missing (empty).
    await expect(token.recover(id, to, deadline, { ...good, holderSig: "0x" })).to.be.revertedWithCustomError(
      token,
      "BadHolderSignature"
    );

    // RA signature made by someone without the RA role.
    const fakeRa = await recoverSigs(id, to, deadline, holder, other);
    await expect(token.recover(id, to, deadline, { ...good, raSig: fakeRa.raSig })).to.be.revertedWithCustomError(
      token,
      "BadRASignature"
    );

    // Holder signed for a different destination than the one submitted.
    const otherDest = await recoverSigs(id, await relayer.getAddress(), deadline);
    await expect(token.recover(id, to, deadline, otherDest)).to.be.revertedWithCustomError(token, "BadHolderSignature");

    // A recover signature cannot be used to finalize.
    await expect(token.finalize(id, deadline, good)).to.be.revertedWithCustomError(token, "BadHolderSignature");
  });

  it("the RA cannot sign as both parties, even if it retired the tokens itself", async function () {
    await token.mint(await ra.getAddress(), 50n);
    await token.connect(ra).retire(50n, commitment);
    const id = await token.retirementCount();
    const deadline = (await latestTimestamp()) + 3600n;
    const sigs = await recoverSigs(id, await other.getAddress(), deadline, ra, ra);
    await expect(token.recover(id, await other.getAddress(), deadline, sigs)).to.be.revertedWithCustomError(
      token,
      "SameSigner"
    );
  });

  it("expired signatures are rejected", async function () {
    const id = await retire();
    const deadline = (await latestTimestamp()) + 60n;
    const sigs = await recoverSigs(id, await other.getAddress(), deadline);
    await network.provider.send("evm_increaseTime", [120]);
    await network.provider.send("evm_mine");
    await expect(token.recover(id, await other.getAddress(), deadline, sigs)).to.be.revertedWithCustomError(
      token,
      "SignatureExpired"
    );
  });

  it("cannot retire zero or more than the balance, and nobody can pull escrow out directly", async function () {
    await expect(token.connect(holder).retire(0n, commitment)).to.be.revertedWithCustomError(token, "ZeroAmount");
    await expect(token.connect(holder).retire(1001n, commitment)).to.be.revertedWithCustomError(
      token,
      "ERC20InsufficientBalance"
    );

    await retire();
    await expect(
      token.connect(holder).transferFrom(await token.getAddress(), await holder.getAddress(), 100n)
    ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    expect(await token.escrowed()).to.equal(100n);
  });
});

describe("GTokenL2BbsBoundRetirableArb — mint from a real proof, then retire and recover", function () {
  isolateChainState();

  it("a minted token can be retired and recovered with both signatures", async function () {
    const [admin, ra, holder, other] = await ethers.getSigners();
    await installMockArbSys();
    const keys = await generateIssuerKeys();
    const verifier = await deployVerifier(keys);

    const outbox = await new MockArbOutbox__factory(admin).deploy();
    const bridge = await new MockArbBridge__factory(admin).deploy(await outbox.getAddress());
    const anchor = await new GTokenAnchorArb__factory(admin).deploy(await bridge.getAddress(), ethers.ZeroAddress);
    const token = await new GTokenL2BbsBoundRetirableArb__factory(admin).deploy(
      "Green Token",
      "GT",
      await verifier.getAddress(),
      await anchor.getAddress(),
      ethers.ZeroAddress,
      await ra.getAddress()
    );
    await anchor.setConfig(await token.getAddress());

    const ledger = { chainId: await chainId(), address: await token.getAddress() };
    const credential = await issueDesignated(keys, ledger, await sampleClaims());
    const deadline = (await latestTimestamp()) + 3600n;
    const { claims, proof } = await proveMint({
      keys,
      credential,
      token: ledger.address,
      recipient: await holder.getAddress(),
      deadline,
    });
    await token.mintBound(await holder.getAddress(), claims, deadline, proof);
    expect(await token.balanceOf(await holder.getAddress())).to.equal(100n);

    const commitment = beneficiaryCommitment("Acme Corp", ethers.id("salt-2"));
    await token.connect(holder).retire(60n, commitment);
    expect(await token.circulatingSupply()).to.equal(40n);

    const domain = await domainOf(token, "Green Token");
    const value = { retirementId: 1n, to: await other.getAddress(), deadline };
    const sigs = {
      ra: await ra.getAddress(),
      holderSig: await holder.signTypedData(domain, RECOVER_TYPES, value),
      raSig: await ra.signTypedData(domain, RECOVER_TYPES, value),
    };
    await token.recover(1n, await other.getAddress(), deadline, sigs);
    expect(await token.balanceOf(await other.getAddress())).to.equal(60n);
    expect(await token.circulatingSupply()).to.equal(100n);
  });
});
