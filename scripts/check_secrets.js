#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Scans git-tracked (default) or staged (--staged) files for credentials:
 * private keys assigned to *_PRIVATE_KEY / *_PK / *SECRET* variables, secret-key JSON fields,
 * RPC URLs that embed provider API keys, PEM private keys, mnemonics, and tracked .env files.
 *
 *   node scripts/check_secrets.js            # whole tree (CI / manual)
 *   node scripts/check_secrets.js --staged   # pre-commit hook (.githooks/pre-commit)
 *
 * Plain Node with no dependencies so the hook stays fast. Matches are reported by file and
 * line with the secret itself masked.
 */
const { execFileSync } = require("node:child_process");

const RULES = [
  {
    name: "private key assigned to a key/secret variable",
    re: /\b[A-Z0-9_]*(PRIVATE_KEY|_PK|SECRET_KEY|SECRET)\b["']?\s*[:=]\s*["']?(0x)?[0-9a-fA-F]{64}\b/,
  },
  { name: "secret key field in JSON", re: /"(secretKey|secretKeyHex|privateKey|private_key|mnemonic)"\s*:\s*"(0x)?[0-9a-zA-Z]{16,}/ },
  { name: "Alchemy RPC URL with API key", re: /[a-z0-9-]+\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]{16,}/ },
  { name: "Infura RPC URL with project id", re: /infura\.io\/v3\/[0-9a-fA-F]{32}/ },
  { name: "QuickNode RPC URL with token", re: /quiknode\.pro\/[0-9a-fA-F]{20,}/ },
  { name: "Etherscan-style API key", re: /\b[A-Z_]*SCAN_API_KEY\s*[:=]\s*["']?[A-Z0-9]{30,}/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "mnemonic phrase", re: /\bMNEMONIC\b["']?\s*[:=]\s*["']?([a-z]+\s+){11,}[a-z]+/ },
];

// Generated or vendored files that cannot hold project secrets.
const SKIP = [/^package-lock\.json$/, /\.(png|jpe?g|gif|pdf|ico|woff2?|wasm)$/i];

const staged = process.argv.includes("--staged");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listFiles() {
  const out = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    : git(["ls-files", "-z"]);
  return out.split("\0").filter(Boolean);
}

function readFile(file) {
  try {
    return staged ? git(["show", `:${file}`]) : require("node:fs").readFileSync(file, "utf8");
  } catch {
    return null; // deleted or unreadable
  }
}

function mask(line) {
  return line
    .replace(/(0x)?[0-9a-fA-F]{32,}/g, (m) => `${m.slice(0, 6)}…[masked]`)
    .replace(/(\/v2\/|\/v3\/|quiknode\.pro\/)[A-Za-z0-9_-]+/g, "$1[masked]")
    .slice(0, 160);
}

const findings = [];
for (const file of listFiles()) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example")) {
    findings.push({ file, line: 0, rule: "environment file is tracked", text: "" });
    continue;
  }
  if (SKIP.some((re) => re.test(file))) continue;
  const content = readFile(file);
  if (content === null || content.includes("\u0000")) continue;
  const lines = content.split("\n");
  lines.forEach((text, i) => {
    for (const rule of RULES) {
      if (rule.re.test(text)) findings.push({ file, line: i + 1, rule: rule.name, text: mask(text.trim()) });
    }
  });
}

if (findings.length === 0) {
  console.log(`check:secrets: no credentials found in ${staged ? "staged" : "tracked"} files.`);
  process.exit(0);
}

console.error(`check:secrets: ${findings.length} possible credential(s) found:`);
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  [${f.rule}]  ${f.text}`);
}
console.error("Move real values to .env (git-ignored) and keep placeholders in .env.example.");
process.exit(1);
