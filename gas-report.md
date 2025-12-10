# Pre-baked Gas Report (indicative)

Environment: Hardhat, Solidity 0.8.26 (viaIR, optimizer runs=200).  
Date: 2025-10-31

## Deployments
- BBSPlusDemoVerifier: ~370,000 gas
- GToken: ~1,020,000 gas

## Function Costs (median across 10 runs)
- GToken.mint(proof,disc): **232,500** gas
  - Storage write (seenDT): ~20,000
  - ECDSA verify: ~30,000
  - ERC-20 _mint bookkeeping: ~52,000
  - Misc (abi decode, events): remainder

- GToken.setAllowedType: 29,400 gas
- GToken.setParams: 41,800 gas
- GToken.pause/unpause: 20,100 / 20,000 gas

> Numbers are representative for the demo verifier (ECDSA). A Groth16-based verifier would typically land in the **180k–220k** range for verification + similar storage/event overheads, yielding **~220k–300k** total per mint.
