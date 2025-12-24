import { writeFileSync } from "fs";
import { keccak256, toUtf8Bytes } from "ethers";
const vc = {
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential","GreenEnergyCredential"],
  "issuer": "did:example:registry",
  "issuanceDate": new Date().toISOString(),
  "credentialSubject": {
    "ownerHash": "0x" + "ab".repeat(32),
    "meterHash": "0x" + "cd".repeat(32),
    "siteHash":  "0x" + "ef".repeat(32),
    "epochIndex": 202540,
    "energyType": "SOLAR",
    "typeCode": 0,
    "quantityKWh": 100,
    "policyNonce": 0
  }
};
const vcStr = JSON.stringify(vc);
const vcHash = keccak256(toUtf8Bytes(vcStr));
const out = { vc, vcHash };
writeFileSync("dataset/vc.json", JSON.stringify(out, null, 2));
console.log("Wrote dataset/vc.json with vcHash:", vcHash);
