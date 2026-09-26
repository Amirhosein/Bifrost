# Bound BBS Minting: Closing Front-Running and Double-Issuance in the Green Token Protocol

*Technical note — Green Credit Project, September 2026*
*Branch `feat/bbs-bound-minting`*

## 1. Summary

The token request of the Green Token protocol (Nabi & Safavi-Naini, WTSC'25, §4.3 step 3) has two open problems:

- **Front-running.** Majid observed that a BBS+ proof in a token request is not bound to anything. Whoever submits it first receives the tokens.
- **Cross-chain double-issuance.** Rei's *Tokenization* note (§2.1) asks how to stop one verifiable credential (VC) from being tokenized on two chains.

This work does three things:

1. **Replaces the mock verifier with a real one.** `BbsBls12381Verifier` checks draft-irtf-cfrg-bbs-signatures-06 proofs (BLS12-381-SHA-256) on-chain. It uses the EIP-2537 BLS12-381 precompiles, which have been live on Arbitrum since ArbOS 51. It is deployed and exercised on Arbitrum Sepolia (§6).
   - It matches the IETF test vectors: 5 valid and 7 negative ProofVerify cases, plus generators, message scalars and domains.
   - It derives the ciphersuite generators itself, so the issuer key is its only trusted input.
   - This was the first next step in both the April and the July reports: "integrate a cryptographic verifier and repeat the security and cost evaluation".
2. **Fixes six attacks (A1–A6)** with a bound mint construction. A test suite shows each attack succeeding against the paper's protocol and failing against the hardened ledger. The construction has three parts:
   - Majid's presentation binding.
   - A nullifier with a fixed disclosure policy.
   - **Designated-ledger binding.**
3. **Shows that presentation binding alone does not solve Rei's cross-chain problem.** The credential holder can always derive a fresh proof for a second ledger. What closes it is having the issuer sign the target ledger into the credential. Binding each proof does not.

**Cost.** The security fix is essentially free:
- Presentation binding plus nullifier: 393,792 gas, against 395,644 for the paper's request (about 1.9k gas cheaper).
- Designated-ledger binding: zero runtime cost.

The real cryptography costs about 271k gas per verification. Pairing and the two multi-scalar multiplications account for 90% of it. The full hardened mint costs 409,547 gas locally. On **Arbitrum Sepolia (N = 50, September 2026)** it averages **451,953 gas, or ≈ $0.029 per mint** at 0.031 gwei. At the April run's gas price that is ≈ $0.019.

## 2. The problem

In the paper, a VC holder submits `token_request = {proof, M_disclosed, public params}`. GToken then does two things:
- It rejects `H(M_disclosed)` if it has seen it before.
- It verifies the BBS+ proof and mints to the requester.

Nothing ties the proof to a requester, a ledger, or a moment in time. The disclosed subset is also the requester's choice.

The current prototype hides this problem because its verifiers are mocks:
- `MockBbsSnarkVerifier` depends on a fresh issuer ECDSA signature for every mint.
- `MockBbsStylusNativeVerifier` needs an owner-approved digest.
- Neither checks BBS+ at all.
- Their digests include `msg.sender` but not the chain or the contract. The recorded testnet run (`docs/bench_bbs_l2_arb_sepolia_auto.json`) shows one `credentialIdHash` minted in two token contracts.
- Off-chain, the BBS+ nonce is a fixed string (`scripts/bbs_create_presentation.ts`).

## 3. Threat analysis

Every row below was reproduced on-chain with the same real verifier (`test/bbs_bound_attacks.test.ts`). The three designs compared are:
- **paper:** the WTSC'25 token request.
- **ph-only:** Majid's presentation-header binding plus a nullifier.
- **hardened:** ph binding, a designated-ledger header, and a nullifier.

| # | Attack | paper | ph-only | hardened |
|---|---|---|---|---|
| A1 | Mempool front-running: copy the request, pay a higher fee, receive the tokens | **EXPLOITED** | blocked | blocked |
| A2 | A third party replays an observed proof on another ledger | **EXPLOITED** | blocked | blocked |
| A3 | The holder mints the same credential on a second ledger (Rei's open problem) | **EXPLOITED** | **EXPLOITED** | blocked |
| A4 | The holder double-mints on one ledger by disclosing a different subset, which changes `H(M_disclosed)` | **EXPLOITED** | blocked | blocked |
| A5 | Two honest producers with the same (type, quantity, timestamp) collide, and the second is refused (DoS) | **EXPLOITED** | blocked | blocked |
| A6 | A proof handed to a relayer is withheld and used much later | **EXPLOITED** | blocked | blocked |

Notes on individual attacks:

- **A1.** The test turns automine off. The honest mint sits in the mempool, and the attacker reads it and resubmits it with a 20× priority fee.
  - Against the paper design, the attacker is mined first and receives the 100 GT. The honest transaction reverts as a duplicate.
  - Against the bound designs, the attacker has to rewrite the recipient, which invalidates the proof.
  - Copying the call unchanged only delivers the tokens to the honest recipient.
- **A3 is the key result.** A challenge bound to (recipient, chain, contract), as Majid proposed, stops *third parties*. It cannot stop the *credential holder*, who holds the signature and can derive a new proof for any other ledger's presentation header. The ledger has to be fixed at **issuance**, by the issuer, inside the signed credential.
- **A4 and A5** are weaknesses of deduplicating on `H(M_disclosed)` with caller-chosen indexes. The paper argues that dedup on the disclosed-data hash prevents on-chain double counting, but that holds only if the disclosure set is fixed. It also refuses legitimate small producers whose readings happen to coincide. That is likely at monthly granularity with round kWh values, which is exactly the micro-generation setting the paper targets.

A privacy side finding: the current prototype sets `credentialIdHash = keccak256(JSON(vc))` (`scripts/bbs_issue_vc.ts`). That is the same construction as the `vcHash` the Registry Administrator (RA) anchors on the private chain through `DataVer.anchorVC` (`scripts/issue_vc.ts`). If the RA anchors that value, any private-chain node can link a public mint to its private verification, which breaks the paper's privacy goal 1 (cross-chain unlinkability). The construction below uses an independent random serial instead.

## 4. Construction

**Ciphersuite.** IETF `draft-irtf-cfrg-bbs-signatures-06`, BLS12-381-SHA-256. Off-chain it uses `@digitalbazaar/bbs-signatures` 3.1.0, a pure-JS implementation of draft-06.

**Credential (L = 8 messages).**

| idx | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| field | ownerID | meterID | siteID | reTypeCode | qtyKWh | readingTimestamp | **serial** | expiry |
| at mint | hidden | hidden | hidden | disclosed | disclosed | disclosed | disclosed (nullifier) | disclosed |

- Each disclosed message is one 32-byte ABI word.
- The contract rebuilds these words from typed claims and maps them to scalars itself. The amount it mints is therefore exactly the signed quantity, and the disclosure indexes are fixed by the contract, not chosen by the caller.
- The `serial` is 32 random bytes assigned by the RA. It is independent of anything published on the private chain.

**Issuer header (designated ledger).** The RA signs the header below into the BBS signature:
```
header = abi.encode(keccak256("GTOKEN_BBS_LEDGER_V1"), chainId, gtokenAddress)
```
The header enters the proof through `domain = calculate_domain(PK, generators, header)`. Each ledger computes the domain for *its own* header once, in its constructor. A credential designated for any other (chain, contract) pair then fails verification there. Designation happens at issuance, when the producer tells the RA which ledger to use, so multi-chain support needs no cross-chain messaging.

**Presentation header (one mint action).** The holder derives the proof with the header below, and the ledger rebuilds it on-chain:
```
ph = abi.encode(keccak256("GTOKEN_BBS_MINT_V1"), chainid, address(this), recipient, amount, nullifier, deadline)
```

**Mint.** `mintBound(recipient, claims, deadline, proof)` runs these steps:
1. Check `deadline` and `expiry`.
2. Reject a used nullifier.
3. `verifier.verifyProof(domain, ph, [3..7], scalars(claims), proof)`.
4. Mark the nullifier used.
5. `_mint(recipient, qty)`.
6. Send the L2→L1 anchor message. `claimId` is keyed by the nullifier, and the existing `GTokenAnchorArb` is reused unchanged.

**Anyone may submit.** The proof fixes the recipient, so a relayer can pay gas for a fresh pseudonym address that holds no ETH. The paper assumes producers use multiple pseudonyms but ignores that funding each pseudonym with gas links it to the funder. Relayed minting removes that link (`test/bbs_bound_mint.test.ts`, `scripts/demo_bbs_bound_local.ts`).

**On-chain verifier.** `contracts/verifiers/BbsBls12381Verifier.sol` implements draft-06 `CoreProofVerify`:

```
T1 = Bbar·c + Abar·ê + D·r̂1                                   (3-point G1 MSM, precompile 0x0c)
T2 = P1·c + Q1·(domain·c) + Σ_disclosed H_i·(msg_i·c) + D·r̂3 + Σ_hidden H_j·m̂_j   (one (L+3)-point MSM)
c  =? hash_to_scalar(R ‖ (i, msg_i)… ‖ Abar ‖ Bbar ‖ D ‖ T1 ‖ T2 ‖ domain ‖ |ph| ‖ ph)
e(Abar, W) · e(Bbar, −BP2) =? 1                             (pairing check, precompile 0x0f)
```

Implementation details:
- Proof points travel in EIP-2537 (uncompressed) form. The MSM and pairing precompiles perform the on-curve and subgroup checks. The contract recompresses points only to compute the Fiat-Shamir challenge.
- The constructor derives Q1, H1..HL with `create_generators`. It uses `hash_to_curve` (`expand_message_xmd`, then `MAP_FP_TO_G1` twice, then G1ADD) and stores the parameters as contract code (SSTORE2) to avoid SLOAD costs.
- Malformed input makes `verifyProof` return `false`, never revert. This covers identity or off-curve points, out-of-range scalars, and wrong or unsorted indexes.

## 5. Security argument (informal)

The arguments use the standard properties of BBS proofs in the random-oracle model:
- **Unforgeability** of signatures under q-SDH.
- **Knowledge soundness** of the proof of possession.
- **Binding** of `header` (through `domain`) and `ph` (through the Fiat-Shamir challenge).

- **A1, A2 (third parties).** An adversary without the credential sees a proof for `ph`, and every rewrite changes the ledger's rebuilt `ph'`. A valid proof for `ph' ≠ ph` needs a new challenge. Producing one without the witness contradicts knowledge soundness together with unforgeability. The only accepted submission is the observed call itself, which pays the honest recipient.
- **A3 (holder).** Verification on ledger B uses `domain_B`, which is derived from `header_B`. A proof that verifies against `domain_B` demonstrates knowledge of a signature whose domain is `domain_B`, that is, a signature on `header_B`. The RA signed only `header_A`, so this would be a forgery. Every compliant ledger therefore rejects the credential except its designated one.
- **A4.** Indexes are fixed and the nullifier is the signed `serial`. Every proof from one credential carries the same serial, so the second mint is rejected no matter which proof is used.
- **A5.** Two independent credentials collide only if their 256-bit random serials collide.
- **A6.** `deadline` is inside `ph`, and the ledger rejects `block.timestamp > deadline`. A relayer cannot extend it without invalidating the proof.

**Limits (stated honestly).**
1. Designation makes illegitimate tokens *publicly provable*, but it cannot stop a non-compliant contract elsewhere that trusts the RA key and ignores the header. Deciding which deployments are official stays a governance question, Rei's Approach 1. Cryptography now gives that registry something verifiable to point at.
2. As in the paper, the RA is trusted to assign unique serials and to issue at most one VC per verified reading. RA key rotation and revocation are not addressed yet.
3. **Arbitrum ordering.** Arbitrum's sequencer is first-come-first-served with no public mempool, which makes A1 harder on Arbitrum today. That rests on trust in the sequencer and RPC provider, though, and Timeboost's express lane, submissions through the L1 delayed inbox, and other target chains all bring the attack back. The binding keeps the protocol chain-agnostic.
4. The disclosed (type, quantity, timestamp) still carries the same single-chain linkability considerations as in the paper. The serial adds none, because each credential is used once.

## 6. Cost evaluation

All figures below were measured on the in-memory Hardhat network (Prague, EIP-2537) with `npm run bench:bbs:bound:local` and written to `docs/bench_bbs_bound_local.json`.
- Each ledger gets one unmeasured warm-up mint.
- Each measured mint pays a fresh recipient, so storage conditions are identical across designs.
- Local figures exclude Arbitrum's L1-data gas component.

**Runtime per mint (L = 8)**

| Design | Operation | Gas | Calldata (B) |
|---|---|---:|---:|
| paper baseline | `requestGToken`, R = 3 (paper's disclosure policy) | 381,077 | 1,380 |
| paper baseline | `requestGToken`, R = 5 | 395,644 | 1,572 |
| ph-bound only | `mintBound`, R = 5 | 393,792 | 932 |
| **hardened** | `mintBound`, R = 5, with L2→L1 anchor | **409,547** | 932 |
| — | `verifyProof` alone (eth_estimateGas, includes the 21k intrinsic) | 308,631 | — |
| — | ERC-20 `transfer` to a fresh address | 51,546 | 68 |

Reading the table:
- The fix costs **−1,852 gas** compared with the paper design at the same disclosure (ph-only vs paper, R = 5). Rebuilding typed claims on-chain shrinks calldata by 640 bytes, which pays for hashing `ph`.
- Designated-ledger binding costs nothing at runtime.
- The remaining 15,755 gas (hardened vs ph-only) is the `ArbSys.sendTxToL1` anchor, measured here against a local mock.

**Where verification gas goes (L = 8, R = 5, `BbsVerifierGasProbe`)**

| Stage | Gas |
|---|---:|
| pairing check, 2 pairs | 106,737 |
| T2 MSM, 11 points | 103,936 |
| T1 MSM, 3 points | 32,695 |
| Fiat-Shamir challenge (compress 5 points + `expand_message_xmd`) | 17,729 |
| shape and range checks | 6,221 |
| load generators and key (EXTCODECOPY) | 3,540 |
| *token side:* map 5 disclosed messages to scalars | 27,853 |

Pairing and the two MSMs are 90% of verification; the precompile calls alone are about 226k gas (EIP-2537 pricing). Solidity-level optimisation has little room left; the remaining lever is the number of signed messages.

**Scaling**

| Variable | Result |
|---|---|
| L = 8, R = 0 … 8 disclosed | 311,399 → 319,238 gas (about +1k per disclosed message) |
| L = 5 / 8 / 12 / 16 signed (R = 5) | 284,600 / 315,837 / 356,130 / 395,682 gas (about +10k per signed message) |
| verifier deployment, L = 5 … 16 | 2.23M … 2.99M gas (one-time; includes on-chain generator derivation) |

**Against the previous prototype and the paper**

| | Verification | Mint (incl. verification) |
|---|---:|---:|
| Paper, Table 2 (BN254 stand-in, Ethereum) | 160,060 (est.) | 227,260 (est.) |
| April report, mock SNARK path, Arbitrum Sepolia N = 50 | 33,396 (mock) | 139,883 |
| **This work, real BLS12-381 BBS, local** | **~271k in-call / 308,631 est.** | **409,547** |
| **This work, real BLS12-381 BBS, Arbitrum Sepolia N = 50** | **338,459 est.** | **451,953** (L2 execution 436,971 + L1 data 14,982) |

These are the first measurements in this project of a *real* BBS verification against the credential format actually issued. They are about 1.7× the paper's BN254-based estimate, or 1.9× once the on-chain message-to-scalar mapping is included.

**Arbitrum Sepolia (N = 50, September 2026).** Measured with `npm run bench:bbs:bound:arb:50`; raw rows are in `docs/bench_bbs_bound_arb_sepolia_repeat.json`.
- Each iteration issues a fresh credential designated for the ledger, derives a bound proof, estimates `verifyProof`, submits `mintBound`, and makes one transfer.
- Arbitrum's `gasUsed` includes an L1-data component, which each receipt reports as `gasUsedForL1`.
- USD figures use ETH = $2,071.03, as in the April report.

| Operation | Avg gas | Median | p95 | of which L1 data | Avg fee (ETH) | Avg fee (USD) |
|---|---:|---:|---:|---:|---:|---:|
| `verifyProof` (eth_estimateGas) | 338,459 | 338,506 | 338,728 | — | 1.06 × 10⁻⁵ | 0.0220 |
| **`mintBound`** (real verification + mint + L2→L1 message) | **451,953** | 447,617 | 474,638 | 14,982 | 1.42 × 10⁻⁵ | **0.0293** |
| `transfer` (to a third address) | 37,946 | 37,612 | 37,629 | 3,158 | 1.19 × 10⁻⁶ | 0.0025 |

How to read these numbers:
- **Gas price moved.** The average effective gas price was 0.0313 gwei, against 0.0200 gwei in the April run. At April's price, one mint costs ≈ **$0.019**, and mint plus transfer ≈ $0.020.
- **The April transfers were self-transfers**, which is why they used 26,801 gas; this run transfers to a separate address. On the April report's "runtime total" basis (verify estimate + mint + transfer), this path costs ≈ $0.054 at today's price, or ≈ $0.034 at April's price, against $0.0083 for the mock.
- **Mint gas is higher than local** (L2 execution 436,971 vs 409,547). The real `ArbSys.sendTxToL1` costs more than the local mock, and so does the first mint to a new balance (iteration 0: 493,441 gas).
- **One-time setup.** Verifier deployment was 2,555,503 gas (≈ $0.16), the ledger 1,755,413 gas (≈ $0.11). On Sepolia L1, the `GTokenAnchorArb` deployment was 667,709 gas and `setConfig` 46,356 gas.
- **Deployments.** Verifier `0x7DF47f2b23c96570858cDBD2bbb886486198276F`, ledger `0x75915E9747562cfbe37f8164100b23CECeF33a3d` (Arbitrum Sepolia), L1 anchor `0x8BDC80D280e1768B583a0838C0c41c819E43039D` (Sepolia). All 50 L2→L1 anchor messages are queued for that anchor and are recorded with their `msgNum` in the JSON.

## 7. Reproduction

```bash
npm install
npm run test:bbs:bound          # IETF vectors, mint tests, attack matrix (prints the table in §3)
npm test                        # full suite: 40 passing
npm run bench:bbs:bound:local   # docs/bench_bbs_bound_local.json
npm run demo:bbs:bound          # narrated end-to-end walkthrough
npm run bench:bbs:bound:arb:50  # Arbitrum Sepolia (needs a funded key in .env)
```

On an Apple-silicon Mac without Rosetta, Hardhat's cached native `solc` 0.8.23 (x86-64) cannot run. Hardhat falls back to the WebAssembly compiler once the native build is marked broken:
```bash
touch ~/Library/Caches/hardhat-nodejs/compilers-v2/macosx-amd64/solc-macosx-amd64-v0.8.23+commit.f704f362.does.not.work
```

## 8. Files

| Path | Role |
|---|---|
| `contracts/bbs/BLS12381.sol` | EIP-2537 wrappers, G1/G2 compression, MSM buffer helpers |
| `contracts/bbs/BbsHash.sol` | `expand_message_xmd`, `hash_to_scalar`, `hash_to_curve_g1`, `create_generators` |
| `contracts/bbs/DataBlob.sol` | Parameter storage as contract code |
| `contracts/verifiers/BbsBls12381Verifier.sol` | Real draft-06 BBS proof verifier |
| `contracts/interfaces/IBbsBls12381Verifier.sol` | Verifier interface and `Proof` struct |
| `contracts/l2/GTokenBbsBoundBase.sol` | Bound mint logic: ph, designated ledger, nullifier |
| `contracts/l2/GTokenL2BbsBoundArb.sol` | Hardened Arbitrum ledger with L2→L1 anchoring |
| `contracts/l2/attack-demo/*` | Paper baseline and ph-only ablation (**demo only**) |
| `contracts/mocks/MockArbSys.sol`, `BbsVerifierGasProbe.sol` | Local ArbSys stand-in; per-stage gas harness |
| `scripts/lib/bbsBound.ts` | Issuer and holder tooling, encodings shared with the contracts |
| `test/fixtures/bbs_draft06_sha256.json` | IETF draft-06 BLS12-381-SHA-256 vectors |
| `test/bbs_verifier_vectors.test.ts`, `test/bbs_bound_mint.test.ts`, `test/bbs_bound_attacks.test.ts` | 29 new tests |
| `scripts/benchmark_bbs_bound_local.ts`, `scripts/benchmark_bbs_bound_arb_sepolia.ts`, `scripts/demo_bbs_bound_local.ts` | Benchmarks and demo |

## 9. Milestone alignment

| Milestone | Contribution |
|---|---|
| **1.7** Prototype demonstrating the L2 solution's security and efficacy (TRL3) | A real cryptographic verifier on the selected L2, plus an attack-vs-defence evaluation with measured costs |
| **2.6** Mechanisms with proved security for multi-attribute token transfer between blockchains | Designated-ledger binding: a credential can be tokenized on exactly one (chain, contract), with a security argument and an on-chain proof of concept |
| **5.2** Smart-contract design and specification for the multi-attribute token system | Specified mint interface, disclosure policy, nullifier semantics and anchor schema |
| July report, next steps | "Integrate a cryptographic verifier into the selected path and repeat the security and cost evaluation" — done for the Solidity path |
