/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";

const { ChildTransactionReceipt, ChildToParentMessageStatus } = require("@arbitrum/sdk");
const { providers } = require("@arbitrum/sdk/node_modules/ethers");

type StatusRow = {
  l2TxHash: string;
  messageIndex: number;
  statusCode: number;
  status: string;
  executableNow: boolean;
  executed: boolean;
  firstExecutableL1Block: string | null;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseHashesFromEnvOrArgs(): string[] {
  const envValue = process.env.OUTBOX_CHECK_TX_HASHES?.trim();
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

async function main() {
  const sepoliaRpc = requireEnv("SEPOLIA_RPC_URL");
  const arbSepoliaRpc = requireEnv("ARBITRUM_SEPOLIA_RPC_URL");

  const txHashes = parseHashesFromEnvOrArgs().map(validateHash);
  if (txHashes.length === 0) {
    throw new Error(
      "No tx hashes provided. Set OUTBOX_CHECK_TX_HASHES or pass tx hashes as args, or run flow:bbs:arb:auto first."
    );
  }

  // The Arbitrum SDK scans L1 logs over wide block ranges; free-tier provider keys (e.g. Alchemy)
  // cap eth_getLogs at 10 blocks, so allow a separate L1 endpoint for these scripts.
  const l1Provider = new providers.JsonRpcProvider(process.env.OUTBOX_L1_RPC_URL || sepoliaRpc);
  const l2Provider = new providers.JsonRpcProvider(arbSepoliaRpc);

  const rows: StatusRow[] = [];

  for (const txHash of txHashes) {
    const receipt = await l2Provider.getTransactionReceipt(txHash);
    if (!receipt) {
      rows.push({
        l2TxHash: txHash,
        messageIndex: 0,
        statusCode: 0,
        status: "L2_TX_NOT_FOUND",
        executableNow: false,
        executed: false,
        firstExecutableL1Block: null,
      });
      continue;
    }

    const l2TxReceipt = new ChildTransactionReceipt(receipt);
    const messages = await l2TxReceipt.getChildToParentMessages(l1Provider);
    if (messages.length === 0) {
      rows.push({
        l2TxHash: txHash,
        messageIndex: 0,
        statusCode: 0,
        status: "NO_L2_TO_L1_MESSAGE",
        executableNow: false,
        executed: false,
        firstExecutableL1Block: null,
      });
      continue;
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const statusCode = (await message.status(l2Provider)) as number;
      const status = (ChildToParentMessageStatus[statusCode] ?? `UNKNOWN_${statusCode}`) as string;
      let firstBlock: { toString(): string } | null = null;
      try {
        firstBlock = await message.getFirstExecutableBlock(l2Provider);
      } catch {
        // Some RPC plans cap eth_getLogs ranges; status() is still the primary signal we need.
        firstBlock = null;
      }
      const executableNow = statusCode === ChildToParentMessageStatus.CONFIRMED;
      const executed = statusCode === ChildToParentMessageStatus.EXECUTED;

      rows.push({
        l2TxHash: txHash,
        messageIndex: i,
        statusCode,
        status,
        executableNow,
        executed,
        firstExecutableL1Block: firstBlock ? firstBlock.toString() : null,
      });
    }
  }

  console.table(rows);

  const outPath = path.join(process.cwd(), "docs", "arb_sepolia_outbox_status.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        l2TxHashes: txHashes,
        rows,
      },
      null,
      2
    )
  );
  console.log("Wrote:", outPath);
  console.log("Status meaning: UNCONFIRMED=not executable yet, CONFIRMED=executable now, EXECUTED=already executed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
