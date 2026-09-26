/* eslint-disable no-console */
import { ethers, network } from "hardhat";

import {
  BbsBls12381Verifier__factory,
  GTokenAnchorArb__factory,
  GTokenL2BbsBoundArb__factory,
  MockArbBridge__factory,
  MockArbOutbox__factory,
  MockArbSys__factory,
} from "../typechain-types";

import {
  deriveProof,
  generateIssuerKeys,
  issueCredential,
  ledgerHeader,
  mintPresentationHeader,
  proofToSolidity,
  publicKeyToEip2537,
  randomSerial,
} from "./lib/bbsBound";

/**
 * End-to-end walkthrough of bound BBS minting on the in-memory Hardhat network:
 *   RA issues a credential designated for one ledger -> holder derives a proof bound to one mint
 *   -> a relayer submits it for an unfunded pseudonym -> a front-runner's rewrite fails
 *   -> the L2->L1 anchor message is executed on the (mock) L1 anchor.
 *
 *   npx hardhat run scripts/demo_bbs_bound_local.ts
 */
async function main() {
  const [deployer, relayer, attacker] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const arbSysMock = await new MockArbSys__factory(deployer).deploy();
  const ARBSYS = "0x0000000000000000000000000000000000000064";
  await network.provider.send("hardhat_setCode", [ARBSYS, await ethers.provider.getCode(await arbSysMock.getAddress())]);
  const arbSys = MockArbSys__factory.connect(ARBSYS, deployer);

  console.log("1. Registry Administrator generates a BBS key (BLS12-381-SHA-256)");
  const keys = await generateIssuerKeys();

  console.log("2. Deploy the real on-chain verifier and the hardened ledger (+ mock L1 anchor stack)");
  const verifier = await new BbsBls12381Verifier__factory(deployer).deploy(8, publicKeyToEip2537(keys.publicKey));
  const outbox = await new MockArbOutbox__factory(deployer).deploy();
  const bridge = await new MockArbBridge__factory(deployer).deploy(await outbox.getAddress());
  const anchor = await new GTokenAnchorArb__factory(deployer).deploy(await bridge.getAddress(), ethers.ZeroAddress);
  const token = await new GTokenL2BbsBoundArb__factory(deployer).deploy(
    "Green Token",
    "GT",
    await verifier.getAddress(),
    await anchor.getAddress(),
    deployer.address
  );
  const tokenAddress = await token.getAddress();
  await anchor.setConfig(tokenAddress);
  console.log(`   verifier ${await verifier.getAddress()}\n   ledger   ${tokenAddress}`);

  console.log("3. RA issues a credential designated for (chainId, ledger); the serial is the nullifier");
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const credential = await issueCredential({
    keys,
    header: ledgerHeader(chainId, tokenAddress),
    hidden: { ownerID: "did:example:owner789", meterID: "meter-56789", siteID: "site-34567" },
    claims: { reTypeCode: 1, qtyKWh: 100n, readingTimestamp: 1_739_620_800n, serial: randomSerial(), expiry: now + 30n * 86_400n },
  });
  console.log(`   serial ${credential.claims.serial}`);

  console.log("4. Holder derives a proof bound to (recipient, amount, nullifier, deadline) for a fresh pseudonym");
  const pseudonym = ethers.Wallet.createRandom().address;
  const deadline = now + 3600n;
  const ph = mintPresentationHeader({
    chainId,
    token: tokenAddress,
    recipient: pseudonym,
    amount: credential.claims.qtyKWh,
    nullifier: credential.claims.serial,
    deadline,
  });
  const proof = proofToSolidity(await deriveProof({ publicKey: keys.publicKey, credential, presentationHeader: ph }));
  console.log(`   pseudonym ${pseudonym} (ETH balance ${await ethers.provider.getBalance(pseudonym)})`);

  console.log("5. A front-runner copies the proof but redirects the mint to itself");
  try {
    await token.connect(attacker).mintBound.staticCall(attacker.address, credential.claims, deadline, proof);
    console.log("   UNEXPECTED: attacker call succeeded");
  } catch (e: any) {
    console.log(`   rejected: ${token.interface.parseError(e.data)?.name ?? e.shortMessage}`);
  }

  console.log("6. A relayer submits the original request and pays the gas");
  const tx = await token.connect(relayer).mintBound(pseudonym, credential.claims, deadline, proof);
  const rc = await tx.wait();
  console.log(`   minted ${await token.balanceOf(pseudonym)} GT to the pseudonym, gasUsed ${rc!.gasUsed}`);

  console.log("7. The L2->L1 anchor message is executed on L1 (outbox mock)");
  const log = rc!.logs.find((l) => l.address.toLowerCase() === ARBSYS.toLowerCase());
  const sent = arbSys.interface.parseLog(log!)!;
  await (await outbox.execute(await anchor.getAddress(), sent.args.data, tokenAddress)).wait();
  const claimId = await token.computeClaimId(credential.claims);
  console.log(`   anchored claimId ${claimId}: ${await anchor.isAnchored(claimId)}`);

  console.log("8. Replaying the same credential fails (nullifier already used)");
  try {
    await token.connect(relayer).mintBound.staticCall(pseudonym, credential.claims, deadline, proof);
    console.log("   UNEXPECTED: replay succeeded");
  } catch (e: any) {
    console.log(`   rejected: ${token.interface.parseError(e.data)?.name ?? e.shortMessage}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
