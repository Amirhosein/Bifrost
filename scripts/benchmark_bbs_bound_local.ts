/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

import {
  CIPHERSUITE,
  DISCLOSED_INDEXES,
  IssuerKeys,
  deriveProof,
  disclosedMessages,
  generateIssuerKeys,
  issueCredential,
  ledgerHeader,
  mintPresentationHeader,
  proofToSolidity,
  publicKeyToEip2537,
  randomSerial,
} from "./lib/bbsBound";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bbs = require("@digitalbazaar/bbs-signatures");

/**
 * Deterministic local gas benchmark for the bound BBS mint path (real on-chain verifier).
 *
 * Measures, on the in-memory Hardhat network (Prague / EIP-2537):
 *  - deployment gas of the verifier and the three ledgers used in the attack matrix;
 *  - runtime gas of paper-baseline vs ph-bound-only vs hardened mints (isolates the cost of the fix);
 *  - a per-stage breakdown of one verification (BbsVerifierGasProbe);
 *  - verification gas as the number of disclosed (R) and signed (L) messages varies.
 *
 * Output: docs/bench_bbs_bound_local.json
 */

type Row = {
  path: string;
  operation: string;
  gasUsed: string;
  calldataBytes?: number;
  notes?: string;
};

const ARBSYS_ADDRESS = "0x0000000000000000000000000000000000000064";

function calldataBytes(data?: string): number {
  return Math.max(0, ((data ?? "0x").length - 2) / 2);
}

async function gasOf(pathLabel: string, operation: string, txPromise: Promise<any>, notes?: string): Promise<Row> {
  const tx = await txPromise;
  const rc = await tx.wait();
  return { path: pathLabel, operation, gasUsed: rc.gasUsed.toString(), calldataBytes: calldataBytes(tx.data), notes };
}

async function deployGas(pathLabel: string, name: string, args: unknown[], notes?: string) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  const rc = await contract.deploymentTransaction()!.wait();
  const row: Row = { path: pathLabel, operation: `deploy:${name}`, gasUsed: rc!.gasUsed.toString(), notes };
  return { contract, row };
}

async function now(): Promise<bigint> {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

/** A generic L-message credential whose last R messages are disclosed (for the scaling sweeps). */
async function genericProof(keys: IssuerKeys, l: number, r: number) {
  const messages = Array.from({ length: l }, () => ethers.randomBytes(32));
  const header = ethers.toUtf8Bytes("bench-header");
  const ph = ethers.toUtf8Bytes("bench-presentation-header");
  const signature = await bbs.sign({ ...keys, header, messages, ciphersuite: CIPHERSUITE });
  const indexes = Array.from({ length: r }, (_, k) => l - r + k);
  const proof = await bbs.deriveProof({
    publicKey: keys.publicKey,
    signature,
    header,
    messages,
    presentationHeader: ph,
    disclosedMessageIndexes: indexes,
    ciphersuite: CIPHERSUITE,
  });
  return { header, ph, indexes, messages: indexes.map((i) => messages[i]), proof: proofToSolidity(proof) };
}

async function main() {
  const [deployer, holder, relayer, recipient, fresh] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const rows: Row[] = [];

  // Local stand-in for the ArbSys precompile (the hardened ledger anchors to L1 through it).
  const arbSysMock = await (await ethers.getContractFactory("MockArbSys")).deploy();
  await network.provider.send("hardhat_setCode", [ARBSYS_ADDRESS, await ethers.provider.getCode(await arbSysMock.getAddress())]);

  const keys = await generateIssuerKeys();
  const pk = publicKeyToEip2537(keys.publicKey);

  // ---------------------------------------------------------------------------
  // Deployment
  // ---------------------------------------------------------------------------
  const { contract: verifier, row: verifierRow } = await deployGas(
    "common",
    "BbsBls12381Verifier",
    [8, pk],
    "L=8; derives 9 generators on-chain (hash_to_curve) and stores params as code"
  );
  rows.push(verifierRow);
  const verifierAddress = await verifier.getAddress();

  const outbox = await (await ethers.getContractFactory("MockArbOutbox")).deploy();
  const bridge = await (await ethers.getContractFactory("MockArbBridge")).deploy(await outbox.getAddress());
  const anchor = await (await ethers.getContractFactory("GTokenAnchorArb")).deploy(await bridge.getAddress(), ethers.ZeroAddress);

  const { contract: hardened, row: hardenedDeploy } = await deployGas(
    "hardened",
    "GTokenL2BbsBoundArb",
    ["Green Token", "GT", verifierAddress, await anchor.getAddress(), ethers.ZeroAddress],
    "Computes the designated-ledger domain once in the constructor"
  );
  rows.push(hardenedDeploy);
  await (anchor as any).setConfig(await hardened.getAddress());

  const { contract: phOnly, row: phOnlyDeploy } = await deployGas("ph-bound-only", "GTokenBbsPresentationBoundOnly", [verifierAddress]);
  rows.push(phOnlyDeploy);
  const { contract: paper, row: paperDeploy } = await deployGas("paper-baseline", "GTokenBbsPaperBaseline", [verifierAddress]);
  rows.push(paperDeploy);

  const hardenedAddr = await hardened.getAddress();
  const phOnlyAddr = await phOnly.getAddress();
  const hidden = { ownerID: "did:example:owner789", meterID: "meter-56789", siteID: "site-34567" };
  // Distinct reading timestamps: the paper baseline would otherwise reject identical
  // (type, qty, timestamp) disclosures as duplicates (attack A5).
  let reading = 1_739_620_800n;
  const claimsFor = async () => ({
    reTypeCode: 1,
    qtyKWh: 100n,
    readingTimestamp: reading++,
    serial: randomSerial(),
    expiry: (await now()) + 30n * 86_400n,
  });

  // ---------------------------------------------------------------------------
  // Runtime: paper baseline vs ph-bound-only vs hardened
  //
  // Every ledger gets one unmeasured warm-up mint first, so each measured mint runs in the same
  // storage state: totalSupply already non-zero, recipient balance zero, dedup slot fresh.
  // ---------------------------------------------------------------------------
  const paperRequest = async (from: typeof holder, indexes: number[]) => {
    const credential = await issueCredential({ keys, header: new Uint8Array(), hidden, claims: await claimsFor() });
    const nonce = ethers.toUtf8Bytes("paper-nonce");
    const proof = proofToSolidity(
      await deriveProof({ publicKey: keys.publicKey, credential, presentationHeader: nonce, disclosedIndexes: indexes })
    );
    return (paper as any).connect(from).requestGToken(indexes, indexes.map((i) => credential.messages[i]), nonce, proof);
  };
  await (await paperRequest(holder, [3, 4, 5])).wait(); // warm-up
  rows.push(
    await gasOf("paper-baseline", "requestGToken (R=3)", paperRequest(recipient, [3, 4, 5]), "Paper disclosure policy {REType, REQuantity, timestamp}")
  );
  rows.push(
    await gasOf("paper-baseline", "requestGToken (R=5)", paperRequest(fresh, DISCLOSED_INDEXES), "Same disclosure set as the bound ledgers")
  );

  const bound = async (token: string, header: Uint8Array, to: string) => {
    const credential = await issueCredential({ keys, header, hidden, claims: await claimsFor() });
    const deadline = (await now()) + 3600n;
    const ph = mintPresentationHeader({
      chainId,
      token,
      recipient: to,
      amount: credential.claims.qtyKWh,
      nullifier: credential.claims.serial,
      deadline,
    });
    const proof = proofToSolidity(await deriveProof({ publicKey: keys.publicKey, credential, presentationHeader: ph }));
    return { claims: credential.claims, deadline, proof, ph };
  };
  const boundMint = async (token: any, header: Uint8Array) => {
    const to = ethers.Wallet.createRandom().address; // fresh pseudonym; a relayer pays gas
    const m = await bound(await token.getAddress(), header, to);
    return token.connect(relayer).mintBound(to, m.claims, m.deadline, m.proof);
  };

  await (await boundMint(phOnly, new Uint8Array())).wait(); // warm-up
  rows.push(
    await gasOf("ph-bound-only", "mintBound (R=5)", boundMint(phOnly, new Uint8Array()), "Presentation binding + nullifier; no L1 anchor")
  );

  const hardenedHeader = ledgerHeader(chainId, hardenedAddr);
  await (await boundMint(hardened, hardenedHeader)).wait(); // warm-up
  rows.push(
    await gasOf(
      "hardened",
      "mintBound (R=5)",
      boundMint(hardened, hardenedHeader),
      "Adds designated-ledger domain + ArbSys.sendTxToL1 (MockArbSys locally; real ArbSys cost differs)"
    )
  );

  // Standalone verification (eth_estimateGas; includes 21k intrinsic + calldata) and a per-stage
  // breakdown. The domain depends only on (PK, L, generators, header), so the probe reuses it.
  let verifyStages: Record<string, string>;
  {
    const m = await bound(hardenedAddr, ledgerHeader(chainId, hardenedAddr), holder.address);
    const domain = await (hardened as any).issuerDomain();
    const scalars = await Promise.all(disclosedMessages(m.claims).map((msg) => (verifier as any).messageToScalar(msg)));
    const est = await (verifier as any).verifyProof.estimateGas(domain, m.ph, DISCLOSED_INDEXES, scalars, m.proof);
    rows.push({ path: "common", operation: "verifyProof (estimateGas)", gasUsed: est.toString(), notes: "L=8, R=5, precomputed domain" });

    const probe = await (await ethers.getContractFactory("BbsVerifierGasProbe")).deploy(8, pk);
    const g = await (probe as any).profile(domain, m.ph, DISCLOSED_INDEXES, scalars, m.proof);
    if (!g.valid) throw new Error("gas probe: proof did not verify");
    const msgGas = await (probe as any).profileMessageScalars(disclosedMessages(m.claims));
    verifyStages = {
      shapeChecks: g.shapeChecks.toString(),
      loadParams: g.loadParams.toString(),
      msmT1: g.msmT1.toString(),
      msmT2: g.msmT2.toString(),
      challenge: g.challenge.toString(),
      pairing: g.pairing.toString(),
      messageScalarsR5: msgGas.toString(),
    };

    // Give the holder a balance for the transfer measurement below (unmeasured).
    await (await (hardened as any).connect(holder).mintBound(holder.address, m.claims, m.deadline, m.proof)).wait();
  }

  rows.push(
    await gasOf("hardened", "transfer", (hardened as any).connect(holder).transfer(recipient.address, 40n), "Post-mint transfer (fresh recipient)")
  );

  // ---------------------------------------------------------------------------
  // Scaling sweeps
  // ---------------------------------------------------------------------------
  const byDisclosed: { L: number; R: number; verifyGas: string }[] = [];
  for (let r = 0; r <= 8; r++) {
    const p = await genericProof(keys, 8, r);
    const scalars = await Promise.all(p.messages.map((msg) => (verifier as any).messageToScalar(msg)));
    const est = await (verifier as any).verifyProofWithHeader.estimateGas(p.header, p.ph, p.indexes, scalars, p.proof);
    byDisclosed.push({ L: 8, R: r, verifyGas: est.toString() });
  }

  const byMessageCount: { L: number; R: number; verifyGas: string; verifierDeployGas: string }[] = [];
  for (const l of [5, 8, 12, 16]) {
    const { contract: v, row } = await deployGas("sweep", "BbsBls12381Verifier", [l, pk]);
    const p = await genericProof(keys, l, 5);
    const scalars = await Promise.all(p.messages.map((msg) => (v as any).messageToScalar(msg)));
    const est = await (v as any).verifyProofWithHeader.estimateGas(p.header, p.ph, p.indexes, scalars, p.proof);
    byMessageCount.push({ L: l, R: 5, verifyGas: est.toString(), verifierDeployGas: row.gasUsed });
  }

  console.table(rows);
  console.table(verifyStages);
  console.table(byDisclosed);
  console.table(byMessageCount);

  const outPath = path.join(process.cwd(), "docs", "bench_bbs_bound_local.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        network: "hardhat",
        hardfork: "hardfork" in network.config ? network.config.hardfork : "default",
        ciphersuite: `${CIPHERSUITE} (draft-irtf-cfrg-bbs-signatures-06)`,
        deployer: deployer.address,
        rows,
        verifyStages,
        scaling: { byDisclosed, byMessageCount },
      },
      null,
      2
    )
  );
  console.log("Wrote:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
