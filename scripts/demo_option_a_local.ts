/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

import { GTokenOptionAArb__factory, MockBridgeSink__factory, RegistryL1__factory } from "../typechain-types";
import { chainId, latestTimestamp } from "../test/helpers/bbsBound";
import { ARB_KEY, BRIDGE, OP_KEY, aliasOf, arbFee, deployOptionA, issueOptionA, opFee, proveA1, proveA2, sentMessageId } from "../test/helpers/optionA";

/**
 * Option A, step by step, on one local chain that stands in for Ethereum + two L2s.
 * Prints who calls what, through which bridge, what the L2 sees as the sender, and the gas of each step.
 * Then measures the registry's own L1 gas with a do-nothing bridge, to separate it from bridge costs.
 * Output: docs/bench_option_a_local.json
 */

type Row = { variant: string; chain: string; layer: "L1" | "L2"; step: string; gasUsed: string; notes?: string };

const ETH_USD = Number(process.env.ETH_USD ?? 2050);
const L1_GWEI = (process.env.L1_GWEI ?? "0.5,2,10").split(",").map(Number);
const L2_GWEI = Number(process.env.L2_GWEI ?? 0.0313);

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function gas(txPromise: Promise<any>) {
  const tx = await txPromise;
  const rc = await tx.wait();
  return { tx, gas: rc.gasUsed as bigint };
}

const rows: Row[] = [];
function log(layer: "L1" | "L2" | "--", text: string, g?: bigint) {
  console.log(`  [${layer}] ${text}${g !== undefined ? `   gas=${g.toLocaleString("en-US")}` : ""}`);
}

async function main() {
  const [, producer, recipient, ra] = await ethers.getSigners();
  const ctx = await deployOptionA(ra.address);
  const registryAddr = await ctx.registry.getAddress();
  const chains = [
    { name: "Arbitrum", key: ARB_KEY, token: ctx.tokenArb, delay: 600, delayText: "~10 minutes" },
    { name: "OP Stack", key: OP_KEY, token: ctx.tokenOp, delay: 120, delayText: "~1-3 minutes" },
  ];

  console.log("\nSetup");
  log("L1", `RegistryL1 ${registryAddr}; RA signs credentials with header (SYSTEM_TAG, L1 chain id, registry)`);
  log("L1", `route ${ARB_KEY} -> Arbitrum Inbox ${await ctx.inbox.getAddress()} -> GTokenOptionAArb ${await ctx.tokenArb.getAddress()}`);
  log("L1", `route ${OP_KEY} -> L1CrossDomainMessenger ${await ctx.opMessenger.getAddress()} -> GTokenOptionAOp ${await ctx.tokenOp.getAddress()}`);
  log("--", `on Arbitrum the registry's messages arrive from alias(registry) = ${aliasOf(registryAddr)}`);

  for (const c of chains) {
    // ---------------- A1 ----------------
    console.log(`\nA1 (verify on Ethereum, mint by message) -> ${c.name}`);
    const cred = await issueOptionA(ctx.keys, ctx.registry);
    const d = (await latestTimestamp()) + 3600n;
    const proof = await proveA1({ keys: ctx.keys, credential: cred, registry: ctx.registry, chainKey: c.key, recipient: recipient.address, deadline: d });
    const f = c.key === ARB_KEY ? arbFee() : opFee();
    const r1 = await gas(ctx.registry.connect(producer).registerAndMint(c.key, recipient.address, cred.claims, d, proof, f.fee, { value: f.value }));
    const id = await sentMessageId(ctx.registry, r1.tx);
    log("L1", `producer -> RegistryL1.registerAndMint(chain ${c.key}): BBS proof checked on L1, serial recorded, message #${id} sent`, r1.gas);
    rows.push({ variant: "A1", chain: c.name, layer: "L1", step: "registerAndMint (incl. mock bridge)", gasUsed: r1.gas.toString() });
    log("--", `bridge delay ${c.delayText}; deposit paid on L1: ${ethers.formatEther(f.value)} ETH (test values)`);
    await increase(c.delay);
    const del = c.key === ARB_KEY ? await gas(ctx.inbox.autoRedeem(id)) : await gas(ctx.opMessenger.relayMessage(id, 200_000n));
    log("L2", `${c.key === ARB_KEY ? "auto-redeem from alias(registry)" : "L2 messenger relays, xDomainMessageSender = registry"} -> mintFromRegistry -> ${await c.token.balanceOf(recipient.address)} GT to recipient`, del.gas);
    rows.push({ variant: "A1", chain: c.name, layer: "L2", step: "delivery: mintFromRegistry (incl. mock bridge)", gasUsed: del.gas.toString() });

    // ---------------- A2 ----------------
    console.log(`\nA2 (register on Ethereum, verify on ${c.name})`);
    const cred2 = await issueOptionA(ctx.keys, ctx.registry);
    const salt = ethers.id("salt-" + cred2.claims.serial);
    const commitment = await ctx.registry.commitmentOf(cred2.claims.serial, c.key, producer.address, salt);
    const cm = await gas(ctx.registry.connect(producer).commit(commitment));
    log("L1", "producer -> RegistryL1.commit(H(serial, chain, producer, salt)): the serial stays hidden", cm.gas);
    rows.push({ variant: "A2", chain: c.name, layer: "L1", step: "commit", gasUsed: cm.gas.toString() });
    await increase(61);
    const f2 = c.key === ARB_KEY ? arbFee() : opFee();
    const rv = await gas(ctx.registry.connect(producer).reveal(cred2.claims.serial, c.key, salt, f2.fee, { value: f2.value }));
    const id2 = await sentMessageId(ctx.registry, rv.tx);
    log("L1", `producer -> RegistryL1.reveal(serial, chain ${c.key}, salt): serial recorded, message #${id2} sent`, rv.gas);
    rows.push({ variant: "A2", chain: c.name, layer: "L1", step: "reveal (incl. mock bridge)", gasUsed: rv.gas.toString() });
    await increase(c.delay);
    const del2 = c.key === ARB_KEY ? await gas(ctx.inbox.autoRedeem(id2)) : await gas(ctx.opMessenger.relayMessage(id2, 200_000n));
    log("L2", `message delivered -> authorizeSerial: authorized=${await c.token.authorized(cred2.claims.serial)}`, del2.gas);
    rows.push({ variant: "A2", chain: c.name, layer: "L2", step: "delivery: authorizeSerial (incl. mock bridge)", gasUsed: del2.gas.toString() });
    const d2 = (await latestTimestamp()) + 3600n;
    const proof2 = await proveA2({ keys: ctx.keys, credential: cred2, token: c.token, recipient: recipient.address, deadline: d2 });
    const mb = await gas(c.token.connect(producer).mintBound(recipient.address, cred2.claims, d2, proof2));
    log("L2", `producer -> mintBound with the full BBS proof -> recipient now holds ${await c.token.balanceOf(recipient.address)} GT`, mb.gas);
    rows.push({ variant: "A2", chain: c.name, layer: "L2", step: "mintBound (BBS verified on L2)", gasUsed: mb.gas.toString() });
  }

  // ---------------- registry gas without any bridge implementation ----------------
  console.log("\nRegistry logic only (do-nothing bridge), to separate it from bridge costs");
  const [admin] = await ethers.getSigners();
  const sink = await new MockBridgeSink__factory(admin).deploy();
  const reg2 = await new RegistryL1__factory(admin).deploy(await ctx.verifier.getAddress());
  const l1ChainId = await chainId();
  const tok2 = await new GTokenOptionAArb__factory(admin).deploy("GT", "GT", await ctx.verifier.getAddress(), l1ChainId, await reg2.getAddress(), ra.address);
  await reg2.setRoute(ARB_KEY, BRIDGE.Arbitrum, await sink.getAddress(), await tok2.getAddress());
  await reg2.setRoute(OP_KEY, BRIDGE.OpStack, await sink.getAddress(), await tok2.getAddress());
  await (await sink.sendMessage(ethers.ZeroAddress, "0x", 0)).wait(); // warm the counter slot
  for (const c of chains) {
    const cred = await issueOptionA(ctx.keys, reg2);
    const d = (await latestTimestamp()) + 3600n;
    const proof = await proveA1({ keys: ctx.keys, credential: cred, registry: reg2, chainKey: c.key, recipient: recipient.address, deadline: d });
    const f = c.key === ARB_KEY ? arbFee() : opFee();
    const a = await gas(reg2.connect(producer).registerAndMint(c.key, recipient.address, cred.claims, d, proof, f.fee, { value: f.value }));
    log("L1", `A1 registerAndMint -> ${c.name}`, a.gas);
    rows.push({ variant: "A1", chain: c.name, layer: "L1", step: "registerAndMint (registry logic only)", gasUsed: a.gas.toString() });

    const cred2 = await issueOptionA(ctx.keys, reg2);
    const salt = ethers.id("s" + cred2.claims.serial);
    const cm = await gas(reg2.connect(producer).commit(await reg2.commitmentOf(cred2.claims.serial, c.key, producer.address, salt)));
    await increase(61);
    const f2 = c.key === ARB_KEY ? arbFee() : opFee();
    const rv = await gas(reg2.connect(producer).reveal(cred2.claims.serial, c.key, salt, f2.fee, { value: f2.value }));
    log("L1", `A2 commit + reveal -> ${c.name}`, cm.gas + rv.gas);
    rows.push({ variant: "A2", chain: c.name, layer: "L1", step: "commit (registry logic only)", gasUsed: cm.gas.toString() });
    rows.push({ variant: "A2", chain: c.name, layer: "L1", step: "reveal (registry logic only)", gasUsed: rv.gas.toString() });
  }

  // L2 function cost on its own (Arbitrum token, called from alias(registry), estimateGas incl. 21,000 base)
  const fresh = ethers.id("fresh-serial-for-estimate");
  const mintData = ctx.tokenArb.interface.encodeFunctionData("mintFromRegistry", [fresh, recipient.address, 100n]);
  const authData = ctx.tokenArb.interface.encodeFunctionData("authorizeSerial", [fresh]);
  const from = aliasOf(registryAddr);
  const to = await ctx.tokenArb.getAddress();
  rows.push({ variant: "A1", chain: "Arbitrum", layer: "L2", step: "mintFromRegistry (function only)", gasUsed: (await ethers.provider.estimateGas({ from, to, data: mintData })).toString(), notes: "estimateGas, includes 21,000 base" });
  rows.push({ variant: "A2", chain: "Arbitrum", layer: "L2", step: "authorizeSerial (function only)", gasUsed: (await ethers.provider.estimateGas({ from, to, data: authData })).toString(), notes: "estimateGas, includes 21,000 base" });

  const priced = rows.map((r) => {
    const g = Number(r.gasUsed);
    const usd = (gwei: number) => Number((g * gwei * 1e-9 * ETH_USD).toFixed(4));
    return r.layer === "L1"
      ? { ...r, ...Object.fromEntries(L1_GWEI.map((x) => [`usdL1@${x}gwei`, usd(x)])) }
      : { ...r, usdL2: Number((g * L2_GWEI * 1e-9 * ETH_USD).toFixed(5)) };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    network: network.name,
    assumptions: {
      ethUsd: ETH_USD,
      l1Gwei: L1_GWEI,
      l2EffectiveGwei: L2_GWEI,
      note: "Mock bridges: the real Arbitrum Inbox and OP L1CrossDomainMessenger add their own L1 gas (not measured here). Rows marked 'registry logic only' isolate the registry.",
    },
    rows: priced,
  };
  const file = path.join(__dirname, "..", "docs", "bench_option_a_local.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log("");
  console.table(priced.map((r: any) => ({ variant: r.variant, chain: r.chain, layer: r.layer, step: r.step, gas: r.gasUsed })));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
