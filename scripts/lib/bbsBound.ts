import { AbiCoder, getBytes, hexlify, keccak256, randomBytes, toUtf8Bytes } from "ethers";

// Both packages are ESM-only; Node >= 22 can require() them from this CommonJS project.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bbs = require("@digitalbazaar/bbs-signatures");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { bls12_381 } = require("@noble/curves/bls12-381.js");

/**
 * Off-chain helpers for the bound BBS mint path (draft-irtf-cfrg-bbs-signatures-06,
 * BLS12-381-SHA-256). The encodings here must match GTokenL2BbsBoundArb byte for byte.
 */

export const CIPHERSUITE = "BLS12-381-SHA-256";

export const LEDGER_TAG = keccak256(toUtf8Bytes("GTOKEN_BBS_LEDGER_V1"));
export const MINT_TAG = keccak256(toUtf8Bytes("GTOKEN_BBS_MINT_V1"));

/** Credential message layout (L = 8). Indexes 0-2 stay hidden; 3-7 are disclosed at mint time. */
export const MESSAGE_LAYOUT = [
  "ownerID",
  "meterID",
  "siteID",
  "reTypeCode",
  "qtyKWh",
  "readingTimestamp",
  "serial",
  "expiry",
] as const;
export const MESSAGE_COUNT = MESSAGE_LAYOUT.length;
export const DISCLOSED_INDEXES = [3, 4, 5, 6, 7];

const coder = AbiCoder.defaultAbiCoder();
const WORD_MASK = (1n << 256n) - 1n;

export type HiddenFields = { ownerID: string; meterID: string; siteID: string };

export type BoundClaims = {
  reTypeCode: number;
  qtyKWh: bigint;
  readingTimestamp: bigint;
  serial: string; // bytes32, issuer-assigned random value; doubles as the nullifier
  expiry: bigint;
};

export type IssuerKeys = { secretKey: Uint8Array; publicKey: Uint8Array };

export type BoundCredential = {
  header: Uint8Array;
  messages: Uint8Array[];
  signature: Uint8Array;
  claims: BoundClaims;
};

export type G1Words = { xHi: bigint; xLo: bigint; yHi: bigint; yLo: bigint };

export type SolidityProof = {
  aBar: G1Words;
  bBar: G1Words;
  d: G1Words;
  eHat: bigint;
  r1Hat: bigint;
  r3Hat: bigint;
  commitments: bigint[];
  challenge: bigint;
};

// ---------------------------------------------------------------------------
// Encodings shared with the contracts
// ---------------------------------------------------------------------------

/** Disclosed messages are single ABI words so the contract can rebuild them from typed claims. */
export function disclosedMessages(claims: BoundClaims): Uint8Array[] {
  return [
    getBytes(coder.encode(["uint256"], [claims.reTypeCode])),
    getBytes(coder.encode(["uint256"], [claims.qtyKWh])),
    getBytes(coder.encode(["uint256"], [claims.readingTimestamp])),
    getBytes(coder.encode(["bytes32"], [claims.serial])),
    getBytes(coder.encode(["uint256"], [claims.expiry])),
  ];
}

export function credentialMessages(hidden: HiddenFields, claims: BoundClaims): Uint8Array[] {
  return [
    toUtf8Bytes(hidden.ownerID),
    toUtf8Bytes(hidden.meterID),
    toUtf8Bytes(hidden.siteID),
    ...disclosedMessages(claims),
  ];
}

/** Issuer-signed BBS header that designates the one ledger allowed to mint this credential. */
export function ledgerHeader(chainId: bigint, token: string): Uint8Array {
  return getBytes(coder.encode(["bytes32", "uint256", "address"], [LEDGER_TAG, chainId, token]));
}

/** Presentation header binding a proof to one mint action (rebuilt on-chain by the token). */
export function mintPresentationHeader(p: {
  chainId: bigint;
  token: string;
  recipient: string;
  amount: bigint;
  nullifier: string;
  deadline: bigint;
}): Uint8Array {
  return getBytes(
    coder.encode(
      ["bytes32", "uint256", "address", "address", "uint256", "bytes32", "uint64"],
      [MINT_TAG, p.chainId, p.token, p.recipient, p.amount, p.nullifier, p.deadline]
    )
  );
}

export function randomSerial(): string {
  return hexlify(randomBytes(32));
}

// ---------------------------------------------------------------------------
// BBS operations (issuer and holder)
// ---------------------------------------------------------------------------

export async function generateIssuerKeys(): Promise<IssuerKeys> {
  return bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
}

export async function issueCredential(p: {
  keys: IssuerKeys;
  header: Uint8Array;
  hidden: HiddenFields;
  claims: BoundClaims;
}): Promise<BoundCredential> {
  const messages = credentialMessages(p.hidden, p.claims);
  const signature: Uint8Array = await bbs.sign({
    secretKey: p.keys.secretKey,
    publicKey: p.keys.publicKey,
    header: p.header,
    messages,
    ciphersuite: CIPHERSUITE,
  });
  return { header: p.header, messages, signature, claims: p.claims };
}

/** Derives a selective-disclosure proof and checks it off-chain before returning it. */
export async function deriveProof(p: {
  publicKey: Uint8Array;
  credential: BoundCredential;
  presentationHeader: Uint8Array;
  disclosedIndexes?: number[];
}): Promise<Uint8Array> {
  const disclosedIndexes = p.disclosedIndexes ?? DISCLOSED_INDEXES;
  const proof: Uint8Array = await bbs.deriveProof({
    publicKey: p.publicKey,
    signature: p.credential.signature,
    header: p.credential.header,
    messages: p.credential.messages,
    presentationHeader: p.presentationHeader,
    disclosedMessageIndexes: disclosedIndexes,
    ciphersuite: CIPHERSUITE,
  });
  const ok: boolean = await bbs.verifyProof({
    publicKey: p.publicKey,
    proof,
    header: p.credential.header,
    presentationHeader: p.presentationHeader,
    disclosedMessages: disclosedIndexes.map((i) => p.credential.messages[i]),
    disclosedMessageIndexes: disclosedIndexes,
    ciphersuite: CIPHERSUITE,
  });
  if (!ok) throw new Error("derived BBS proof failed off-chain verification");
  return proof;
}

// ---------------------------------------------------------------------------
// Conversions to the EIP-2537 layouts used on-chain
// ---------------------------------------------------------------------------

function fpWords(v: bigint): [bigint, bigint] {
  return [v >> 256n, v & WORD_MASK];
}

export function g1Words(compressed: Uint8Array): G1Words {
  const { x, y } = bls12_381.G1.Point.fromBytes(compressed).toAffine();
  const [xHi, xLo] = fpWords(x);
  const [yHi, yLo] = fpWords(y);
  return { xHi, xLo, yHi, yLo };
}

/** Compressed 96-byte G2 public key -> 256-byte EIP-2537 encoding (x.c0 || x.c1 || y.c0 || y.c1). */
export function publicKeyToEip2537(publicKey: Uint8Array): string {
  const { x, y } = bls12_381.G2.Point.fromBytes(publicKey).toAffine();
  const words = [x.c0, x.c1, y.c0, y.c1].flatMap(fpWords);
  return coder.encode(Array(8).fill("uint256"), words);
}

/** Parses draft-06 proof octets (Abar, Bbar, D, e^, r1^, r3^, m^_1..m^_U, c). */
export function proofToSolidity(proof: Uint8Array): SolidityProof {
  const pointLen = 48;
  const scalarLen = 32;
  const scalarsStart = 3 * pointLen;
  if (proof.length < scalarsStart + 4 * scalarLen || (proof.length - scalarsStart) % scalarLen !== 0) {
    throw new Error(`invalid BBS proof length ${proof.length}`);
  }
  const scalars: bigint[] = [];
  for (let off = scalarsStart; off < proof.length; off += scalarLen) {
    scalars.push(BigInt(hexlify(proof.subarray(off, off + scalarLen))));
  }
  return {
    aBar: g1Words(proof.subarray(0, pointLen)),
    bBar: g1Words(proof.subarray(pointLen, 2 * pointLen)),
    d: g1Words(proof.subarray(2 * pointLen, 3 * pointLen)),
    eHat: scalars[0],
    r1Hat: scalars[1],
    r3Hat: scalars[2],
    commitments: scalars.slice(3, -1),
    challenge: scalars[scalars.length - 1],
  };
}
