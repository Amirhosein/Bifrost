import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { blsVerifyProof } from "@mattrglobal/bbs-signatures";

type Presentation = {
  publicKeyHex: string;
  nonceHex: string;
  proofHex: string;
  revealedValues: {
    reType: string;
    qtyKWh: string;
    timestamp: string;
    credentialIdHash: string;
  };
};

function fromHex(hex: string): Uint8Array {
  return ethers.getBytes(hex);
}

async function main() {
  const presPath = path.join(process.cwd(), "dataset", "bbs_presentation.json");
  const p = JSON.parse(fs.readFileSync(presPath, "utf8")) as Presentation;

  const verified = await blsVerifyProof({
    proof: fromHex(p.proofHex),
    publicKey: fromHex(p.publicKeyHex),
    nonce: fromHex(p.nonceHex),
    messages: [
      Uint8Array.from(Buffer.from(p.revealedValues.reType, "utf8")),
      Uint8Array.from(Buffer.from(p.revealedValues.qtyKWh, "utf8")),
      Uint8Array.from(Buffer.from(p.revealedValues.timestamp, "utf8")),
      fromHex(p.revealedValues.credentialIdHash),
    ],
  });

  console.log("BBS+ presentation verified:", verified.verified);
  console.log("Revealed values:", p.revealedValues);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

