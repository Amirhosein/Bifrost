import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { blsSign, generateBls12381G2KeyPair } from "@mattrglobal/bbs-signatures";

type BbsVcRecord = {
  issuer: {
    publicKeyHex: string;
  };
  vc: {
    id: string;
    type: string[];
    issuer: string;
    issuanceDate: string;
    credentialSubject: {
      ownerID: string;
      meterID: string;
      siteID: string;
      reType: string;
      qtyKWh: string;
      timestamp: string;
    };
  };
  credentialIdHash: string;
  messageOrder: string[];
  messagesHex: string[];
  signatureHex: string;
};

function toBytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "utf8"));
}

function fromHex(hex: string): Uint8Array {
  return ethers.getBytes(hex);
}

function toHex(b: Uint8Array): string {
  return ethers.hexlify(b);
}

async function main() {
  const ownerID = process.env.BBS_OWNER_ID ?? "did:example:owner789";
  const meterID = process.env.BBS_METER_ID ?? "meter-56789";
  const siteID = process.env.BBS_SITE_ID ?? "site-34567";
  const reType = process.env.BBS_RE_TYPE ?? "Solar";
  const qtyKWh = process.env.BBS_QTY_KWH ?? "100";
  const timestamp = process.env.BBS_TIMESTAMP ?? "2025-02-15T12:00:00Z";
  const vcId = process.env.BBS_VC_ID ?? "urn:uuid:green-credit-vc-1";
  const issuerDid = process.env.BBS_ISSUER_DID ?? "did:example:registry";

  const vc = {
    id: vcId,
    type: ["VerifiableCredential", "RenewableEnergyVC"],
    issuer: issuerDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      ownerID,
      meterID,
      siteID,
      reType,
      qtyKWh,
      timestamp,
    },
  };

  const credentialIdHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(vc)));

  // Message ordering is canonical and must be preserved for selective disclosure proofs.
  const messageOrder = ["ownerID", "meterID", "siteID", "reType", "qtyKWh", "timestamp", "credentialIdHash"];
  const messages = [toBytes(ownerID), toBytes(meterID), toBytes(siteID), toBytes(reType), toBytes(qtyKWh), toBytes(timestamp), fromHex(credentialIdHash)];

  const keyPair = await generateBls12381G2KeyPair();
  const signature = await blsSign({ keyPair, messages });

  const out: BbsVcRecord = {
    // The issuer secret key is deliberately not persisted: the record is committed to git,
    // and presentations only need the public key and the signature.
    issuer: {
      publicKeyHex: toHex(keyPair.publicKey),
    },
    vc,
    credentialIdHash,
    messageOrder,
    messagesHex: messages.map(toHex),
    signatureHex: toHex(signature),
  };

  const outPath = path.join(process.cwd(), "dataset", "bbs_vc.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log("Wrote:", outPath);
  console.log("credentialIdHash:", credentialIdHash);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
