import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { blsCreateProof } from "@mattrglobal/bbs-signatures";

type VcRecord = {
  issuer: {
    publicKeyHex: string;
  };
  credentialIdHash: string;
  messagesHex: string[];
  signatureHex: string;
  messageOrder: string[];
  vc: {
    credentialSubject: {
      reType: string;
      qtyKWh: string;
      timestamp: string;
    };
  };
};

function fromHex(hex: string): Uint8Array {
  return ethers.getBytes(hex);
}

function toHex(b: Uint8Array): string {
  return ethers.hexlify(b);
}

async function main() {
  const inPath = path.join(process.cwd(), "dataset", "bbs_vc.json");
  const rec = JSON.parse(fs.readFileSync(inPath, "utf8")) as VcRecord;

  const nonceText = process.env.BBS_NONCE ?? "green-credit-bbs-nonce-v1";
  const nonce = Uint8Array.from(Buffer.from(nonceText, "utf8"));

  // Reveal paper fields + credentialIdHash used for anti-replay on-chain binding.
  const revealIndices = [3, 4, 5, 6];
  const proof = await blsCreateProof({
    signature: fromHex(rec.signatureHex),
    publicKey: fromHex(rec.issuer.publicKeyHex),
    messages: rec.messagesHex.map(fromHex),
    nonce,
    revealed: revealIndices,
  });

  const out = {
    source: "dataset/bbs_vc.json",
    revealIndices,
    revealedFieldNames: revealIndices.map((i) => rec.messageOrder[i]),
    revealedValues: {
      reType: rec.vc.credentialSubject.reType,
      qtyKWh: rec.vc.credentialSubject.qtyKWh,
      timestamp: rec.vc.credentialSubject.timestamp,
      credentialIdHash: rec.credentialIdHash,
    },
    publicKeyHex: rec.issuer.publicKeyHex,
    nonceHex: toHex(nonce),
    proofHex: toHex(proof),
  };

  const outPath = path.join(process.cwd(), "dataset", "bbs_presentation.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Wrote:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

