#!/usr/bin/env python3
"""Oracle stub over a synthetic dataset.

This script simulates the "Oracle relay" in the paper:
- It reads a local JSON dataset of meter readings
- It checks whether a proposed reading exists and is marked valid
- It prints a simple verdict JSON

Usage:
  python3 scripts/oracle_verify.py --data data/synthetic_meter_readings.json \
    --ownerHash 0x... --meterHash 0x... --siteHash 0x... \
    --epochIndex 202540 --typeCode 1 --qtyKWh 100 --policyNonce 0

NOTE: In a real deployment, the Oracle would fetch from a service provider and sign a verdict.
"""

import argparse
import json
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--ownerHash", required=True)
    p.add_argument("--meterHash", required=True)
    p.add_argument("--siteHash", required=True)
    p.add_argument("--epochIndex", type=int, required=True)
    p.add_argument("--typeCode", type=int, required=True)
    p.add_argument("--qtyKWh", type=int, required=True)
    p.add_argument("--policyNonce", type=int, required=True)
    args = p.parse_args()

    rows = json.loads(Path(args.data).read_text())

    match = None
    for r in rows:
        if (
            r["ownerHash"].lower() == args.ownerHash.lower()
            and r["meterHash"].lower() == args.meterHash.lower()
            and r["siteHash"].lower() == args.siteHash.lower()
            and int(r["epochIndex"]) == args.epochIndex
            and int(r["typeCode"]) == args.typeCode
            and int(r["qtyKWh"]) == args.qtyKWh
            and int(r["policyNonce"]) == args.policyNonce
        ):
            match = r
            break

    out = {
        "found": match is not None,
        "valid": bool(match["valid"]) if match is not None else False,
    }
    print(json.dumps(out, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
