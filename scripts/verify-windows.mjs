#!/usr/bin/env node
// verify-windows.mjs -- the desktop window allocator against the live box (docs/GAP-ANALYSIS.md DISPLAY-4).
//   1. a deleted agent's ensureForeverBox is refused without a bring-up: no new X server, no assignment
//   2. a fresh agent still gets a window right after that (nothing wedged on the lowest free index)
//   3. a seat the host did not issue (a stray X server with a foreign token) is adopted, not refused
//   4. everything the gate started is gone at the end: assignments, X servers, tokens
// Usage: SAND_PROFILE_DIRS=... node scripts/verify-windows.mjs
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = "grok-bot-local-vm";
const token = () => { for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) { if (!dir) continue; try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {} } throw new Error("no local-docker-vm.json token under SAND_PROFILE_DIRS"); };
const TOKEN = token();
const call = async (method, args = {}) => { const res = await fetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) }); const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = text; } if (!res.ok) throw new Error(`${method} ${res.status}: ${typeof body === "string" ? body : body?.error ?? text}`); return body; };
const sh = (cmd) => new Promise((resolve) => execFile("docker", ["exec", BOX, "sh", "-c", cmd], { maxBuffer: 8 << 20 }, (error, out, err) => resolve({ code: error?.code ?? 0, out: String(out ?? ""), err: String(err ?? "") })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`); if (!ok) failures += 1; };
const seats = async () => { const xvfb = (await sh(`ps -eo args | awk '$1=="Xvfb"{print $2}'`)).out.trim().split(/\s+/).filter(Boolean).map((d) => Number(d.slice(1))).sort((a, b) => a - b); const tokens = (await sh("ls /tmp/sand-window-tokens.d 2>/dev/null")).out.trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b); const assigned = JSON.parse((await sh("cat /home/box/.sand-window-assignments.json")).out || "{}").assignments ?? {}; return { xvfb, tokens, assigned }; };
const windowOf = (status) => Number(/:(\d+)/.exec(status?.windows?.[0]?.display ?? status?.vncUrl ?? "")?.[1] ?? NaN);
const mint = async (tag) => { const made = await call("createAgent", { name: `probe-windows-${tag}-${Math.random().toString(36).slice(2, 6)}`, description: "", origin: "user", isKickstartRequested: false }); return made?.agent ?? made; };

const before = await seats();
console.log(`before: Xvfb ${JSON.stringify(before.xvfb)} tokens ${JSON.stringify(before.tokens)} assignments ${Object.keys(before.assigned).length}`);
const made = [];
try {
  // 1. a deleted agent is refused before the box is touched
  const a = await mint("gone"); made.push(a.id);
  const aStatus = await call("ensureForeverBox", { id: a.id });
  const aIndex = Object.entries((await seats()).assigned).find(([id]) => id === a.id)?.[1];
  check(Number.isInteger(aIndex) && aIndex >= 3, "the first probe got a fork window", `index ${aIndex}, state ${aStatus?.state}`);
  await call("deleteAgents", { ids: [a.id] }); made.pop();
  await sleep(3000);
  const afterDelete = await seats();
  check(!(a.id in afterDelete.assigned), "delete released its assignment");
  let refused = 0, storms = 0;
  for (let i = 0; i < 5; i += 1) { try { await call("ensureForeverBox", { id: a.id }); storms += 1; } catch (error) { if (/no longer exists|deleted|unknown agent/.test(error.message)) refused += 1; /* the gateway refuses a tombstoned id as "unknown agent" before the service sees it */ else console.log(`    other error: ${error.message}`); } await sleep(300); }
  const afterPolls = await seats();
  check(refused === 5 && storms === 0, "five polls of the deleted agent's desktop were all refused", `refused ${refused}, brought up ${storms}`);
  check(JSON.stringify(afterPolls.xvfb) === JSON.stringify(afterDelete.xvfb) && !(a.id in afterPolls.assigned), "the polls started no X server and wrote no assignment", `Xvfb ${JSON.stringify(afterPolls.xvfb)}`);
  // 2. a fresh agent is not wedged
  const b = await mint("fresh"); made.push(b.id);
  const bStatus = await call("ensureForeverBox", { id: b.id });
  const bIndex = (await seats()).assigned[b.id];
  check(Number.isInteger(bIndex) && bIndex >= 3 && bStatus?.state === "running", "a fresh agent gets a window right after the deleted one's polls", `index ${bIndex}, state ${bStatus?.state}`);
  // 3. a seat the host did not issue is adopted: forge a foreign token on b's live display, then ask for it again
  const forged = await sh(`printf 'not-the-hosts-token' > /tmp/sand-window-tokens.d/${bIndex} && cat /tmp/sand-window-tokens.d/${bIndex}`);
  check(forged.out === "not-the-hosts-token", "a foreign token was planted on the live seat", `index ${bIndex}`);
  await call("deleteAgents", { ids: [b.id] }); made.pop();
  await sleep(3000);
  const c = await mint("adopt"); made.push(c.id);
  // the lowest free index is b's old one; the seat may be dead (stop-window ran) or alive with the foreign token
  const cStatus = await call("ensureForeverBox", { id: c.id }).catch((error) => ({ error: error.message }));
  const cIndex = (await seats()).assigned[c.id];
  check(cStatus?.state === "running" && Number.isInteger(cIndex), "the next agent is not refused a seat that carried a token the host did not issue", cStatus?.error ?? `index ${cIndex}`);
  const bound = (await sh(`cat /tmp/sand-window-tokens.d/${cIndex} 2>/dev/null`)).out;
  check(bound.length > 0 && bound !== "not-the-hosts-token", "the seat now carries the host's own token", `token length ${bound.length}`);
} catch (error) {
  check(false, `gate crashed: ${error.message}`);
} finally {
  for (const id of made) { try { await call("deleteAgents", { ids: [id] }); } catch {} }
  await sleep(4000);
  const after = await seats();
  const leaked = after.xvfb.filter((d) => !before.xvfb.includes(d));
  const leakedTokens = after.tokens.filter((t) => !before.tokens.includes(t));
  const probeRows = Object.keys(after.assigned).filter((id) => made.includes(id));
  check(leaked.length === 0 && leakedTokens.length === 0 && probeRows.length === 0, "nothing the gate started is left on the box", `Xvfb ${JSON.stringify(after.xvfb)} tokens ${JSON.stringify(after.tokens)} assignments ${Object.keys(after.assigned).length}`);
}
console.log(failures === 0 ? "PASS - windows" : `FAIL - windows (${failures})`);
process.exit(failures === 0 ? 0 : 1);
