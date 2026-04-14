# BBS+ L2 Runbook (Automated Arbitrum Sepolia Flow)

This runbook gives you a one-command, real-testnet flow for:

1. Building a real BBS+ VC and selective-disclosure proof off-chain.
2. Deploying L1 anchor contracts on Sepolia.
3. Deploying L2 verifier + mint contracts on Arbitrum Sepolia.
4. Running verify estimate, mint, and transfer on L2.
5. Writing fee/cost receipts to JSON.

## What this automated flow verifies

- Real BBS+ issuance/presentation/verification is performed off-chain in the script.
- Public-chain minting and transfer happen on Arbitrum Sepolia (L2).
- L2->L1 anchor messages are created during mint.
- L1 anchor execution is asynchronous and not immediate.

## 1) Accounts and API keys you need

You need:

1. One EOA private key funded on both Sepolia and Arbitrum Sepolia.
2. Sepolia RPC URL (Alchemy/Infura/QuickNode/etc.; API key is inside the URL).
3. Arbitrum Sepolia RPC URL (Alchemy/Infura/QuickNode/etc.; API key is inside the URL).
4. Arbitrum Sepolia L1 bridge address (from Arbitrum official docs).

Optional:

- Separate issuer key (`ISSUER_PRIVATE_KEY`).
- Separate holder key (`HOLDER_PRIVATE_KEY`).

## 2) Prepare `.env`

```bash
cp .env.example .env
```

Set at minimum:

- `DEPLOYER_PRIVATE_KEY`
- `SEPOLIA_RPC_URL`
- `ARBITRUM_SEPOLIA_RPC_URL`
- `ARBITRUM_L1_BRIDGE`

Recommended:

- `BENCH_RECIPIENT` (if omitted, holder receives and transfers to self)
- `RUN_SNARK_MOCK=true`
- `RUN_STYLUS_SIM=true`
- Optional native Stylus verifier override:
  - `STYLUS_NATIVE_VERIFIER=0x...` (if set, flow uses the deployed Stylus verifier instead of Solidity mock verifier)
- Optional Stylus deploy tuning:
  - `STYLUS_OWNER=0x...`
  - `STYLUS_MAX_FEE_GWEI=0.1`

## 3) Fund wallets

Fund the deployer (and holder if separate) on:

1. Sepolia ETH faucet (for L1 deployment/config txs).
2. Arbitrum Sepolia ETH faucet (for L2 deploy/mint/transfer txs).

Without balance on both networks, the automation will fail mid-run.

## 4) Run automated testnet flow

```bash
npm run flow:bbs:arb:auto
```

Optional: deploy a native Stylus verifier first, then rerun the flow with that address:

```bash
npm run deploy:stylus:bbs:verifier
STYLUS_NATIVE_VERIFIER=0x<deployed_stylus_verifier> npm run flow:bbs:arb:auto
```

This runs both paths (unless toggled off):

1. `solidity-snark-mock-arb`
2. `stylus-native-sim-arb` (default mock verifier), or `stylus-native-arb` when `STYLUS_NATIVE_VERIFIER` is set

Outputs:

- `dataset/bbs_vc.testnet.auto.json`
- `dataset/bbs_presentation.testnet.auto.json`
- `docs/bench_bbs_l2_arb_sepolia_auto.json` (or `AUTO_BBS_REPORT_PATH`)

The JSON report includes:

- Deployed contract addresses.
- Per-operation tx hash, gas used, gas price, and paid fee.
- Verify estimate rows, mint rows, transfer rows.

## 5) Optional: add L1 anchor execution receipt costs later

When an L2->L1 message is eventually executed on Sepolia, set:

- `SNARK_L1_RELAY_TX_HASH` and/or
- `STYLUS_L1_RELAY_TX_HASH` (or `L1_RELAY_TX_HASH`)

Then rerun:

```bash
npm run flow:bbs:arb:auto
```

The script will append L1 execution cost rows from those receipts.

### Check if L2->L1 messages are executable now

```bash
npm run check:arb:outbox
```

Or pass explicit tx hashes:

```bash
npm run check:arb:outbox -- 0x<l2_mint_tx_hash_1> 0x<l2_mint_tx_hash_2>
```

Status meaning:

- `UNCONFIRMED`: not executable yet on L1 Outbox.
- `CONFIRMED`: executable now (safe to execute/claim on L1).
- `EXECUTED`: already executed.

If your RPC plan has strict `eth_getLogs` range limits, use a paid/archival RPC endpoint for this status check.

## 6) Local deterministic benchmark (no funds)

```bash
npm run bench:bbs:local
```

Output:

- `docs/bench_bbs_l2_local.json`

## 7) Repeated Arbitrum Sepolia runtime benchmark (median / p95)

Use this to avoid single-run noise and report statistically stronger numbers.

```bash
npm run bench:bbs:arb:repeat
```

Shortcut commands:

```bash
npm run bench:bbs:arb:repeat:20
npm run bench:bbs:arb:repeat:50
```

Default behavior:

- Uses latest deployment addresses from `docs/bench_bbs_l2_arb_sepolia_auto.json`.
- Runs `BENCH_REPEAT_COUNT=10` iterations per enabled path.
- Writes `docs/bench_bbs_l2_arb_sepolia_repeat.json`.

Useful env overrides:

- `BENCH_REPEAT_COUNT` (e.g., `20`)
- `REPEAT_RUN_SNARK` / `REPEAT_RUN_STYLUS`
- `REPEAT_SNARK_L2_TOKEN`, `REPEAT_SNARK_VERIFIER`
- `REPEAT_STYLUS_L2_TOKEN`, `REPEAT_STYLUS_VERIFIER`
- `STYLUS_OWNER_PRIVATE_KEY` (if stylus verifier owner differs from deployer)

The output includes per-iteration rows and summary statistics:

- average gas
- median gas
- p95 gas
- average fee (wei / ETH)

## Notes

- Minting is L2-only.
- L1 remains anchor-only (no L1 mint path).
- Stylus path can run in 2 modes:
  - default Solidity mock verifier (`stylus-native-sim-arb`)
  - deployed native Stylus verifier (`stylus-native-arb`) when `STYLUS_NATIVE_VERIFIER` is provided
- SNARK path in this automated flow uses mock receipt verification for end-to-end execution. For full RISC Zero Groth16 receipts on-chain, you still need external seal generation/prover integration.
