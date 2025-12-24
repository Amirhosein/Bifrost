# V2 Cost & Gas Calculations

This document explains how to measure and interpret **gas** and **fees** for the V2 architecture:

* **L2 minting contract:** `contracts/l2/GTokenL2.sol`
* **L1 anchoring contract:** `contracts/l1/GTokenAnchor.sol`

It is written to address a common point of confusion:

> A “single” end-to-end flow spans **two execution environments** (L2 and L1). In a real optimistic rollup, the L2 mint transaction and the L1 anchor execution happen at **different times** and are priced differently.

---

## 1. What numbers are we measuring?

### 1.1 “Gas used” (EVM)

* `gasUsed` is the amount of EVM gas consumed by a transaction.
* It is an **execution complexity metric** (how many EVM operations ran), not a dollar cost.

You can read it from the receipt:

*Hardhat / ethers v6* → `receipt.gasUsed`

### 1.2 “Fee paid” (network cost)

Fees depend on the chain:

* **Ethereum L1:** `fee ≈ gasUsed × effectiveGasPrice`
* **Optimistic L2s (e.g., Arbitrum / OP Stack):** total fee is typically
  * an **L2 execution fee** (L2 gas × L2 gas price), plus
  * an **L1 data fee** (posting calldata / batch data to L1).

So a transaction can have **similar gasUsed** across chains but wildly different **fees**.

---

## 2. Why the unit-test gas looks too high

In our Hardhat tests we use `MockCrossDomainMessenger`, which **delivers the L1 message immediately** in the same transaction:

```
GTokenL2.mintWithProof(...)
  └─ messenger.sendMessage(...)
      └─ anchor.recordMint(...)
```

That means the receipt for `mintWithProof(...)` includes:

* the L2 mint execution, **and**
* the L1 anchoring execution

…all rolled into one local transaction.

On a real optimistic rollup, the flow is split:

1. **L2 transaction:** `mintWithProof(...)` executes on L2 and posts a message.
2. **Later L1 transaction:** the rollup finalizes and delivers the message, executing `recordMint(...)` on L1.

To compare against a paper that reports *“proof verification gas”* and *“mint gas”*, you must compare:

* **L2 mint gas** (without the L1 anchor execution), and
* **L1 anchor gas** (as a separate transaction)

---

## 3. Reproducible gas report (local)

### 3.1 One-command local report

Run:

```bash
npx hardhat run scripts/gas_report_v2_local.ts
```

This prints a table and writes:

* `docs/gas_report_v2_local.json`

### 3.2 What the script reports

The script produces three key numbers:

1. **L2 mintWithProof (no L1 relay)**
   * Uses `MockCrossDomainMessengerNoop` that **does not deliver** the message.
   * Approximates the **L2-side execution** cost.
2. **L1 relay: messenger.sendMessage → recordMint**
   * Uses `L2SenderMock` to simulate the authorized L2 sender.
   * Approximates the **later L1 execution** cost.
3. **Combined mintWithProof (includes immediate L1 recordMint)**
   * Matches the unit test behaviour.
   * Useful for deterministic testing, **not** a realistic single-chain fee number.

Additionally, it outputs `estimateGas` for the demo verifier’s ECDSA verification path.

---

## 4. Matching the question (paper vs. implementation)

The paper reports something like:

* “ZK verification ≈ 116k gas”
* “minting ≈ 67k gas”

There are two common reasons your measurements won’t match exactly:

1. **Different scope of what is counted**

   * Papers often report *microbenchmarks* (only the verifier + only a minimal mint).
   * Our transaction includes: duplicate-guard state write + ERC20 mint + custom events + message send.
2. **Cross-domain anchoring is often excluded**

   * Many papers treat L1 anchoring / settlement as a separate cost.
   * Our unit test combines it into one local transaction unless you split it (Section 3).

With the split measurement (Section 3), you can directly compare:

* **L2 `mintWithProof`** ↔ (paper verifier + mint)
* **L1 `recordMint` relay** ↔ (paper anchoring / settlement cost, if reported)

---

## 5. Next step: real L2 fee estimation (Arbitrum / OP Stack)

Local gas does **not** equal real fees. For a real L2 demo run you should collect:

* L2 receipt: `gasUsed`, `effectiveGasPrice`
* calldata size: `tx.data.length`

Then report (qualitatively or numerically):

* L2 execution fee
* L1 data fee
* total paid fee

The exact fee formula differs by rollup implementation and can change over time, so the **most robust** approach is:

1. run the transaction on the target testnet, and
2. record the fee fields from the receipt / explorer

---

> **Gas reporting methodology.** Gas results are collected from transaction receipts (`gasUsed`) on a local Hardhat EVM for repeatability. Because the V2 architecture spans L2 minting and L1 anchoring, we report gas in two parts: (i) L2 mint execution for `mintWithProof(...)` where message delivery is not executed in the same transaction, and (ii) L1 anchoring gas for `recordMint(...)` executed through the cross-domain messenger. This split matches the operational reality of optimistic rollups, where L2 execution and L1 settlement are decoupled in time and fee markets. In addition, we provide an end-to-end combined number (test-style) to validate control flow, but we do not interpret it as a single real-world fee.
