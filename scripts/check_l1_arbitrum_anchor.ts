import { ethers } from "hardhat";

/**
 * Check the Arbitrum L1 anchor state on Sepolia.
 *
 * Usage:
 *   L1_ANCHOR=0x... DT_HASH=0x... npx hardhat run scripts/check_l1_arbitrum_anchor.ts --network sepolia
 */

async function main() {
  const l1Anchor = process.env.L1_ANCHOR;
  const dtHash = process.env.DT_HASH;

  if (!l1Anchor) throw new Error("Missing env var L1_ANCHOR");
  if (!dtHash) throw new Error("Missing env var DT_HASH");

  const net = await ethers.provider.getNetwork();
  console.log("--- L1 Anchor Check (Arbitrum) ---");
  console.log("network:", net.name, "chainId:", net.chainId.toString());
  console.log("L1_ANCHOR:", l1Anchor);
  console.log("DT_HASH:", dtHash);

  const anchor = await ethers.getContractAt("GTokenAnchorArb", l1Anchor);
  const anchored = await anchor.isAnchored(dtHash as `0x${string}`);
  console.log("isAnchored:", anchored);

  if (anchored) {
    const info = await anchor.anchorInfo(dtHash as `0x${string}`);
    console.log("anchorInfo:", info);
  } else {
    console.log(
      "Not anchored yet. On real Arbitrum, you must wait until the L2->L1 message becomes executable and is redeemed via the Outbox."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
