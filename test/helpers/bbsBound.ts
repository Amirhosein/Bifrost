import { ethers, network } from "hardhat";

import {
  BbsBls12381Verifier__factory,
  GTokenAnchorArb__factory,
  GTokenL2BbsBoundArb__factory,
  MockArbBridge__factory,
  MockArbOutbox__factory,
  MockArbSys__factory,
} from "../../typechain-types";

import {
  BoundClaims,
  BoundCredential,
  HiddenFields,
  IssuerKeys,
  deriveProof,
  generateIssuerKeys,
  issueCredential,
  ledgerHeader,
  mintPresentationHeader,
  proofToSolidity,
  publicKeyToEip2537,
  randomSerial,
} from "../../scripts/lib/bbsBound";

export const ARBSYS_ADDRESS = "0x0000000000000000000000000000000000000064";

export const DEFAULT_HIDDEN: HiddenFields = {
  ownerID: "did:example:owner789",
  meterID: "meter-56789",
  siteID: "site-34567",
};

/**
 * Snapshots the chain before a suite and reverts after it, so time travel and deployments in
 * these suites do not leak into other test files (which compute expiries from wall-clock time).
 */
export function isolateChainState() {
  let snapshotId: string;
  before(async function () {
    snapshotId = await network.provider.send("evm_snapshot");
  });
  after(async function () {
    await network.provider.send("evm_revert", [snapshotId]);
  });
}

/** Installs MockArbSys runtime code at the ArbSys precompile address. */
async function deployer() {
  return (await ethers.getSigners())[0];
}

export async function installMockArbSys() {
  const signer = await deployer();
  const mock = await new MockArbSys__factory(signer).deploy();
  await network.provider.send("hardhat_setCode", [ARBSYS_ADDRESS, await ethers.provider.getCode(await mock.getAddress())]);
  return MockArbSys__factory.connect(ARBSYS_ADDRESS, signer);
}

export async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

export async function chainId(): Promise<bigint> {
  return (await ethers.provider.getNetwork()).chainId;
}

export async function deployVerifier(keys: IssuerKeys) {
  const v = await new BbsBls12381Verifier__factory(await deployer()).deploy(8, publicKeyToEip2537(keys.publicKey));
  await v.waitForDeployment();
  return v;
}

/** Hardened Arbitrum token plus the L1 anchor stack (outbox/bridge mocks) wired together. */
export async function deployBoundLedger(verifierAddress: string) {
  const signer = await deployer();
  const outbox = await new MockArbOutbox__factory(signer).deploy();
  const bridge = await new MockArbBridge__factory(signer).deploy(await outbox.getAddress());
  const anchor = await new GTokenAnchorArb__factory(signer).deploy(await bridge.getAddress(), ethers.ZeroAddress);
  const token = await new GTokenL2BbsBoundArb__factory(signer).deploy(
    "Green Token",
    "GT",
    verifierAddress,
    await anchor.getAddress(),
    ethers.ZeroAddress
  );
  await token.waitForDeployment();
  await anchor.setConfig(await token.getAddress());
  return { token, anchor, outbox };
}

export async function sampleClaims(overrides: Partial<BoundClaims> = {}): Promise<BoundClaims> {
  const now = await latestTimestamp();
  return {
    reTypeCode: 1, // Solar
    qtyKWh: 100n,
    readingTimestamp: 1_739_620_800n, // 2025-02-15T12:00:00Z, the paper's sample reading
    serial: randomSerial(),
    expiry: now + 30n * 24n * 3600n,
    ...overrides,
  };
}

/** Issuer side: sign a credential designated for `(chainId, ledger)`. */
export async function issueDesignated(
  keys: IssuerKeys,
  ledger: { chainId: bigint; address: string },
  claims: BoundClaims,
  hidden: HiddenFields = DEFAULT_HIDDEN
): Promise<BoundCredential> {
  return issueCredential({ keys, header: ledgerHeader(ledger.chainId, ledger.address), hidden, claims });
}

/** Issuer side: sign a credential with no ledger binding (paper-style). */
export async function issueUnbound(
  keys: IssuerKeys,
  claims: BoundClaims,
  hidden: HiddenFields = DEFAULT_HIDDEN
): Promise<BoundCredential> {
  return issueCredential({ keys, header: new Uint8Array(), hidden, claims });
}

/** Holder side: derive a proof bound to one mint on `token` and shape the contract arguments. */
export async function proveMint(p: {
  keys: IssuerKeys;
  credential: BoundCredential;
  token: string;
  recipient: string;
  deadline: bigint;
  chainId?: bigint;
}) {
  const ph = mintPresentationHeader({
    chainId: p.chainId ?? (await chainId()),
    token: p.token,
    recipient: p.recipient,
    amount: p.credential.claims.qtyKWh,
    nullifier: p.credential.claims.serial,
    deadline: p.deadline,
  });
  const proof = proofToSolidity(await deriveProof({ publicKey: p.keys.publicKey, credential: p.credential, presentationHeader: ph }));
  return { claims: p.credential.claims, deadline: p.deadline, proof };
}

export { generateIssuerKeys };
