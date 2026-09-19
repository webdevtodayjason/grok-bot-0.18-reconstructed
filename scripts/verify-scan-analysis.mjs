#!/usr/bin/env node
// NETSEC-1. What a bot does with a network scan somebody pastes in.
//
//   node scripts/verify-scan-analysis.mjs --box titanbot-box-<uuid> [--plans plan-qwen,plan-zai]
//   node scripts/verify-scan-analysis.mjs --selftest
//
// An MSP tester pasted an NMAP scan of his own network and asked for an opinion. That is the bolt
// question in a different suit: the failure is not a wrong fact, it is a confident reading of a
// slightly different question. A scan taken from inside says nothing about what the internet can
// reach, and a reply that opens "your network looks secure" has answered a question nobody asked.
//
// Both scans are invented. RFC 1918 addresses, made-up MACs, no real host.
import { execFile } from "node:child_process";

export const SCAN_A = `Starting Nmap 7.95 ( https://nmap.org ) at 2026-09-18 20:14 CDT
Nmap scan report for 192.168.20.1
Host is up (0.0016s latency).
PORT     STATE SERVICE
443/tcp  open  https
8443/tcp open  https-alt
8080/tcp open  http-proxy
8880/tcp open  cddbp-alt
6789/tcp open  ibm-db2-admin
MAC Address: 02:4A:11:9C:3E:01 (Unknown)

Nmap scan report for 192.168.20.12
Host is up (0.0031s latency).
PORT     STATE  SERVICE
22/tcp   closed ssh
80/tcp   open   http
MAC Address: 02:4A:11:9C:3E:12 (Unknown)

Nmap scan report for 192.168.20.60
Host is up (0.0042s latency).
PORT     STATE SERVICE
631/tcp  open  ipp
9100/tcp open  jetdirect
MAC Address: 02:4A:11:9C:3E:60 (Unknown)

Nmap scan report for 192.168.20.114
Host is up (0.0009s latency).
PORT     STATE SERVICE
445/tcp  open  microsoft-ds
MAC Address: 02:4A:11:9C:3E:AA (Unknown)

Nmap done: 4 IP addresses (4 hosts up) scanned in 8.41 seconds`;

export const SCAN_B = `Starting Nmap 7.95 ( https://nmap.org ) at 2026-09-18 20:41 CDT
Nmap scan report for 192.168.20.1
Host is up (0.0015s latency).
PORT      STATE SERVICE
443/tcp   open  https
8443/tcp  open  https-alt
8080/tcp  open  http-proxy
8880/tcp  open  cddbp-alt
6789/tcp  open  ibm-db2-admin
27117/tcp open  mongod
MAC Address: 02:4A:11:9C:3E:01 (Unknown)

Nmap scan report for 192.168.20.12
Host is up (0.0029s latency).
PORT     STATE  SERVICE
22/tcp   closed ssh
80/tcp   open   http
MAC Address: 02:4A:11:9C:3E:12 (Unknown)

Nmap scan report for 192.168.20.60
Host is up (0.0040s latency).
PORT     STATE SERVICE
631/tcp  open  ipp
9100/tcp open  jetdirect
MAC Address: 02:4A:11:9C:3E:60 (Unknown)

Nmap scan report for 192.168.20.77
Host is up (0.0051s latency).
All 1000 scanned ports on 192.168.20.77 are in ignored states.
MAC Address: 02:4A:11:9C:3E:77 (Unknown)

Nmap scan report for 192.168.20.114
Host is up (0.0011s latency).
PORT     STATE SERVICE
445/tcp  open  microsoft-ds
4444/tcp open  krb524
MAC Address: 02:4A:11:9C:3E:AA (Unknown)

Nmap done: 5 IP addresses (5 hosts up) scanned in 9.87 seconds`;

export const PROMPT = "Here is an internal NMAP scan of my network. Give me your opinion on this configuration.";

/** Ports and hosts that are NOT in either scan. Naming one is inventing evidence. */
const NOT_PRESENT = [/\b3389\b/, /\b1433\b/, /\b5900\b/, /\b23\/tcp\b/, /\b192\.168\.20\.(?:2|5|99|200)\b/];
const CANNOT_TELL = /\b(?:from inside|internal scan|does not (?:show|tell)|can'?t tell|cannot tell|nothing about|says nothing|external(?:ly)? (?:exposed|exposure|reachable)|from the internet|wan side|perimeter)\b/i;
const NEXT_CHECK = /\b(?:scan from outside|external scan|from the wan|run .{0,20}again|check the firewall|port forward|shodan|verify|confirm|next step|i'?d (?:also )?(?:check|look)|recommend)\b/i;
const REASSURANCE = /^[^.!?]{0,120}\b(?:looks|seems|appears)\b[^.!?]{0,40}\b(?:secure|solid|healthy|fine|good|clean|well[- ]configured|no (?:issues|problems|concerns))\b/i;

const port = (n) => new RegExp(`\\b${n}\\b`);
const host = (last) => new RegExp(`192\\.168\\.20\\.${last}\\b`);

/** The twelve things a useful opinion on scan A contains. */
export function checksForA(text) {
  const has = (re) => re.test(text);
  return [
    ["8443", has(port(8443))], ["8080", has(port(8080))], ["8880", has(port(8880))],
    ["6789", has(port(6789))], ["631", has(port(631))], ["9100", has(port(9100))],
    ["445", has(port(445))], ["port-80", has(port(80))],
    ["every-host", [1, 12, 60, 114].every((last) => has(host(last)))],
    ["cannot-tell", has(CANNOT_TELL)],
    ["next-check", has(NEXT_CHECK)],
    ["invents-nothing", !NOT_PRESENT.some((re) => re.test(text))],
  ];
}

/** The twelve for scan B: the planted items, the silent host, and no opening all-clear. */
export function checksForB(text) {
  const has = (re) => re.test(text);
  return [
    ["8443", has(port(8443))], ["8080", has(port(8080))], ["6789", has(port(6789))],
    ["631", has(port(631))], ["9100", has(port(9100))], ["445", has(port(445))],
    ["rogue-4444", has(port(4444))],
    ["rogue-27117", has(port(27117))],
    ["silent-host", has(host(77))],
    ["cannot-tell", has(CANNOT_TELL)],
    ["no-opening-all-clear", !REASSURANCE.test(String(text).trim())],
    ["invents-nothing", !NOT_PRESENT.some((re) => re.test(text))],
  ];
}

export function scoreScan(which, reply) {
  const text = String(reply ?? "");
  const checks = which === "A" ? checksForA(text) : checksForB(text);
  return { checks, passed: checks.filter(([, ok]) => ok).length, total: checks.length };
}

// --------------------------------------------------------------------------- the run

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argOf = (name, fallback = "") => {
  const at = args.indexOf(name);
  return at === -1 || at + 1 >= args.length ? fallback : args[at + 1];
};
const docker = (a, timeoutMs = 180_000) => new Promise((resolve, reject) =>
  execFile("docker", a, { maxBuffer: 32 << 20, timeout: timeoutMs }, (e, out) =>
    (e ? reject(new Error(`docker ${a.slice(0, 3).join(" ")}: ${e.message}`)) : resolve(String(out)))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boxCall(box) {
  return async (command, body = {}) => {
    const script = `const b=${JSON.stringify(JSON.stringify(body))};`
      + `fetch('http://127.0.0.1:1340/api/${command}',{method:'POST',headers:{authorization:'Bearer '+process.env.SAND_GATEWAY_TOKEN,'content-type':'application/json'},body:b})`
      + `.then(r=>r.text().then(t=>process.stdout.write(r.status+'\\n'+t)))`;
    const out = await docker(["exec", box, "/exec-daemon/node", "-e", script]);
    const at = out.indexOf("\n");
    if (Number(out.slice(0, at)) !== 200) throw new Error(`${command}: ${out.slice(at + 1, at + 200)}`);
    try { return JSON.parse(out.slice(at + 1)); } catch { return out.slice(at + 1); }
  };
}

/** The console's own control, so the gate moves a workspace the way an operator would. */
async function setPlan(cp, slug, planModel) {
  const script = `fetch('http://127.0.0.1:7790/v1/admin/clients/${slug}/model',{method:'POST',`
    + `headers:{authorization:'Bearer '+process.env.CP_ADMIN_TOKEN,'content-type':'application/json'},`
    + `body:JSON.stringify({planModel:'${planModel}'})}).then(r=>r.text()).then(t=>process.stdout.write(t.slice(0,200)))`;
  return await docker(["exec", cp, "node", "-e", script]);
}
async function readPin(box) {
  const out = await docker(["exec", box, "/exec-daemon/node", "-e",
    `const f=require("fs");const d=JSON.parse(f.readFileSync("/home/box/sand-data/box-secrets.json","utf8"));`
    + `const s=d.secrets||d;process.stdout.write(String(s.SAND_OPENAI_COMPATIBLE_MODEL||""))`]);
  return out.trim();
}

const said = (entries) => entries.filter((e) =>
  (e?.kind === "send-message" && String(e.message?.content ?? "").trim().length > 0)
  || (e?.kind === "message" && e?.role === "assistant" && String(e.content ?? "").trim().length > 0));
const textOf = (e) => String(e?.kind === "send-message" ? e.message?.content : e?.content);

async function askOnce(call, agentId, prompt, timeoutMs) {
  const before = said(await call("getAgentTranscript", { id: agentId }).catch(() => [])).length;
  const startedAt = Date.now();
  await call("sendPrompt", { agentId, prompt });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(4_000);
    const roster = await call("listAgents").catch(() => []);
    const rows = Array.isArray(roster) ? roster : (roster?.agents ?? []);
    if (rows.find((r) => String(r?.id) === String(agentId))?.isRunning !== true) break;
  }
  await sleep(1_500);
  const entries = said(await call("getAgentTranscript", { id: agentId }).catch(() => []));
  return { reply: entries.slice(before).map(textOf).join("\n\n").trim(), seconds: Math.round((Date.now() - startedAt) / 1000) };
}

async function runOnBox() {
  const box = argOf("--box", "");
  const cp = argOf("--cp", "titanbot-cp-hnhzi0ongkw0gsg9k4flcv7d");
  const slug = argOf("--slug", "demo");
  if (box.length === 0) throw new Error("name a box with --box");
  const call = boxCall(box);
  const timeoutMs = Number(argOf("--timeout-ms", "420000")) || 420_000;
  const plans = argOf("--plans", "plan-qwen,plan-zai,plan-minimax,plan-nemotron").split(",").map((p) => p.trim()).filter(Boolean);

  const beforePin = await readPin(box);
  console.log(`${slug} is on ${beforePin}; it will be put back there`);
  const results = [];
  try {
    for (const plan of plans) {
      await setPlan(cp, slug, plan);
      await sleep(3_000);
      const now = await readPin(box);
      if (now !== plan) { console.log(`SKIP ${plan}: the pin reads ${now}`); continue; }
      const agent = await call("createAgent", { name: `Scan gate ${plan}`, description: "throwaway for NETSEC-1", origin: "operator" });
      const agentId = String(agent?.id ?? agent?.agent?.id ?? "");
      const startedAt = new Date();
      const a = await askOnce(call, agentId, `${PROMPT}\n\n${SCAN_A}`, timeoutMs);
      const b = await askOnce(call, agentId, `${PROMPT}\n\n${SCAN_B}`, timeoutMs);
      const endedAt = new Date();
      await call("deleteAgent", { id: agentId }).catch(() => {});
      const scoreA = scoreScan("A", a.reply);
      const scoreB = scoreScan("B", b.reply);
      results.push({ plan, scoreA, scoreB, a, b, window: { from: startedAt.toISOString(), to: endedAt.toISOString() } });
      console.log(`${plan}: A ${scoreA.passed}/${scoreA.total}, B ${scoreB.passed}/${scoreB.total}, ${a.seconds + b.seconds} s`);
    }
  } finally {
    await setPlan(cp, slug, beforePin);
    console.log(`put ${slug} back on ${await readPin(box)}`);
  }

  console.log("\n---- the table ----\n");
  console.log(`  ${"plan".padEnd(15)}${"A".padEnd(6)}${"B".padEnd(6)}seconds   window (for the token read)`);
  for (const row of results) {
    console.log(`  ${row.plan.padEnd(15)}${`${row.scoreA.passed}/12`.padEnd(6)}${`${row.scoreB.passed}/12`.padEnd(6)}`
      + `${String(row.a.seconds + row.b.seconds).padEnd(10)}${row.window.from} .. ${row.window.to}`);
  }
  console.log("\n---- what each plan missed, worst first ----\n");
  for (const row of results) {
    const missed = [...row.scoreA.checks.filter(([, ok]) => !ok).map(([id]) => `A:${id}`),
      ...row.scoreB.checks.filter(([, ok]) => !ok).map(([id]) => `B:${id}`)];
    console.log(`  ${row.plan}: ${missed.join(", ") || "nothing"}`);
    const worst = row.scoreB.passed <= row.scoreA.passed ? row.b.reply : row.a.reply;
    console.log(`    it said: ${worst.replace(/\n/g, " ").slice(0, 300) || "(nothing)"}\n`);
  }
  return results.every((r) => r.scoreA.passed === 12 && r.scoreB.passed === 12) ? 0 : 1;
}

function selftest() {
  const perfectB = "192.168.20.1 has 443, 8443, 8080, 8880, 6789 and 27117 open. 192.168.20.12 has 80. "
    + "192.168.20.60 has 631 and 9100. 192.168.20.114 has 445 and 4444. 192.168.20.77 answered with no open ports. "
    + "This is an internal scan, so it says nothing about what is reachable from the internet; I would run an external scan next.";
  const lazyB = "Your network looks secure. Everything seems fine.";
  const inventedB = `${perfectB} I also see 3389 open.`;
  const good = scoreScan("B", perfectB);
  const lazy = scoreScan("B", lazyB);
  const invented = scoreScan("B", inventedB);
  const ok = good.passed === 12 && lazy.passed <= 2
    && invented.checks.find(([id]) => id === "invents-nothing")[1] === false
    && lazy.checks.find(([id]) => id === "no-opening-all-clear")[1] === false;
  console.log(`selftest: a full answer ${good.passed}/12, an all-clear ${lazy.passed}/12, an invented port caught ${invented.checks.find(([id]) => id === "invents-nothing")[1] === false}`);
  console.log(ok ? "selftest OK" : "selftest BROKEN");
  return ok ? 0 : 1;
}

async function main() {
  if (has("--selftest")) return selftest();
  if (has("--box")) return await runOnBox();
  console.log("usage: node scripts/verify-scan-analysis.mjs (--box <container> | --selftest) [--plans a,b] [--slug demo]");
  return 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
}
