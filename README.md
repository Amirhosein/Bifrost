# Green Credit Capstone - Code Deliverables

This repository contains the public mint contract (`GToken`), private side contracts (`MetReg`, `DataVer`),
a pluggable verifier (`IVerifier`) and a demo verifier (`BBSPlusDemoVerifier`), plus scripts, tests,
a pre-baked gas report, and **Foundry** fuzz/invariant tests.

## Quick Start (Hardhat)

```bash
npm i
npm run build
npm test
```

Run a local node then deploy public contracts:
```bash
npx hardhat node
npx hardhat run --network localhost script/deploy_public.ts
```

Generate a synthetic VC + proof and mint:
```bash
# Set GTOKEN=<address printed by deploy script>
export GTOKEN=<address>
npm run issue:vc
npm run prove
npm run mint
```

## Gas Report

See `gas-report.md` for an indicative pre-baked report. To reproduce:
```bash
npm run gas
```

## Foundry (Fuzz/Property Tests)

Install Foundry (https://book.getfoundry.sh/), then:
```bash
forge test -vvv
```

The tests live under `foundry-test/` and do not require `forge-std`; they use cheatcodes via the standard
`hevm` interface mapping.
