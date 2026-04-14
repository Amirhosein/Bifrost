/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

type NetRow = {
  path: string;
  operation: string;
  txHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  feeWei: string;
  chainId: string;
  notes?: string;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

async function rowFromTx(pathLabel: string, operation: string, chainId: bigint, tx: any, notes?: string): Promise<NetRow> {
  const rc = await tx.wait();
  const gasUsed = rc.gasUsed as bigint;
  const egp = (rc.effectiveGasPrice ?? 0n) as bigint;
  return {
    path: pathLabel,
    operation,
    txHash: tx.hash,
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: egp.toString(),
    feeWei: (gasUsed * egp).toString(),
    chainId: chainId.toString(),
    notes,
  };
}

async function runPath(
  pathLabel: string,
  tokenAddr: string,
  proofHex: string,
  zkSealHex: string,
  claims: {
    reTypeCode: number;
    qtyKWh: bigint;
    readingTimestamp: number;
    credentialIdHash: `0x${string}`;
    expiry: bigint;
  }
): Promise<NetRow[]> {
  const [holder] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const token = await ethers.getContractAt("GTokenL2BbsSnark", tokenAddr);
  const proof = ethers.getBytes(proofHex);
  const zkSeal = zkSealHex === "0x" ? "0x" : ethers.getBytes(zkSealHex);

  const rows: NetRow[] = [];
  rows.push(
    await rowFromTx(
      pathLabel,
      "mintWithBbsProof",
      net.chainId,
      token.connect(holder).mintWithBbsProof(claims, proof, zkSeal),
      "L2 mint and authorization verification"
    )
  );
  rows.push(
    await rowFromTx(
      pathLabel,
      "transfer",
      net.chainId,
      token.connect(holder).transfer(requireEnv("BENCH_RECIPIENT"), 1n),
      "Post-mint transfer benchmark"
    )
  );
  return rows;
}

async function maybeLoadL1RelayRow(rows: NetRow[]) {
  const l1RelayTxHash = process.env.L1_RELAY_TX_HASH;
  const sepoliaRpc = process.env.SEPOLIA_RPC_URL;
  if (!l1RelayTxHash || !sepoliaRpc) return;

  const provider = new ethers.JsonRpcProvider(sepoliaRpc);
  const rc = await provider.getTransactionReceipt(l1RelayTxHash);
  if (!rc) return;

  const tx = await provider.getTransaction(l1RelayTxHash);
  const egp = (rc.effectiveGasPrice ?? tx?.gasPrice ?? 0n) as bigint;
  const gasUsed = rc.gasUsed as bigint;

  rows.push({
    path: "common",
    operation: "L1 anchor execution (receipt lookup)",
    txHash: l1RelayTxHash,
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: egp.toString(),
    feeWei: (gasUsed * egp).toString(),
    chainId: rc.chainId.toString(),
    notes: "Provided via L1_RELAY_TX_HASH",
  });
}

async function main() {
  const l2Net = await ethers.provider.getNetwork();
  console.log("Running benchmark on:", l2Net.name, l2Net.chainId.toString());

  const claims = {
    reTypeCode: Number(requireEnv("RE_TYPE_CODE")),
    qtyKWh: BigInt(requireEnv("QTY_KWH")),
    readingTimestamp: Number(requireEnv("READING_TIMESTAMP")),
    credentialIdHash: requireEnv("CREDENTIAL_ID_HASH") as `0x${string}`,
    expiry: BigInt(requireEnv("EXPIRY")),
  };

  const rows: NetRow[] = [];

  const snarkToken = process.env.BBS_SNARK_L2_TOKEN;
  if (snarkToken) {
    const proofHex = requireEnv("BBS_SNARK_PROOF_HEX");
    const zkSealHex = requireEnv("BBS_SNARK_ZK_SEAL_HEX");
    rows.push(...(await runPath("solidity-snark", snarkToken, proofHex, zkSealHex, claims)));
  }

  const stylusToken = process.env.BBS_STYLUS_L2_TOKEN;
  if (stylusToken) {
    const proofHex = requireEnv("BBS_STYLUS_PROOF_HEX");
    const zkSealHex = process.env.BBS_STYLUS_ZK_SEAL_HEX ?? "0x";
    rows.push(...(await runPath("stylus-native", stylusToken, proofHex, zkSealHex, claims)));
  }

  await maybeLoadL1RelayRow(rows);

  console.table(rows);
  const outPath = path.join(process.cwd(), "docs", "bench_bbs_l2_arb_sepolia.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        l2ChainId: l2Net.chainId.toString(),
        claims: {
          ...claims,
          qtyKWh: claims.qtyKWh.toString(),
          expiry: claims.expiry.toString(),
        },
        rows,
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

