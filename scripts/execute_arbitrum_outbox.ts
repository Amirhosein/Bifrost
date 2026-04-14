/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";

const { ChildTransactionReceipt, ChildToParentMessageStatus } = require("@arbitrum/sdk");
const { providers, Wallet } = require("@arbitrum/sdk/node_modules/ethers");

type ExecRow = {
  l2TxHash: string;
  messageIndex: number;
  statusCode: number;
  status: string;
  action: "SKIP_UNCONFIRMED" | "SKIP_EXECUTED" | "WOULD_EXECUTE" | "EXECUTED";
  l1TxHash?: string;
  l1GasUsed?: string;
  l1GasPriceWei?: string;
  l1FeeWei?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function parseHashesFromEnvOrArgs(): string[] {
  const envValue = process.env.OUTBOX_EXEC_TX_HASHES?.trim();
  if (envValue) {
    return envValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const args = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
  if (args.length > 0) return args;

  const reportPath = path.join(process.cwd(), "docs", "bench_bbs_l2_arb_sepolia_auto.json");
  if (!fs.existsSync(reportPath)) return [];
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    rows?: Array<{ operation?: string; chainId?: string; txHash?: string }>;
  };
  const hashes = (report.rows ?? [])
    .filter((r) => r.operation === "mintWithBbsProof" && r.chainId === "421614" && !!r.txHash && r.txHash !== "-")
    .map((r) => r.txHash as string);
  return [...new Set(hashes)];
}

function validateHash(h: string): string {
  if (!/^0x([A-Fa-f0-9]{64})$/.test(h)) throw new Error(`Invalid tx hash: ${h}`);
  return h;
}

function toBigIntSafe(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

async function main() {
  const sepoliaRpc = requireEnv("SEPOLIA_RPC_URL");
  const arbSepoliaRpc = requireEnv("ARBITRUM_SEPOLIA_RPC_URL");
  const pk = process.env.L1_EXECUTOR_PRIVATE_KEY || requireEnv("DEPLOYER_PRIVATE_KEY");
  const shouldExecute = parseBoolEnv("OUTBOX_EXECUTE", false);

  const txHashes = parseHashesFromEnvOrArgs().map(validateHash);
  if (txHashes.length === 0) {
    throw new Error(
      "No tx hashes provided. Set OUTBOX_EXEC_TX_HASHES or pass tx hashes as args, or run flow:bbs:arb:auto first."
    );
  }

  const l1Provider = new providers.JsonRpcProvider(sepoliaRpc);
  const l2Provider = new providers.JsonRpcProvider(arbSepoliaRpc);
  const l1Signer = new Wallet(pk, l1Provider);

  const rows: ExecRow[] = [];

  for (const txHash of txHashes) {
    const receipt = await l2Provider.getTransactionReceipt(txHash);
    if (!receipt) {
      rows.push({
        l2TxHash: txHash,
        messageIndex: 0,
        statusCode: -1,
        status: "L2_TX_NOT_FOUND",
        action: "SKIP_UNCONFIRMED",
      });
      continue;
    }

    const l2TxReceipt = new ChildTransactionReceipt(receipt);
    const messages = await l2TxReceipt.getChildToParentMessages(l1Signer);
    if (messages.length === 0) {
      rows.push({
        l2TxHash: txHash,
        messageIndex: 0,
        statusCode: -1,
        status: "NO_L2_TO_L1_MESSAGE",
        action: "SKIP_UNCONFIRMED",
      });
      continue;
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const statusCode = (await message.status(l2Provider)) as number;
      const status = (ChildToParentMessageStatus[statusCode] ?? `UNKNOWN_${statusCode}`) as string;

      if (statusCode === ChildToParentMessageStatus.UNCONFIRMED) {
        rows.push({
          l2TxHash: txHash,
          messageIndex: i,
          statusCode,
          status,
          action: "SKIP_UNCONFIRMED",
        });
        continue;
      }

      if (statusCode === ChildToParentMessageStatus.EXECUTED) {
        rows.push({
          l2TxHash: txHash,
          messageIndex: i,
          statusCode,
          status,
          action: "SKIP_EXECUTED",
        });
        continue;
      }

      if (!shouldExecute) {
        rows.push({
          l2TxHash: txHash,
          messageIndex: i,
          statusCode,
          status,
          action: "WOULD_EXECUTE",
        });
        continue;
      }

      const tx = await message.execute(l2Provider);
      const rc = await tx.wait();
      if (!rc) throw new Error(`No L1 receipt for outbox execution ${tx.hash}`);
      const gasUsed = toBigIntSafe(rc.gasUsed);
      const gasPrice = toBigIntSafe((rc as { effectiveGasPrice?: unknown }).effectiveGasPrice ?? rc.gasPrice ?? 0n);

      rows.push({
        l2TxHash: txHash,
        messageIndex: i,
        statusCode,
        status,
        action: "EXECUTED",
        l1TxHash: tx.hash,
        l1GasUsed: gasUsed.toString(),
        l1GasPriceWei: gasPrice.toString(),
        l1FeeWei: (gasUsed * gasPrice).toString(),
      });
    }
  }

  console.table(rows);

  const outPath = path.join(process.cwd(), "docs", "arb_sepolia_outbox_execute.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        shouldExecute,
        l1Executor: l1Signer.address,
        l2TxHashes: txHashes,
        rows,
      },
      null,
      2
    )
  );
  console.log("Wrote:", outPath);
  if (!shouldExecute) {
    console.log("Dry-run mode (OUTBOX_EXECUTE != true): no L1 execution tx was sent.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
