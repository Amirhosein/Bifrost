# Privacy-Preserving Green Credits on L2 (Arbitrum Sepolia)

This repository implements an end-to-end engineering prototype for the public-chain side of the Green Token methodology:

- selective-disclosure-oriented credential flow (BBS+ off-chain artifacts),
- L2 verification and minting on Arbitrum Sepolia,
- L1 anchor-only audit trail on Ethereum Sepolia via Arbitrum outbox,
- reproducible local and testnet benchmarking (including repeated runs with average/median/p95).

The project also contains legacy/local demo paths and OP-Stack style anchor contracts for comparison.

## What this project does today

### Core delivered functionality

1. Mints ERC-20 green-credit tokens on L2 after verifier-gated authorization.
2. Enforces duplicate-prevention at contract level.
3. Emits L2->L1 anchor messages and supports outbox monitoring/execution.
4. Runs in both local deterministic mode and live Sepolia/Arbitrum Sepolia mode.
5. Produces JSON benchmark artifacts suitable for reporting.

### Important implementation status

1. Off-chain BBS+ issuance, presentation generation, and verification are implemented.
2. Public-chain flow is implemented and benchmarked on real testnets.
3. Current verifier harness for benchmark comparison is still non-production cryptographic semantics:
- SNARK track uses mock receipt/verifier semantics.
- Stylus-native track currently uses digest-approval semantics, not full native BBS+ pairing verification.

So this repo is a strong system-level and cost-baseline implementation, while full production cryptographic on-chain verification remains the next milestone.

## Architecture

### Layers and responsibilities

1. Private/pre-validation domain (`contracts/private`)
- `MetReg.sol`: meter registry/status controls.
- `DataVer.sol`: commitment/verdict/VC-hash indexing.

2. L2 execution domain (`contracts/l2`)
- `GTokenL2*.sol`: verifier-gated minting + duplicate prevention + L2->L1 message emission.
- `GTokenL2BbsSnark*.sol`: BBS-claim model mint path.

3. L1 audit domain (`contracts/l1`)
- `GTokenAnchor.sol`: generic xDomain anchor pattern.
- `GTokenAnchorArb.sol`: Arbitrum bridge/outbox authenticated anchor pattern.

4. Verifier contracts (`contracts/verifiers`)
- mock SNARK/stylus verifier contracts for controlled measurement.
- RISC Zero adapter interface scaffold.

5. Stylus workspace (`stylus/`)
- native Rust verifier workspace and deploy tooling.

### BBS disclosed claim model used by L2 mint

`BbsDisclosedClaims`:

- `reTypeCode` (`uint16`)
- `qtyKWh` (`uint256`)
- `readingTimestamp` (`uint64`)
- `credentialIdHash` (`bytes32`)
- `expiry` (`uint64`)

Duplicate-prevention key:

- `usedCredential[credentialIdHash]`

Anchor claim key:

- `claimId = keccak256(credentialIdHash, reTypeCode, qtyKWh, readingTimestamp)`

### Repository map

- `contracts/`: Solidity contracts (private/L2/L1/interfaces/mocks/verifiers)
- `scripts/`: deployment, flow orchestration, benchmark, outbox utilities
- `test/`: Hardhat test coverage
- `stylus/`: Rust Stylus projects and scaffolding
- `dataset/`: generated VC/presentation artifacts
- `docs/`: benchmark/outbox/report JSON and LaTeX report

## Prerequisites

1. Node.js (LTS recommended)
2. npm
3. For Stylus native deployment path:
- Rust + Cargo
- `cargo-stylus`

### Install

```bash
npm install
```

### Quick local validation

```bash
npm run clean
npm test
```

Optional local demos:

```bash
npm run demo:v2
npm run demo:arb:mock
npm run gas:v2
```

### Environment configuration

Create local config:

```bash
cp .env.example .env
```

Minimum required for Arbitrum Sepolia automation:

1. `DEPLOYER_PRIVATE_KEY`
2. `SEPOLIA_RPC_URL`
3. `ARBITRUM_SEPOLIA_RPC_URL`
4. `ARBITRUM_L1_BRIDGE`

Common optional variables:

1. `ISSUER_PRIVATE_KEY`, `HOLDER_PRIVATE_KEY`
2. `BENCH_RECIPIENT`
3. `RUN_SNARK_MOCK`, `RUN_STYLUS_SIM`
4. `STYLUS_NATIVE_VERIFIER` (use deployed stylus verifier instead of solidity mock)
5. `BENCH_REPEAT_COUNT` and repeat-path overrides

Reference: [docs/bbs_l2_runbook.md](docs/bbs_l2_runbook.md)

## Main workflows

### 1) BBS artifact generation (off-chain)

```bash
npm run bbs:issue:vc
npm run bbs:create:presentation
npm run bbs:verify:presentation
```

Outputs:

- `dataset/bbs_vc.json`
- `dataset/bbs_presentation.json`

### 2) Full automated Arbitrum Sepolia flow

```bash
npm run flow:bbs:arb:auto
```

This flow:

1. Builds/validates BBS artifacts off-chain.
2. Deploys needed L1 and L2 contracts.
3. Executes verify estimate, mint, transfer on L2.
4. Emits L2->L1 message metadata.
5. Writes machine-readable benchmark output.

Default output:

- `docs/bench_bbs_l2_arb_sepolia_auto.json`

### 3) Deploy native Stylus verifier and use it in flow

Deploy:

```bash
npm run deploy:stylus:bbs:verifier
```

Output:

- `docs/stylus_bbs_verifier_deploy.json`

Then run automated flow with that verifier:

```bash
STYLUS_NATIVE_VERIFIER=0x<deployed_stylus_verifier> npm run flow:bbs:arb:auto
```

Path labels in outputs:

1. `solidity-snark-mock-arb`
2. `stylus-native-sim-arb` (default mock stylus verifier)
3. `stylus-native-arb` (when `STYLUS_NATIVE_VERIFIER` is provided)

### 4) Repeated benchmark (stronger statistics)

```bash
npm run bench:bbs:arb:repeat
npm run bench:bbs:arb:repeat:20
npm run bench:bbs:arb:repeat:50
```

Output:

- `docs/bench_bbs_l2_arb_sepolia_repeat.json`

Includes per-operation:

1. sample count
2. average gas
3. median gas
4. p95 gas
5. average fee (wei/ETH)

### 5) Outbox lifecycle monitoring and execution

Check whether messages are executable on L1:

```bash
npm run check:arb:outbox
```

Execute confirmed messages:

```bash
npm run exec:arb:outbox
```

Outputs:

- `docs/arb_sepolia_outbox_status.json`
- `docs/arb_sepolia_outbox_execute.json`

Status model:

1. `UNCONFIRMED`: not yet executable
2. `CONFIRMED`: executable now
3. `EXECUTED`: already executed

### 6) Local deterministic BBS benchmark

```bash
npm run bench:bbs:local
```

Output:

- `docs/bench_bbs_l2_local.json`

### Script index

Core quality and build:

- `npm test`
- `npm run build`
- `npm run clean`

Core BBS flow:

- `npm run flow:bbs:arb:auto`
- `npm run bench:bbs:arb`
- `npm run bench:bbs:arb:repeat`
- `npm run check:arb:outbox`
- `npm run exec:arb:outbox`

Deploy helpers:

- `npm run deploy:l1:arbitrum`
- `npm run config:l1:arbitrum`
- `npm run deploy:l2:bbs:snark:mock`
- `npm run deploy:l2:bbs:stylus:sim`
- `npm run deploy:l2:bbs:risc0`
- `npm run deploy:stylus:bbs:verifier`

Legacy/local demo helpers:

- `npm run demo:v2`
- `npm run demo:arb:mock`
- `npm run gas:v2`

### Security and integrity properties currently enforced

1. Duplicate mint prevention at contract state level.
2. Expiry/freshness checks in mint authorization path.
3. L1 remains anchor-only (no active L1 mint path).
4. Arbitrum outbox sender authentication on L1 anchor execution.

### Cost interpretation guidance

1. L2 mint/transfer and L1 anchor execution are separate lifecycle steps.
2. Repeated benchmarks are more reliable than single-run snapshots.
3. Testnet fees are engineering indicators, not mainnet commitments.
4. Current verifier harness costs are not final production-crypto costs.

## Troubleshooting

### High RPC request counts on provider dashboard

This is expected during repeated benchmarks. One logical action can trigger many RPC calls:

1. `eth_chainId`
2. `eth_estimateGas`
3. nonce/fee calls
4. `eth_sendRawTransaction`
5. repeated receipt polling

Repeated benchmark loops amplify this substantially.

### Outbox not executable yet

Expected until Arbitrum confirmation/challenge lifecycle passes. Keep checking status with:

```bash
npm run check:arb:outbox
```

### Bridge address errors

If flow fails around bridge/outbox checks, verify `ARBITRUM_L1_BRIDGE` is the correct Sepolia bridge contract address.

### Stylus deploy issues

1. Ensure `cargo` and `cargo stylus` are installed.
2. Ensure wallet has Arbitrum Sepolia ETH.
3. If fee errors occur, tune `STYLUS_MAX_FEE_GWEI`.

## Documents and reports

- Runbook: [docs/bbs_l2_runbook.md](docs/bbs_l2_runbook.md)
- Project report (LaTeX): [docs/report.tex](docs/report.tex)
- Benchmark outputs: `docs/bench_bbs_l2_*.json`

## Next milestone

To reach paper-faithful production cryptographic path on public chain:

1. integrate real on-chain RISC Zero receipt verification or full native Stylus BBS+ verification semantics,
2. remove digest-approval benchmark semantics from critical path,
3. rerun repeated benchmarks and update comparative cost report.
