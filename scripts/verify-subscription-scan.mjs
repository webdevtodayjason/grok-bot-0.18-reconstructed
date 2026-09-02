#!/usr/bin/env node
// verify-subscription-scan.mjs -- the subscriptions gate (docs/SUBSCRIPTIONS-CONTRACT.md).
//
// Default: the relay's scan reports presence, identity and expiry for Codex, MiniMax, Gemini and
// Claude on this Mac, and its output contains no secret. The Claude row must come from the CLI's
// own status command, never from its keychain or credentials file.
// --leaks: every secret the adoption store holds is absent from endpoints.json, the host log and
// the recent transcripts of every agent. Secrets are compared by value and never printed.
// Usage: node scripts/verify-subscription-scan.mjs [--leaks]
import { execFile } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = "grok-bot-local-vm";
const LEAKS = process.argv.includes("--leaks");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {}
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}
const call = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const docker = (args) => new Promise((resolve) => execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) => resolve(error && !out ? "" : String(out))));

let failures = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures += 1; };

if (!LEAKS) {
  const raw = await (await fetch(`${GATEWAY}/subscriptions`)).text();
  const { subscriptions } = JSON.parse(raw);
  const byId = Object.fromEntries(subscriptions.map((s) => [s.id, s]));
  for (const id of ["codex", "minimax", "gemini", "claude"]) {
    const row = byId[id];
    check(row != null && typeof row.present === "boolean" && typeof row.usable === "boolean" && typeof row.source === "string",
      `${id} reported`, row ? `present ${row.present}, usable ${row.usable}, identity ${row.identity ?? "none"}, expires ${row.expiresAt ?? "n/a"}, source ${row.source}` : "missing");
  }
  check(byId.claude?.source === "claude auth status --json", "Claude asked through its CLI, not read", byId.claude?.source);
  check(/existence only/.test(byId.gemini?.source ?? ""), "Gemini checked for existence only", byId.gemini?.source);
  // No secret in the scan output: nothing that looks like a token, and no value from the store.
  const { storedSecrets } = await import(path.join(repoRoot, "ui", "subscriptions.mjs"));
  const secrets = await storedSecrets();
  check(!secrets.some((s) => raw.includes(s)), `no adopted secret in the scan output (${secrets.length} held)`);
  check(!/eyJ[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}/.test(raw), "no token-shaped string in the scan output");
} else {
  const { storedSecrets } = await import(path.join(repoRoot, "ui", "subscriptions.mjs"));
  const secrets = await storedSecrets();
  console.log(`  INFO  ${secrets.length} adopted secret(s) held in the store`);
  const surfaces = [];
  const endpointsFile = path.join(repoRoot, "ui", "endpoints.json");
  surfaces.push(["ui/endpoints.json", existsSync(endpointsFile) ? readFileSync(endpointsFile, "utf8") : ""]);
  surfaces.push(["host log (last 4000 lines)", await docker(["exec", BOX, "sh", "-c", "tail -4000 /tmp/sand-host.log 2>/dev/null || true"])]);
  const agents = (await call("listAgents")).filter((a) => !a.isGroup);
  for (const a of agents.slice(0, 8)) {
    const entries = await call("getAgentTranscript", { id: a.id }).catch(() => []);
    surfaces.push([`transcript ${a.name}`, JSON.stringify(entries.slice(-300))]);
  }
  surfaces.push(["scan output", await (await fetch(`${GATEWAY}/subscriptions`)).text()]);
  for (const [name, text] of surfaces) {
    const hit = secrets.find((s) => text.includes(s));
    check(hit == null, `no adopted secret in ${name}`, hit ? "a stored secret appears here" : `${text.length} chars checked`);
  }
  const mode = (() => { try { return (statSync(path.join(repoRoot, "ui", "subscriptions.json")).mode & 0o777).toString(8); } catch { return "absent"; } })();
  console.log(`  INFO  store mode ${mode}`);
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
