/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { ethers as ethersLib } from "ethers";

import { GTokenAnchorArb__factory } from "../typechain-types";

import {
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
 * Repeated Arbitrum Sepolia benchmark for bound BBS minting with the real on-chain verifier.
 *
 *   npx hardhat run --network arbitrumSepolia scripts/benchmark_bbs_bound_arb_sepolia.ts
 *
 * Each iteration issues a fresh credential (new serial) designated for the deployed ledger,
 * derives a proof bound to (recipient, amount, nullifier, deadline), estimates verifyProof,
 * submits mintBound (the deployer acts as relayer) and, when minting to the deployer, a transfer.
 *
 * Env:
 *   BENCH_REPEAT_COUNT      iterations (default 10)
 *   BOUND_VERIFIER / BOUND_TOKEN   reuse deployments (requires BOUND_ISSUER_SECRET_KEY)
 *   BOUND_ISSUER_SECRET_KEY hex BBS secret key; otherwise a fresh key is generated in memory
 *   BOUND_L1_ANCHOR         L1 GTokenAnchorArb address used as the L2->L1 target
 *   BOUND_DEPLOY_L1_ANCHOR  "true" to deploy a fresh GTokenAnchorArb on Sepolia (needs SEPOLIA_RPC_URL,
 *                           ARBITRUM_L1_BRIDGE) and authorize the new ledger, so its messages can be executed on L1
 *   BOUND_FRESH_RECIPIENT   "true" to mint to a new random pseudonym each iteration (relayer mode)
 *   BENCH_RECIPIENT         transfer target (default: a fixed random address)
 *
 * Output: docs/bench_bbs_bound_arb_sepolia_repeat.json (no keys or RPC URLs are written).
 */

type TxRow = {
  path: string;
  operation: string;
  iteration: number;
  chainId: string;
  txHash: string;
  gasUsed: string;
  gasUsedForL1?: string;
  effectiveGasPrice: string;
  feeWei: string;
  notes?: string;
};

const PATH_LABEL = "bbs-bound-real-verifier-arb";

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function stats(values: bigint[]) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sum = sorted.reduce((a, b) => a + b, 0n);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
  const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))];
  return { avg: sum / BigInt(sorted.length), median, p95 };
}

async function receiptRow(operation: string, iteration: number, txHash: string, notes?: string): Promise<TxRow> {
  const rc = await ethers.provider.getTransactionReceipt(txHash);
  if (!rc) throw new Error(`missing receipt for ${txHash}`);
  // Arbitrum receipts also report the L1 data component of gasUsed.
  const raw = (await ethers.provider.send("eth_getTransactionReceipt", [txHash])) as { gasUsedForL1?: string };
  const price = rc.gasPrice ?? 0n;
  return {
    path: PATH_LABEL,
    operation,
    iteration,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    txHash,
    gasUsed: rc.gasUsed.toString(),
    gasUsedForL1: raw.gasUsedForL1 ? BigInt(raw.gasUsedForL1).toString() : undefined,
    effectiveGasPrice: price.toString(),
    feeWei: (rc.gasUsed * price).toString(),
    notes,
  };
}

async function main() {
  const [relayer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 421614n && process.env.ALLOW_NON_STANDARD_CHAIN !== "true") {
    throw new Error(`Intended for Arbitrum Sepolia (421614); got ${chainId}. Set ALLOW_NON_STANDARD_CHAIN=true to override.`);
  }
  // Dry run on the in-memory network: stand in for ArbSys and keep the report out of docs/.
  const dryRun = network.name === "hardhat";
  if (dryRun) {
    const mock = await (await ethers.getContractFactory("MockArbSys")).deploy();
    await network.provider.send("hardhat_setCode", [
      "0x0000000000000000000000000000000000000064",
      await ethers.provider.getCode(await mock.getAddress()),
    ]);
  }
  const repeatCount = Number(envOr("BENCH_REPEAT_COUNT", "10"));
  const freshRecipient = envOr("BOUND_FRESH_RECIPIENT", "false") === "true";
  const transferTarget = envOr("BENCH_RECIPIENT", ethers.Wallet.createRandom().address);

  // Issuer (Registry Administrator) key — kept in memory unless supplied via env.
  let keys: IssuerKeys;
  if (process.env.BOUND_ISSUER_SECRET_KEY) {
    const secretKey = ethers.getBytes(process.env.BOUND_ISSUER_SECRET_KEY);
    keys = { secretKey, publicKey: await bbs.secretKeyToPublicKey({ secretKey, ciphersuite: "BLS12-381-SHA-256" }) };
  } else {
    keys = await generateIssuerKeys();
  }

  const rows: TxRow[] = [];
  const l1Rows: { operation: string; txHash: string; gasUsed: string; effectiveGasPrice: string }[] = [];
  const deployments: Record<string, string> = {};

  // ---------------------------------------------------------------------------
  // Deploy (or reuse) verifier + hardened ledger
  // ---------------------------------------------------------------------------
  let verifierAddress = process.env.BOUND_VERIFIER;
  if (!verifierAddress) {
    const v = await (await ethers.getContractFactory("BbsBls12381Verifier")).deploy(8, publicKeyToEip2537(keys.publicKey));
    await v.waitForDeployment();
    verifierAddress = await v.getAddress();
    rows.push(await receiptRow("deploy:BbsBls12381Verifier", -1, v.deploymentTransaction()!.hash, "One-time setup"));
  } else if (!process.env.BOUND_ISSUER_SECRET_KEY) {
    throw new Error("BOUND_VERIFIER requires BOUND_ISSUER_SECRET_KEY (the verifier is bound to one issuer key).");
  }
  deployments.verifier = verifierAddress;

  // Optional L1 anchor on Sepolia; the deployer key signs on both layers.
  let l1AnchorContract: ReturnType<typeof GTokenAnchorArb__factory.connect> | undefined;
  let l1Anchor = process.env.BOUND_L1_ANCHOR ?? "";
  if (!dryRun && envOr("BOUND_DEPLOY_L1_ANCHOR", "false") === "true") {
    const l1Rpc = process.env.SEPOLIA_RPC_URL;
    const bridge = process.env.ARBITRUM_L1_BRIDGE;
    const pk = process.env.DEPLOYER_PRIVATE_KEY;
    if (!l1Rpc || !bridge || !pk) throw new Error("BOUND_DEPLOY_L1_ANCHOR needs SEPOLIA_RPC_URL, ARBITRUM_L1_BRIDGE, DEPLOYER_PRIVATE_KEY");
    const l1Signer = new ethersLib.Wallet(pk, new ethersLib.JsonRpcProvider(l1Rpc));
    const deployed = await new GTokenAnchorArb__factory(l1Signer as any).deploy(bridge, ethers.ZeroAddress);
    await deployed.waitForDeployment();
    const rc = await deployed.deploymentTransaction()!.wait();
    l1Anchor = await deployed.getAddress();
    l1AnchorContract = GTokenAnchorArb__factory.connect(l1Anchor, l1Signer as any);
    l1Rows.push({ operation: "deploy:GTokenAnchorArb (L1)", txHash: rc!.hash, gasUsed: rc!.gasUsed.toString(), effectiveGasPrice: (rc!.gasPrice ?? 0n).toString() });
    console.log(`L1 anchor deployed on Sepolia: ${l1Anchor}`);
  }
  if (!l1Anchor) {
    l1Anchor = relayer.address;
    console.warn("No L1 anchor configured: L2->L1 messages target the deployer address and cannot execute on L1.");
  }
  deployments.l1Anchor = l1Anchor;

  let token: any;
  if (process.env.BOUND_TOKEN) {
    token = await ethers.getContractAt("GTokenL2BbsBoundArb", process.env.BOUND_TOKEN);
  } else {
    token = await (await ethers.getContractFactory("GTokenL2BbsBoundArb")).deploy(
      "Green Token (bound BBS)",
      "GTB",
      verifierAddress,
      l1Anchor,
      ethers.ZeroAddress
    );
    await token.waitForDeployment();
    rows.push(await receiptRow("deploy:GTokenL2BbsBoundArb", -1, token.deploymentTransaction()!.hash, "One-time setup"));
  }
  const tokenAddress: string = await token.getAddress();
  deployments.token = tokenAddress;
  if (l1AnchorContract) {
    const tx = await l1AnchorContract.setConfig(tokenAddress);
    const rc = await tx.wait();
    l1Rows.push({ operation: "anchor.setConfig (L1)", txHash: tx.hash, gasUsed: rc!.gasUsed.toString(), effectiveGasPrice: (rc!.gasPrice ?? 0n).toString() });
  }
  const verifier = await ethers.getContractAt("BbsBls12381Verifier", verifierAddress);
  const domain = await token.issuerDomain();

  console.log(`Verifier ${verifierAddress} | Token ${tokenAddress} | iterations ${repeatCount}`);

  // ---------------------------------------------------------------------------
  // Iterations
  // ---------------------------------------------------------------------------
  const l2ToL1Messages: { iteration: number; l2TxHash: string; msgNum: string }[] = [];
  const readingBase = BigInt(Math.floor(Date.now() / 1000));
  for (let i = 0; i < repeatCount; i++) {
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const recipient = freshRecipient ? ethers.Wallet.createRandom().address : relayer.address;
    const credential = await issueCredential({
      keys,
      header: ledgerHeader(chainId, tokenAddress),
      hidden: { ownerID: `did:example:owner-${i}`, meterID: "meter-56789", siteID: "site-34567" },
      claims: {
        reTypeCode: 1,
        qtyKWh: 100n,
        readingTimestamp: readingBase + BigInt(i),
        serial: randomSerial(),
        expiry: now + 30n * 86_400n,
      },
    });
    const deadline = now + 3600n;
    const ph = mintPresentationHeader({
      chainId,
      token: tokenAddress,
      recipient,
      amount: credential.claims.qtyKWh,
      nullifier: credential.claims.serial,
      deadline,
    });
    const proof = proofToSolidity(await deriveProof({ publicKey: keys.publicKey, credential, presentationHeader: ph }));

    const scalars = await Promise.all(disclosedMessages(credential.claims).map((m) => verifier.messageToScalar(m)));
    const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
    const verifyGas = await verifier.verifyProof.estimateGas(domain, ph, DISCLOSED_INDEXES, scalars, proof);
    rows.push({
      path: PATH_LABEL,
      operation: "verifyProof (estimateGas)",
      iteration: i,
      chainId: chainId.toString(),
      txHash: "-",
      gasUsed: verifyGas.toString(),
      effectiveGasPrice: gasPrice.toString(),
      feeWei: (verifyGas * gasPrice).toString(),
      notes: "Real BBS verification (EIP-2537), L=8, R=5",
    });

    const mintTx = await token.connect(relayer).mintBound(recipient, credential.claims, deadline, proof);
    const mintRc = await mintTx.wait();
    rows.push(await receiptRow("mintBound", i, mintTx.hash, freshRecipient ? "Relayed to fresh pseudonym" : undefined));
    const l2ToL1 = mintRc.logs
      .map((log: any) => {
        try {
          return token.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((ev: any) => ev?.name === "L2ToL1Message");
    if (l2ToL1) l2ToL1Messages.push({ iteration: i, l2TxHash: mintTx.hash, msgNum: l2ToL1.args.msgNum.toString() });

    if (!freshRecipient) {
      const transferTx = await token.connect(relayer).transfer(transferTarget, 1n);
      await transferTx.wait();
      rows.push(await receiptRow("transfer", i, transferTx.hash));
    }
    console.log(`iteration ${i}: mint ${mintTx.hash}`);
  }

  // ---------------------------------------------------------------------------
  // Summary (same schema as benchmark_bbs_arbitrum_sepolia_repeat.ts)
  // ---------------------------------------------------------------------------
  const groups = new Map<string, TxRow[]>();
  for (const r of rows.filter((r) => r.iteration >= 0)) {
    groups.set(r.operation, [...(groups.get(r.operation) ?? []), r]);
  }
  const summary = [...groups.entries()].map(([operation, group]) => {
    const gas = stats(group.map((g) => BigInt(g.gasUsed)));
    const fee = stats(group.map((g) => BigInt(g.feeWei)));
    return {
      path: PATH_LABEL,
      operation,
      samples: group.length,
      avgGas: gas.avg.toString(),
      medianGas: gas.median.toString(),
      p95Gas: gas.p95.toString(),
      avgFeeWei: fee.avg.toString(),
      avgFeeEth: ethers.formatEther(fee.avg),
    };
  });
  console.table(summary);

  const outPath = dryRun
    ? path.join(process.cwd(), "cache", "bench_bbs_bound_dryrun.json")
    : path.join(process.cwd(), "docs", "bench_bbs_bound_arb_sepolia_repeat.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        networks: { l2ChainId: chainId.toString() },
        config: { repeatCount, freshRecipient, relayer: relayer.address, issuerPublicKey: ethers.hexlify(keys.publicKey) },
        deployments,
        l1Rows,
        l2ToL1Messages,
        rows,
        summary,
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
