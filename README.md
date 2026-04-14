# Privacy‑Preserving Tokenized Green Credits (L2 Mint + L1 Anchor)

This repository contains a deployable engineering prototype for **tokenized green credit issuance** that:

- keeps **meter / site / raw reading data off public chains** (public chains see only minimal issuance fields + hashes),
- enforces **duplicate prevention** at the smart‑contract level, and
- supports **Layer‑2 (L2) minting** with an **auditable Layer‑1 (L1) anchor** via authenticated **L2→L1 messaging**.

The codebase is designed to run **fully locally (no funded wallets required)** using Hardhat, including mock cross‑chain components and reproducible gas measurements.

---

## High‑level architecture

### Domains and responsibilities

**1) Private verification domain (hashes only)**

- `MetReg` — meter registry with GA‑controlled activation/revocation status
- `DataVer` — reading commitment index + oracle verdicts + VC (credential) hash anchoring

This domain is intentionally minimal and stores **only hashes and status flags** so private details do not appear on public networks.

**2) Public minting domain (L2)**

- L2 token contracts mint ERC‑20 “green credits” after:
  - verifying an authorization proof (via a verifier interface), and
  - enforcing duplicate prevention using a canonical disclosure tuple hash (`dtHash`)

**3) Public audit domain (L1 anchor)**

- L1 anchor contracts store an immutable record of each mint, accepted **only** through authenticated cross‑chain calls.

---

## What’s implemented

### Core features

- **ERC‑20 minting** gated by a verifier (`IProofVerifier`).
- **Duplicate‑guard** keyed by a canonical Disclosure Tuple (DT) hash.
- Two L1 anchoring patterns:
  - **Generic messenger** pattern (OP‑Stack‑style authentication).
  - **Arbitrum outbox** pattern (Bridge/Outbox + `l2ToL1Sender()` authentication).
- **Local “mock” cross‑chain environment** so you can demonstrate end‑to‑end behavior without funding wallets.
- **Reproducible gas report** that separates L2 mint cost from the later L1 anchor execution cost.

---

## Directory structure

```
artifacts/
cache/
contracts/
data/
dataset/
docs/
ECE 910 Final Report.pdf
foundry-test/
hardhat.config.ts
node_modules/
package-lock.json
package.json
README.md
script/
scripts/
test/
tsconfig.json
typechain-types/
foundry.toml
```

### Recommended

Keep these under version control:

- `contracts/` (all Solidity)
- `scripts/` (TypeScript scripts used by npm commands)
- `test/` (Hardhat tests)
- `docs/` (gas report JSON, diagrams metadata, notes)
- `dataset/` and/or `data/` (if used by scripts; synthetic only)
- `hardhat.config.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `foundry.toml`


## Prerequisites

- Node.js
- npm

---

## Quickstart (local, no funds required)

### 1) Install dependencies

```bash
npm install
```

### 2) Clean + run the test suite

```bash
npx hardhat clean
npm test
```

Expected: all tests pass, including private‑side registry/indexing tests, Arbitrum anchor authentication tests, and V2 mint + L1 anchor tests.

### 3) Run the V2 local demo (mint + anchor)

```bash
npm run demo:v2
```

Expected behavior:

- prints holder address and issuance fields (`epochIndex`, `typeCode`, `qtyKWh`, etc.)
- mints tokens on the local L2 instance
- confirms the mint is anchored on the local L1 instance
- attempts a duplicate mint and shows it reverts with `DuplicateDT()`

### 4) Run the Arbitrum anchor demo (mock)

```bash
npm run demo:arb:mock
```

Expected behavior:

1) direct call from an EOA reverts (not from bridge/outbox)
2) outbox call with wrong L2 sender reverts
3) outbox call with correct L2 sender succeeds and stores anchor info
4) duplicate anchor attempt reverts

### 5) Generate the local gas report (JSON)

```bash
npm run gas:v2
```

Outputs:

- a console table of measured gas and calldata sizes
- `docs/gas_report_v2_local.json`

**Interpretation note:** On real optimistic rollups, the **L2 mint** and the **L1 anchor execution** are **separate transactions**. The gas report therefore distinguishes:

- L2 mint cost excluding later L1 execution
- modeled L1 execution gas for `recordMint`
- a “combined local” number used only for synchronous unit‑test convenience

---

## How duplicate prevention works

Minting is keyed by a **Disclosure Tuple (DT)** defined by policy:

- `epochIndex` (uint64)
- `typeCode` (uint16)
- `qtyKWh` (uint256)
- `policyNonce` (uint128)

The minting contract computes:

- `dtHash = keccak256(abi.encodePacked(epochIndex, typeCode, qtyKWh, policyNonce))`

A mapping `usedDT[dtHash]` is set on the first successful mint and never cleared.
Any subsequent attempt to mint the same DT reverts with `DuplicateDT()`.

This guard is designed to remain correct even if the proof mechanism changes (ECDSA now, selective disclosure / ZK later).

---

## Proof/authorization model (current prototype)

Minting is gated by a verifier interface (`IProofVerifier`).

The current implementation uses `DemoIssuerVerifier` with **ECDSA signature checks** as an engineering placeholder for stronger credential proofs.

Design notes:

- the signed digest binds to the **holder address** (prevents third‑party replay),
- the digest includes an **opaque hidden commitment** (`bytes32`) which can bind off‑chain evidence without revealing it on‑chain.

---

## L2 → L1 anchoring models

Two anchoring patterns are implemented:

### 1) Generic messenger model (OP‑Stack‑style)

The L1 anchor accepts `recordMint(...)` only when:

- `msg.sender == messenger`, and
- `messenger.xDomainMessageSender() == allowlistedL2Token`

### 2) Arbitrum outbox model

The Arbitrum‑specific L1 anchor accepts `recordMint(...)` only when:

- `msg.sender == bridge.activeOutbox()`, and
- `IOutbox(msg.sender).l2ToL1Sender() == allowlistedL2Token`

Mocks are included so this logic is testable locally.

---

## Optional testnet deployment (requires funded key)

This repo can be configured for Sepolia + Arbitrum Sepolia deployments.

1) Copy env template:

```bash
cp .env.example .env
```

2) Fill in:

- `DEPLOYER_PRIVATE_KEY`
- `SEPOLIA_RPC_URL`
- `ARBITRUM_SEPOLIA_RPC_URL`
- any L1 bridge/outbox addresses required by scripts (from official Arbitrum docs)

⚠️ Never commit real private keys to git.

If you do **not** have funds, you can still demonstrate correctness using the local mocks (`demo:v2`, `demo:arb:mock`) and the test suite.

---

## Troubleshooting

### “Network `<name>` doesn’t exist”

If you see Hardhat errors like “Network sepolia doesn’t exist”, ensure:

- your `hardhat.config.ts` defines that network name, and
- your `.env` has the required RPC and key variables.

### Tests fail after copying files

Run clean:

```bash
npx hardhat clean
npm test
```

---

## Scope / ethics note

This is a **technical prototype**. Tokens produced by this system are **not official RECs** and do not provide regulatory compliance on their own. The design goal is to keep **PII and raw meter readings off public chains**, but real‑world privacy also depends on off‑chain operational practices.

---

## Suggested `.gitignore` (if using git)

```gitignore
node_modules/
artifacts/
cache/
typechain-types/
.env
.DS_Store
```

---

## License

MIT
