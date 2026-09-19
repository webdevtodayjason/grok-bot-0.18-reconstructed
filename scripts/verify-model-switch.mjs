#!/usr/bin/env node
// verify-model-switch.mjs -- MODEL-1's one real measurement: a customer moving their own workspace
// between the plans it is entitled to, on the live server, through the product's own doors.
//
// WHY THIS CANNOT BE A UNIT TEST. tests/relay-model-switch.test.mjs measures the routes against a
// relay copy with a box made of directories, which is the right place for the refusals and for the
// rule that no request body may name a workspace. Three claims are not reachable from there, and
// they are the three the wave is actually judged on:
//
//   the entitlement really narrows   the admin action moves a virtual KEY at the proxy, and a
//                                    record that agreed with a key nobody moved would pass every
//                                    assertion in the tree;
//   a customer can really do it      the switch is pressed as a signed-in customer of that
//                                    workspace, not as the operator through the super admin door;
//   the box really moved             proved from the PROXY's own spend log -- one row, on this
//                                    workspace's key, on the plan that was chosen. A file written
//                                    into a box is what the box was told; a spend row is what it ran.
//
// THE SESSION IS A SIGN-IN LINK AND NEVER A PASSWORD. The demo tenant's password lives in cp.env
// and this gate may not read it; the relay's instance password is Jason's. The product mints
// single-use sign-in links for exactly this reason, so the gate asks the admin door for one, clicks
// it, and drops it. The link is never printed, never written and never logged: it is a stateless
// bearer the relay does not check for revocation (ONBOARD-5). What the gate ends up holding is an
// ordinary customer session for that workspace, which is the thing under test.
//
// WHAT IT TOUCHES AND PUTS BACK, in order, whatever happens:
//   the entitlement   read first, restored in a finally through the same admin action
//   the model         read first, restored by switching back and proved a second time
//   one agent         a throwaway bot, created on that box and deleted again
//
// IT REFUSES TO RUN ON titanium. That is Jason's own workspace and his own box; a gate that moves
// the model on it moves the machine he is working on. --slug names any other, and demo is the
// default because it is Titanium's own throwaway tenant.
//
// THREE SECRETS ARE READ OVER SSH AT RUN TIME AND HELD IN MEMORY ONLY: the control plane's admin
// token, its relay token and the proxy's master key. None is written to this Mac, none is printed,
// and the spend read that needs the master key happens inside the control plane's own container so
// the key never crosses the network at all.
//
//   node scripts/verify-model-switch.mjs
//   node scripts/verify-model-switch.mjs --slug demo --host dell-remote
//   node scripts/verify-model-switch.mjs --plans plan-zai,plan-qwen --denied plan-nemotron
//
// Exit 0 everything passed, 1 something failed, 2 the arguments are wrong.
import { execFile } from "node:child_process";
import process from "node:process";

import { gateUserAgent } from "./gate-agent.mjs";

const GATE_AGENT = gateUserAgent(import.meta.url);

const argv = process.argv.slice(2);
const value = (name, fallback = null) => {
  const inline = argv.find((one) => one.startsWith(`--${name}=`));
  if (inline != null) return inline.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const SLUG = String(value("slug", "demo"));
const SSH_HOST = String(value("host", process.env.TITANBOT_HOST ?? "dell-remote"));
const CP_URL = String(value("cp", process.env.TITANBOT_CP_URL ?? "https://api.titanium.bot")).replace(/\/+$/, "");
const CONSOLE_URL = String(value("console", process.env.TITANBOT_CONSOLE_URL ?? "https://console.titanium.bot")).replace(/\/+$/, "");
const WANTED = String(value("plans", "plan-zai,plan-qwen")).split(",").map((one) => one.trim()).filter(Boolean);
const DENIED = String(value("denied", "plan-nemotron")).trim();
// MODEL-1c. A plan this proxy serves that CANNOT take a picture, and the route one goes to instead.
// Empty skips that leg rather than inventing a pin, because a plan with eyes proves nothing here.
const VISION_PIN = String(value("vision-pin", "plan-nemotron")).trim();
const VISION_FALLBACK = String(value("vision-fallback", "plan-zai-vision")).trim();
// How long to wait for the proxy's own row. /spend/logs is batch written -- ten seconds on this
// install -- so a read straight after a turn is how an assertion flakes.
const SPEND_WAIT_MS = Number(value("spend-wait-ms", "120000"));

if (SLUG === "titanium") {
  process.stderr.write("\nverify-model-switch refuses to run on titanium: that is the operator's own workspace and his own box.\n");
  process.exit(2);
}
if (WANTED.length !== 2) {
  process.stderr.write("\nverify-model-switch needs exactly two plans in --plans: it switches between them and back.\n");
  process.exit(2);
}
if (WANTED.includes(DENIED)) {
  process.stderr.write("\n--denied must name a plan that is NOT in --plans; it is the one the refusal is measured on.\n");
  process.exit(2);
}

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1; else failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const note = (line) => console.log(`  NOTE  ${line}`);
const step = (line) => console.log(`\n== ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the server ---------------------------------------------------------------------------------

const ssh = (command, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SSH_HOST, command],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error != null) return reject(new Error(`ssh ${SSH_HOST}: ${String(stderr || error.message).split("\n")[0].slice(0, 200)}`));
      resolve(String(stdout));
    });
});

/**
 * Run a script INSIDE the control plane's own container and read one JSON line back.
 *
 * Base64 on the way in, so nothing in the script has to survive two layers of shell quoting, and
 * the script is deleted again. This is the only way the proxy can be asked anything at all: it
 * publishes no port, it is reachable on the shared docker network alone, and its master key is in
 * that container's environment -- which is exactly where it should stay.
 */
async function inControlPlane(source, timeoutMs = 90_000) {
  const blob = Buffer.from(source, "utf8").toString("base64");
  // .cjs, not .mjs: the control plane's package.json says module, and a probe written as one cannot
  // call require. The name is fixed rather than random so a run that is killed leaves one file
  // behind and not a directory of them.
  const out = await ssh(`docker exec ${CP_CONTAINER} sh -lc 'echo ${blob} | base64 -d > /tmp/model-switch-probe.cjs; node /tmp/model-switch-probe.cjs; rm -f /tmp/model-switch-probe.cjs'`, timeoutMs);
  const line = out.split("\n").map((one) => one.trim()).filter((one) => one.startsWith("{") || one.startsWith("[")).pop();
  if (line == null) throw new Error(`the control plane answered nothing readable: ${out.slice(0, 200)}`);
  return JSON.parse(line);
}

let CP_CONTAINER = "";
let ADMIN_TOKEN = "";
let RELAY_TOKEN = "";

// ---- the doors ----------------------------------------------------------------------------------

const headers = (extra = {}) => ({ "user-agent": GATE_AGENT, accept: "application/json", ...extra });

async function admin(method, path, body) {
  const res = await fetch(`${CP_URL}${path}`, {
    method,
    headers: headers({ authorization: `Bearer ${ADMIN_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed ?? {}, text };
}

async function relayAdmin(path) {
  const res = await fetch(`${CONSOLE_URL}${path}`, {
    headers: headers({ authorization: `Bearer ${RELAY_TOKEN}` }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: {} }; }
}

let COOKIE = "";
async function asCustomer(method, path, body) {
  const res = await fetch(`${CONSOLE_URL}${path}`, {
    method,
    headers: headers({ cookie: COOKIE, ...(body === undefined ? {} : { "content-type": "application/json" }) }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed ?? {}, text };
}

// The box's own gateway, through the relay, on the customer's own session. Same door the console
// uses; the gateway token is the relay's and never reaches this process.
async function gw(method, args = {}) {
  const answer = await asCustomer("POST", `/api/${method}`, args);
  if (answer.status !== 200) throw new Error(`${method} answered ${answer.status}: ${answer.text.slice(0, 160)}`);
  return answer.body;
}

// ---- the proxy's own record of what ran ----------------------------------------------------------

/**
 * Every spend row on this workspace's key since a moment, newest first.
 *
 * The join is the key's HASH, which is what the record calls keyId and what the log calls api_key.
 * The alias comes back too so a reader can see whose rows these are without holding anything.
 *
 * /spend/logs is batch written -- ten seconds on this install -- so every caller polls rather than
 * reading once and concluding. CP_PROXY_URL on this server carries a /v1 the spend routes are not
 * under, which is why it is stripped here the way cp/provision.mjs strips it.
 */
async function spendSince(sinceIso) {
  const source = `
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync("/data/titanbot/${SLUG}/profile/model-proxy.json", "utf8"));
const base = String(process.env.CP_PROXY_URL ?? "").replace(/\\/+$/, "").replace(/\\/v1$/, "");
(async () => {
  const res = await fetch(base + "/spend/logs", {
    headers: { authorization: "Bearer " + process.env.CP_PROXY_MASTER_KEY, accept: "application/json" },
  });
  const rows = await res.json();
  const mine = (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row.api_key) === String(record.keyId))
    .filter((row) => String(row.startTime ?? "") >= ${JSON.stringify(sinceIso)})
    .map((row) => ({
      at: String(row.startTime ?? ""),
      group: String(row.model_group ?? ""),
      model: String(row.model ?? ""),
      tokens: Number(row.total_tokens ?? 0) || 0,
      alias: String(row.metadata?.user_api_key_alias ?? ""),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  console.log(JSON.stringify({ ok: true, rows: mine, keyId: String(record.keyId).slice(0, 12) }));
})().catch((error) => console.log(JSON.stringify({ ok: false, why: String(error?.message ?? error) })));
`;
  return inControlPlane(source);
}

/**
 * The two lists this workspace has, which are different questions and were one field until a live
 * turn stopped. The RECORD is what the relay narrows a customer's choices to. The KEY is what the
 * proxy will actually answer on, routing targets and all, and the only way to read it is to ask.
 */
async function entitlementOf() {
  const source = `
const fs = require("node:fs");
(async () => {
  const record = JSON.parse(fs.readFileSync("/data/titanbot/${SLUG}/profile/model-proxy.json", "utf8"));
  const models = (Array.isArray(record.models) ? record.models : []).map((row) => String(row?.id ?? row?.model ?? row));
  const base = String(process.env.CP_PROXY_URL ?? "").replace(/\\/+$/, "").replace(/\\/v1$/, "");
  let keyModels = null;
  try {
    const info = await (await fetch(base + "/key/info?key=" + encodeURIComponent(record.key), {
      headers: { authorization: "Bearer " + process.env.CP_PROXY_MASTER_KEY, accept: "application/json" },
    })).json();
    const list = info?.info?.models ?? info?.models ?? null;
    if (Array.isArray(list)) keyModels = list.map(String);
  } catch { keyModels = null; }
  console.log(JSON.stringify({ ok: true, models, keyModels, keyId: String(record.keyId ?? "").slice(0, 12) }));
})().catch((error) => console.log(JSON.stringify({ ok: false, why: String(error?.message ?? error) })));
`;
  return inControlPlane(source, 60_000);
}

/**
 * MODEL-1c. WHAT THE KEY MAY ACTUALLY CALL after an entitlement write, asked with the key itself.
 *
 * The defect this exists for took a live turn down on 2026-09-19 00:12Z: the write set a key's
 * models to the customer-visible plans that were ticked, and the host routes a spoken turn to the
 * talk tier and a screenshot to the vision route, neither of which anybody ticks. The proxy then
 * answers "key not allowed to access model" and the customer sees a turn fail.
 *
 * So this asks the box's own door -- the relay's model proxy, carrying that workspace's virtual key
 * -- for one token on each routing alias, with a real image part on the vision one. It runs inside
 * the control plane's container because that is where the key record is, so the key never reaches
 * this Mac. What must not come back is the key-scope refusal; an upstream that is busy or slow is
 * a different answer and is reported as itself.
 */
async function routingReach(aliases) {
  const source = `
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync("/data/titanbot/${SLUG}/profile/model-proxy.json", "utf8"));
// The relay's model proxy, which is the address every box is pointed at. Resolved the way
// cp/provision.mjs resolves it, because CP_RELAY_MODEL_URL is a default on this server and only
// CP_RELAY_HOST is actually set.
const relayBase = String(process.env.CP_RELAY_MODEL_URL || process.env.CP_RELAY_URL
  || ("http://" + String(process.env.CP_RELAY_HOST ?? "") + ":7777")).replace(/\\/+$/, "");
const base = relayBase + "/model-proxy/v1";
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
(async () => {
  const out = [];
  for (const alias of ${JSON.stringify(aliases)}) {
    const vision = alias.endsWith("-vision");
    const body = {
      model: alias,
      max_tokens: 1,
      messages: [{
        role: "user",
        content: vision ? [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: PIXEL } }] : "hi",
      }],
    };
    let status = 0;
    let said = "";
    try {
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + record.key, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      status = res.status;
      said = (await res.text()).slice(0, 300);
    } catch (error) { said = String(error?.message ?? error); }
    // The one refusal this leg is about, in the words LiteLLM uses for it.
    const scoped = /not allowed to access model|API Key not allowed to access model/i.test(said);
    out.push({ alias, status, scoped, said: scoped ? said.slice(0, 160) : "" });
  }
  console.log(JSON.stringify({ ok: true, rows: out }));
})().catch((error) => console.log(JSON.stringify({ ok: false, why: String(error?.message ?? error) })));
`;
  return inControlPlane(source, 120_000);
}

/**
 * The plans this workspace is offered right now, or an empty list when the read did not answer.
 * Callers that WAIT on this treat empty as "not yet", never as "none".
 */
async function offeredPlans() {
  const seen = await asCustomer("GET", "/model/plans").catch(() => ({ status: 0, body: {} }));
  return seen.status === 200 && Array.isArray(seen.body.plans) ? seen.body.plans.map((one) => String(one.model)) : [];
}

/**
 * The box's own wire trace for this workspace, which is the only place that says what a request
 * CARRIED rather than what it cost. Read over ssh out of the host's stdout file; it exists only
 * where SAND_TOOL_TRACE is on for that box, and a box without it answers so rather than failing.
 */
async function boxWire() {
  // THIS WORKSPACE'S OWN CONTAINER, named by the control plane. Scanning every box for one whose
  // trace mentions the pin read the wrong box on the first run: another workspace is pinned to the
  // same plan, its lines matched, and the leg reported that box's history as this one's.
  const row = (await admin("GET", "/v1/admin/clients")).body.clients?.find((one) => one.slug === SLUG) ?? null;
  const name = String(row?.boxContainer ?? "");
  if (name.length === 0) return { ok: false, why: `the control plane did not name ${SLUG}'s container`, lines: [], rerouted: 0 };
  const raw = await ssh(`docker exec ${name} sh -lc 'grep -o "\\[sand\\]\\[wire\\] {[^}]*}" /tmp/sand-host.log 2>/dev/null | tail -60'`).catch(() => "");
  if (raw.trim().length === 0) {
    return { ok: false, why: `${name} has no wire trace (SAND_TOOL_TRACE may be off on that box)`, lines: [], rerouted: 0 };
  }
  const lines = [];
  for (const one of raw.split("\n")) {
    const at = one.indexOf("{");
    if (at < 0) continue;
    try {
      const parsed = JSON.parse(one.slice(at));
      lines.push({
        model: String(parsed.model ?? ""),
        imageParts: Number(parsed.imageParts ?? 0),
        historyImageParts: Number(parsed.historyImageParts ?? 0),
        imagesAllowed: parsed.imagesAllowed === true,
      });
    } catch { /* a truncated line is not a measurement */ }
  }
  // The reroute line is the host's own sentence, counted with its own grep so no quoting has to
  // survive being both a shell string and a regex.
  const said = await ssh(`docker exec ${name} sh -lc 'grep -c "so it goes to" /tmp/sand-host.log 2>/dev/null || true'`).catch(() => "0");
  return { ok: true, lines, rerouted: Number(said.trim()) || 0, box: name, why: "" };
}

/** Wait for a bot to stop working, so the next prompt is a turn rather than a queue entry. */
async function waitForIdle(agentId, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const roster = await gw("listAgents").catch(() => null);
    const rows = Array.isArray(roster) ? roster : roster?.agents ?? [];
    const mine = rows.find((one) => one?.id === agentId);
    if (mine == null || mine.isRunning !== true) return true;
    await sleep(4000);
  }
  return false;
}

/** One plan, chosen as the customer, with the chosen row's own words back. */
const chooseAsCustomer = (model) => asCustomer("POST", "/model/use", { model });

/** What that box's own file says it is pointed at, read through the relay's operator door. */
const boxSays = () => relayAdmin(`/admin/tenants/${encodeURIComponent(SLUG)}/running`);

/** Wait for a spend row newer than `since` whose group is `plan` or its talk sibling. */
async function waitForSpend(plan, since) {
  const deadline = Date.now() + SPEND_WAIT_MS;
  let last = null;
  for (;;) {
    const answer = await spendSince(since);
    if (answer.ok !== true) return { ok: false, why: answer.why, rows: [] };
    last = answer;
    const hit = answer.rows.find((row) => row.group === plan || row.group === `${plan}-talk`);
    if (hit != null) return { ok: true, row: hit, rows: answer.rows };
    if (Date.now() > deadline) return { ok: false, why: "no spend row arrived in time", rows: last.rows };
    await sleep(6000);
  }
}

// ---- the run --------------------------------------------------------------------------------------

let restoreEntitlement = null;
let keyBefore = null;
let restoreModel = null;
let throwaway = null;

async function main() {
  step(`the server, and the three credentials this gate holds for the length of the run`);
  CP_CONTAINER = (await ssh(`docker ps --format '{{.Names}}' | grep '^titanbot-cp-' | head -1`)).trim();
  check(CP_CONTAINER.length > 0, "the control plane container is running", CP_CONTAINER || "(none found)");
  if (CP_CONTAINER.length === 0) return;
  ADMIN_TOKEN = (await ssh(`docker exec ${CP_CONTAINER} printenv CP_ADMIN_TOKEN`)).trim();
  RELAY_TOKEN = (await ssh(`docker exec ${CP_CONTAINER} printenv CP_RELAY_TOKEN`)).trim();
  check(ADMIN_TOKEN.length > 16 && RELAY_TOKEN.length > 16, "the admin and relay credentials were read over ssh", "held in memory, never printed");

  step(`what ${SLUG} is entitled to and what it is running, before anything moves`);
  const before = await entitlementOf();
  check(before.ok === true, `${SLUG} has a plan key with a model list`, before.ok ? before.models.join(", ") : String(before.why));
  if (before.ok === true) note(`its key answers on ${Array.isArray(before.keyModels) ? before.keyModels.join(", ") : "(the proxy did not say)"}`);
  if (before.ok !== true) return;
  restoreEntitlement = before.models;
  // What the KEY carried before this run, so the restore can be judged on the key and not only on
  // the record. It is a list of alias names and carries nothing secret.
  keyBefore = before.keyModels ?? null;
  const running = await boxSays();
  check(running.status === 200 && running.body.read === true, `${SLUG}'s box says what it is pointed at`,
    `${running.body.model ?? "?"}${running.body.pinned ? " (pinned by its container environment)" : ""}`);
  restoreModel = String(running.body.model ?? "");
  if (running.body.pinned === true) {
    note("that box's container environment pins the endpoint, so nothing written into its file takes effect. The spend legs below cannot prove a move on this box.");
  }

  step(`entitled to exactly ${WANTED.join(" and ")}, through the admin action`);
  const entitled = await admin("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/models`, { models: WANTED });
  check(entitled.status === 200, "the admin door wrote the entitlement", `HTTP ${entitled.status} ${String(entitled.body.message ?? entitled.body.error ?? "").slice(0, 120)}`);
  if (entitled.status !== 200) {
    note("every leg below needs the entitlement to have moved, so the run stops here rather than measuring the old one.");
    // Nothing was written, so there is nothing to put back. Clearing this is what stops the restore
    // reporting a second failure for a change that never happened.
    restoreEntitlement = null;
    return;
  }
  const after = await entitlementOf();
  check(after.ok === true && after.models.length === WANTED.length && WANTED.every((one) => after.models.includes(one)),
    "and the key record names exactly those plans", after.ok ? after.models.join(", ") : String(after.why));
  const row = await admin("GET", "/v1/admin/clients");
  const mine = (row.body.clients ?? []).find((one) => one.slug === SLUG) ?? null;
  check(Array.isArray(mine?.allowed) && WANTED.every((one) => mine.allowed.includes(one)),
    "and the clients panel reads it back on that workspace's row", JSON.stringify(mine?.allowed ?? null));

  // MODEL-1c. THE KEY KEPT THE ROUTES THE HOST USES WITHOUT BEING ASKED. A narrowing that sent the
  // ticked plans alone answered "key not allowed to access model" the moment a turn was spoken or
  // carried a screenshot, which is what took a live turn down on 2026-09-19 00:12Z. Measured with
  // the key itself, on the relay's own model door, one token each.
  const scoped = Array.isArray(entitled.body.keyModels) ? entitled.body.keyModels : [];
  check(scoped.length > WANTED.length,
    "the key carries more than the plans that were ticked", scoped.join(", ") || "(the answer named none)");
  // MODEL-1d. A SAVE TAKES OFF ONLY WHAT WAS UNTICKED. Everything else on that key stays, routing
  // target and hand-entitled plan alike: the first version of this fix kept the routing targets and
  // still dropped a customer plan an operator had put on by hand, which was a second outage.
  const untickedNow = Array.isArray(entitled.body.unticked) ? entitled.body.unticked : [];
  const survivors = (before.models ?? []).filter((one) => !untickedNow.includes(one));
  const lost = survivors.filter((one) => !scoped.includes(one));
  check(lost.length === 0, "and nothing it already had was taken off except what was unticked",
    lost.length === 0
      ? `unticked ${untickedNow.join(", ") || "nothing"}; kept ${survivors.join(", ") || "nothing"}`
      : `lost ${lost.join(", ")}`);
  const routes = scoped.filter((one) => /-(talk|vision|code)$/.test(one));
  if (routes.length === 0) {
    skip("the talk tier and the vision route still answer on that key", "this proxy serves no routing alias for those plans");
  } else {
    const reach = await routingReach(routes);
    check(reach.ok === true, "the key was asked on each routing alias", reach.ok ? routes.join(", ") : String(reach.why));
    for (const one of reach.rows ?? []) {
      check(one.scoped === false,
        `${one.alias} is not refused as outside this key's scope`,
        one.scoped ? one.said : `HTTP ${one.status}, which is the upstream's own answer and not a refusal of the key`);
    }
  }

  step(`a customer session for ${SLUG}, minted as a sign-in link and never written down`);
  const link = await admin("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/sign-in-link`, {});
  check(link.status === 200 && typeof link.body.url === "string" && link.body.url.length > 0,
    "the admin door minted a single-use sign-in link", `HTTP ${link.status} for ${String(link.body.email ?? "?")}`);
  if (link.status !== 200) return;
  const signIn = await fetch(String(link.body.url), {
    headers: headers({ accept: "text/html" }), redirect: "manual", signal: AbortSignal.timeout(45_000),
  });
  COOKIE = /(?:^|,\s*)(gb_session=[^;]+)/.exec(signIn.headers.get("set-cookie") ?? "")?.[1] ?? "";
  check(COOKIE.length > 0, "and clicking it signs in as that workspace's own person", `HTTP ${signIn.status}`);
  if (COOKIE.length === 0) return;
  const who = await asCustomer("GET", "/auth/state");
  check(who.body?.workspace?.slug === SLUG && who.body?.operator !== true,
    "the session is that customer's and is not the operator's", `${who.body?.workspace?.slug ?? "?"}, operator ${String(who.body?.operator)}`);

  step("what that customer is offered in their own Settings");
  // POLLED, AND THE WAIT IS THE MEASUREMENT. The entitlement is written at the proxy and into the
  // key record on the control plane; the relay learns it on its own registry refresh, which is a
  // minute. So a read taken straight after the admin action truthfully answers the OLD set, and a
  // gate that asserted on the first read would be asserting that a cache is instant.
  const startedWaiting = Date.now();
  let plans = await asCustomer("GET", "/model/plans");
  let offered = (plans.body.plans ?? []).map((one) => one.model);
  const matches = () => offered.length === WANTED.length && WANTED.every((one) => offered.includes(one));
  while (!matches() && Date.now() - startedWaiting < 150_000) {
    await sleep(6000);
    plans = await asCustomer("GET", "/model/plans");
    offered = (plans.body.plans ?? []).map((one) => one.model);
  }
  const waited = Math.round((Date.now() - startedWaiting) / 1000);
  check(plans.status === 200, "GET /model/plans answers the signed-in customer", `HTTP ${plans.status}`);
  check(matches(), "and it offers exactly the plans this workspace may run",
    `${offered.join(", ") || "(none)"} · ${waited}s after the entitlement was written`);
  note(`the relay reads the entitlement off its own registry, which refreshes every 60 s: a customer whose Settings is already open sees the new set on a load after that.`);
  check(!offered.includes(DENIED), `and ${DENIED} is not among them`, offered.join(", ") || "(none)");
  check(!/sk-/.test(plans.text), "and no credential is in that answer");
  for (const one of plans.body.plans ?? []) {
    if (one.vision?.supported === false) {
      note(`${one.model}: text only, screenshots go to ${one.vision.fallbackLabel || one.vision.fallback || "nowhere"}`);
    }
  }

  step("a throwaway bot on that box, to take the turns");
  const roster = await gw("listAgents");
  const rosterBefore = (Array.isArray(roster) ? roster : roster?.agents ?? []).length;
  note(`the roster is ${rosterBefore} before this gate adds anything`);
  const made = await gw("createAgent", {
    name: `verify-model-switch ${Math.random().toString(36).slice(2, 8)}`,
    description: "Throwaway bot for the MODEL-1 gate. Deleted when it finishes.",
    origin: "user",
    isKickstartRequested: false,
  });
  throwaway = made?.id ?? made?.agentId ?? made?.agent?.id ?? null;
  check(throwaway != null, "a throwaway bot was created", String(throwaway ?? "(none)"));
  if (throwaway == null) return;

  // ---- the two switches, each proved by a row the proxy wrote ------------------------------------
  for (const [index, plan] of WANTED.entries()) {
    step(`${index === 0 ? "onto" : "back onto"} ${plan}, chosen by the customer`);
    const at = new Date(Date.now() - 2000).toISOString();
    const used = await chooseAsCustomer(plan);
    check(used.status === 200 && used.body.model === plan, "POST /model/use took it", `HTTP ${used.status} ${String(used.body.modelLabel ?? used.body.error ?? "")}`);
    check(used.body.appliesFrom === "next message", "and says when it applies", String(used.body.appliesFrom ?? "(not said)"));
    const says = await boxSays();
    check(says.body.model === plan, "the box's own file names it", `${says.body.model ?? "?"} / ${says.body.modelLabel ?? ""}`);

    const said = await gw("sendPrompt", { agentId: throwaway, prompt: "Reply with the single word OK and nothing else." }).then(() => true).catch((error) => {
      note(`sendPrompt: ${String(error.message).slice(0, 160)}`);
      return false;
    });
    check(said, "one short turn was sent to the throwaway bot");
    const landed = await waitForSpend(plan, at);
    check(landed.ok === true, `and the proxy's own spend log has a row on ${plan}`,
      landed.ok
        ? `${landed.row.group} · ${landed.row.model} · ${landed.row.tokens} tokens · ${landed.row.at}`
        : `${landed.why}; rows since the switch: ${landed.rows.map((one) => one.group).join(", ") || "none"}`);
    if (landed.ok && landed.row.group !== plan) {
      note(`the row is on ${landed.row.group}, the talk tier of ${plan}: the router upgraded this turn, which is still that plan's own pool.`);
    }
    await gw("deleteAgent", { id: throwaway }).catch(() => {});
    throwaway = null;
    if (index === 0) {
      const remade = await gw("createAgent", {
        name: `verify-model-switch ${Math.random().toString(36).slice(2, 8)}`,
        description: "Throwaway bot for the MODEL-1 gate. Deleted when it finishes.",
        origin: "user",
        isKickstartRequested: false,
      }).catch(() => null);
      throwaway = remade?.id ?? remade?.agentId ?? remade?.agent?.id ?? null;
    }
  }

  // ---- MODEL-1c: a picture skips a pin that cannot read one -------------------------------------
  //
  // The defect: a screenshot on a text-only plan cost the refused hop, a learned refusal and the
  // same question asked again with the picture turned into a sentence. Measured here on the one
  // thing that cannot be argued with -- the proxy's own spend log -- because a wire line proves
  // what this host INTENDED and a spend row proves where the tokens went.
  if (VISION_PIN.length > 0) {
    step(`a picture on ${VISION_PIN}, which cannot read one`);
    const entitled2 = await admin("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/models`, { models: [...WANTED, VISION_PIN] });
    check(entitled2.status === 200, `${SLUG} is entitled to ${VISION_PIN} for this leg`, `HTTP ${entitled2.status}`);
    if (entitled2.status === 200) {
      // THE SWITCH WAITS FOR THE REGISTRY. The entitlement is true at the proxy the moment the
      // action answers and reaches the relay on its own sixty second refresh, so a switch fired
      // straight afterwards is refused for a plan the workspace already has.
      const armedAt = Date.now();
      let offers = [];
      while (!offers.includes(VISION_PIN) && Date.now() - armedAt < 150_000) {
        offers = await offeredPlans();
        if (!offers.includes(VISION_PIN)) await sleep(6000);
      }
      check(offers.includes(VISION_PIN), `${VISION_PIN} reached this workspace's own choices`,
        `${offers.join(", ") || "(none)"} · ${Math.round((Date.now() - armedAt) / 1000)}s`);
      // The relay writes the vision route into the box only for a plan it measured text-only, so
      // the switch itself is what arms this. Read the box back rather than assuming it.
      const onPin = await chooseAsCustomer(VISION_PIN);
      check(onPin.status === 200, `the box is pointed at ${VISION_PIN}`, `HTTP ${onPin.status}`);
      const wrote = await relayAdmin(`/admin/tenants/${encodeURIComponent(SLUG)}/running`);
      check(String(wrote.body.model ?? "") === VISION_PIN, "and its own file says so", String(wrote.body.model ?? "?"));

      const at = new Date(Date.now() - 2000).toISOString();
      // A picture in the conversation: the bot takes a screenshot of its own screen, which is the
      // shape a computerUse turn arrives in and the one that used to pay the refused hop.
      const said = await gw("sendPrompt", {
        agentId: throwaway,
        prompt: "Take one screenshot of your screen with your computer tool, then tell me in one short line what is on it.",
      }).then(() => true).catch((error) => { note(`sendPrompt: ${String(error.message).slice(0, 160)}`); return false; });
      check(said, "one turn carrying a screenshot was sent");
      const landed = await waitForSpend(VISION_FALLBACK, at);
      check(landed.ok === true, `the picture was answered by ${VISION_FALLBACK} rather than the pin`,
        landed.ok
          ? `${landed.row.group} · ${landed.row.model} · ${landed.row.tokens} tokens`
          : `${landed.why}; rows since: ${landed.rows.map((one) => one.group).join(", ") || "none"}`);
      // AND THE PIN STILL ANSWERS ITS OWN TEXT. A reroute that took every turn would be a customer
      // silently moved off the plan they chose.
      // A FRESH CONVERSATION FOR THE TEXT TURN, and this is the correction the first run of this
      // leg earned. The rule is about what the REQUEST carries, not about what the person typed: a
      // follow-up in the conversation above is an image-bearing request, because the screenshot is
      // still in its history and is still sent. Asking that bot a text question and expecting the
      // pin to answer measured the wrong thing. A second bot has no picture behind it at all.
      const plain = await gw("createAgent", {
        name: `verify-model-switch ${Math.random().toString(36).slice(2, 8)}`,
        description: "Throwaway bot for the MODEL-1c text leg. Deleted when it finishes.",
        origin: "user",
        isKickstartRequested: false,
      }).catch(() => null);
      const plainId = plain?.id ?? plain?.agentId ?? plain?.agent?.id ?? null;
      check(plainId != null, "a second bot, with no picture in its history", String(plainId ?? "(none)"));
      if (plainId != null) {
        const textAt = new Date(Date.now() - 1000).toISOString();
        await gw("sendPrompt", { agentId: plainId, prompt: "Reply with the single word OK and nothing else." }).catch(() => {});
        const text = await waitForSpend(VISION_PIN, textAt);
        check(text.ok === true, `and a turn with no picture still goes to ${VISION_PIN}`,
          text.ok ? `${text.row.group} · ${text.row.tokens} tokens` : text.why);
        await gw("deleteAgent", { id: plainId }).catch(() => {});
      }

      // AND THE BOX'S OWN WIRE LOG, which is the half a spend row cannot show: that the request
      // went out CARRYING the picture rather than having it replaced by a sentence first, and that
      // nothing learned a refusal off it. imagesAllowed staying true is what keeps that picture in
      // the history of every later call on that conversation -- an ordinary follow-up, a routine,
      // or a background revival -- so each of those is rerouted for the same reason this one was.
      const wire = await boxWire();
      check(wire.ok === true, "the box's own wire log could be read", wire.ok ? `${wire.lines.length} line(s)` : String(wire.why));
      if (wire.ok === true) {
        const carried = wire.lines.filter((one) => one.model === VISION_PIN && one.imageParts > 0);
        check(carried.length > 0, `a request on ${VISION_PIN} went out carrying the picture`,
          carried.length > 0
            ? `historyImageParts ${carried.at(-1).historyImageParts}, imageParts ${carried.at(-1).imageParts}`
            : "no request on the pin carried an image part");
        check(carried.every((one) => one.imagesAllowed === true),
          "and nothing learned a refusal off it, so a later call still carries that picture",
          carried.map((one) => String(one.imagesAllowed)).join(", ") || "(none)");
        check(wire.rerouted > 0, "and the host said so on the wire, naming both plans", `${wire.rerouted} reroute line(s)`);
      }

      // PUT THE ENTITLEMENT BACK BEFORE THE REFUSAL LEG. That leg proves this workspace cannot
      // reach a plan it is not entitled to, and this one just entitled it to exactly that plan:
      // leaving it on would make the next refusal a pass for the wrong reason.
      await chooseAsCustomer(WANTED[1]).catch(() => {});
      const narrowed = await admin("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/models`, { models: WANTED });
      check(narrowed.status === 200, `${VISION_PIN} is taken off again before the refusal is measured`, `HTTP ${narrowed.status}`);
      const backAt = Date.now();
      let back = [];
      // AN EMPTY ANSWER IS NOT A NARROWED ONE. A read that failed carries no plans either, and
      // taking that for "the plan is gone" is how the refusal leg below came to run against a
      // workspace that was still entitled.
      while ((back.length === 0 || back.includes(VISION_PIN)) && Date.now() - backAt < 150_000) {
        back = await offeredPlans();
        if (back.length === 0 || back.includes(VISION_PIN)) await sleep(6000);
      }
      check(back.length > 0 && !back.includes(VISION_PIN), "and this workspace's own choices no longer offer it",
        `${back.join(", ") || "(the read answered nothing)"} · ${Math.round((Date.now() - backAt) / 1000)}s`);
    }
  }

  step(`a plan this workspace is not entitled to`);
  const refused = await chooseAsCustomer(DENIED);
  check(refused.status === 404, `POST /model/use ${DENIED} is refused`, `HTTP ${refused.status} ${String(refused.body.error ?? "").slice(0, 120)}`);
  const unchanged = await boxSays();
  check(unchanged.body.model === WANTED[1], "and the box is still on the plan it was", String(unchanged.body.model ?? "?"));

  step("and the same door refuses a stranger");
  const stranger = await fetch(`${CONSOLE_URL}/model/use`, {
    method: "POST", headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ model: WANTED[0] }), redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
  check(stranger.status === 401, "with no session it is 401", `HTTP ${stranger.status}`);
}

try {
  await main();
} catch (error) {
  check(false, "the run reached the end", String(error?.message ?? error).slice(0, 220));
} finally {
  step("putting it back");
  if (throwaway != null) {
    const gone = await gw("deleteAgent", { id: throwaway }).then(() => true).catch(() => false);
    check(gone, "the throwaway bot was deleted", String(throwaway));
  }
  if (restoreModel != null && restoreModel.length > 0 && COOKIE.length > 0) {
    const back = await chooseAsCustomer(restoreModel);
    check(back.status === 200, `the workspace is back on ${restoreModel}`, `HTTP ${back.status}`);
  } else if (restoreModel != null && restoreModel.length > 0) {
    skip(`the workspace is back on ${restoreModel}`, "there was no customer session to put it back with");
  }
  if (restoreEntitlement != null && ADMIN_TOKEN.length > 0) {
    const back = await admin("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/models`, { models: restoreEntitlement });
    check(back.status === 200, "the entitlement is back to what it was", `${restoreEntitlement.join(", ")} (HTTP ${back.status})`);
    // AND THE KEY IS BACK WHERE IT WAS TOO, which the record alone cannot say. A run that put the
    // entitlement back and left the key short would have taken a workspace off a plan it had
    // before, quietly, which is the whole class of defect this gate now exists to catch.
    const keyBack = Array.isArray(back.body.keyModels) ? back.body.keyModels : [];
    const missing = (keyBefore ?? []).filter((one) => !keyBack.includes(one));
    check(missing.length === 0, "and so is its key, alias for alias",
      missing.length === 0 ? keyBack.join(", ") : `missing ${missing.join(", ")}`);
  }
  // THE ROSTER, AND ONLY THIS GATE'S OWN ROWS IN IT. demo is shared with other gates, so a count
  // is not evidence: what this file is answerable for is that nothing it created is still there.
  const roster = COOKIE.length > 0 ? await gw("listAgents").catch(() => null) : null;
  if (roster != null) {
    const rows = Array.isArray(roster) ? roster : roster?.agents ?? [];
    const mine = rows.filter((one) => String(one?.name ?? "").startsWith("verify-model-switch"));
    check(mine.length === 0, "no bot this gate made is left on that box",
      mine.length === 0 ? `${rows.length} on the roster, none of them this gate's` : mine.map((one) => one.id).join(", "));
  }
  console.log(`\nverify-model-switch: ${passes} pass, ${failures} fail, ${skips} skip · ${SLUG} on ${SSH_HOST} · ${CONSOLE_URL}`);
  process.exit(failures > 0 ? 1 : 0);
}
