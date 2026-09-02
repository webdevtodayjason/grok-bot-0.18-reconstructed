#!/usr/bin/env node
// verify-codex-adoption.mjs -- Codex adoption gate (docs/SUBSCRIPTIONS-CONTRACT.md, step 4).
//
// Adopts the Codex CLI login through the relay, points the box at the adopted endpoint (the
// Responses transport with this product's own originator), runs the rubric's speak and work tiers
// on a fresh agent, and proves the vendor's own auth file was never written: its bytes are hashed
// before and after. The box is switched back to where it was on every exit path.
// Usage: node scripts/verify-codex-adoption.mjs [--rounds 1] [--turn-timeout-ms 150000]
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = "grok-bot-local-vm";
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const ROUNDS = flag("--rounds", "1");
const TURN_TIMEOUT = flag("--turn-timeout-ms", "150000");
const AUTH_FILE = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "auth.json");

const relay = async (route, body) => {
  const res = await fetch(`${GATEWAY}${route}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${typeof parsed === "string" ? parsed.slice(0, 200) : parsed.error ?? text.slice(0, 200)}`);
  return parsed;
};
const docker = (args) => new Promise((resolve) => execFile("docker", args, { maxBuffer: 8 << 20 }, (error, out) => resolve(error && !out ? "" : String(out))));
const run = (args) => new Promise((resolve) => execFile("node", args, { maxBuffer: 16 << 20, env: process.env }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out) + String(err) })));
const sha = (file) => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return "absent"; } };

let failures = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures += 1; };

const before = await relay("/endpoints");
const previous = (before.endpoints ?? []).find((e) => e.baseUrl === before.live?.baseUrl && e.model === before.live?.model)?.id ?? null;
const authBefore = sha(AUTH_FILE);
try {
  const scan = (await relay("/subscriptions")).subscriptions.find((s) => s.id === "codex");
  check(scan?.usable === true, "Codex CLI login found", scan ? `${scan.identity ?? "no identity"}, expires ${scan.expiresAt}` : "no row");
  if (!scan?.usable) throw new Error("nothing to adopt");
  const adopted = await relay("/subscriptions/adopt", { id: "codex" });
  check(adopted.endpoint?.subscription === "codex" && adopted.endpoint.transport === "responses" && !adopted.endpoint.apiKey, "adopted as a keyless Responses endpoint", `${adopted.endpoint.id} · ${adopted.endpoint.model}`);
  const used = await relay("/endpoints/use", { id: adopted.endpoint.id });
  console.log(`  INFO  box now on ${used.using}`);
  const secretsRaw = await docker(["exec", BOX, "cat", "/home/box/sand-data/box-secrets.json"]);
  let secrets = {}; try { secrets = JSON.parse(secretsRaw).secrets ?? {}; } catch {}
  check(secrets.SAND_OPENAI_COMPATIBLE_TRANSPORT === "responses", "box speaks the Responses transport");
  check(secrets.SAND_OPENAI_COMPATIBLE_ORIGINATOR === "grok-bot", "box identifies as grok-bot", `originator=${secrets.SAND_OPENAI_COMPATIBLE_ORIGINATOR ?? "unset"}`);
  check(typeof secrets.SAND_OPENAI_COMPATIBLE_ACCOUNT_ID === "string" && secrets.SAND_OPENAI_COMPATIBLE_ACCOUNT_ID.length > 0, "ChatGPT account id set for the box");
  const rubric = await run(["scripts/model-rubric.mjs", "--models", adopted.endpoint.id, "--end", adopted.endpoint.id, "--turn-timeout-ms", TURN_TIMEOUT, "--out", path.join(os.tmpdir(), "rubric-codex.json")]);
  const scoreLine = rubric.out.split("\n").find((l) => /^\s+score /.test(l)) ?? "(no score line)";
  const speak = /"speak"\s*\{"passed":(\d)/.exec(rubric.out.replace(/speak\s+/, '"speak" '))?.[1];
  const work = /"work"\s*\{"passed":(\d)/.exec(rubric.out.replace(/work\s+/, '"work" '))?.[1];
  console.log(`  INFO  ${scoreLine.trim()}`);
  for (const line of rubric.out.split("\n").filter((l) => /^\s+(speak|work|history|note:)/.test(l))) console.log(`        ${line.trim().slice(0, 220)}`);
  check(Number(speak) >= 1, "spoke through the Responses transport", `speak ${speak ?? "?"}/2`);
  check(Number(work) >= 1, "worked with evidence through the Responses transport", `work ${work ?? "?"}/2`);
} catch (error) {
  check(false, "codex adoption", error.message);
} finally {
  check(sha(AUTH_FILE) === authBefore, "the Codex CLI's auth.json was never written", `sha256 unchanged: ${authBefore.slice(0, 12)}…`);
  if (previous) { await relay("/endpoints/use", { id: previous }).catch(() => {}); console.log(`  INFO  box restored to ${previous}`); }
}
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
