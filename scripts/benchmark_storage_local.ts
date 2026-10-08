/* eslint-disable no-console */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

import { CIPHERSUITE, generateIssuerKeys, issueCredential, ledgerHeader, randomSerial } from "./lib/bbsBound";

/**
 * Local gas benchmark: keeping used-credential tags or whole credentials on-chain, versus keeping only an
 * IPFS pointer on-chain (the credential itself, encrypted, off-chain). Also measures the retirement path.
 *
 * Gas is deterministic for the EVM; USD figures use the stated prices (override with env vars).
 * Output: docs/bench_storage_local.json
 */

type Row = { path: string; operation: string; gasUsed: string; calldataBytes?: number; dataBytes?: number; notes?: string };

const ETH_USD = Number(process.env.ETH_USD ?? 2050);
const L1_GWEI = (process.env.L1_GWEI ?? "0.5,2,10").split(",").map(Number);
const L2_GWEI = Number(process.env.L2_GWEI ?? 0.0313); // effective Arbitrum Sepolia price we measured
const SCALE = 1_000_000; // credentials, for the "per million" column

function calldataBytes(data?: string): number {
  return Math.max(0, ((data ?? "0x").length - 2) / 2);
}

async function gasOf(pathLabel: string, operation: string, txPromise: Promise<any>, extra: Partial<Row> = {}): Promise<Row> {
  const tx = await txPromise;
  const rc = await tx.wait();
  return { path: pathLabel, operation, gasUsed: rc.gasUsed.toString(), calldataBytes: calldataBytes(tx.data), ...extra };
}

// ---- CIDv1 (raw codec, sha2-256) without extra dependencies ------------------

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1 = 0x01 (version) | 0x55 (raw codec) | 0x12 0x20 (sha2-256, 32 bytes) | digest. */
function cidV1Raw(data: Uint8Array) {
  const digest = crypto.createHash("sha256").update(data).digest();
  const bytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return { bytes, digest, text: "b" + base32(bytes) };
}

// ---- sample credentials ----------------------------------------------------------

/** Our binary BBS credential: issuer header | 8 x 32-byte messages | 80-byte signature. */
async function binaryCredential() {
  const keys = await generateIssuerKeys();
  const header = ledgerHeader(42161n, "0x000000000000000000000000000000000000dEaD");
  const vc = await issueCredential({
    keys,
    header,
    hidden: { ownerID: "did:example:owner789", meterID: "meter-56789", siteID: "site-34567" },
    claims: { reTypeCode: 1, qtyKWh: 100n, readingTimestamp: 1_739_620_800n, serial: randomSerial(), expiry: 1_800_000_000n },
  });
  return { bytes: Buffer.concat([Buffer.from(header), ...vc.messages.map((m: Uint8Array) => Buffer.from(m)), Buffer.from(vc.signature)]), signature: vc.signature };
}

/** A W3C-style JSON credential carrying the same fields and a BBS proof value. */
function jsonCredential(signature: Uint8Array) {
  const vc = {
    "@context": ["https://www.w3.org/2018/credentials/v1", "https://w3id.org/security/bbs/v1", "https://example.org/green-credentials/v1"],
    id: "urn:uuid:3f6d2c1a-9b7e-4f21-8c3d-6a5b4e3f2d1c",
    type: ["VerifiableCredential", "RenewableGenerationCredential"],
    issuer: "did:example:registry-administrator",
    issuanceDate: "2026-02-15T12:05:00Z",
    expirationDate: "2027-02-15T12:05:00Z",
    credentialSubject: {
      id: "did:example:owner789",
      meterID: "meter-56789",
      siteID: "site-34567",
      reTypeCode: 1,
      reType: "Solar",
      qtyKWh: 100,
      readingTimestamp: "2025-02-15T12:00:00Z",
      serial: "0x" + crypto.randomBytes(32).toString("hex"),
      designatedLedger: { chainId: 42161, contract: "0x000000000000000000000000000000000000dEaD" },
    },
    proof: {
      type: "BbsBlsSignature2020",
      created: "2026-02-15T12:05:00Z",
      proofPurpose: "assertionMethod",
      verificationMethod: "did:example:registry-administrator#bbs-key-1",
      ciphersuite: CIPHERSUITE,
      proofValue: Buffer.from(signature).toString("base64"),
    },
  };
  return Buffer.from(JSON.stringify(vc, null, 2));
}

/** AES-256-GCM, as the off-chain copy must be encrypted (the credential holds hidden fields). */
function encrypt(data: Buffer) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

async function main() {
  const [signer, ra, holder] = await ethers.getSigners();
  const rows: Row[] = [];

  const bench = await (await ethers.getContractFactory("StorageBench")).deploy();
  await bench.waitForDeployment();

  const bin = await binaryCredential();
  const json = jsonCredential(bin.signature);
  const samples = [
    { label: "binary credential", data: bin.bytes },
    { label: "JSON credential", data: json },
  ];

  // Tags: one entry per used credential.
  rows.push(await gasOf("tag", "mapping(bytes32 => bool)", bench.storeTag(ethers.hexlify(crypto.randomBytes(32))), { dataBytes: 32 }));
  rows.push(
    await gasOf("tag", "packed record (chain, registrant, time)", bench.storeTagRecord(ethers.hexlify(crypto.randomBytes(32)), 42161), {
      dataBytes: 32,
    })
  );

  const cids: Record<string, string> = {};
  for (const s of samples) {
    const key = () => ethers.hexlify(crypto.randomBytes(32));
    const n = s.data.length;
    rows.push(await gasOf("credential on-chain", `contract storage, ${s.label}`, bench.storeBytes(key(), s.data), { dataBytes: n }));
    rows.push(await gasOf("credential on-chain", `SSTORE2 code, ${s.label}`, bench.storeAsCode(key(), s.data), { dataBytes: n }));
    rows.push(await gasOf("credential on-chain", `event log, ${s.label}`, bench.logCredential(key(), s.data), { dataBytes: n, notes: "contracts cannot read it back" }));

    const enc = encrypt(s.data);
    const cid = cidV1Raw(enc);
    cids[s.label] = cid.text;
    rows.push(
      await gasOf("IPFS pointer", `32-byte digest, ${s.label}`, bench.storeCidDigest(key(), cid.digest), {
        dataBytes: 32,
        notes: `encrypted copy off-chain: ${enc.length} bytes`,
      })
    );
    rows.push(
      await gasOf("IPFS pointer", `full CIDv1 bytes, ${s.label}`, bench.storeCidBytes(key(), cid.bytes), {
        dataBytes: cid.bytes.length,
        notes: `encrypted copy off-chain: ${enc.length} bytes`,
      })
    );

    // Reads (estimateGas includes the 21,000 base cost of a transaction).
    const k1 = key();
    await (await bench.storeBytes(k1, s.data)).wait();
    rows.push({ path: "read", operation: `contract storage, ${s.label}`, gasUsed: (await bench.readBytes.estimateGas(k1)).toString(), dataBytes: n, notes: "estimateGas, includes 21,000 base" });
    const k2 = key();
    await (await bench.storeAsCode(k2, s.data)).wait();
    rows.push({ path: "read", operation: `SSTORE2 code, ${s.label}`, gasUsed: (await bench.readAsCode.estimateGas(k2, n)).toString(), dataBytes: n, notes: "estimateGas, includes 21,000 base" });
  }

  // Retirement path (MockRetirableToken carries exactly the GTokenRetirable logic).
  const token = await (await ethers.getContractFactory("MockRetirableToken")).deploy(ra.address);
  await (await token.mint(holder.address, 1000n)).wait();
  const commitment = ethers.id("beneficiary-commitment");
  await (await token.connect(holder).retire(1n, commitment)).wait(); // warm-up: escrow balance slot already non-zero
  rows.push(await gasOf("retirement", "retire", token.connect(holder).retire(100n, commitment)));
  const domain = { name: "Retirable Test", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await token.getAddress() };
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
  const recoverTypes = { Recover: [{ name: "retirementId", type: "uint256" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }] };
  const finalizeTypes = { Finalize: [{ name: "retirementId", type: "uint256" }, { name: "deadline", type: "uint256" }] };
  const rv = { retirementId: 2n, to: holder.address, deadline };
  rows.push(
    await gasOf(
      "retirement",
      "recover (two EIP-712 signatures)",
      token.recover(2n, holder.address, deadline, { ra: ra.address, holderSig: await holder.signTypedData(domain, recoverTypes, rv), raSig: await ra.signTypedData(domain, recoverTypes, rv) })
    )
  );
  await (await token.connect(holder).retire(100n, commitment)).wait();
  const fv = { retirementId: 3n, deadline };
  rows.push(
    await gasOf(
      "retirement",
      "finalize (two EIP-712 signatures)",
      token.finalize(3n, deadline, { ra: ra.address, holderSig: await holder.signTypedData(domain, finalizeTypes, fv), raSig: await ra.signTypedData(domain, finalizeTypes, fv) })
    )
  );

  // USD per operation and per million credentials.
  const usd = (gas: bigint, gwei: number) => (Number(gas) * gwei * 1e-9 * ETH_USD);
  const priced = rows.map((r) => {
    const gas = BigInt(r.gasUsed);
    const l1 = Object.fromEntries(L1_GWEI.map((g) => [`usdL1@${g}gwei`, Number(usd(gas, g).toFixed(4))]));
    return { ...r, ...l1, usdArbitrum: Number(usd(gas, L2_GWEI).toFixed(5)), usdPerMillionL1At2gwei: Math.round(usd(gas, 2) * SCALE) };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    network: network.name,
    hardfork: (network.config as any).hardfork ?? null,
    assumptions: { ethUsd: ETH_USD, l1Gwei: L1_GWEI, arbitrumEffectiveGwei: L2_GWEI, scale: SCALE },
    sampleSizes: { binaryCredentialBytes: bin.bytes.length, jsonCredentialBytes: json.length, encryptedOverheadBytes: 28, cidV1Bytes: 36 },
    sampleCids: cids,
    rows: priced,
  };
  const file = path.join(__dirname, "..", "docs", "bench_storage_local.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.table(priced.map((r) => ({ path: r.path, operation: r.operation, bytes: r.dataBytes, gas: r.gasUsed, ...Object.fromEntries(L1_GWEI.map((g) => [`$L1@${g}`, (r as any)[`usdL1@${g}gwei`]])), $Arb: r.usdArbitrum })));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
