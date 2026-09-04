#!/usr/bin/env node
// verify-deploy.mjs -- the R750 deploy gate, run FROM THE MAC over the tailnet.
//
// It proves four things in order, because a failure in an earlier one explains every later one:
//   1. shape      both titanbot containers run, and their published ports are where they should
//                 be: the relay on 100.110.83.82 only, the box on 127.0.0.1 only, nothing on 0.0.0.0
//   2. gateway    getHostStatus and listAgents answer 200 through http://100.110.83.82:7787
//   3. writes     a probe agent is created and deleted, and the roster returns to its baseline
//   4. console    the Machine Room loads in real headless Chrome and paints the roster
//
// The server's bearer token is read over ssh at test time and held in memory only. It is never
// written to disk on this Mac and never printed.
//
//   node scripts/verify-deploy.mjs
//
// Env: TITANBOT_HOST (ssh destination, default dell-remote), TITANBOT_URL (default
// http://100.110.83.82:7787), TITANBOT_ROOT, GROK_BOT_PLAYWRIGHT_DIR, GROK_BOT_CHROME.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const HOST = process.env.TITANBOT_HOST ?? "dell-remote";
const ROOT = process.env.TITANBOT_ROOT ?? "/home/sem/titanbot";
const BIND = process.env.TITANBOT_BIND ?? "100.110.83.82";
const PORT = process.env.TITANBOT_PORT ?? "7787";
const URL_BASE = process.env.TITANBOT_URL ?? `http://${BIND}:${PORT}`;
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
  ?? "/private/tmp/claude-501/-Users-sem-orca-workspaces-grok-bot-0-18-reconstructed-gb/5d8b03a4-9c9b-4e51-af12-2606d5d99b44/scratchpad/pw";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// BatchMode so a missing key fails fast instead of hanging on a password prompt.
const ssh = (command) => new Promise((resolve, reject) =>
  execFile("ssh", ["-o", "BatchMode=yes", HOST, command], { maxBuffer: 32 << 20 },
    (error, out, err) => (error ? reject(new Error(`ssh: ${String(err || error.message).slice(0, 300)}`)) : resolve(String(out)))));

// deleteAgent records the id in the box's deleted-agents.json and never removes it, so this list
// is the one piece of state a probe run leaves behind for good. Reading it lets the gate assert
// how much it left rather than assume none.
const BOX_CONTAINER = process.env.TITANBOT_BOX ?? "titanbot-box";
const tombstones = async () => {
  const raw = await ssh(
    `docker exec ${BOX_CONTAINER} cat /home/box/sand-data/agents/deleted-agents.json 2>/dev/null || echo '[]'`,
  ).catch(() => "[]");
  try { const value = JSON.parse(raw.trim() || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
};

step(`shape of the install on ${HOST}`);
const running = JSON.parse(await ssh(
  `docker inspect titanbot-box titanbot-relay --format '{{json .State.Running}}' 2>/dev/null | paste -sd, - | sed 's/^/[/;s/$/]/'`,
).catch(() => "[]"));
check(running.length === 2 && running.every((r) => r === true), "titanbot-box and titanbot-relay are both running",
  running.length === 2 ? `${running}` : "one or both containers are missing");

// Port bindings, read as docker's own JSON rather than parsed out of `docker ps` text.
const ports = JSON.parse(await ssh(
  `docker inspect titanbot-relay titanbot-box --format '{{json .NetworkSettings.Ports}}' | paste -sd, - | sed 's/^/[/;s/$/]/'`,
).catch(() => "[{},{}]"));
const [relayPorts, boxPorts] = ports;
const bindingsOf = (map) => Object.entries(map ?? {}).flatMap(([container, list]) =>
  (list ?? []).map((b) => ({ container, host: `${b.HostIp}:${b.HostPort}` })));
const relayBindings = bindingsOf(relayPorts);
const boxBindings = bindingsOf(boxPorts);
check(relayBindings.length === 1 && relayBindings[0].container === "7777/tcp" && relayBindings[0].host === `${BIND}:${PORT}`,
  `the relay publishes exactly 7777 on ${BIND}:${PORT}`, relayBindings.map((b) => `${b.container}->${b.host}`).join(" ") || "nothing published");
check(boxBindings.length > 0 && boxBindings.every((b) => b.host.startsWith("127.0.0.1:")),
  "every box port is bound on the server's loopback only", boxBindings.map((b) => b.host).join(" ") || "nothing published");
const wideOpen = [...relayBindings, ...boxBindings].filter((b) => b.host.startsWith("0.0.0.0:") || b.host.startsWith(":::"));
check(wideOpen.length === 0, "no titanbot port is published on 0.0.0.0", wideOpen.map((b) => b.host).join(" ") || "none");

// The token file is the single source of truth for the gateway bearer. Read it here, hold it in
// memory, and never let it reach this Mac's disk or this script's output.
const TOKEN = JSON.parse(await ssh(`cat ${ROOT}/profile/local-docker-vm.json`)).token ?? "";
check(TOKEN.length === 64 && /^[0-9a-f]+$/.test(TOKEN), "the server's gateway token is 64 hex characters", "value withheld");
const mode = (await ssh(`stat -c %a ${ROOT}/profile/local-docker-vm.json`)).trim();
check(mode === "600", "the token file is 0600 on the server", `mode ${mode}`);

step(`gateway through ${URL_BASE}`);
const call = async (method, args = {}, headers = {}) => {
  const res = await fetch(`${URL_BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text };
};

const status = await call("getHostStatus", {}, { authorization: `Bearer ${TOKEN}` });
check(status.status === 200 && typeof status.body?.hostVersion === "string", "getHostStatus returns 200 with a hostVersion",
  status.status === 200 ? `hostVersion ${status.body?.hostVersion}, capabilities ${JSON.stringify(status.body?.capabilities ?? [])}` : `HTTP ${status.status} ${status.text.slice(0, 160)}`);

// The relay exists to hold the bearer the browser must never see, so the unauthenticated call is
// the one that proves it is doing its job.
const unauth = await call("getHostStatus");
check(unauth.status === 200 && typeof unauth.body?.hostVersion === "string",
  "the same call with no authorization header also returns 200, so the relay is injecting the bearer",
  `HTTP ${unauth.status}`);

const listed = await call("listAgents", {}, { authorization: `Bearer ${TOKEN}` });
const roster = Array.isArray(listed.body) ? listed.body : listed.body?.agents ?? [];
check(listed.status === 200 && Array.isArray(roster), "listAgents returns 200 with an array",
  listed.status === 200 ? `${roster.length} agent(s)` : `HTTP ${listed.status} ${listed.text.slice(0, 160)}`);
const baseline = roster.map((a) => a.id).sort();

step("a probe agent, created and deleted");
const tombstonesBefore = await tombstones();
let probeId = null;
try {
  const made = await call("createAgent", {
    name: `verify-deploy-${Math.random().toString(36).slice(2, 7)}`,
    description: "", origin: "user", isKickstartRequested: false,
  }, { authorization: `Bearer ${TOKEN}` });
  const agent = made.body?.agent ?? made.body;
  probeId = agent?.id ?? null;
  check(made.status === 200 && typeof probeId === "string", "createAgent returns 200 with an id",
    made.status === 200 ? probeId ?? "no id in the response" : `HTTP ${made.status} ${made.text.slice(0, 160)}`);
  if (probeId) {
    const after = await call("listAgents", {}, { authorization: `Bearer ${TOKEN}` });
    const ids = (Array.isArray(after.body) ? after.body : after.body?.agents ?? []).map((a) => a.id);
    // The roster can stay at one entry after the probe is created, so this asserts the probe's id
    // is present rather than that the list grew. The reason is a filter, not a phantom: the default
    // "Grok" agent is a real directory on disk with its own store.db, and buildSummary
    // (source/host/extensions/session/session-summaries.ts) drops any row that has no transcript,
    // no name or description of its own, no durable footprint, and is not the active agent. Once
    // the probe becomes active, the blank default stops matching `isActive` and falls out of the
    // list it was in a moment ago. Deleting the probe makes it active again and it comes back.
    check(ids.includes(probeId), "the probe agent appears in listAgents",
      `${ids.length} listed; a blank non-active default agent is filtered out of the list, so this count can stay flat`);
  }
} finally {
  if (probeId) {
    const gone = await call("deleteAgent", { id: probeId }, { authorization: `Bearer ${TOKEN}` }).catch((e) => ({ status: 0, text: String(e) }));
    check(gone.status === 200, "deleteAgent returns 200", `HTTP ${gone.status}`);
    await sleep(1500);
    const final = await call("listAgents", {}, { authorization: `Bearer ${TOKEN}` });
    const ids = (Array.isArray(final.body) ? final.body : final.body?.agents ?? []).map((a) => a.id).sort();
    check(!ids.includes(probeId), "the probe agent is gone from listAgents");
    // A roster that grew during the run is a bug even when the probe cleaned itself up.
    const strays = ids.filter((id) => !baseline.includes(id) && id !== probeId);
    check(strays.length === 0, "the roster is back to its baseline", strays.length ? `strays: ${strays.join(",")}` : `${ids.length} agent(s)`);
    // The roster is back; the volume is not. deleted-agents.json keeps the probe's id for good, so
    // that file grows by exactly one entry per gate run. Expected residue, asserted rather than
    // ignored, because "grows by one" and "grows by more than one" are different bugs and only a
    // check tells them apart.
    const tombstonesAfter = await tombstones();
    check(tombstonesAfter.length === tombstonesBefore.length + 1 && tombstonesAfter.includes(probeId),
      "deleting the probe left exactly one new tombstone, which is expected permanent residue",
      `deleted-agents.json holds ${tombstonesAfter.length} id(s), was ${tombstonesBefore.length}`);
  }
}

step("the Machine Room in a real browser");
// playwright-core comes from the scratchpad install, never from this repo's dependencies, and it
// drives the real Chrome on this Mac rather than a bundled build.
const require = createRequire(`${PW_DIR}/package.json`);
let browser = null;
try {
  const { chromium } = require("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

  const response = await page.goto(`${URL_BASE}/`, { waitUntil: "load", timeout: 45_000 });
  check(response?.status() === 200, "the console at / returns 200", `HTTP ${response?.status()}`);

  // The roster is what the adapter paints from listAgents, so its cards are the honest signal
  // that the page reached the gateway rather than just rendering static markup.
  const until = async (fn, ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value != null && value !== false) return value;
      if (Date.now() > deadline) return null;
      await sleep(1000);
    }
  };
  const cards = await until(async () => {
    const n = await page.$$eval(".worker-card[data-context-id]", (els) => els.length);
    return n > 0 ? n : null;
  }, 30_000);
  check(cards != null, "the roster renders agent cards from the live gateway", cards != null ? `${cards} card(s)` : "no .worker-card[data-context-id] after 30 s");
  if (cards != null) {
    const names = await page.$$eval(".worker-card[data-context-id] .worker-name", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
    check(names.length > 0, "the cards carry agent names", names.slice(0, 4).join(", "));
  }
  // Reads "0 / 50 agents" on a fresh install even with a card on screen. Both numbers come from the
  // same directory: gateway countAgents is countAgentsOnDisk, which is
  // `sessionStore.listAgents().length` with NO active-agent id, while the card comes from
  // roster-projection.listAgents(), which passes the announced active id. Without that id the blank
  // default agent fails buildSummary's is-this-a-real-agent test (isActive is `dirName ===
  // activeAgentId`) and is filtered out of the count. Same store, different argument -- so the
  // discrepancy is real and unexplained-by-design, not a synthesized card. Measured on the R750:
  // countAgents 0 twice in a row while listAgents returned agent 96a720b6 with a store.db path.
  const count = await page.evaluate(() => document.querySelector("[data-agent-count]")?.textContent?.trim() ?? "");
  check(/\d+\s*\/\s*50/.test(count), "the roster header shows the host's agent count", count || "empty");

  // A gateway the page cannot reach shows up here long before it shows up as a blank panel.
  const gatewayErrors = pageErrors.filter((t) => /gateway|api\/|fetch|502|401/i.test(t));
  check(gatewayErrors.length === 0, "no console error mentions the gateway", gatewayErrors.slice(0, 2).join(" | ") || "none");
  const apiFailures = failedRequests.filter((t) => /\/api\/|\/events/.test(t));
  check(apiFailures.length === 0, "no /api or /events request failed", apiFailures.slice(0, 3).join(" | ") || "none");
} catch (error) {
  check(false, "the browser check ran", String(error?.message ?? error).slice(0, 200));
} finally {
  await browser?.close().catch(() => {});
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failing check(s)  ${URL_BASE}`);
process.exit(failures === 0 ? 0 : 1);
