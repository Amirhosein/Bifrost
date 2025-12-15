# Green Credit Capstone – V2 (Layer‑2 aware)

This repository is a **self‑contained prototype** for *tokenized green credits* with:

- **Private-side verification artifacts** (meter registry + data verification index)
- **VC-style issuance (demo)** using an issuer signature over *hidden commitment + disclosed mint fields*
- **Public minting on an EVM chain** via `GTokenL2` (ERC‑20) with:
  - **duplicate‑guard** (no double-mint per disclosure tuple)
  - **policy checks** (min qty, expiry)
  - **L2 → L1 anchoring** (optional): after a successful mint on L2, the contract sends a cross-domain message to an L1 contract (`GTokenAnchor`) to record the mint.

> Why this is V2: the research direction is to **apply Layer‑2** to the *public mint* part of the architecture. This repo models that by (1) keeping the token on an L2 (`GTokenL2`) and (2) anchoring mints to L1 for auditability and better trust boundaries.

## Repo map

- `contracts/private/MetReg.sol` – meter registry (private domain)
- `contracts/private/DataVer.sol` – verification index (private domain)
- `contracts/l2/GTokenL2.sol` – ERC‑20 minting contract intended for L2
- `contracts/l1/GTokenAnchor.sol` – L1 anchoring contract that records L2 mints
- `contracts/mocks/MockCrossDomainMessenger.sol` – local test messenger that simulates OP‑Stack style cross-domain messaging
- `contracts/mocks/DemoVCVerifier.sol` – lightweight demo verifier (EIP-191 style signature check)
- `scripts/deploy-v2.ts` – deploys an end‑to‑end demo locally
- `scripts/demo-v2.ts` – runs a full “issue‑proof‑mint” flow
- `test/v2.l2-anchoring.test.ts` – tests minting, duplicate guard, and L2→L1 anchoring

## Quick start (local)

```bash
npm i
npm run build
npm test
npm run demo:v2
```

The demo prints:
- deployed addresses
- a generated *hidden commitment*
- the computed disclosure tuple hash
- token balance after mint
- L1 anchor record for the mint

## How the “VC proof” works (demo)

This is an **engineering demo** that is executable and testable:

- The issuer signs a digest over:
  - `hiddenCommitment` (hash of owner/meter/site)
  - disclosure tuple fields `(epoch, typeCode, qtyKWh, policyNonce)`
  - `expiry`
- The user submits the signature as `proof`.
- `DemoVCVerifier` checks the signature and expiry.

In the final capstone report, the *cryptographic goal* is BBS+ selective disclosure and proof of possession. The demo verifier is a stand-in to keep the prototype runnable.

## Layer‑2 angle

In a real OP‑Stack L2 deployment (Optimism/Base):
- `GTokenL2` would use the canonical **L2CrossDomainMessenger** to send a message to L1.
- `GTokenAnchor` would verify that:
  - `msg.sender` is the L1 messenger, and
  - `xDomainMessageSender()` is the trusted L2 contract.

In this repo:
- `MockCrossDomainMessenger` simulates that behavior on a single Hardhat chain.

## License
MIT
