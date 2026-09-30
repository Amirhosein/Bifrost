import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BoundCredential, IssuerKeys, deriveProof, proofToSolidity } from "../scripts/lib/bbsBound";
import {
  GTokenBbsBoundBase,
  GTokenBbsBoundBase__factory,
  GTokenBbsPaperBaseline__factory,
  GTokenBbsPresentationBoundOnly__factory,
} from "../typechain-types";
import {
  chainId,
  deployBoundLedger,
  deployVerifier,
  generateIssuerKeys,
  installMockArbSys,
  isolateChainState,
  issueDesignated,
  issueUnbound,
  latestTimestamp,
  proveMint,
  sampleClaims,
} from "./helpers/bbsBound";

/**
 * Attack matrix: each attack runs against three ledgers that share one real BBS verifier.
 *   paper    — GTokenBbsPaperBaseline: the WTSC'25 token request (dedup on H(M_disclosed)).
 *   ph-only  — GTokenBbsPresentationBoundOnly: presentation-header binding alone (Majid's fix).
 *   hardened — GTokenL2BbsBoundArb: ph binding + designated-ledger header + nullifier.
 * The assertions pin each outcome, and the matrix is printed at the end.
 */

type Design = "paper" | "ph-only" | "hardened";
type Outcome = "EXPLOITED" | "blocked";

const PAPER_INDEXES = [3, 4, 5]; // REType, REQuantity, timestamp — the paper's disclosure policy
const matrix = new Map<string, Record<Design, Outcome>>();

function record(attack: string, design: Design, outcome: Outcome) {
  const row = matrix.get(attack) ?? ({} as Record<Design, Outcome>);
  row[design] = outcome;
  matrix.set(attack, row);
}

async function provePaper(keys: IssuerKeys, credential: BoundCredential, indexes = PAPER_INDEXES, nonce = "0x6e6f6e6365") {
  const proof = proofToSolidity(
    await deriveProof({
      publicKey: keys.publicKey,
      credential,
      presentationHeader: ethers.getBytes(nonce),
      disclosedIndexes: indexes,
    })
  );
  return { indexes, messages: indexes.map((i) => ethers.hexlify(credential.messages[i])), nonce, proof };
}

const TX = { gasLimit: 3_000_000n };
const LOW_TIP = { ...TX, maxFeePerGas: ethers.parseUnits("50", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("1", "gwei") };
const HIGH_TIP = { ...TX, maxFeePerGas: ethers.parseUnits("80", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("20", "gwei") };

/** Submits the honest tx, lets the attacker front-run it from the mempool, mines one block. */
async function frontRun(
  honest: () => Promise<{ hash: string }>,
  attack: (pending: { to: string; data: string }) => Promise<{ hash: string }>
) {
  await network.provider.send("evm_setAutomine", [false]);
  try {
    const honestTx = await honest();
    const pending = await ethers.provider.getTransaction(honestTx.hash); // attacker watches the mempool
    const attackTx = await attack({ to: pending!.to!, data: pending!.data });
    await network.provider.send("evm_mine");
    const honestRcpt = await ethers.provider.getTransactionReceipt(honestTx.hash);
    const attackRcpt = await ethers.provider.getTransactionReceipt(attackTx.hash);
    expect(attackRcpt!.index).to.be.lessThan(honestRcpt!.index, "attacker tx should be ordered first");
    return { honestOk: honestRcpt!.status === 1, attackOk: attackRcpt!.status === 1 };
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
}

describe("Attack matrix — paper protocol vs presentation binding vs hardened ledger", function () {
  isolateChainState();

  let keys: IssuerKeys;
  let verifierAddress: string;
  let holder: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let producer2: HardhatEthersSigner;

  before(async function () {
    [, holder, attacker, producer2] = await ethers.getSigners();
    await installMockArbSys();
    keys = await generateIssuerKeys();
    verifierAddress = await (await deployVerifier(keys)).getAddress();
  });

  // Both bound designs share GTokenBbsBoundBase's interface.
  const asBound = async (c: { getAddress(): Promise<string> }): Promise<GTokenBbsBoundBase> =>
    GTokenBbsBoundBase__factory.connect(await c.getAddress(), holder);
  const deployPaper = async () => new GTokenBbsPaperBaseline__factory(holder).deploy(verifierAddress);
  const deployPhOnly = async () => asBound(await new GTokenBbsPresentationBoundOnly__factory(holder).deploy(verifierAddress));
  const deployHardened = async () => asBound((await deployBoundLedger(verifierAddress)).token);

  const deadline = async () => (await latestTimestamp()) + 3600n;

  it("A1 mempool front-running: attacker steals the mint", async function () {
    // paper: copy the request verbatim; tokens go to msg.sender = attacker.
    {
      const token = await deployPaper();
      const r = await provePaper(keys, await issueUnbound(keys, await sampleClaims()));
      const { honestOk, attackOk } = await frontRun(
        () => token.connect(holder).requestGToken(r.indexes, r.messages, r.nonce, r.proof, LOW_TIP),
        (p) => attacker.sendTransaction({ ...p, ...HIGH_TIP })
      );
      expect(attackOk && !honestOk).to.equal(true);
      expect(await token.balanceOf(attacker.address)).to.equal(100n);
      record("A1 mempool front-running", "paper", "EXPLOITED");
    }

    // ph-only and hardened: the attacker must rewrite the recipient, which breaks the proof.
    for (const [design, deploy] of [
      ["ph-only", deployPhOnly],
      ["hardened", deployHardened],
    ] as const) {
      const token = await deploy();
      const addr = await token.getAddress();
      const credential =
        design === "hardened"
          ? await issueDesignated(keys, { chainId: await chainId(), address: addr }, await sampleClaims())
          : await issueUnbound(keys, await sampleClaims());
      const m = await proveMint({ keys, credential, token: addr, recipient: holder.address, deadline: await deadline() });

      const { honestOk, attackOk } = await frontRun(
        () => token.connect(holder).mintBound(holder.address, m.claims, m.deadline, m.proof, LOW_TIP),
        (p) => {
          const [, claims, dl, proof] = token.interface.parseTransaction({ data: p.data })!.args;
          const data = token.interface.encodeFunctionData("mintBound", [attacker.address, claims, dl, proof]);
          return attacker.sendTransaction({ to: p.to, data, ...HIGH_TIP });
        }
      );
      expect(honestOk && !attackOk).to.equal(true);
      expect(await token.balanceOf(attacker.address)).to.equal(0n);
      expect(await token.balanceOf(holder.address)).to.equal(100n);
      record("A1 mempool front-running", design, "blocked");
    }
  });

  it("A2 third party replays an observed proof on another ledger", async function () {
    // paper: the same request is valid on every deployment that trusts the issuer.
    {
      const [a, b] = [await deployPaper(), await deployPaper()];
      const r = await provePaper(keys, await issueUnbound(keys, await sampleClaims()));
      await a.connect(holder).requestGToken(r.indexes, r.messages, r.nonce, r.proof);
      await b.connect(attacker).requestGToken(r.indexes, r.messages, r.nonce, r.proof);
      expect(await b.balanceOf(attacker.address)).to.equal(100n);
      record("A2 third-party replay on another ledger", "paper", "EXPLOITED");
    }

    for (const [design, deploy] of [
      ["ph-only", deployPhOnly],
      ["hardened", deployHardened],
    ] as const) {
      const [a, b] = [await deploy(), await deploy()];
      const aAddr = await a.getAddress();
      const credential =
        design === "hardened"
          ? await issueDesignated(keys, { chainId: await chainId(), address: aAddr }, await sampleClaims())
          : await issueUnbound(keys, await sampleClaims());
      const m = await proveMint({ keys, credential, token: aAddr, recipient: holder.address, deadline: await deadline() });
      await a.connect(holder).mintBound(holder.address, m.claims, m.deadline, m.proof);
      await expect(b.connect(attacker).mintBound(holder.address, m.claims, m.deadline, m.proof)).to.be.revertedWithCustomError(
        b,
        "InvalidProof"
      );
      record("A2 third-party replay on another ledger", design, "blocked");
    }
  });

  it("A3 holder mints the same credential on a second ledger (cross-chain double issuance)", async function () {
    // paper: nothing ties the credential to a ledger.
    {
      const [a, b] = [await deployPaper(), await deployPaper()];
      const credential = await issueUnbound(keys, await sampleClaims());
      const ra = await provePaper(keys, credential, PAPER_INDEXES, "0x01");
      const rb = await provePaper(keys, credential, PAPER_INDEXES, "0x02");
      await a.connect(holder).requestGToken(ra.indexes, ra.messages, ra.nonce, ra.proof);
      await b.connect(holder).requestGToken(rb.indexes, rb.messages, rb.nonce, rb.proof);
      expect((await a.balanceOf(holder.address)) + (await b.balanceOf(holder.address))).to.equal(200n);
      record("A3 holder double-issues on a second ledger", "paper", "EXPLOITED");
    }

    // ph-only: the holder simply derives a fresh proof bound to ledger B — presentation binding alone
    // does not stop the credential owner.
    {
      const [a, b] = [await deployPhOnly(), await deployPhOnly()];
      const credential = await issueUnbound(keys, await sampleClaims());
      for (const t of [a, b]) {
        const m = await proveMint({ keys, credential, token: await t.getAddress(), recipient: holder.address, deadline: await deadline() });
        await t.connect(holder).mintBound(holder.address, m.claims, m.deadline, m.proof);
      }
      expect((await a.balanceOf(holder.address)) + (await b.balanceOf(holder.address))).to.equal(200n);
      record("A3 holder double-issues on a second ledger", "ph-only", "EXPLOITED");
    }

    // hardened: the issuer signed ledger A into the credential header; B's domain differs.
    {
      const [a, b] = [await deployHardened(), await deployHardened()];
      const [aAddr, bAddr] = [await a.getAddress(), await b.getAddress()];
      const credential = await issueDesignated(keys, { chainId: await chainId(), address: aAddr }, await sampleClaims());
      const ma = await proveMint({ keys, credential, token: aAddr, recipient: holder.address, deadline: await deadline() });
      await a.connect(holder).mintBound(holder.address, ma.claims, ma.deadline, ma.proof);
      const mb = await proveMint({ keys, credential, token: bAddr, recipient: holder.address, deadline: await deadline() });
      await expect(b.connect(holder).mintBound(holder.address, mb.claims, mb.deadline, mb.proof)).to.be.revertedWithCustomError(
        b,
        "InvalidProof"
      );

      // Same contract address, different chain: a credential designated for Arbitrum Sepolia (421614)
      // is rejected by a ledger at that address on this chain (31337).
      const c = await deployHardened();
      const cAddr = await c.getAddress();
      const foreign = await issueDesignated(keys, { chainId: 421614n, address: cAddr }, await sampleClaims());
      const mc = await proveMint({ keys, credential: foreign, token: cAddr, recipient: holder.address, deadline: await deadline() });
      await expect(c.connect(holder).mintBound(holder.address, mc.claims, mc.deadline, mc.proof)).to.be.revertedWithCustomError(
        c,
        "InvalidProof"
      );
      record("A3 holder double-issues on a second ledger", "hardened", "blocked");
    }
  });

  it("A4 holder double-mints on one ledger by changing the disclosed subset", async function () {
    // paper: H(M_disclosed) changes when one more message is revealed, so dedup misses it.
    {
      const token = await deployPaper();
      const credential = await issueUnbound(keys, await sampleClaims());
      const first = await provePaper(keys, credential, [3, 4, 5]);
      const second = await provePaper(keys, credential, [3, 4, 5, 7]);
      await token.connect(holder).requestGToken(first.indexes, first.messages, first.nonce, first.proof);
      await token.connect(holder).requestGToken(second.indexes, second.messages, second.nonce, second.proof);
      expect(await token.balanceOf(holder.address)).to.equal(200n); // 100 kWh minted twice
      record("A4 double mint via different disclosed subset", "paper", "EXPLOITED");
    }

    // ph-only / hardened: the disclosure policy is fixed by the contract and dedup is by serial.
    for (const [design, deploy] of [
      ["ph-only", deployPhOnly],
      ["hardened", deployHardened],
    ] as const) {
      const token = await deploy();
      const addr = await token.getAddress();
      const credential =
        design === "hardened"
          ? await issueDesignated(keys, { chainId: await chainId(), address: addr }, await sampleClaims())
          : await issueUnbound(keys, await sampleClaims());
      const m1 = await proveMint({ keys, credential, token: addr, recipient: holder.address, deadline: await deadline() });
      await token.connect(holder).mintBound(holder.address, m1.claims, m1.deadline, m1.proof);
      const m2 = await proveMint({ keys, credential, token: addr, recipient: holder.address, deadline: (await deadline()) + 1n });
      await expect(token.connect(holder).mintBound(holder.address, m2.claims, m2.deadline, m2.proof)).to.be.revertedWithCustomError(
        token,
        "NullifierAlreadyUsed"
      );
      record("A4 double mint via different disclosed subset", design, "blocked");
    }
  });

  it("A5 two honest producers with identical (type, quantity, timestamp) collide", async function () {
    const shared = { reTypeCode: 1, qtyKWh: 100n, readingTimestamp: 1_739_620_800n };
    const other = { ownerID: "did:example:owner123", meterID: "meter-11111", siteID: "site-22222" };

    // paper: producer 2's legitimate request hashes to the same H(M_disclosed) and is refused.
    {
      const token = await deployPaper();
      const r1 = await provePaper(keys, await issueUnbound(keys, await sampleClaims(shared)));
      const r2 = await provePaper(keys, await issueUnbound(keys, await sampleClaims(shared), other));
      await token.connect(holder).requestGToken(r1.indexes, r1.messages, r1.nonce, r1.proof);
      await expect(token.connect(producer2).requestGToken(r2.indexes, r2.messages, r2.nonce, r2.proof)).to.be.revertedWithCustomError(
        token,
        "DuplicateRequest"
      );
      record("A5 honest-producer collision (DoS)", "paper", "EXPLOITED");
    }

    for (const [design, deploy] of [
      ["ph-only", deployPhOnly],
      ["hardened", deployHardened],
    ] as const) {
      const token = await deploy();
      const addr = await token.getAddress();
      const ledger = { chainId: await chainId(), address: addr };
      const c1 = design === "hardened" ? await issueDesignated(keys, ledger, await sampleClaims(shared)) : await issueUnbound(keys, await sampleClaims(shared));
      const c2 =
        design === "hardened"
          ? await issueDesignated(keys, ledger, await sampleClaims(shared), other)
          : await issueUnbound(keys, await sampleClaims(shared), other);
      const m1 = await proveMint({ keys, credential: c1, token: addr, recipient: holder.address, deadline: await deadline() });
      const m2 = await proveMint({ keys, credential: c2, token: addr, recipient: producer2.address, deadline: await deadline() });
      await token.connect(holder).mintBound(holder.address, m1.claims, m1.deadline, m1.proof);
      await token.connect(producer2).mintBound(producer2.address, m2.claims, m2.deadline, m2.proof);
      expect(await token.balanceOf(producer2.address)).to.equal(100n);
      record("A5 honest-producer collision (DoS)", design, "blocked");
    }
  });

  it("A6 a withheld proof is used long after it was handed to a relayer", async function () {
    const month = 30 * 24 * 3600;

    // paper: proofs never expire.
    {
      const token = await deployPaper();
      const r = await provePaper(keys, await issueUnbound(keys, await sampleClaims({ expiry: (await latestTimestamp()) + 365n * 86_400n })));
      await network.provider.send("evm_increaseTime", [month]);
      await network.provider.send("evm_mine");
      await token.connect(attacker).requestGToken(r.indexes, r.messages, r.nonce, r.proof);
      expect(await token.balanceOf(attacker.address)).to.equal(100n);
      record("A6 stale / withheld proof", "paper", "EXPLOITED");
    }

    for (const [design, deploy] of [
      ["ph-only", deployPhOnly],
      ["hardened", deployHardened],
    ] as const) {
      const token = await deploy();
      const addr = await token.getAddress();
      const claims = await sampleClaims({ expiry: (await latestTimestamp()) + 365n * 86_400n });
      const credential =
        design === "hardened"
          ? await issueDesignated(keys, { chainId: await chainId(), address: addr }, claims)
          : await issueUnbound(keys, claims);
      const m = await proveMint({ keys, credential, token: addr, recipient: holder.address, deadline: await deadline() });
      await network.provider.send("evm_increaseTime", [month]);
      await network.provider.send("evm_mine");
      await expect(token.connect(attacker).mintBound(holder.address, m.claims, m.deadline, m.proof)).to.be.revertedWithCustomError(
        token,
        "DeadlinePassed"
      );
      record("A6 stale / withheld proof", design, "blocked");
    }
  });

  after(function () {
    const designs: Design[] = ["paper", "ph-only", "hardened"];
    const width = Math.max(...[...matrix.keys()].map((k) => k.length));
    console.log(`\n      ${"attack".padEnd(width)} | ${designs.map((d) => d.padEnd(9)).join(" | ")}`);
    console.log(`      ${"-".repeat(width)}-+-${designs.map(() => "-".repeat(9)).join("-+-")}`);
    for (const [attack, row] of matrix) {
      console.log(`      ${attack.padEnd(width)} | ${designs.map((d) => (row[d] ?? "-").padEnd(9)).join(" | ")}`);
    }
  });
});
