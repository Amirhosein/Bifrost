import fs from "node:fs";
import path from "node:path";
import { expect } from "chai";
import { ethers } from "hardhat";

import { BbsBls12381Verifier__factory } from "../typechain-types";
import {
  DISCLOSED_INDEXES,
  MESSAGE_COUNT,
  deriveProof,
  generateIssuerKeys,
  issueCredential,
  proofToSolidity,
  publicKeyToEip2537,
  randomSerial,
} from "../scripts/lib/bbsBound";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { bls12_381 } = require("@noble/curves/bls12-381.js");

const R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

type VectorFile = {
  PK: string;
  generators: string[];
  messages: string[];
  message_scalars: string[];
  signatureDomains: { name: string; header: string; messageCount: number; domain: string }[];
  proofVerify: {
    name: string;
    PK: string;
    proof: string;
    header: string;
    ph: string;
    disclosedMessages: string[];
    disclosedIndexes: number[];
    output: boolean;
  }[];
};

// IETF draft-irtf-cfrg-bbs-signatures-06 BLS12-381-SHA-256 vectors (via @digitalbazaar/bbs-signatures fixtures).
const fixtures: VectorFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "bbs_draft06_sha256.json"), "utf8")
);

const h = (hex: string) => (hex.length === 0 ? "0x" : "0x" + hex);
const bytes = (hex: string) => ethers.getBytes(h(hex));

async function deployVerifier(messageCount: number, pkHex: string) {
  const [deployer] = await ethers.getSigners();
  const v = await new BbsBls12381Verifier__factory(deployer).deploy(messageCount, publicKeyToEip2537(bytes(pkHex)));
  await v.waitForDeployment();
  return v;
}

/** Splits concatenated EIP-2537 G1 points and compresses them with noble for comparison. */
function compressRawG1(raw: string): string[] {
  const data = ethers.getBytes(raw);
  const out: string[] = [];
  for (let off = 0; off < data.length; off += 128) {
    const x = BigInt(ethers.hexlify(data.subarray(off, off + 64)));
    const y = BigInt(ethers.hexlify(data.subarray(off + 64, off + 128)));
    const p = bls12_381.G1.Point.fromAffine({ x, y });
    out.push(Buffer.from(p.toBytes()).toString("hex"));
  }
  return out;
}

describe("BbsBls12381Verifier — IETF draft-06 BLS12-381-SHA-256 vectors", function () {
  // L for each fixture proof, taken from the valid case that produced it.
  const proofMessageCount = new Map<string, number>();
  for (const c of fixtures.proofVerify) {
    if (c.output) {
      const u = (c.proof.length / 2 - 272) / 32;
      proofMessageCount.set(c.proof, c.disclosedIndexes.length + u);
    }
  }

  it("derives the ciphersuite message generators on-chain", async function () {
    const v = await deployVerifier(10, fixtures.PK);
    expect(compressRawG1(await v.generators())).to.deep.equal(fixtures.generators);
  });

  it("maps messages to scalars (hash_to_scalar with MAP_MSG_TO_SCALAR_AS_HASH_)", async function () {
    const v = await deployVerifier(1, fixtures.PK);
    for (let i = 0; i < fixtures.messages.length; i++) {
      const s = await v.messageToScalar(h(fixtures.messages[i]));
      expect(s).to.equal(BigInt(h(fixtures.message_scalars[i])));
    }
  });

  it("computes calculate_domain for the issuer key, L and header", async function () {
    for (const d of fixtures.signatureDomains) {
      const v = await deployVerifier(d.messageCount, fixtures.PK);
      expect(await v.domainFor(h(d.header))).to.equal(BigInt(h(d.domain)), d.name);
    }
  });

  for (const c of fixtures.proofVerify) {
    it(`ProofVerify: ${c.name} -> ${c.output}`, async function () {
      const l = proofMessageCount.get(c.proof);
      expect(l, "fixture proof without a matching valid case").to.not.equal(undefined);
      const v = await deployVerifier(l!, c.PK);
      const scalars = await Promise.all(c.disclosedMessages.map((m) => v.messageToScalar(h(m))));
      const proof = proofToSolidity(bytes(c.proof));
      const ok = await v.verifyProofWithHeader(h(c.header), h(c.ph), c.disclosedIndexes, scalars, proof);
      expect(ok).to.equal(c.output);
    });
  }
});

describe("BbsBls12381Verifier — proofs from @digitalbazaar/bbs-signatures", function () {
  const header = ethers.toUtf8Bytes("gtoken-test-header");
  const ph = ethers.toUtf8Bytes("gtoken-test-presentation");

  async function setup() {
    const keys = await generateIssuerKeys();
    const v = await deployVerifier(MESSAGE_COUNT, ethers.hexlify(keys.publicKey).slice(2));
    const claims = {
      reTypeCode: 1,
      qtyKWh: 100n,
      readingTimestamp: 1_739_620_800n,
      serial: randomSerial(),
      expiry: 4_102_444_800n,
    };
    const credential = await issueCredential({
      keys,
      header,
      hidden: { ownerID: "did:example:owner789", meterID: "meter-56789", siteID: "site-34567" },
      claims,
    });
    const proofBytes = await deriveProof({ publicKey: keys.publicKey, credential, presentationHeader: ph });
    const scalars = await Promise.all(DISCLOSED_INDEXES.map((i) => v.messageToScalar(credential.messages[i])));
    return { v, keys, credential, proof: proofToSolidity(proofBytes), scalars };
  }

  it("accepts a library-generated proof (L=8, 5 disclosed)", async function () {
    const { v, proof, scalars } = await setup();
    expect(await v.verifyProofWithHeader(header, ph, DISCLOSED_INDEXES, scalars, proof)).to.equal(true);
    const gas = await v.verifyProofWithHeader.estimateGas(header, ph, DISCLOSED_INDEXES, scalars, proof);
    console.log(`      verifyProofWithHeader estimateGas (L=8, R=5): ${gas}`);
  });

  it("rejects wrong presentation header, header, or disclosed value", async function () {
    const { v, proof, scalars } = await setup();
    expect(await v.verifyProofWithHeader(header, ethers.toUtf8Bytes("other"), DISCLOSED_INDEXES, scalars, proof)).to
      .equal(false);
    expect(await v.verifyProofWithHeader(ethers.toUtf8Bytes("other"), ph, DISCLOSED_INDEXES, scalars, proof)).to
      .equal(false);
    const tampered = [...scalars];
    tampered[1] = await v.messageToScalar(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1000n]));
    expect(await v.verifyProofWithHeader(header, ph, DISCLOSED_INDEXES, tampered, proof)).to.equal(false);
  });

  it("rejects tampered proof components without reverting", async function () {
    const { v, proof, scalars } = await setup();
    const check = (p: typeof proof, idx = DISCLOSED_INDEXES, s = scalars) =>
      v.verifyProofWithHeader(header, ph, idx, s, p);

    expect(await check({ ...proof, challenge: (proof.challenge + 1n) % R })).to.equal(false);
    expect(await check({ ...proof, eHat: (proof.eHat + 1n) % R })).to.equal(false);
    expect(await check({ ...proof, commitments: [proof.commitments[0] ^ 1n, ...proof.commitments.slice(1)] })).to
      .equal(false);
    // scalar out of range, zero scalar
    expect(await check({ ...proof, r1Hat: R })).to.equal(false);
    expect(await check({ ...proof, r3Hat: 0n })).to.equal(false);
    // identity and off-curve points
    expect(await check({ ...proof, aBar: { xHi: 0n, xLo: 0n, yHi: 0n, yLo: 0n } })).to.equal(false);
    expect(await check({ ...proof, d: { ...proof.d, yLo: proof.d.yLo ^ 1n } })).to.equal(false);
    // swapped points
    expect(await check({ ...proof, aBar: proof.bBar, bBar: proof.aBar })).to.equal(false);
    // disclosure shape: unsorted, duplicated, wrong count
    expect(await check(proof, [4, 3, 5, 6, 7], [scalars[1], scalars[0], ...scalars.slice(2)])).to.equal(false);
    expect(await check(proof, [3, 3, 5, 6, 7])).to.equal(false);
    expect(await check(proof, [3, 4, 5, 6], scalars.slice(0, 4))).to.equal(false);
  });
});
