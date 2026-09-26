/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { ethers } from "ethers";
import {
  blsCreateProof,
  blsSign,
  blsVerifyProof,
  generateBls12381G2KeyPair,
} from "@mattrglobal/bbs-signatures";
import { redactRpcUrl } from "./lib/redact";

type Claims = {
  reTypeCode: number;
  qtyKWh: bigint;
  readingTimestamp: number;
  credentialIdHash: `0x${string}`;
  expiry: bigint;
};

type TxRow = {
  path: string;
  operation: string;
  chainId: string;
  txHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  feeWei: string;
  notes?: string;
};

type PathDeployment = {
  path: string;
  l1Anchor: string;
  l2Verifier: string;
  l2Token: string;
  claimId: string;
  l2ToL1MsgNum?: string;
};

type BbsBuildResult = {
  claims: Claims;
  bbsProofHex: `0x${string}`;
  vcPath: string;
  presentationPath: string;
  reType: string;
  qtyKWhText: string;
  timestampIso: string;
};

const RE_TYPE_CODE_BY_NAME: Record<string, number> = {
  solar: 1,
  wind: 2,
  hydro: 3,
  geothermal: 4,
  biomass: 5,
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function parseNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number in ${name}: ${value}`);
  return parsed;
}

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  return BigInt(value);
}

function requireAddress(name: string): `0x${string}` {
  const value = requireEnv(name);
  return normalizeAddress(name, value);
}

function ensureAddress(name: string, value: string): `0x${string}` {
  return normalizeAddress(name, value);
}

function maybeAddress(name: string): `0x${string}` | undefined {
  const value = process.env[name];
  if (!value || !value.trim()) return undefined;
  return normalizeAddress(name, value);
}

function normalizeAddress(name: string, value: string): `0x${string}` {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  // Accept non-checksummed mixed-case user input by canonicalizing through lowercase.
  return ethers.getAddress(trimmed.toLowerCase()) as `0x${string}`;
}

function toUtf8Bytes(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "utf8"));
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return ethers.hexlify(bytes) as `0x${string}`;
}

function fromHex(hex: string): Uint8Array {
  return ethers.getBytes(hex);
}

function rowFromReceipt(
  pathLabel: string,
  operation: string,
  chainId: bigint,
  txHash: string,
  receipt: ethers.TransactionReceipt,
  notes?: string
): TxRow {
  const anyReceipt = receipt as ethers.TransactionReceipt & {
    effectiveGasPrice?: bigint;
  };
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = anyReceipt.effectiveGasPrice ?? receipt.gasPrice ?? 0n;
  return {
    path: pathLabel,
    operation,
    chainId: chainId.toString(),
    txHash,
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    feeWei: (gasUsed * effectiveGasPrice).toString(),
    notes,
  };
}

async function waitAndRow(
  pathLabel: string,
  operation: string,
  chainId: bigint,
  txPromise: Promise<ethers.ContractTransactionResponse>,
  rows: TxRow[],
  notes?: string
): Promise<ethers.TransactionReceipt> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`No receipt for ${operation}`);
  rows.push(rowFromReceipt(pathLabel, operation, chainId, tx.hash, receipt, notes));
  return receipt;
}

async function deployContract(
  contractName: string,
  args: unknown[],
  signer: ethers.Signer,
  chainId: bigint,
  rows: TxRow[],
  pathLabel: string
): Promise<ethers.Contract> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const deployTx = contract.deploymentTransaction();
  if (!deployTx) throw new Error(`Missing deployment tx for ${contractName}`);
  const receipt = await deployTx.wait();
  if (!receipt) throw new Error(`No deployment receipt for ${contractName}`);
  rows.push(
    rowFromReceipt(
      pathLabel,
      `deploy:${contractName}`,
      chainId,
      deployTx.hash,
      receipt,
      "Deployment cost"
    )
  );
  return contract;
}

function resolveReTypeCode(reType: string): number {
  const explicit = process.env.RE_TYPE_CODE;
  if (explicit) return Number(explicit);
  return RE_TYPE_CODE_BY_NAME[reType.toLowerCase()] ?? 1;
}

function deriveReadingTimestamp(): { readingTimestamp: number; timestampIso: string } {
  const readingTsEnv = process.env.READING_TIMESTAMP;
  const bbsTimestampEnv = process.env.BBS_TIMESTAMP;

  if (readingTsEnv) {
    const readingTimestamp = Number(readingTsEnv);
    if (!Number.isFinite(readingTimestamp) || readingTimestamp <= 0) {
      throw new Error(`Invalid READING_TIMESTAMP: ${readingTsEnv}`);
    }
    const timestampIso = bbsTimestampEnv ?? new Date(readingTimestamp * 1000).toISOString();
    return { readingTimestamp, timestampIso };
  }

  const timestampIso = bbsTimestampEnv ?? "2025-02-15T12:00:00Z";
  const parsedMillis = Date.parse(timestampIso);
  if (Number.isNaN(parsedMillis)) throw new Error(`Invalid BBS_TIMESTAMP: ${timestampIso}`);
  return { readingTimestamp: Math.floor(parsedMillis / 1000), timestampIso };
}

async function assertValidArbitrumBridge(l1Provider: ethers.JsonRpcProvider, bridgeAddress: string) {
  const code = await l1Provider.getCode(bridgeAddress);
  if (code === "0x") {
    throw new Error(
      `ARBITRUM_L1_BRIDGE ${bridgeAddress} has no contract code on Sepolia. Set the real Arbitrum bridge contract address.`
    );
  }

  const iface = new ethers.Interface(["function activeOutbox() view returns (address)"]);
  try {
    const ret = await l1Provider.call({
      to: bridgeAddress,
      data: iface.encodeFunctionData("activeOutbox"),
    });
    iface.decodeFunctionResult("activeOutbox", ret);
  } catch {
    throw new Error(
      `ARBITRUM_L1_BRIDGE ${bridgeAddress} does not respond to activeOutbox(). Check the configured bridge address.`
    );
  }
}

async function buildBbsArtifacts(): Promise<BbsBuildResult> {
  const ownerID = envOr("BBS_OWNER_ID", "did:example:owner789");
  const meterID = envOr("BBS_METER_ID", "meter-56789");
  const siteID = envOr("BBS_SITE_ID", "site-34567");
  const reType = envOr("BBS_RE_TYPE", "Solar");
  const qtyKWhText = envOr("QTY_KWH", envOr("BBS_QTY_KWH", "100"));
  const { readingTimestamp, timestampIso } = deriveReadingTimestamp();
  const vcId = envOr("BBS_VC_ID", "urn:uuid:green-credit-vc-auto");
  const issuerDid = envOr("BBS_ISSUER_DID", "did:example:registry");
  const nonceText = envOr("BBS_NONCE", "green-credit-bbs-auto-nonce-v1");

  const vc = {
    id: vcId,
    type: ["VerifiableCredential", "RenewableEnergyVC"],
    issuer: issuerDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      ownerID,
      meterID,
      siteID,
      reType,
      qtyKWh: qtyKWhText,
      timestamp: timestampIso,
    },
  };

  const credentialIdHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(vc)));

  const messageOrder = [
    "ownerID",
    "meterID",
    "siteID",
    "reType",
    "qtyKWh",
    "timestamp",
    "credentialIdHash",
  ];
  const messages = [
    toUtf8Bytes(ownerID),
    toUtf8Bytes(meterID),
    toUtf8Bytes(siteID),
    toUtf8Bytes(reType),
    toUtf8Bytes(qtyKWhText),
    toUtf8Bytes(timestampIso),
    fromHex(credentialIdHash),
  ];

  const keyPair = await generateBls12381G2KeyPair();
  const signature = await blsSign({ keyPair, messages });
  const revealIndices = [3, 4, 5, 6];
  const nonce = toUtf8Bytes(nonceText);
  const proof = await blsCreateProof({
    signature,
    publicKey: keyPair.publicKey,
    messages,
    nonce,
    revealed: revealIndices,
  });

  const proofVerification = await blsVerifyProof({
    proof,
    publicKey: keyPair.publicKey,
    nonce,
    messages: [messages[3], messages[4], messages[5], messages[6]],
  });
  if (!proofVerification.verified) {
    throw new Error("Generated BBS proof did not verify off-chain");
  }

  const vcPath = path.join(process.cwd(), "dataset", "bbs_vc.testnet.auto.json");
  const presentationPath = path.join(process.cwd(), "dataset", "bbs_presentation.testnet.auto.json");
  fs.mkdirSync(path.dirname(vcPath), { recursive: true });

  fs.writeFileSync(
    vcPath,
    JSON.stringify(
      {
        issuer: {
          publicKeyHex: toHex(keyPair.publicKey),
        },
        vc,
        credentialIdHash,
        messageOrder,
        messagesHex: messages.map((m) => toHex(m)),
        signatureHex: toHex(signature),
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    presentationPath,
    JSON.stringify(
      {
        source: path.relative(process.cwd(), vcPath),
        revealIndices,
        revealedFieldNames: revealIndices.map((i) => messageOrder[i]),
        revealedValues: {
          reType,
          qtyKWh: qtyKWhText,
          timestamp: timestampIso,
          credentialIdHash,
        },
        nonceHex: toHex(nonce),
        publicKeyHex: toHex(keyPair.publicKey),
        proofHex: toHex(proof),
      },
      null,
      2
    )
  );

  const now = Math.floor(Date.now() / 1000);
  const defaultExpiry = BigInt(now + parseNumberEnv("EXPIRY_SECONDS", 3600));
  const expiry = parseBigIntEnv("EXPIRY", defaultExpiry);

  return {
    claims: {
      reTypeCode: resolveReTypeCode(reType),
      qtyKWh: BigInt(qtyKWhText),
      readingTimestamp,
      credentialIdHash: credentialIdHash as `0x${string}`,
      expiry,
    },
    bbsProofHex: toHex(proof),
    vcPath,
    presentationPath,
    reType,
    qtyKWhText,
    timestampIso,
  };
}

async function loadRelayRow(
  rows: TxRow[],
  provider: ethers.JsonRpcProvider,
  pathLabel: string,
  txHash: string
) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return;
  const tx = await provider.getTransaction(txHash);
  const network = await provider.getNetwork();
  const effectiveGasPrice = receipt.gasPrice ?? tx?.gasPrice ?? 0n;
  const gasUsed = receipt.gasUsed;
  rows.push({
    path: pathLabel,
    operation: "L1 anchor execution (receipt lookup)",
    chainId: network.chainId.toString(),
    txHash,
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    feeWei: (gasUsed * effectiveGasPrice).toString(),
    notes: "Manual relay tx lookup; set *_L1_RELAY_TX_HASH",
  });
}

async function runSnarkPath(params: {
  bridgeAddress: `0x${string}`;
  registryAdmin: `0x${string}`;
  holder: ethers.Wallet;
  recipient: `0x${string}`;
  issuer: ethers.Wallet;
  l1Deployer: ethers.Wallet;
  l2Deployer: ethers.Wallet;
  l1ChainId: bigint;
  l2ChainId: bigint;
  claims: Claims;
  bbsProofHex: `0x${string}`;
  rows: TxRow[];
}): Promise<PathDeployment> {
  const pathLabel = "solidity-snark-mock-arb";
  const claims = params.claims;
  const bbsProof = fromHex(params.bbsProofHex);

  const l1Anchor = await deployContract(
    "GTokenAnchorArb",
    [params.bridgeAddress, ethers.ZeroAddress],
    params.l1Deployer,
    params.l1ChainId,
    params.rows,
    pathLabel
  );

  const verifier = await deployContract(
    "MockBbsSnarkVerifier",
    [params.issuer.address],
    params.l2Deployer,
    params.l2ChainId,
    params.rows,
    pathLabel
  );

  const token = await deployContract(
    "GTokenL2BbsSnarkArb",
    [
      "GreenToken",
      "GT",
      await verifier.getAddress(),
      await l1Anchor.getAddress(),
      params.registryAdmin,
    ],
    params.l2Deployer,
    params.l2ChainId,
    params.rows,
    pathLabel
  );

  await waitAndRow(
    pathLabel,
    "anchor.setConfig",
    params.l1ChainId,
    l1Anchor.connect(params.l1Deployer).setConfig(await token.getAddress()),
    params.rows,
    "Authorize L2 sender on L1 anchor"
  );

  const verifierForDigest = verifier.connect(params.holder);
  const digest = (await verifierForDigest.digest(params.holder.address, claims, bbsProof)) as `0x${string}`;
  const zkSeal = await params.issuer.signMessage(fromHex(digest));

  const verifyEstimate = await verifierForDigest.verifyForMint.estimateGas(
    params.holder.address,
    claims,
    bbsProof,
    zkSeal
  );
  params.rows.push({
    path: pathLabel,
    operation: "verifyForMint (estimateGas)",
    chainId: params.l2ChainId.toString(),
    txHash: "-",
    gasUsed: verifyEstimate.toString(),
    effectiveGasPrice: "0",
    feeWei: "0",
    notes: "Mock SNARK verifier estimate",
  });

  const mintReceipt = await waitAndRow(
    pathLabel,
    "mintWithBbsProof",
    params.l2ChainId,
    token.connect(params.holder).mintWithBbsProof(claims, bbsProof, zkSeal),
    params.rows,
    "L2 verify + mint + sendTxToL1"
  );

  let l2ToL1MsgNum: string | undefined;
  for (const log of mintReceipt.logs) {
    try {
      const parsed = token.interface.parseLog(log);
      if (parsed?.name === "L2ToL1Message") {
        l2ToL1MsgNum = parsed.args[0].toString();
      }
    } catch {
      // ignore unrelated logs
    }
  }

  await waitAndRow(
    pathLabel,
    "transfer",
    params.l2ChainId,
    token.connect(params.holder).transfer(params.recipient, 1n),
    params.rows,
    "Post-mint transfer benchmark"
  );

  const claimId = (await token.computeClaimId(claims)) as `0x${string}`;
  return {
    path: pathLabel,
    l1Anchor: await l1Anchor.getAddress(),
    l2Verifier: await verifier.getAddress(),
    l2Token: await token.getAddress(),
    claimId,
    l2ToL1MsgNum,
  };
}

async function runStylusSimPath(params: {
  bridgeAddress: `0x${string}`;
  registryAdmin: `0x${string}`;
  stylusVerifierAddress?: `0x${string}`;
  holder: ethers.Wallet;
  recipient: `0x${string}`;
  l1Deployer: ethers.Wallet;
  l2Deployer: ethers.Wallet;
  l2Provider: ethers.JsonRpcProvider;
  l1ChainId: bigint;
  l2ChainId: bigint;
  claims: Claims;
  bbsProofHex: `0x${string}`;
  rows: TxRow[];
}): Promise<PathDeployment> {
  const pathLabel = params.stylusVerifierAddress ? "stylus-native-arb" : "stylus-native-sim-arb";
  const claims = params.claims;
  const bbsProof = fromHex(params.bbsProofHex);

  const l1Anchor = await deployContract(
    "GTokenAnchorArb",
    [params.bridgeAddress, ethers.ZeroAddress],
    params.l1Deployer,
    params.l1ChainId,
    params.rows,
    pathLabel
  );

  const stylusVerifierArtifact = await hre.artifacts.readArtifact("MockBbsStylusNativeVerifier");
  const verifier = params.stylusVerifierAddress
    ? new ethers.Contract(params.stylusVerifierAddress, stylusVerifierArtifact.abi, params.l2Provider)
    : await deployContract(
        "MockBbsStylusNativeVerifier",
        [],
        params.l2Deployer,
        params.l2ChainId,
        params.rows,
        pathLabel
      );

  if (params.stylusVerifierAddress) {
    params.rows.push({
      path: pathLabel,
      operation: "use:StylusNativeVerifier",
      chainId: params.l2ChainId.toString(),
      txHash: "-",
      gasUsed: "0",
      effectiveGasPrice: "0",
      feeWei: "0",
      notes: `Using deployed Stylus verifier at ${params.stylusVerifierAddress}`,
    });
  }

  const token = await deployContract(
    "GTokenL2BbsSnarkArb",
    [
      "GreenTokenStylus",
      "GTS",
      await verifier.getAddress(),
      await l1Anchor.getAddress(),
      params.registryAdmin,
    ],
    params.l2Deployer,
    params.l2ChainId,
    params.rows,
    pathLabel
  );

  await waitAndRow(
    pathLabel,
    "anchor.setConfig",
    params.l1ChainId,
    l1Anchor.connect(params.l1Deployer).setConfig(await token.getAddress()),
    params.rows,
    "Authorize L2 sender on L1 anchor"
  );

  const verifierAsOwner = verifier.connect(params.l2Deployer);
  const digest = (await verifierAsOwner.digest(params.holder.address, claims, bbsProof)) as `0x${string}`;
  await waitAndRow(
    pathLabel,
    "setDigestApproval",
    params.l2ChainId,
    verifierAsOwner.setDigestApproval(digest, true),
    params.rows,
    "Stylus native simulation approval"
  );

  const verifyEstimate = await verifier.connect(params.holder).verifyForMint.estimateGas(
    params.holder.address,
    claims,
    bbsProof,
    "0x"
  );
  params.rows.push({
    path: pathLabel,
    operation: "verifyForMint (estimateGas)",
    chainId: params.l2ChainId.toString(),
    txHash: "-",
    gasUsed: verifyEstimate.toString(),
    effectiveGasPrice: "0",
    feeWei: "0",
    notes: "Stylus native simulation verifier estimate",
  });

  const mintReceipt = await waitAndRow(
    pathLabel,
    "mintWithBbsProof",
    params.l2ChainId,
    token.connect(params.holder).mintWithBbsProof(claims, bbsProof, "0x"),
    params.rows,
    "L2 verify + mint + sendTxToL1"
  );

  let l2ToL1MsgNum: string | undefined;
  for (const log of mintReceipt.logs) {
    try {
      const parsed = token.interface.parseLog(log);
      if (parsed?.name === "L2ToL1Message") {
        l2ToL1MsgNum = parsed.args[0].toString();
      }
    } catch {
      // ignore unrelated logs
    }
  }

  await waitAndRow(
    pathLabel,
    "transfer",
    params.l2ChainId,
    token.connect(params.holder).transfer(params.recipient, 1n),
    params.rows,
    "Post-mint transfer benchmark"
  );

  const claimId = (await token.computeClaimId(claims)) as `0x${string}`;
  return {
    path: pathLabel,
    l1Anchor: await l1Anchor.getAddress(),
    l2Verifier: await verifier.getAddress(),
    l2Token: await token.getAddress(),
    claimId,
    l2ToL1MsgNum,
  };
}

async function main() {
  const sepoliaRpc = requireEnv("SEPOLIA_RPC_URL");
  const arbSepoliaRpc = requireEnv("ARBITRUM_SEPOLIA_RPC_URL");
  const deployerPk = requireEnv("DEPLOYER_PRIVATE_KEY");
  const bridgeAddress = requireAddress("ARBITRUM_L1_BRIDGE");

  const l1Provider = new ethers.JsonRpcProvider(sepoliaRpc);
  const l2Provider = new ethers.JsonRpcProvider(arbSepoliaRpc);

  const l1Network = await l1Provider.getNetwork();
  const l2Network = await l2Provider.getNetwork();

  const strictChains = !parseBoolEnv("ALLOW_NON_STANDARD_CHAIN", false);
  if (strictChains) {
    if (l1Network.chainId !== 11155111n) {
      throw new Error(`Expected Sepolia chainId 11155111, got ${l1Network.chainId.toString()}`);
    }
    if (l2Network.chainId !== 421614n) {
      throw new Error(`Expected Arbitrum Sepolia chainId 421614, got ${l2Network.chainId.toString()}`);
    }
  }

  await assertValidArbitrumBridge(l1Provider, bridgeAddress);

  const l1Deployer = new ethers.Wallet(deployerPk, l1Provider);
  const l2Deployer = new ethers.Wallet(deployerPk, l2Provider);
  const issuer = new ethers.Wallet(envOr("ISSUER_PRIVATE_KEY", deployerPk), l2Provider);
  const holder = new ethers.Wallet(envOr("HOLDER_PRIVATE_KEY", deployerPk), l2Provider);

  const recipient = process.env.BENCH_RECIPIENT
    ? ensureAddress("BENCH_RECIPIENT", process.env.BENCH_RECIPIENT)
    : (holder.address as `0x${string}`);
  const registryAdmin = process.env.REGISTRY_ADMIN
    ? ensureAddress("REGISTRY_ADMIN", process.env.REGISTRY_ADMIN)
    : (l2Deployer.address as `0x${string}`);
  const stylusVerifierAddress = maybeAddress("STYLUS_NATIVE_VERIFIER");

  console.log("L1 chainId:", l1Network.chainId.toString(), "| RPC host:", redactRpcUrl(sepoliaRpc));
  console.log("L2 chainId:", l2Network.chainId.toString(), "| RPC host:", redactRpcUrl(arbSepoliaRpc));
  console.log("L1 deployer:", l1Deployer.address);
  console.log("L2 deployer:", l2Deployer.address);
  console.log("Issuer:", issuer.address);
  console.log("Holder:", holder.address);
  console.log("Recipient:", recipient);
  console.log("Arbitrum L1 bridge:", bridgeAddress);

  const [l1Balance, l2DeployerBalance, l2HolderBalance] = await Promise.all([
    l1Provider.getBalance(l1Deployer.address),
    l2Provider.getBalance(l2Deployer.address),
    l2Provider.getBalance(holder.address),
  ]);
  console.log("L1 deployer ETH:", ethers.formatEther(l1Balance));
  console.log("L2 deployer ETH:", ethers.formatEther(l2DeployerBalance));
  console.log("L2 holder ETH:", ethers.formatEther(l2HolderBalance));

  if (l1Balance === 0n) {
    throw new Error(`L1 deployer ${l1Deployer.address} has 0 ETH on Sepolia`);
  }
  if (l2DeployerBalance === 0n) {
    throw new Error(`L2 deployer ${l2Deployer.address} has 0 ETH on Arbitrum Sepolia`);
  }
  if (l2HolderBalance === 0n) {
    throw new Error(`L2 holder ${holder.address} has 0 ETH on Arbitrum Sepolia`);
  }

  const bbs = await buildBbsArtifacts();
  console.log("BBS VC file:", bbs.vcPath);
  console.log("BBS presentation file:", bbs.presentationPath);
  console.log("Claims:", bbs.claims);

  const rows: TxRow[] = [];
  const deployments: PathDeployment[] = [];

  const runSnark = parseBoolEnv("RUN_SNARK_MOCK", true);
  const runStylus = parseBoolEnv("RUN_STYLUS_SIM", true);
  if (!runSnark && !runStylus) {
    throw new Error("Both RUN_SNARK_MOCK and RUN_STYLUS_SIM are false. Nothing to run.");
  }

  if (runSnark) {
    deployments.push(
      await runSnarkPath({
        bridgeAddress,
        registryAdmin,
        holder,
        recipient,
        issuer,
        l1Deployer,
        l2Deployer,
        l1ChainId: l1Network.chainId,
        l2ChainId: l2Network.chainId,
        claims: bbs.claims,
        bbsProofHex: bbs.bbsProofHex,
        rows,
      })
    );
  }

  if (runStylus) {
    deployments.push(
      await runStylusSimPath({
        bridgeAddress,
        registryAdmin,
        stylusVerifierAddress,
        holder,
        recipient,
        l1Deployer,
        l2Deployer,
        l2Provider,
        l1ChainId: l1Network.chainId,
        l2ChainId: l2Network.chainId,
        claims: bbs.claims,
        bbsProofHex: bbs.bbsProofHex,
        rows,
      })
    );
  }

  const l1RelayCommon = process.env.L1_RELAY_TX_HASH;
  if (l1RelayCommon) {
    await loadRelayRow(rows, l1Provider, "common", l1RelayCommon);
  }
  const l1RelaySnark = process.env.SNARK_L1_RELAY_TX_HASH;
  if (l1RelaySnark) {
    await loadRelayRow(rows, l1Provider, "solidity-snark-mock-arb", l1RelaySnark);
  }
  const l1RelayStylus = process.env.STYLUS_L1_RELAY_TX_HASH;
  if (l1RelayStylus) {
    const stylusPathLabel =
      deployments.find((d) => d.path === "stylus-native-arb")?.path ??
      deployments.find((d) => d.path === "stylus-native-sim-arb")?.path ??
      "stylus-native-sim-arb";
    await loadRelayRow(rows, l1Provider, stylusPathLabel, l1RelayStylus);
  }

  const reportPath = envOr(
    "AUTO_BBS_REPORT_PATH",
    path.join("docs", "bench_bbs_l2_arb_sepolia_auto.json")
  );
  const absoluteReportPath = path.isAbsolute(reportPath)
    ? reportPath
    : path.join(process.cwd(), reportPath);
  fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });

  const output = {
    generatedAt: new Date().toISOString(),
    runMode: "arbitrum-sepolia-bbs-auto",
    networks: {
      l1: { chainId: l1Network.chainId.toString(), rpcHost: redactRpcUrl(sepoliaRpc) },
      l2: { chainId: l2Network.chainId.toString(), rpcHost: redactRpcUrl(arbSepoliaRpc) },
    },
    actors: {
      l1Deployer: l1Deployer.address,
      l2Deployer: l2Deployer.address,
      issuer: issuer.address,
      holder: holder.address,
      recipient,
      registryAdmin,
    },
    claims: {
      ...bbs.claims,
      qtyKWh: bbs.claims.qtyKWh.toString(),
      expiry: bbs.claims.expiry.toString(),
      reTypeText: bbs.reType,
      qtyKWhText: bbs.qtyKWhText,
      timestampIso: bbs.timestampIso,
    },
    artifacts: {
      // Repo-relative so the committed report does not expose local usernames/paths.
      vcPath: path.relative(process.cwd(), bbs.vcPath),
      presentationPath: path.relative(process.cwd(), bbs.presentationPath),
    },
    deployments,
    rows,
  };
  fs.writeFileSync(absoluteReportPath, JSON.stringify(output, null, 2));

  console.table(rows);
  console.log("Deployments:", deployments);
  console.log("Wrote report:", absoluteReportPath);
  console.log(
    "Note: L2->L1 messages are created during mint, but L1 anchor execution happens later via Outbox."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
