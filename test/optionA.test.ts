import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Signer } from "ethers";

import { issueDesignated, isolateChainState, latestTimestamp, chainId } from "./helpers/bbsBound";
import {
  ARB_KEY,
  BRIDGE,
  MODE,
  OP_KEY,
  aliasOf,
  arbFee,
  deployOptionA,
  installAliasExecutor,
  issueOptionA,
  opFee,
  proveA1,
  proveA2,
  sentMessageId,
} from "./helpers/optionA";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Address } = require("@arbitrum/sdk");

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("Option A — shared registry on Ethereum, mint on the chosen L2", function () {
  isolateChainState();

  let ctx: Awaited<ReturnType<typeof deployOptionA>>;
  let producer: Signer, recipient: Signer, attacker: Signer, ra: Signer;
  let recipientAddr: string;

  beforeEach(async function () {
    const [, s1, s2, s3, s4] = await ethers.getSigners();
    [producer, recipient, attacker, ra] = [s1, s2, s3, s4];
    recipientAddr = await recipient.getAddress();
    ctx = await deployOptionA(await ra.getAddress());
  });

  async function deadline() {
    return (await latestTimestamp()) + 3600n;
  }

  /** A1 end to end up to the bridge: returns the message id and the claims. */
  async function a1(chainKey: number, credential?: any, gasLimit?: bigint) {
    credential = credential ?? (await issueOptionA(ctx.keys, ctx.registry));
    const d = await deadline();
    const proof = await proveA1({ keys: ctx.keys, credential, registry: ctx.registry, chainKey, recipient: recipientAddr, deadline: d });
    const { fee, value } = chainKey === ARB_KEY ? arbFee(gasLimit) : opFee(gasLimit);
    const tx = await ctx.registry.connect(producer).registerAndMint(chainKey, recipientAddr, credential.claims, d, proof, fee, { value });
    return { id: await sentMessageId(ctx.registry, tx), credential };
  }

  /** A2 commit + reveal: returns the message id. */
  async function a2Register(chainKey: number, serial: string, who: Signer = producer) {
    const salt = ethers.id("salt-" + serial);
    await ctx.registry.connect(who).commit(await ctx.registry.commitmentOf(serial, chainKey, await who.getAddress(), salt));
    await increase(61);
    const { fee, value } = chainKey === ARB_KEY ? arbFee() : opFee();
    const tx = await ctx.registry.connect(who).reveal(serial, chainKey, salt, fee, { value });
    return sentMessageId(ctx.registry, tx);
  }

  describe("alias", function () {
    it("our alias matches the Arbitrum SDK and round-trips, including wrap-around", async function () {
      for (const a of [await ctx.registry.getAddress(), "0xffffffffffffffffffffffffffffffffffffffff", ethers.ZeroAddress]) {
        expect(aliasOf(a)).to.equal(ethers.getAddress(new Address(a).applyAlias().value));
      }
    });
  });

  describe("happy paths", function () {
    it("A1 → Arbitrum: one L1 transaction verifies the proof; the retryable ticket mints on L2", async function () {
      const { id, credential } = await a1(ARB_KEY);
      expect(await ctx.tokenArb.balanceOf(recipientAddr)).to.equal(0n); // nothing on L2 until delivery

      const reg = await ctx.registry.registrations(credential.claims.serial);
      expect(reg.chainKey).to.equal(ARB_KEY);
      expect(reg.mode).to.equal(MODE.VerifyOnL1);

      await increase(600); // ~10 minutes on Arbitrum
      await expect(ctx.inbox.autoRedeem(id)).to.emit(ctx.tokenArb, "RegistryMint").withArgs(credential.claims.serial, recipientAddr, 100n);
      expect(await ctx.tokenArb.balanceOf(recipientAddr)).to.equal(100n);
    });

    it("A1 → OP Stack: the deposit is relayed by the L2 messenger and mints", async function () {
      const { id, credential } = await a1(OP_KEY);
      expect(await ctx.tokenOp.balanceOf(recipientAddr)).to.equal(0n);
      await increase(120); // ~1-3 minutes on OP Stack
      await expect(ctx.opMessenger.relayMessage(id, 200_000n)).to.emit(ctx.tokenOp, "RegistryMint").withArgs(credential.claims.serial, recipientAddr, 100n);
      expect(await ctx.tokenOp.balanceOf(recipientAddr)).to.equal(100n);
    });

    for (const [name, key] of [["Arbitrum", ARB_KEY], ["OP Stack", OP_KEY]] as const) {
      it(`A2 → ${name}: commit, reveal, authorize on L2, then mint there with the full proof`, async function () {
        const credential = await issueOptionA(ctx.keys, ctx.registry);
        const serial = credential.claims.serial;
        const token = key === ARB_KEY ? ctx.tokenArb : ctx.tokenOp;
        const d = await deadline();
        const proof = await proveA2({ keys: ctx.keys, credential, token, recipient: recipientAddr, deadline: d });

        await expect(token.mintBound(recipientAddr, credential.claims, d, proof)).to.be.revertedWithCustomError(token, "NotAuthorized");

        const id = await a2Register(key, serial);
        if (key === ARB_KEY) await ctx.inbox.autoRedeem(id);
        else await ctx.opMessenger.relayMessage(id, 200_000n);
        expect(await token.authorized(serial)).to.equal(true);

        await token.connect(attacker).mintBound(recipientAddr, credential.claims, d, proof); // anyone may submit
        expect(await token.balanceOf(recipientAddr)).to.equal(100n);
        await expect(token.mintBound(recipientAddr, credential.claims, d, proof)).to.be.revertedWithCustomError(token, "AlreadyMinted");
      });
    }
  });

  describe("one issuance across chains", function () {
    it("a serial registered for one chain cannot be registered again, by either variant", async function () {
      const { credential } = await a1(ARB_KEY);
      const serial = credential.claims.serial;

      const d = await deadline();
      const proofOp = await proveA1({ keys: ctx.keys, credential, registry: ctx.registry, chainKey: OP_KEY, recipient: recipientAddr, deadline: d });
      const { fee } = opFee();
      await expect(ctx.registry.registerAndMint(OP_KEY, recipientAddr, credential.claims, d, proofOp, fee))
        .to.be.revertedWithCustomError(ctx.registry, "AlreadyRegistered")
        .withArgs(serial, ARB_KEY);

      const salt = ethers.id("x");
      await ctx.registry.connect(producer).commit(await ctx.registry.commitmentOf(serial, OP_KEY, await producer.getAddress(), salt));
      await increase(61);
      await expect(ctx.registry.connect(producer).reveal(serial, OP_KEY, salt, fee)).to.be.revertedWithCustomError(ctx.registry, "AlreadyRegistered");
    });

    it("a serial authorized on one chain cannot be minted on the other", async function () {
      const credential = await issueOptionA(ctx.keys, ctx.registry);
      const id = await a2Register(ARB_KEY, credential.claims.serial);
      await ctx.inbox.autoRedeem(id);

      const d = await deadline();
      const proofOp = await proveA2({ keys: ctx.keys, credential, token: ctx.tokenOp, recipient: recipientAddr, deadline: d });
      await expect(ctx.tokenOp.mintBound(recipientAddr, credential.claims, d, proofOp)).to.be.revertedWithCustomError(ctx.tokenOp, "NotAuthorized");
    });
  });

  describe("proof binding", function () {
    it("an A1 proof made for one chain or recipient fails for another", async function () {
      const credential = await issueOptionA(ctx.keys, ctx.registry);
      const d = await deadline();
      const proofArb = await proveA1({ keys: ctx.keys, credential, registry: ctx.registry, chainKey: ARB_KEY, recipient: recipientAddr, deadline: d });
      const { fee } = opFee();
      await expect(ctx.registry.registerAndMint(OP_KEY, recipientAddr, credential.claims, d, proofArb, fee)).to.be.revertedWithCustomError(ctx.registry, "InvalidProof");
      const arb = arbFee();
      await expect(
        ctx.registry.registerAndMint(ARB_KEY, await attacker.getAddress(), credential.claims, d, proofArb, arb.fee, { value: arb.value })
      ).to.be.revertedWithCustomError(ctx.registry, "InvalidProof");
    });

    it("a credential designated for one ledger (not for the registry) is rejected", async function () {
      const credential = await issueDesignated(ctx.keys, { chainId: await chainId(), address: await ctx.tokenArb.getAddress() }, (await issueOptionA(ctx.keys, ctx.registry)).claims);
      const d = await deadline();
      const proof = await proveA1({ keys: ctx.keys, credential, registry: ctx.registry, chainKey: ARB_KEY, recipient: recipientAddr, deadline: d });
      const { fee, value } = arbFee();
      await expect(ctx.registry.registerAndMint(ARB_KEY, recipientAddr, credential.claims, d, proof, fee, { value })).to.be.revertedWithCustomError(
        ctx.registry,
        "InvalidProof"
      );
    });
  });

  describe("only the registry can reach the L2 tokens", function () {
    it("Arbitrum: a direct call, or a retryable from any other L1 account, is refused", async function () {
      const serial = ethers.id("forged");
      await expect(ctx.tokenArb.connect(attacker).authorizeSerial(serial)).to.be.revertedWithCustomError(ctx.tokenArb, "NotFromRegistry");

      const payload = ctx.tokenArb.interface.encodeFunctionData("authorizeSerial", [serial]);
      const { fee, value } = arbFee();
      await installAliasExecutor(await ctx.inbox.getAddress(), await attacker.getAddress());
      await ctx.inbox
        .connect(attacker)
        .createRetryableTicket(await ctx.tokenArb.getAddress(), 0, fee.maxSubmissionCost, await attacker.getAddress(), await attacker.getAddress(), fee.gasLimit, fee.maxFeePerGas, payload, { value });
      const id = (await ctx.inbox.ticketCount()) - 1n;
      await expect(ctx.inbox.autoRedeem(id)).to.emit(ctx.inbox, "RedeemAttempt").withArgs(id, false, true);
      expect(await ctx.tokenArb.authorized(serial)).to.equal(false);
    });

    it("OP Stack: a direct call, or a message from any other L1 sender, is refused", async function () {
      const serial = ethers.id("forged");
      await expect(ctx.tokenOp.connect(attacker).authorizeSerial(serial)).to.be.revertedWithCustomError(ctx.tokenOp, "NotFromRegistry");

      const payload = ctx.tokenOp.interface.encodeFunctionData("authorizeSerial", [serial]);
      await ctx.opMessenger.connect(attacker).sendMessage(await ctx.tokenOp.getAddress(), payload, 200_000);
      const nonce = (await ctx.opMessenger.messageCount()) - 1n;
      await expect(ctx.opMessenger.relayMessage(nonce, 200_000n)).to.emit(ctx.opMessenger, "FailedRelayedMessage").withArgs(nonce);
      expect(await ctx.tokenOp.authorized(serial)).to.equal(false);
    });
  });

  describe("when a message does not arrive", function () {
    it("Arbitrum: the automatic redeem fails (too little gas), then anyone redeems it manually", async function () {
      const { id } = await a1(ARB_KEY, undefined, 30_000n);
      await expect(ctx.inbox.autoRedeem(id)).to.emit(ctx.inbox, "RedeemAttempt").withArgs(id, false, true);
      expect(await ctx.tokenArb.balanceOf(recipientAddr)).to.equal(0n);

      await increase(3 * 24 * 3600); // within the 7-day lifetime
      await ctx.inbox.connect(attacker).redeem(id, 300_000n);
      expect(await ctx.tokenArb.balanceOf(recipientAddr)).to.equal(100n);
      await expect(ctx.inbox.redeem(id, 300_000n)).to.be.revertedWithCustomError(ctx.inbox, "AlreadyRedeemed");
    });

    it("Arbitrum: after 7 days the ticket expires; resend delivers it, and a second resend cannot mint twice", async function () {
      const { id, credential } = await a1(ARB_KEY, undefined, 30_000n);
      await ctx.inbox.autoRedeem(id);
      await increase(7 * 24 * 3600 + 1);
      await expect(ctx.inbox.redeem(id, 300_000n)).to.be.revertedWithCustomError(ctx.inbox, "TicketExpired");

      const { fee, value } = arbFee();
      const tx = await ctx.registry.connect(attacker).resend(credential.claims.serial, fee, { value }); // anyone may resend
      await ctx.inbox.autoRedeem(await sentMessageId(ctx.registry, tx));
      expect(await ctx.tokenArb.balanceOf(recipientAddr)).to.equal(100n);

      const tx2 = await ctx.registry.resend(credential.claims.serial, fee, { value });
      await expect(ctx.inbox.autoRedeem(await sentMessageId(ctx.registry, tx2))).to.emit(ctx.tokenArb, "DuplicateIgnored");
      expect(await ctx.tokenArb.balanceOf(recipientAddr)).to.equal(100n);
    });

    it("OP Stack: a failed relay is recorded and can be replayed later", async function () {
      const { id } = await a1(OP_KEY, undefined, 25_000n);
      await expect(ctx.opMessenger.relayMessage(id, 25_000n)).to.emit(ctx.opMessenger, "FailedRelayedMessage").withArgs(id);
      expect(await ctx.tokenOp.balanceOf(recipientAddr)).to.equal(0n);
      await ctx.opMessenger.connect(attacker).relayMessage(id, 200_000n);
      expect(await ctx.tokenOp.balanceOf(recipientAddr)).to.equal(100n);
      await expect(ctx.opMessenger.relayMessage(id, 200_000n)).to.be.revertedWith("already relayed");
    });

    it("resend needs an existing registration", async function () {
      const { fee, value } = arbFee();
      await expect(ctx.registry.resend(ethers.id("unknown"), fee, { value })).to.be.revertedWithCustomError(ctx.registry, "NotRegistered");
    });
  });

  describe("commit-reveal (A2)", function () {
    it("a reveal needs an old enough commitment from the same account", async function () {
      const serial = ethers.id("serial-a2");
      const salt = ethers.id("salt");
      const { fee } = opFee();
      await ctx.registry.connect(producer).commit(await ctx.registry.commitmentOf(serial, OP_KEY, await producer.getAddress(), salt));
      await expect(ctx.registry.connect(producer).reveal(serial, OP_KEY, salt, fee)).to.be.revertedWithCustomError(ctx.registry, "CommitmentTooNew");
      await increase(61);
      await expect(ctx.registry.connect(producer).reveal(serial, OP_KEY, ethers.id("wrong"), fee)).to.be.revertedWithCustomError(ctx.registry, "CommitmentMissing");
      await expect(ctx.registry.connect(attacker).reveal(serial, OP_KEY, salt, fee)).to.be.revertedWithCustomError(ctx.registry, "CommitmentMissing");
    });

    it("someone who sees the serial only at reveal time cannot register it for another chain first", async function () {
      const serial = ethers.id("serial-front-run");
      const salt = ethers.id("salt");
      await ctx.registry.connect(producer).commit(await ctx.registry.commitmentOf(serial, ARB_KEY, await producer.getAddress(), salt));
      await increase(61);

      // The attacker learns the serial from the pending reveal and commits for OP right away...
      const evil = ethers.id("evil");
      await ctx.registry.connect(attacker).commit(await ctx.registry.commitmentOf(serial, OP_KEY, await attacker.getAddress(), evil));
      const { fee } = opFee();
      await expect(ctx.registry.connect(attacker).reveal(serial, OP_KEY, evil, fee)).to.be.revertedWithCustomError(ctx.registry, "CommitmentTooNew");

      // ...so the producer's reveal lands first, and later the attacker's is refused.
      const arb = arbFee();
      await ctx.registry.connect(producer).reveal(serial, ARB_KEY, salt, arb.fee, { value: arb.value });
      await increase(61);
      await expect(ctx.registry.connect(attacker).reveal(serial, OP_KEY, evil, fee)).to.be.revertedWithCustomError(ctx.registry, "AlreadyRegistered");
    });
  });

  describe("L1-side checks", function () {
    it("routes are set once; unknown chains, bad recipients, wrong fees are refused", async function () {
      await expect(ctx.registry.setRoute(ARB_KEY, BRIDGE.Arbitrum, ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ctx.registry,
        "ChainAlreadyConfigured"
      );

      const credential = await issueOptionA(ctx.keys, ctx.registry);
      const d = await deadline();
      const proof = await proveA1({ keys: ctx.keys, credential, registry: ctx.registry, chainKey: OP_KEY, recipient: recipientAddr, deadline: d });
      const { fee } = opFee();
      await expect(ctx.registry.registerAndMint(7, recipientAddr, credential.claims, d, proof, fee)).to.be.revertedWithCustomError(ctx.registry, "UnknownChain");
      await expect(ctx.registry.registerAndMint(OP_KEY, await ctx.tokenOp.getAddress(), credential.claims, d, proof, fee)).to.be.revertedWithCustomError(
        ctx.registry,
        "BadRecipient"
      );
      await expect(ctx.registry.registerAndMint(OP_KEY, recipientAddr, credential.claims, d, proof, fee, { value: 1n })).to.be.revertedWithCustomError(
        ctx.registry,
        "UnexpectedValue"
      );

      const arbProof = await proveA1({ keys: ctx.keys, credential, registry: ctx.registry, chainKey: ARB_KEY, recipient: recipientAddr, deadline: d });
      const arb = arbFee();
      await expect(
        ctx.registry.registerAndMint(ARB_KEY, recipientAddr, credential.claims, d, arbProof, arb.fee, { value: arb.value - 1n })
      ).to.be.revertedWithCustomError(ctx.inbox, "InsufficientDeposit");
    });
  });
});
