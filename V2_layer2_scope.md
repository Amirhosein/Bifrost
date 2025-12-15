# Scope: Adding Layer‑2 to the Public Minting Side

This document turns the V1 + L2 survey theme into **concrete engineering scope**.

## What we want

**Major goal:**

- Explore **Layer‑2 scaling** options for the *public minting chain* in the green token system.
- Produce a **survey-style comparison**: which L2 (optimistic rollup vs zk rollup, etc.) best fits this system (gas, finality, security, decentralization, developer UX).

**Why it matters for our system:**

- The public chain performs verification + minting. Moving it to L2 can reduce gas fees and improve UX.
- But L2 introduces new risks (bridges, sequencer issues, governance/upgrades) that must be addressed.

**Minor goal mentioned:**

- Property sale / owner change corner case in Alberta microgeneration. This is secondary for V2.

## What we implement in this repo (V2 engineering)

We add an L2-aware pattern:

1. `GTokenL2` runs on the chosen L2 (e.g., OP Stack / Optimism / Base style networks).
2. A lightweight `GTokenAnchor` runs on L1 and **records DT hashes minted on L2** via a cross-domain message.
3. This creates:
   - cheap mints on L2,
   - an L1 audit trail,
   - and a place to anchor security monitoring.

## Why we anchor to L1

Your survey draft highlights that bridges + sequencing + governance are where failures happen.
Anchoring mint events to L1 provides:

- **Auditability:** L1 is the source of truth for historical records.
- **Incident response:** if L2 halts, we still have L1‑level evidence of what was minted.
- **Cross‑deployment uniqueness (optional):** can evolve to make DT uniqueness global across multiple L2s.

## Security considerations we will explicitly document for V2

Mapped to your survey’s vulnerability buckets:

- **Bridge message auth:** `GTokenAnchor.recordMint()` only accepts calls from the messenger and checks `xDomainMessageSender()` equals the known L2 GToken address.
- **Sequencer downtime:** the minting contract continues to function on L2, but anchoring can be delayed; we treat anchoring as best‑effort telemetry in MVP.
- **Upgrades:** roles exist; production requires timelocked upgrades.
- **Testing:** property tests / invariants for “no double mint” remain.

## What stays the same from V1

- Hybrid design: private verification + VC issuance + public minting.
- Duplicate guard = canonical hash of `(epoch, type, qty, nonce)`.
- Selective disclosure goal: only mint-relevant fields are disclosed.

## What changes from V1

- “Public chain” becomes **L2**.
- An **L1 anchor** is added.
- Deployment + evaluation scripts include L1 vs L2 comparison.

## Next steps for the V2 report

1. Add a decision matrix table (L2 candidates × requirements).
2. Select 1–2 target L2s for concrete deployment (e.g., OP Stack and Arbitrum).
3. Run cost experiments: L1 gas vs L2 fees (and messaging cost to L1).
4. Add an explicit L2 threat model section and mitigations.
