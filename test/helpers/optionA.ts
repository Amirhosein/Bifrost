import { ethers, network } from "hardhat";
import { getBytes } from "ethers";

import {
  ArbAliasExecutor__factory,
  GTokenOptionAArb__factory,
  GTokenOptionAOp__factory,
  MockArbInbox__factory,
  MockOpMessengerQueued__factory,
  RegistryL1__factory,
} from "../../typechain-types";

import { BoundCredential, IssuerKeys, deriveProof, generateIssuerKeys, issueCredential, proofToSolidity } from "../../scripts/lib/bbsBound";
import { DEFAULT_HIDDEN, chainId, deployVerifier, sampleClaims } from "./bbsBound";

/** Chain keys the registry routes to (the intended L2 chain ids; all share one Hardhat chain here). */
export const ARB_KEY = 412346; // Arbitrum nitro-testnode
export const OP_KEY = 901; // OP Stack devnet

export const BRIDGE = { None: 0, Arbitrum: 1, OpStack: 2 } as const;
export const MODE = { None: 0, VerifyOnL1: 1, VerifyOnL2: 2 } as const;

const ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;

/** Arbitrum L1 -> L2 alias: L1 address + 0x1111...1111 (mod 2^160). */
export function aliasOf(l1: string): string {
  return ethers.getAddress("0x" + ((BigInt(l1) + ALIAS_OFFSET) % (1n << 160n)).toString(16).padStart(40, "0"));
}

/** Retryable ticket fee parameters: deposit = maxSubmissionCost + gasLimit * maxFeePerGas. */
export function arbFee(gasLimit = 300_000n) {
  const fee = { maxSubmissionCost: 100_000_000_000_000n, gasLimit, maxFeePerGas: 100_000_000n };
  return { fee, value: fee.maxSubmissionCost + fee.gasLimit * fee.maxFeePerGas };
}

/** OP Stack: no explicit fee; gasLimit is the message's minGasLimit. */
export function opFee(minGasLimit = 200_000n) {
  return { fee: { maxSubmissionCost: 0n, gasLimit: minGasLimit, maxFeePerGas: 0n }, value: 0n };
}

/** Puts the alias executor at alias(l1Address), so the mock inbox can deliver "from" that L1 sender. */
export async function installAliasExecutor(inboxAddress: string, l1Address: string) {
  const [signer] = await ethers.getSigners();
  const exec = await new ArbAliasExecutor__factory(signer).deploy(inboxAddress);
  await network.provider.send("hardhat_setCode", [aliasOf(l1Address), await ethers.provider.getCode(await exec.getAddress())]);
}

export async function deployOptionA(raAddress: string) {
  const [signer] = await ethers.getSigners();
  const keys = await generateIssuerKeys();
  const verifier = await deployVerifier(keys);
  const verifierAddr = await verifier.getAddress();

  const registry = await new RegistryL1__factory(signer).deploy(verifierAddr);
  const registryAddr = await registry.getAddress();
  const l1ChainId = await chainId();

  const inbox = await new MockArbInbox__factory(signer).deploy();
  const opMessenger = await new MockOpMessengerQueued__factory(signer).deploy();
  const tokenArb = await new GTokenOptionAArb__factory(signer).deploy("Green Token (Arb)", "GTA", verifierAddr, l1ChainId, registryAddr, raAddress);
  const tokenOp = await new GTokenOptionAOp__factory(signer).deploy(
    "Green Token (OP)",
    "GTO",
    verifierAddr,
    l1ChainId,
    registryAddr,
    await opMessenger.getAddress(),
    raAddress
  );

  await registry.setRoute(ARB_KEY, BRIDGE.Arbitrum, await inbox.getAddress(), await tokenArb.getAddress());
  await registry.setRoute(OP_KEY, BRIDGE.OpStack, await opMessenger.getAddress(), await tokenOp.getAddress());
  await installAliasExecutor(await inbox.getAddress(), registryAddr);

  return { keys, verifier, registry, inbox, opMessenger, tokenArb, tokenOp };
}

/** RA side: an Option A credential, bound to the registry (not to a chain). */
export async function issueOptionA(keys: IssuerKeys, registry: { issuerHeader(): Promise<string> }, claimOverrides = {}) {
  const claims = await sampleClaims(claimOverrides);
  return issueCredential({ keys, header: getBytes(await registry.issuerHeader()), hidden: DEFAULT_HIDDEN, claims });
}

/** A1: proof bound to (registry, chainKey, recipient, amount, serial, deadline), checked on L1. */
export async function proveA1(p: {
  keys: IssuerKeys;
  credential: BoundCredential;
  registry: { presentationHeader(c: number, r: string, a: bigint, s: string, d: bigint): Promise<string> };
  chainKey: number;
  recipient: string;
  deadline: bigint;
}) {
  const c = p.credential.claims;
  const ph = getBytes(await p.registry.presentationHeader(p.chainKey, p.recipient, c.qtyKWh, c.serial, p.deadline));
  return proofToSolidity(await deriveProof({ publicKey: p.keys.publicKey, credential: p.credential, presentationHeader: ph }));
}

/** A2: proof bound to (L2 token, recipient, amount, serial, deadline), checked on the chosen L2. */
export async function proveA2(p: {
  keys: IssuerKeys;
  credential: BoundCredential;
  token: { presentationHeader(r: string, a: bigint, s: string, d: bigint): Promise<string> };
  recipient: string;
  deadline: bigint;
}) {
  const c = p.credential.claims;
  const ph = getBytes(await p.token.presentationHeader(p.recipient, c.qtyKWh, c.serial, p.deadline));
  return proofToSolidity(await deriveProof({ publicKey: p.keys.publicKey, credential: p.credential, presentationHeader: ph }));
}

/** Reads the ticket id / message nonce out of the registry's MessageSent event. */
export async function sentMessageId(registry: any, tx: any): Promise<bigint> {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed?.name === "MessageSent") return parsed.args.messageId as bigint;
    } catch {
      /* other contract's log */
    }
  }
  throw new Error("MessageSent not found");
}
