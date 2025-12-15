# Practical Tokenized Green Credits - Capstone Prototype (V2: L2 Issuance + L1 Anchor)

This repository contains a minimal, end-to-end **prototype** for issuing **tokenized green credits** using a hybrid architecture:

- **Private-domain verification**: meter registration + reading commitments + oracle verdicts + hash anchoring
- **Public issuance on an L2-style execution environment**: ERC-20 minting with a strict **duplicate guard**
- **L1 anchoring**: the L2 mint is **recorded on L1** through a cross-domain messenger interface to create a durable, auditable anchor

> **Prototype note:** This is a capstone-oriented engineering artifact. It demonstrates architecture, protocol flow, and security-relevant checks (duplicate prevention, access control, cross-domain authorization), using local test harnesses and synthetic flows.

---

## What this software does

### Goal

Enable a micro-producer (e.g., small solar/wind generator) to mint “green credit” tokens in a way that:

1. Keeps sensitive verification and raw meter details **off the public chain**
2. Allows public issuance to remain **auditable** (via an L1 anchor)
3. Prevents **double counting** (duplicate mints for the same disclosure tuple)

### High-level flow

1. A meter is registered in `MetReg` (private domain).
2. A reading commitment is recorded in `DataVer`.
3. An oracle posts a verdict for the commitment.
4. A credential/hash is anchored in `DataVer`.
5. A holder mints on the L2 token contract (`GTokenL2`) by submitting a proof.
6. The L2 contract sends a cross-domain message to `GTokenAnchor` on L1 to record the mint.
7. Any attempt to mint again for the same disclosure tuple is rejected.

---

## Key features (V2)

- **L2 minting contract (`GTokenL2`)**

  - ERC‑20 token mint
  - Proof-gated issuance (demo proof verifier interface)
  - Duplicate prevention using a deterministic `dtHash`
- **L1 anchor contract (`GTokenAnchor`)**

  - Records a mint only when called **through a messenger**
  - Enforces the authorized **cross-domain sender** (the L2 token contract)
  - Stores anchor metadata keyed by `dtHash`
- **Local cross-domain messaging harness**

  - A mock messenger contract simulates the cross-domain messaging pattern locally
  - Enables reproducible tests of “L2 → messenger → L1 anchor” authorization logic
- **Private-domain verification contracts**

  - `MetReg`: meter registry with activation status
  - `DataVer`: reading commitments + oracle verdicts + VC hash anchoring

---

## Repository structure

```
contracts/
  interfaces/
    ICrossDomainMessenger.sol
    IGTokenAnchor.sol
    IProofVerifier.sol

  private/
    MetReg.sol
    DataVer.sol

  l2/
    GTokenL2.sol

  l1/
    GTokenAnchor.sol

  mocks/
    DemoIssuerVerifier.sol
    MockCrossDomainMessenger.sol

scripts/
  deploy_v2_local.ts
  demo_v2_local.ts
  oracle_verify.py

test/
  private_contracts.test.ts
  v2_l2_anchor.test.ts
```

---

## Contracts overview

### Private domain

#### `MetReg` (Meter Registry)

- Registers meters and maintains an “active” flag.
- Intended to represent a registry authority / governance authority function.

#### `DataVer` (Verification Index)

- Stores:
  - reading commitments (`readingHash`)
  - oracle verdicts
  - anchored VC hash (`vcHash`) linked to a reading commitment

### Public domain (L2 + L1)

#### `GTokenL2` (L2 ERC‑20 token)

- Mints green tokens on L2 after a proof verifies.
- Prevents duplicate mints using `dtHash`, derived from:

**Disclosure Tuple (DT)**

- `epochIndex` (uint64)
- `typeCode` (uint16)
- `qtyKWh` (uint256)
- `policyNonce` (uint128)

**Duplicate key**
`dtHash = keccak256(abi.encodePacked(epochIndex, typeCode, qtyKWh, policyNonce))`

#### `GTokenAnchor` (L1 Anchor)

- Records the mint on L1 via:
  - a mandatory **messenger** caller
  - a verified **cross-domain sender** (must equal the configured L2 token address)
- Stores `AnchorInfo` for each `dtHash`.

---

## Getting started

### Prerequisites

- Node.js (recommended: Node 18+)
- npm

### Install

```bash
npm install
```

### Run tests

```bash
npx hardhat clean
npm test
```

Expected: all tests passing, including:

- Private-side contract tests
- L2 mint + L1 anchor tests

---

## Run the end-to-end demo (local)

This script demonstrates:

- deployment
- digest computation
- proof/signature generation (demo verifier)
- L2 mint
- L1 anchor recording
- duplicate mint prevention

Run:

```bash
npx hardhat run scripts/demo_v2_local.ts
```

The demo prints:

- the holder address and mint parameters
- the computed digest used for proof/signature
- the mint tx hash
- the holder’s L2 token balance
- anchor status + anchor info from L1
- a duplicate mint attempt that must revert

---

## Security and correctness notes

This prototype includes engineering controls that are intentionally testable:

- **Duplicate prevention**: `dtHash` is write-once (no double mint for same DT)
- **Cross-domain authorization on L1**:
  - L1 anchor rejects direct calls that bypass the messenger
  - L1 anchor rejects calls where `xDomainMessageSender` is not the authorized L2 contract
- **Role-based controls** on private-side contracts (registry/admin/oracle roles)

> Production deployments require additional security work:
> audits, rollup-specific messenger addresses, upgrade governance, monitoring, and real credential proof systems (e.g., BBS+/ZK) instead of the demo verifier.

---

## License

MIT
