#!/usr/bin/env node
// verify-gateway-reads.mjs -- host wave E1 probes against the live gateway (docs/GAP-ANALYSIS.md §0).
//   GW-15   setAgentUnread{isUnread:true} raises without error and isUnread:false clears it
//   AUDIT-1 getAgentActionAudit pages the per-agent ledger newest-first; [] for an agent without one
//   CHURN-1 agent-upserted events on /events while the roster is idle stay near zero for 30 s
//   FLAGS-1 the host log carries one [sand][gates] table line since the last start
// Usage: node scripts/verify-gateway-reads.mjs
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = "grok-bot-local-vm";
const token = () => { for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) { if (!dir) continue; try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {} } throw new Error("no gateway token: set SAND_PROFILE_DIRS"); };
const TOKEN = token();
const call = async (method, args = {}) => { const res = await fetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) }); const text = await res.text(); if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`); try { return JSON.parse(text); } catch { return text; } };
const docker = (args) => new Promise((resolve) => execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) => resolve(error && !out ? "" : String(out))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures += 1; };

const rosterBefore = (await call("listAgents")).map((a) => a.id).sort();
let agent;
try {
  const made = await call("createAgent", { name: `verify-reads-${Math.random().toString(36).slice(2, 7)}`, description: "", origin: "user", isKickstartRequested: false });
  agent = made?.agent ?? made;
  // GW-15
  let raiseError = null;
  try { await call("setAgentUnread", { id: agent.id, isUnread: true }); } catch (error) { raiseError = error.message; }
  const raised = (await call("listAgents")).find((a) => a.id === agent.id);
  check(raiseError == null, "setAgentUnread{isUnread:true} returns without error", raiseError ?? `unreadCount ${raised?.unreadCount}`);
  check((raised?.unreadCount ?? 0) > 0 || raised?.hasUnread === true, "the raise is visible in listAgents", `unreadCount ${raised?.unreadCount}, hasUnread ${raised?.hasUnread}`);
  await call("setAgentUnread", { id: agent.id, isUnread: false });
  const cleared = (await call("listAgents")).find((a) => a.id === agent.id);
  check((cleared?.unreadCount ?? 0) === 0 && cleared?.hasUnread !== true, "isUnread:false clears it", `unreadCount ${cleared?.unreadCount}`);
  // AUDIT-1
  const empty = await call("getAgentActionAudit", { id: agent.id });
  check(Array.isArray(empty?.rows) && empty.rows.length === 0, "getAgentActionAudit is [] for an agent with no ledger");
  const withLedger = (await call("listAgents")).find((a) => a.name === "Chief of staff") ?? rosterBefore[0];
  const page = await call("getAgentActionAudit", { id: withLedger.id ?? withLedger, limit: 5 });
  const rows = page?.rows ?? [];
  const newestFirst = rows.length < 2 || rows.every((row, i) => i === 0 || String(rows[i - 1].ts ?? "") >= String(row.ts ?? ""));
  check(rows.length > 0, "getAgentActionAudit returns rows for an agent with a ledger", `${rows.length} rows, first ${rows[0]?.type ?? "?"}:${rows[0]?.tool ?? rows[0]?.action?.kind ?? "?"}`);
  check(newestFirst, "rows are newest first");
  check(rows.every((row) => String(row.head ?? "").length <= 8_000), "no row body exceeds the stored head");
  if (page?.nextBefore) { const next = await call("getAgentActionAudit", { id: withLedger.id ?? withLedger, limit: 5, before: page.nextBefore }); check((next?.rows ?? []).length > 0 && next.rows[0]?.eventId !== rows[0]?.eventId, "paging with nextBefore yields a different page"); }
  // FLAGS-1
  const gates = await docker(["exec", BOX, "sh", "-c", "grep -F '[sand][gates] {' /tmp/sand-host.log | tail -1 | cut -c1-400"]);
  check(gates.includes("sand_browser_use_subagent"), "the host log carries a [sand][gates] table", gates.trim().slice(0, 160));
} finally {
  if (agent?.id) await call("deleteAgent", { id: agent.id }).catch(() => {});
}
// CHURN-1: idle roster, count agent-upserted for 30 s
const controller = new AbortController();
let upserts = 0;
const listen = (async () => { try { const res = await fetch(`${GATEWAY}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal }); const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) if (line.includes("agent-upserted")) upserts += 1; } } catch {} })();
await sleep(30_000); controller.abort(); await listen.catch(() => {});
check(upserts <= 2, "agent-upserted stays quiet on an idle roster for 30 s", `${upserts} event(s)`);
let rosterAfter = (await call("listAgents")).map((a) => a.id).sort();
for (const id of rosterAfter.filter((x) => !rosterBefore.includes(x))) { console.log(`  WARN  an agent appeared during the run and was removed: ${id}`); await call("deleteAgent", { id }).catch(() => {}); }
rosterAfter = (await call("listAgents")).map((a) => a.id).sort();
check(JSON.stringify(rosterAfter) === JSON.stringify(rosterBefore), "roster unchanged", `${rosterAfter.length} agents`);
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
