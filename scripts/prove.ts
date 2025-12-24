import { readFileSync, writeFileSync } from "fs";
import { AbiCoder, keccak256, Wallet, getBytes, hexlify } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const { vcHash, vc } = JSON.parse(readFileSync("dataset/vc.json", "utf-8"));
const disc = {
  epochIndex: vc.credentialSubject.epochIndex,
  typeCode: vc.credentialSubject.typeCode,
  quantityKWh: vc.credentialSubject.quantityKWh,
  policyNonce: vc.credentialSubject.policyNonce
};

const coder = new AbiCoder();
const discBytes = coder.encode(["tuple(uint64,uint16,uint256,uint128)"], [[disc.epochIndex, disc.typeCode, BigInt(disc.quantityKWh), BigInt(disc.policyNonce)]]);
const discHash = keccak256(discBytes);
const message = keccak256(Buffer.concat([getBytes(vcHash), getBytes(discHash)]));

const issuerKey = process.env.ISSUER_KEY;
if (!issuerKey) throw new Error("ISSUER_KEY missing in .env");
const wallet = new Wallet(issuerKey);
const signature = await wallet.signMessage(getBytes(message));

const proofPacked = coder.encode(["bytes32","bytes"], [vcHash, signature]);

const out = { disc, discBytes: hexlify(getBytes(discBytes)), proof: proofPacked };
writeFileSync("dataset/proof.json", JSON.stringify(out, null, 2));
console.log("Wrote dataset/proof.json; signer:", wallet.address);
