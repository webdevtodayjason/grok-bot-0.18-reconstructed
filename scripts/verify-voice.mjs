#!/usr/bin/env node
// verify-voice.mjs -- the talking-to-your-team gate (VOICE-1, docs/VOICE.md).
//
// ONE LEG PER RUN, because the legs that touch the local box hold the host's one global active agent
// and every gate on this repository has to fit inside a 300 second warden ceiling. `--leg all` is
// deliberately not a thing.
//
//   --leg cp        the control plane half, on this Mac, with no relay and no box: the policy route's
//                   two doors, the claim-before-dial order, the day cap counting a session that is
//                   still running, the operator read living outside /v1/admin, a customer session
//                   refused at the cap write, and the three CLI verbs over the same HTTP the operator
//                   types. Needs nothing but node.
//   --leg relay     a relay with a stub vendor: the accepted socket, the ready frame, and the ledger
//                   row written BEFORE the dial.
//   --leg nokey     an empty voice.json: the upgrade is ACCEPTED, one plain sentence arrives, then bye.
//   --leg caps      a one-minute policy: a refusal in words over an accepted socket.
//   --leg origin    a cross-origin upgrade: refused in words, not with a destroyed socket.
//   --leg browser   real Chrome with a WAV file as the microphone, the talk button, all four orb
//                   states, a real reply from the local box read back and heard, the mic proved held
//                   from BOTH sides, the spoken row with its chip, and the seven-stamp hop ledger.
//
// WHY A REFUSAL IS NEVER A DESTROYED SOCKET, which four of these legs exist to hold the line on.
// MEASURED on this Mac 2026-09-09: an unknown upgrade path on this relay answers 0 bytes with no
// status line, cookie or not, and real Chrome reports only `onerror` at 16 ms with no close code --
// indistinguishable from the relay being down. That is the void-answer failure this console has
// already been burned by (memory: handoff-screen-and-void-rpc). So every voice refusal is: accept the
// upgrade, send one `note` frame carrying one plain sentence, send `bye`, close 1000.
//
// WHAT THIS GATE WILL NOT DO. It never pastes a realtime key anywhere. There is none on this machine,
// and a key set over ssh would be the hand operation no-hand-operations-on-the-product forbids: the
// mechanism is the workspace's own Voice card in the console. So the vendor in every leg below is a
// stub, and on the R750 the shipped result is the no-key sentence read by a person.
//
// Every leg prints PASS or FAIL with a number and the machine it was measured on. Exit 2 names what
// it tried when a tool it needs is absent; exit 1 is a real failure.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { gateUserAgent } from "./gate-agent.mjs";

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = gateUserAgent(import.meta.url);
const MACHINE = process.env.GATE_MACHINE ?? `${os.hostname()} (${os.platform()} ${os.arch()})`;
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:1340";

const LEGS = ["cp", "relay", "nokey", "caps", "origin", "browser"];
const leg = (() => {
  const at = process.argv.indexOf("--leg");
  return at === -1 ? "" : String(process.argv[at + 1] ?? "");
})();

if (process.argv.includes("--help") || process.argv.includes("-h") || leg.length === 0) {
  console.log([
    "verify-voice.mjs -- the talking-to-your-team gate (VOICE-1, docs/VOICE.md).",
    "",
    `  timeout 300 node scripts/verify-voice.mjs --leg <${LEGS.join("|")}>`,
    "",
    "One leg per run: the live legs hold the host's one global active agent and every gate here has",
    "to fit a 300 second ceiling. The browser and relay legs want the shipping lock, because a",
    "concurrent gate on this box steals that agent.",
    "",
    "  cp       the control plane half. Needs only node; runs anywhere.",
    "  relay    a relay against a stub vendor: the accepted socket, the ready frame, the claim first.",
    "  nokey    an empty voice.json answers one plain sentence over an ACCEPTED socket.",
    "  caps     a one minute policy refuses in words.",
    "  origin   a cross-origin upgrade is refused in words, never by a destroyed socket.",
    "  browser  real Chrome, a WAV file as the microphone, the orb, the transcript, the hop ledger.",
    "",
    "Env: SAND_PROFILE_DIRS (the live legs), SAND_GATEWAY_URL, GATE_MIC_WAV,",
    "     GROK_BOT_PLAYWRIGHT_DIR, VOICE_GATE_PORT (default 7793), VOICE_GATE_CP_PORT (default 7794).",
    "",
    "No realtime key is pasted by this gate, ever. The vendor is a stub; the mechanism for a real key",
    "is the workspace's own Voice card.",
  ].join("\n"));
  process.exit(leg.length === 0 && !process.argv.includes("--help") && !process.argv.includes("-h") ? 2 : 0);
}

if (!LEGS.includes(leg)) {
  console.error(`unknown leg ${JSON.stringify(leg)}. One of: ${LEGS.join(", ")}`);
  process.exit(2);
}

// ---- the gate's own scaffolding -------------------------------------------------------------------

let failures = 0;
let checks = 0;
const step = (what) => console.log(`\n== ${what}`);
const pass = (what, detail = "") => { checks += 1; console.log(`  PASS  ${what}${detail ? `  (${detail})` : ""}`); };
const fail = (what, detail = "") => { checks += 1; failures += 1; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); };
const check = (ok, what, detail = "") => (ok ? pass(what, detail) : fail(what, detail));
const info = (line) => console.log(`  INFO  ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const missing = (what, tried) => {
  console.error(`\n${what} is not available, so this leg measured nothing.`);
  for (const line of tried) console.error(`  ${line}`);
  process.exit(2);
};

const cleanups = [];
const onExit = () => { while (cleanups.length > 0) { try { cleanups.pop()(); } catch { /* best effort */ } } };
// SIGTERM never reaches a finally (node's default handler ends the process) and this gate runs under
// `timeout`, which sends exactly that. A child left behind holds the port for the next run.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { onExit(); process.exit(143); });

/** Every request this gate makes says its own name at the door. */
const ask = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(Number(init.timeoutMs ?? 10_000)),
  });
  const text = await response.text();
  let body = null;
  if (text.length > 0) { try { body = JSON.parse(text); } catch { body = null; } }
  return { status: response.status, text, body, headers: response.headers };
};

// ---- the control plane this gate stands up -------------------------------------------------------

/**
 * A real cp/server.mjs on a temp data directory, which is what makes `--leg cp` a measurement of the
 * thing that ships rather than of a test harness. Nothing here reads the operator's own cp.env.
 */
async function startControlPlane(portOffset = 0) {
  const root = mkdtempSync(path.join(os.tmpdir(), "voice-gate-cp-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // The offset matters: a second instance on the same port does NOT fail loudly. Its child cannot
  // bind and the readiness probe answers from the FIRST one, so the gate would measure the wrong
  // service and pass. Found on this Mac 2026-09-09 doing exactly that.
  const port = Number(process.env.VOICE_GATE_CP_PORT ?? 7794) + portOffset;
  const adminToken = randomBytes(24).toString("hex");
  const relayToken = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [path.join(repoRoot, "cp", "server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CP_PORT: String(port),
      CP_DATA_DIR: path.join(root, "data"),
      CP_TENANT_ROOT: path.join(root, "tenants"),
      CP_RELEASE_ROOT: path.join(root, "release"),
      CP_SESSION_SECRET: randomBytes(32).toString("hex"),
      CP_ADMIN_TOKEN: adminToken,
      CP_RELAY_TOKEN: relayToken,
      CP_BASE_DOMAIN: "titanium.bot",
      CP_PUBLIC_URL: `http://127.0.0.1:${port}`,
      CP_ALLOW_NEW_TENANTS: "1",
      // No outbound vendor reads from a gate. One stale marketing row beats a gate that browses.
      CP_MARKETPLACE_VERIFY: "0",
      COOLIFY_URL: "",
      COOLIFY_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += String(chunk); });
  child.stderr.on("data", (chunk) => { log += String(chunk); });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60 && child.exitCode == null; i += 1) {
    const probe = await ask(`${base}/v1/health`).catch(() => null);
    if (probe != null) return { base, adminToken, relayToken, root, log: () => log };
    await sleep(250);
  }
  missing("a control plane", [`node cp/server.mjs on ${base} never answered`, log.slice(-500)]);
  return null;
}

const asAdmin = (cp, method, pathname, body) => ask(`${cp.base}${pathname}`, {
  method,
  headers: { authorization: `Bearer ${cp.adminToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const asRelay = (cp, method, pathname, body) => ask(`${cp.base}${pathname}`, {
  method,
  headers: { authorization: `Bearer ${cp.relayToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ---- leg: cp ------------------------------------------------------------------------------------

async function legControlPlane() {
  console.log(`verify-voice --leg cp on ${MACHINE}`);
  const cp = await startControlPlane();
  info(`control plane at ${cp.base}, data in a temp directory, no Coolify and no proxy`);

  step("the policy the relay dials against: two doors, numbers only");
  const t0 = Date.now();
  const noBearer = await ask(`${cp.base}/v1/relay/voice/policy?slug=gate`);
  check(noBearer.status === 401, "a policy read with no credential is 401", `got ${noBearer.status}`);
  const wrongDoor = await asAdmin(cp, "GET", "/v1/relay/voice/policy?slug=gate");
  check(wrongDoor.status === 401, "and the OPERATOR token does not open the relay's door", `got ${wrongDoor.status}`);
  const policy = await asRelay(cp, "GET", "/v1/relay/voice/policy?slug=gate");
  check(policy.status === 200, "the relay's own credential reads it", `${Date.now() - t0} ms on ${MACHINE}`);
  check(policy.body?.dayMinutes === 120 && policy.body?.sessionMinutes === 30,
    "the shipped defaults are 120 minutes a day and 30 a session", JSON.stringify({ day: policy.body?.dayMinutes, session: policy.body?.sessionMinutes }));
  check(Array.isArray(policy.body?.vendors) && policy.body.vendors.length === 2, "and an allowlist of the two vendors", JSON.stringify(policy.body?.vendors));
  check(!/sk-|bearer |xai-|authorization|wss:\/\//i.test(policy.text),
    "nothing credential-shaped and no vendor address in the answer", policy.text.slice(0, 120));
  const wrongMethod = await ask(`${cp.base}/v1/relay/voice/policy?slug=gate`, { method: "POST" });
  check(wrongMethod.status === 405, "a wrong method is refused BEFORE the credential is looked at", `got ${wrongMethod.status}`);

  step("the claim comes before the dial, and an open session counts toward the day");
  const sessionId = `gate-${randomBytes(6).toString("hex")}`;
  const claimAt = Date.now();
  const claim = await asRelay(cp, "POST", "/v1/relay/voice/usage/open", { slug: "gate", sessionId, agentId: "a_titan", vendor: "xai", model: "grok-voice-think-fast-2.0" });
  check(claim.status === 200 && claim.body?.ok === true, "the claim is accepted", `${Date.now() - claimAt} ms on ${MACHINE}`);
  const openPolicy = await asRelay(cp, "GET", "/v1/relay/voice/policy?slug=gate");
  check(openPolicy.body?.openSessions === 1, "the policy sees one session open", JSON.stringify(openPolicy.body?.openSessions));
  // The row exists with no outcome on it: that is what "before the dial" looks like from outside.
  const midRead = await asAdmin(cp, "GET", "/v1/voice/usage?slug=gate");
  const midLine = (midRead.body?.tenants ?? [])[0];
  check(midLine?.open === 1 && midLine?.sessions === 1, "and the operator's read shows it open rather than absent", JSON.stringify(midLine ?? null));
  check(midRead.body?.everMeasured === true, "the ledger has been measured, so the panel draws numbers rather than words");

  step("the settle writes both meters and the event count, and they stay apart");
  const settle = await asRelay(cp, "POST", "/v1/relay/voice/usage/close", {
    sessionId, wallSeconds: 95, audioInSeconds: 21, audioOutSeconds: 34, billedItemEvents: 4, toolCalls: 2, heldFrames: 58, closeReason: "the gate toggled off",
  });
  check(settle.status === 200, "the settle is accepted", `got ${settle.status}`);
  const after = ((await asAdmin(cp, "GET", "/v1/voice/usage?slug=gate")).body?.tenants ?? [])[0];
  check(after?.wallSeconds === 95, "wall clock is 95 seconds", String(after?.wallSeconds));
  check(after?.audioInSeconds === 21 && after?.audioOutSeconds === 34, "audio is 21 in and 34 out, which is a different meter", JSON.stringify({ in: after?.audioInSeconds, out: after?.audioOutSeconds }));
  check(after?.billedItemEvents === 4 && after?.toolCalls === 2, "4 billable events and 2 turns handed to the team", JSON.stringify({ events: after?.billedItemEvents, tool: after?.toolCalls }));
  check(after?.heldFrames === 58, "and the echo gate's dropped-frame count survived the session", String(after?.heldFrames));
  const ghost = await asRelay(cp, "POST", "/v1/relay/voice/usage/close", { sessionId: "never-claimed" });
  check(ghost.status === 404, "a settle nobody claimed is a 404 and never a new row", `got ${ghost.status}`);

  step("the day cap, counted on this service's own rows");
  await asAdmin(cp, "POST", "/v1/voice/caps", { slug: "capped", dayMinutes: 1 });
  const first = await asRelay(cp, "POST", "/v1/relay/voice/usage/open", { slug: "capped", sessionId: `capped-${randomBytes(4).toString("hex")}`, vendor: "xai" });
  check(first.status === 200, "the first session inside a one minute day is allowed");
  await asRelay(cp, "POST", "/v1/relay/voice/usage/close", { sessionId: first.body.sessionId, wallSeconds: 90 });
  const refused = await asRelay(cp, "POST", "/v1/relay/voice/usage/open", { slug: "capped", sessionId: "capped-second", vendor: "xai" });
  check(refused.status === 429, "and the next one is refused with 429 so the relay can pass the sentence on", `got ${refused.status}`);
  check(/used all the voice time it has for today/.test(String(refused.body?.message ?? "")),
    "in plain words a person can act on", JSON.stringify(refused.body?.message));
  const leaks = ["xai", "openai", "grok", "realtime", "voice.dayMinutes", "titan("];
  const leaked = leaks.filter((word) => String(refused.body?.message ?? "").toLowerCase().includes(word.toLowerCase()));
  check(leaked.length === 0, "naming no vendor, no model, no setting and no tool", leaked.join(", ") || "nothing leaked");

  step("one word switches voice off for a workspace");
  await asAdmin(cp, "POST", "/v1/voice/caps", { slug: "quiet", vendors: "none" });
  const off = await asRelay(cp, "POST", "/v1/relay/voice/usage/open", { slug: "quiet", sessionId: "quiet-1", vendor: "xai" });
  check(off.status === 403 && off.body?.message === "Voice is not switched on for this workspace yet.",
    "and their talk button reads one plain sentence rather than an error", `${off.status} ${JSON.stringify(off.body?.message)}`);

  step("the operator's read lives outside /v1/admin, so cp/admin.mjs is untouched by this wave");
  const underAdmin = await asAdmin(cp, "GET", "/v1/admin/voice/usage");
  check(underAdmin.status === 404, "cp/admin.mjs 404s anything it does not match itself, which is why the read is elsewhere", `got ${underAdmin.status}`);
  check((await ask(`${cp.base}/v1/voice/usage`)).status === 401, "and the read itself needs the operator bearer");
  check((await asRelay(cp, "GET", "/v1/voice/usage")).status === 401, "the relay's credential reads numbers and not the ledger");

  step("no customer-reachable route can raise a cap");
  await asAdmin(cp, "POST", "/v1/tenants", { slug: "gatecust", name: "Gate Customer" }).catch(() => null);
  const email = `gate-${randomBytes(4).toString("hex")}@example.invalid`;
  const password = `gate-${randomBytes(12).toString("hex")}`;
  const made = await asAdmin(cp, "POST", "/v1/accounts", { email, password, tenant: "gatecust" });
  if (made.status !== 201 && made.status !== 200) {
    info(`a customer account could not be made here (${made.status} ${made.text.slice(0, 120)}), so this leg asserts the unauthenticated and relay cases only`);
  } else {
    const signedIn = await ask(`${cp.base}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const customer = String(signedIn.body?.token ?? "");
    check(customer.length > 0, "a customer can sign in", `${signedIn.status}`);
    const tried = await ask(`${cp.base}/v1/voice/caps`, {
      method: "POST",
      headers: { authorization: `Bearer ${customer}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "gatecust", dayMinutes: 100000 }),
    });
    check(tried.status === 401, "and their own session cannot raise their own cap", `got ${tried.status}`);
  }
  const byRelay = await asRelay(cp, "POST", "/v1/voice/caps", { slug: "gate", dayMinutes: 100000 });
  check(byRelay.status === 401, "and neither can the relay's credential", `got ${byRelay.status}`);
  const capsNow = await asRelay(cp, "GET", "/v1/relay/voice/policy?slug=gate");
  check(capsNow.body?.dayMinutes === 120, "the cap is unchanged by either attempt", String(capsNow.body?.dayMinutes));

  step("the three CLI verbs, over the same HTTP the operator types");
  const cliEnv = { ...process.env, CP_ADMIN_TOKEN: cp.adminToken, CP_PUBLIC_URL: cp.base };
  const cli = async (args) => {
    const { stdout } = await exec(process.execPath, [path.join(repoRoot, "cp", "cli.mjs"), ...args], { cwd: repoRoot, env: cliEnv, timeout: 30_000 });
    return stdout;
  };
  const policyOut = await cli(["voice", "policy", "gate"]);
  check(/120 minutes a day, 30 minutes a session/.test(policyOut), "voice policy prints the numbers in force", policyOut.split("\n")[0]);
  check(/WALL CLOCK/.test(policyOut), "and says which meter they are");
  const capOut = await cli(["voice", "cap", "gate", "--day-minutes", "45", "--session-minutes", "12"]);
  check(/45 minutes a day, 12 minutes a session/.test(capOut), "voice cap writes them", capOut.split("\n")[0]);
  check((await asRelay(cp, "GET", "/v1/relay/voice/policy?slug=gate")).body?.dayMinutes === 45, "and the relay would read the new number");
  const usageOut = await cli(["voice", "usage"]);
  check(/workspace\s+wall\s+heard\s+spoken/.test(usageOut), "voice usage keeps the meters in separate columns", usageOut.split("\n").find((line) => line.includes("wall")) ?? "");
  check(/heard and spoken are AUDIO seconds/.test(usageOut), "and names which each one is");
  const emptyOut = await cli(["voice", "usage", "--day", "2020-01-01"]);
  check(/no workspace talked on 2020-01-01/.test(emptyOut), "a window with nothing in it says so rather than printing noughts", emptyOut.split("\n")[0]);
  // AND THE FLAG'S VALUE IS NOT READ AS THE WORKSPACE. The first cut of these verbs left the four new
  // flags out of the CLI's valued-flag set, so `--day 2020-01-01` ALSO set the slug to "2020-01-01" and
  // the line above passed for the wrong reason: both readings give an empty answer. This asserts a day
  // that HAS rows, where the two readings differ.
  const today = new Date().toISOString().slice(0, 10);
  const sameDay = await cli(["voice", "usage", "--day", today]);
  check(/\bgate\b/.test(sameDay), "a day that has rows names the workspace that made them, so --day is not read as a slug",
    sameDay.split("\n").find((line) => /gate/.test(line)) ?? sameDay.split("\n")[0]);
  // And the other half of that rule, on a ledger nobody has ever written to.
  const fresh = await startControlPlane(10).catch(() => null);
  if (fresh != null) {
    const never = await exec(process.execPath, [path.join(repoRoot, "cp", "cli.mjs"), "voice", "usage"], {
      cwd: repoRoot, env: { ...process.env, CP_ADMIN_TOKEN: fresh.adminToken, CP_PUBLIC_URL: fresh.base }, timeout: 30_000,
    }).then((r) => r.stdout).catch((error) => String(error?.stdout ?? error?.message ?? ""));
    check(/not measured/.test(never) && !/0 minutes/.test(never),
      "a ledger nobody has ever written to reads not measured in words, never 0 minutes", never.split("\n")[0]);
  }

  step("the two realtime rows on the Providers panel are inert");
  // Measured on this Mac 2026-09-09: with no proxy configured that panel answers no providers at all
  // and says why, so this is asserted by tests/cp-voice.test.mjs against a fake proxy instead. Said
  // out loud rather than skipped silently, because a gate that prints nothing here looks like a pass.
  info("the panel needs a configured proxy to answer rows; tests/cp-voice.test.mjs asserts the two rows offer no model and mint no credential against a fake one");
  return;
}

// ---- the relay legs -----------------------------------------------------------------------------

const VOICE_EDGE = path.join(repoRoot, "ui", "voice-edge.mjs");
const VOICE_JS = path.join(repoRoot, "ui", "machine-room", "voice.js");
const STUB_REALTIME = path.join(repoRoot, "tests", "helpers", "stub-realtime.mjs");

/**
 * The three pieces the live legs need and this item does not own.
 *
 * Item A builds ui/voice-edge.mjs, the relay's upgrade branch and tests/helpers/stub-realtime.mjs;
 * item B builds ui/machine-room/voice.js. Until those are merged these legs measure nothing, and an
 * exit 2 naming which file is absent is the honest answer -- a leg that quietly printed PASS against
 * a relay with no voice in it is worse than no leg at all.
 */
function requireTheOtherItems(forBrowser = false) {
  const absent = [];
  if (!existsSync(VOICE_EDGE)) absent.push(`ui/voice-edge.mjs (item A: the bridge and the upgrade branch)`);
  if (!existsSync(STUB_REALTIME)) absent.push(`tests/helpers/stub-realtime.mjs (item A: the stub vendor this leg dials instead of a real one)`);
  if (forBrowser && !existsSync(VOICE_JS)) absent.push(`ui/machine-room/voice.js (item B: the talk button, the orb and the capture)`);
  if (absent.length > 0) {
    missing("the relay half of this wave", [
      ...absent.map((one) => `not on disk: ${one}`),
      "this leg runs at the MERGED commit. Until then the control plane half is measured by --leg cp",
      "and by `node --test tests/cp-voice.test.mjs`.",
    ]);
  }
}

/**
 * A relay on loopback with a temp auth record, a temp tenant state directory, and the vendor address
 * pointed at the stub. Never ui/auth.json: that is somebody's working relay.
 */
async function startRelay({ port, voiceJson, stubUrl, policyUrl = "", relayToken = "" }) {
  const { newAuthRecord } = await import(path.join(repoRoot, "ui", "auth.mjs"));
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-relay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  const password = randomBytes(18).toString("hex");
  writeFileSync(authFile, `${JSON.stringify(newAuthRecord(password), null, 2)}\n`, { mode: 0o600 });
  const stateDir = path.join(dir, "state");
  const child = spawn(process.execPath, [path.join(repoRoot, "ui", "server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SAND_UI_PORT: String(port),
      SAND_UI_BIND_HOST: "127.0.0.1",
      SAND_UI_AUTH_FILE: authFile,
      SAND_PROFILE_DIRS: process.env.SAND_PROFILE_DIRS ?? "",
      SAND_HOST_GATEWAY_URL: GATEWAY,
      SAND_UI_STATE_DIR: stateDir,
      // The one environment override, the way ui/mail-edge.mjs does it for GROK_BOT_MAIL_API_BASE: the
      // address a vendor is read at is a relay variable, and a gate points it at its own stub. A
      // realtime KEY is never an environment variable on either side of this.
      GROK_BOT_VOICE_WS_BASE: stubUrl,
      ...(policyUrl ? { CP_URL: policyUrl } : {}),
      ...(relayToken ? { CP_RELAY_TOKEN: relayToken } : {}),
      ...(voiceJson ? { GROK_BOT_VOICE_SETTINGS_FILE: voiceJson } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += String(chunk); });
  child.stderr.on("data", (chunk) => { log += String(chunk); });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60 && child.exitCode == null; i += 1) {
    const probe = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (probe != null) return { base, password, authFile, stateDir, dir, log: () => log };
    await sleep(250);
  }
  missing("a relay", [`node ui/server.mjs on ${base} never answered`, log.slice(-600)]);
  return null;
}

/**
 * One websocket to the relay's voice door, over a hand-rolled client, and everything it said.
 *
 * THE THING THIS MEASURES IS THAT THE UPGRADE WAS ACCEPTED. A refusal that arrives as a destroyed
 * socket is indistinguishable from the relay being down, so the legs below assert `accepted` as hard
 * as they assert the sentence.
 */
async function openVoiceSocket(base, { cookie = "", origin = "", timeoutMs = 15_000 } = {}) {
  const { createConnection } = await import("node:net");
  const { createHash, randomBytes: rb } = await import("node:crypto");
  const url = new URL(base);
  const key = rb(16).toString("base64");
  const expect = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write([
        "GET /voice/socket HTTP/1.1",
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `User-Agent: ${UA}`,
        ...(origin ? [`Origin: ${origin}`] : []),
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        "", "",
      ].join("\r\n"));
    });
    const out = { accepted: false, statusLine: "", bytes: 0, frames: [], notes: [], closedWith: null, error: "" };
    let buffer = Buffer.alloc(0);
    let handshake = false;
    const done = () => resolve(out);
    const timer = setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } done(); }, timeoutMs);
    socket.on("data", (chunk) => {
      out.bytes += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshake) {
        const at = buffer.indexOf("\r\n\r\n");
        if (at === -1) return;
        const head = buffer.slice(0, at).toString("latin1");
        out.statusLine = head.split("\r\n")[0] ?? "";
        out.accepted = /^HTTP\/1\.1 101/.test(out.statusLine) && head.includes(expect);
        handshake = true;
        buffer = buffer.slice(at + 4);
      }
      // Server frames are unmasked, so the decode is a length and a slice. Text only: the gate never
      // needs to play the audio, only to count it.
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + length) return;
        const payload = buffer.slice(offset, offset + length);
        buffer = buffer.slice(offset + length);
        if (opcode === 0x1) {
          const text = payload.toString("utf8");
          out.frames.push(text);
          try {
            const frame = JSON.parse(text);
            if (frame?.t === "note" && typeof frame.text === "string") out.notes.push(frame.text);
            if (frame?.t === "bye") out.closedWith = String(frame.reason ?? "");
          } catch { /* a frame this gate does not parse is still recorded above */ }
        } else if (opcode === 0x2) {
          out.frames.push(`<binary ${payload.length} bytes>`);
        } else if (opcode === 0x8) {
          out.closedWith = out.closedWith ?? (payload.length >= 2 ? `${payload.readUInt16BE(0)} ${payload.slice(2).toString("utf8")}` : "");
          clearTimeout(timer);
          try { socket.end(); } catch { /* gone */ }
          done();
          return;
        }
      }
    });
    socket.on("error", (error) => { out.error = String(error?.message ?? error); clearTimeout(timer); done(); });
    socket.on("close", () => { clearTimeout(timer); done(); });
  });
}

/** The console's own cookie, which is the only credential the voice door takes. */
async function signIn(relay) {
  const response = await fetch(`${relay.base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ password: relay.password }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((one) => String(one).split(";")[0]).join("; ");
  return { status: response.status, cookie };
}

async function legRelay() {
  console.log(`verify-voice --leg relay on ${MACHINE}`);
  requireTheOtherItems(false);
  const cp = await startControlPlane();
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({});
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });
  const voiceJson = path.join(mkdtempSync(path.join(os.tmpdir(), "voice-gate-key-")), "voice.json");
  // A fake key, because this gate holds no real one and never will. It is here only to get the bridge
  // past "no key set" and onto the stub; the stub does not look at it.
  writeFileSync(voiceJson, `${JSON.stringify({ apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
  cleanups.push(() => rmSync(path.dirname(voiceJson), { recursive: true, force: true }));

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793),
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const session = await signIn(relay);
  check(session.cookie.length > 0, "the console's own cookie is the way in", `sign-in answered ${session.status}`);

  step("the upgrade is accepted and the relay says what it opened");
  const t0 = Date.now();
  const socket = await openVoiceSocket(relay.base, { cookie: session.cookie, origin: relay.base });
  check(socket.accepted, "GET /voice/socket answers 101", `${socket.statusLine} in ${Date.now() - t0} ms on ${MACHINE}`);
  const ready = socket.frames.map((one) => { try { return JSON.parse(one); } catch { return null; } }).find((one) => one?.t === "ready");
  check(ready != null, "and a ready frame arrives", JSON.stringify(ready ?? socket.frames.slice(0, 2)));
  check(typeof ready?.sessionCapSeconds === "number" && ready.sessionCapSeconds > 0, "carrying the session cap the relay will hold itself to", String(ready?.sessionCapSeconds));
  check(!/gate-not-a-real-key/.test(socket.frames.join(" ")), "and no key reaches the page");

  step("the ledger row is written BEFORE the vendor hears anything");
  const rows = (await asAdmin(cp, "GET", "/v1/voice/usage")).body?.tenants ?? [];
  check(rows.length > 0, "the control plane has a row for this session", JSON.stringify(rows.map((one) => one.slug)));
  check((rows[0]?.open ?? 0) >= 1 || (rows[0]?.sessions ?? 0) >= 1, "and it exists whether or not the session has ended", JSON.stringify(rows[0] ?? null));
  info(`the stub saw ${stub.events?.length ?? 0} event(s); the claim is the row above and not one of them`);
  return;
}

async function legNoKey() {
  console.log(`verify-voice --leg nokey on ${MACHINE}`);
  requireTheOtherItems(false);
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({});
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-nokey-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ apiKey: "", vendor: "" })}\n`, { mode: 0o600 });

  const relay = await startRelay({ port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 1, voiceJson, stubUrl: stub.url });
  const session = await signIn(relay);

  step("a workspace with no realtime key reads one plain sentence, over an ACCEPTED socket");
  const t0 = Date.now();
  const socket = await openVoiceSocket(relay.base, { cookie: session.cookie, origin: relay.base });
  // THE SILENT-SOCKET RULE. A refusal that destroys the socket is indistinguishable from the relay
  // being down, and the console has already been burned by exactly that.
  check(socket.accepted, "the upgrade is accepted rather than destroyed", `${socket.statusLine || "no status line at all"} in ${Date.now() - t0} ms on ${MACHINE}`);
  check(socket.notes.length >= 1, "and one note arrives", JSON.stringify(socket.notes));
  const sentence = socket.notes[0] ?? "";
  check(/key/i.test(sentence) || /not set/i.test(sentence) || /switched on/i.test(sentence),
    "saying in plain words that this workspace has no realtime key yet", JSON.stringify(sentence));
  for (const word of ["xai", "openai", "grok", "websocket", "socket", "titan(", "undefined", "null", "error"]) {
    check(!sentence.toLowerCase().includes(word), `the sentence does not say ${word}`, JSON.stringify(sentence));
  }
  check(socket.closedWith != null, "then bye and a close the page can read", String(socket.closedWith));
  check(stub.events?.length === 0 || stub.events == null, "and the vendor was never dialled", `stub saw ${stub.events?.length ?? 0} event(s)`);
  return;
}

async function legCaps() {
  console.log(`verify-voice --leg caps on ${MACHINE}`);
  requireTheOtherItems(false);
  const cp = await startControlPlane();
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({});
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-caps-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });

  step("a workspace whose day is already spent is refused in words");
  // One minute a day, then a session that already used ninety seconds of it. The relay reads the
  // policy from the control plane and the numbers come back already spent.
  const slug = "gatecaps";
  await asAdmin(cp, "POST", "/v1/voice/caps", { slug, dayMinutes: 1 });
  const spent = await asRelay(cp, "POST", "/v1/relay/voice/usage/open", { slug, sessionId: `spent-${randomBytes(4).toString("hex")}`, vendor: "xai" });
  if (spent.status === 200) await asRelay(cp, "POST", "/v1/relay/voice/usage/close", { sessionId: spent.body.sessionId, wallSeconds: 90 });
  const policy = await asRelay(cp, "GET", `/v1/relay/voice/policy?slug=${slug}`);
  check(policy.body?.dayRemainingSeconds === 0, "the policy the relay reads says nothing is left today", String(policy.body?.dayRemainingSeconds));

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 2,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const session = await signIn(relay);
  const socket = await openVoiceSocket(relay.base, { cookie: session.cookie, origin: relay.base });
  check(socket.accepted, "the upgrade is still accepted, because a refusal is words and not a dead socket", socket.statusLine);
  const said = socket.notes.join(" ");
  check(socket.notes.length >= 1, "a note arrives", JSON.stringify(socket.notes));
  check(/voice time|today|not switched on/i.test(said), "saying in plain words what ran out and when it comes back", JSON.stringify(said));
  check(stub.events?.length === 0 || stub.events == null, "and the vendor was never dialled", `stub saw ${stub.events?.length ?? 0} event(s)`);
  return;
}

async function legOrigin() {
  console.log(`verify-voice --leg origin on ${MACHINE}`);
  requireTheOtherItems(false);
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({});
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-origin-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
  const relay = await startRelay({ port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 3, voiceJson, stubUrl: stub.url });
  const session = await signIn(relay);

  step("an upgrade from somewhere else is refused in words");
  // An upgrade carries cookies, is exempt from CORS, and the relay's existing upgrade handler checks
  // no Origin at all. So the voice branch checks it itself, or any page anywhere could open a
  // microphone on a signed-in visitor's workspace.
  const foreign = await openVoiceSocket(relay.base, { cookie: session.cookie, origin: "https://evil.example" });
  check(foreign.accepted, "the socket is accepted, because a destroyed socket reads as the relay being down", foreign.statusLine || "no status line");
  check(foreign.notes.length >= 1, "and one note says no", JSON.stringify(foreign.notes));
  check(foreign.closedWith != null, "then bye and a close with a reason", String(foreign.closedWith));
  const home = await openVoiceSocket(relay.base, { cookie: session.cookie, origin: relay.base });
  const ready = home.frames.map((one) => { try { return JSON.parse(one); } catch { return null; } }).find((one) => one?.t === "ready");
  check(ready != null, "and the console's own origin still gets in", JSON.stringify(ready ?? home.notes));
  return;
}

// ---- leg: browser --------------------------------------------------------------------------------

const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
  ?? process.env.PLAYWRIGHT_DIR
  ?? path.join(repoRoot, ".cache", "playwright");

async function loadPlaywright() {
  const tried = [];
  try { return createRequire(path.join(PW_DIR, "package.json"))("playwright-core"); }
  catch (error) { tried.push(`playwright-core in ${PW_DIR}: ${String(error.message).split("\n")[0]}`); }
  try {
    const mod = await import(`${PW_DIR}/playwright/index.js`);
    return mod.chromium ? mod : (mod.default ?? mod);
  } catch (error) { tried.push(`playwright in ${PW_DIR}/playwright: ${String(error.message).split("\n")[0]}`); }
  missing("playwright", [...tried, "run scripts/setup-gates.sh, or set GROK_BOT_PLAYWRIGHT_DIR"]);
  return null;
}

/** Three seconds of a 440 Hz tone, which is the microphone for this run. */
async function makeMicWav(dir) {
  const wav = path.join(dir, "mic.wav");
  try {
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000", "-ac", "1", "-acodec", "pcm_s16le", wav], { timeout: 30_000 });
  } catch (error) {
    missing("ffmpeg", [`ffmpeg -f lavfi -i sine=... failed: ${String(error?.message ?? error).split("\n")[0]}`, "install ffmpeg, or set GATE_MIC_WAV to a 48 kHz mono 16-bit WAV file"]);
  }
  return wav;
}

async function legBrowser() {
  console.log(`verify-voice --leg browser on ${MACHINE}`);
  requireTheOtherItems(true);
  const cp = await startControlPlane();
  const { startStubRealtime } = await import(STUB_REALTIME);
  // The stub speaks the OpenAI event shape, accepts audio, emits one function call for the only tool
  // there is, and speaks whatever comes back as audio deltas.
  const stub = await startStubRealtime({ toolCall: { name: "titan", arguments: JSON.stringify({ message: "what is the team working on" }) } });
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });

  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-browser-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
  const wav = process.env.GATE_MIC_WAV ?? await makeMicWav(dir);

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 4,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const session = await signIn(relay);

  const { chromium } = await loadPlaywright();
  // THE FAKE DEVICE FLAGS, and the third one matters as much as the first two: Chromium's own switch
  // list warns that a fake audio file is mangled by the capture pipeline's processing, so the page
  // also asks for echoCancellation, noiseSuppression and autoGainControl off when it opens the
  // microphone. Without both halves the WAV arrives unusable and reads as a bad model.
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  cleanups.push(() => { try { browser.close(); } catch { /* gone */ } });
  const context = await browser.newContext({ userAgent: UA, permissions: ["microphone"] });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  step("the console, signed in, with the talk button on the composer");
  await page.goto(`${relay.base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="password"]', relay.password).catch(() => {});
  await page.press('input[type="password"]', "Enter").catch(() => {});
  // Never networkidle: the console holds an EventSource open for the whole session.
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => window.__voice !== undefined, null, { timeout: 30_000 }).catch(() => {});
  const hasVoice = await page.evaluate(() => window.__voice !== undefined);
  check(hasVoice, "ui/machine-room/voice.js published window.__voice", String(hasVoice));
  const button = page.locator('[data-voice-talk]');
  check(await button.count() > 0, "and the talk button is on the page", `${await button.count()} found`);
  check(await button.getAttribute("type") === "button", "carrying type=button, or it would submit the composer's form");

  step("press it, and watch the orb");
  const seen = await page.evaluate(() => {
    window.__voiceGateStates = [];
    const orb = document.querySelector("[data-voice-orb]");
    if (orb == null) return false;
    new MutationObserver(() => window.__voiceGateStates.push(orb.getAttribute("data-voice-orb")))
      .observe(orb, { attributes: true, attributeFilter: ["data-voice-orb"] });
    window.__voiceGateStates.push(orb.getAttribute("data-voice-orb"));
    return true;
  });
  check(seen, "the orb is on the page and being watched");
  const pressed = Date.now();
  await button.click();
  // Long enough for the whole round trip: the stub's function call, the relay's sendPrompt, a real
  // reply off the local box (measured 5.5 to 25 seconds there), and the audio back.
  await page.waitForFunction(() => (window.__voiceGateStates ?? []).includes("speaking"), null, { timeout: 120_000 })
    .catch(() => {});
  const states = await page.evaluate(() => window.__voiceGateStates ?? []);
  info(`orb states in order: ${states.join(" -> ")}`);
  for (const state of ["listening", "thinking", "speaking"]) {
    check(states.includes(state), `the orb showed ${state}`, states.join(" -> "));
  }

  step("what the vendor heard, and what the team was asked");
  check((stub.audioFrames ?? 0) > 0, "the microphone reached the vendor through the relay", `${stub.audioFrames ?? 0} frame(s)`);
  check((stub.toolCalls ?? []).length === 1, "and exactly one tool call was dispatched, once", JSON.stringify((stub.toolCalls ?? []).map((one) => one.name)));
  check((stub.toolOutputs ?? []).length >= 1, "with a result handed back as function_call_output", `${(stub.toolOutputs ?? []).length}`);
  const replied = String((stub.toolOutputs ?? [])[0]?.output ?? "");
  check(replied.length > 0, "carrying a real reply from the box rather than an empty string", `${replied.length} characters`);
  info(`the reply began: ${JSON.stringify(replied.slice(0, 120))}`);

  step("the mic was held shut while the reply was spoken, proved from BOTH sides");
  const stats = await page.evaluate(() => (window.__voice?.stats?.() ?? null));
  check(Number(stats?.heldFrames ?? 0) > 0, "the page dropped frames in the held window", JSON.stringify(stats));
  check((stub.appendsDuringPlayback ?? 0) === 0, "and nothing it did send reached the vendor during playback", String(stub.appendsDuringPlayback ?? 0));

  step("playback, and why there are no .played ranges to look at");
  // A DESIGN DECISION AND NOT A TEST DETAIL. Playback is Web Audio -- PCM16 deltas decoded into
  // AudioBuffers on a scheduler off the socket's onmessage path, because draining the player inline is
  // what froze omarchy's whole event loop, tool calls included, for the length of every spoken reply.
  // There is therefore no HTMLMediaElement and no .played TimeRanges. The evidence is the clock
  // advancing and real energy in the room.
  const playback = await page.evaluate(() => (window.__voice?.playback?.() ?? null));
  info("there are no .played TimeRanges here: playback is Web Audio, not an <audio> element. See docs/VOICE.md.");
  check(Number(playback?.currentTime ?? 0) > 0, "the audio clock advanced", JSON.stringify(playback));
  check(Number(playback?.rms ?? 0) > 0.001, "and an analyser heard real energy rather than a silent buffer", `rms ${playback?.rms}`);
  check(Number(playback?.bytesQueued ?? 0) > 0, "with bytes actually queued", String(playback?.bytesQueued));

  step("the spoken turn is an ordinary row in the one conversation, marked as spoken");
  const spoken = await page.evaluate(() => document.querySelectorAll("[data-spoken]").length);
  check(spoken > 0, "the transcript shows a spoken row with its chip", `${spoken} row(s)`);

  step("the hop ledger");
  const hops = await page.evaluate(() => (window.__voice?.hops?.() ?? null));
  if (hops == null) {
    fail("the page did not publish a hop ledger", "window.__voice.hops() answered nothing");
  } else {
    for (const [name, value] of Object.entries(hops)) info(`${name}: ${value} ms (${MACHINE})`);
    // THE FOUR HOPS THIS PRODUCT OWNS. T2->T3 is Titan's own thinking time and is REPORTED and never
    // asserted: measured on grok-bot-local-vm it is 5.5 to 25 seconds, 50.6 on a cold box, and the
    // host exposes no partial reply to make it shorter. What is ours is that the person hears
    // something during it.
    check(Number(hops.t1ToT2 ?? Infinity) <= 50, "the tool call reaches sendPrompt inside 50 ms", `${hops.t1ToT2} ms on ${MACHINE}`);
    check(Number(hops.t3Detection ?? Infinity) <= 450, "the reply is noticed inside 450 ms of its own timestamp at a 400 ms poll", `${hops.t3Detection} ms on ${MACHINE}`);
    check(Number(hops.t3ToT4 ?? Infinity) <= 20, "the first sentence goes back inside 20 ms", `${hops.t3ToT4} ms on ${MACHINE}`);
    check(Number(hops.t5ToT6 ?? Infinity) <= 120, "and the first sample is audible inside 120 ms of arriving", `${hops.t5ToT6} ms on ${MACHINE}`);
    info(`T2->T3, which is the team thinking and not ours: ${hops.t2ToT3} ms on ${MACHINE}`);
  }

  step("the ledger row, and the scratch agent this run made");
  const rows = (await asAdmin(cp, "GET", "/v1/voice/usage")).body?.tenants ?? [];
  check(rows.length > 0, "a row exists for this session", JSON.stringify(rows[0] ?? null));
  check(Number(rows[0]?.heldFrames ?? 0) > 0, "and the relay's own dropped-frame count is on it", String(rows[0]?.heldFrames));
  check(Number(rows[0]?.toolCalls ?? 0) >= 1, "with the turn it handed to the team", String(rows[0]?.toolCalls));
  info(`the gate picked its Titan as: ${String(await page.evaluate(() => window.__voice?.agentName?.() ?? "")) || "(the page did not say)"}`);
  check(pageErrors.length === 0, "and the page threw nothing", pageErrors.slice(0, 2).join(" | ") || "clean");
  // A roster that grows during a gate run is a bug, so whatever this leg created goes away. Item B's
  // page opens no agent of its own, so the only thing to clean is a scratch agent a future revision
  // of this leg creates; the check is here so it cannot be forgotten then.
  info("this leg creates no agent of its own: the spoken turn goes to the workspace's chosen first agent");
  return;
}

// ---- run one leg ---------------------------------------------------------------------------------

try {
  if (leg === "cp") await legControlPlane();
  else if (leg === "relay") await legRelay();
  else if (leg === "nokey") await legNoKey();
  else if (leg === "caps") await legCaps();
  else if (leg === "origin") await legOrigin();
  else if (leg === "browser") await legBrowser();
} catch (error) {
  failures += 1;
  console.log(`\n  FAIL  the leg threw: ${String(error?.stack ?? error).split("\n").slice(0, 4).join(" | ")}`);
} finally {
  onExit();
}

console.log(`\n--leg ${leg} on ${MACHINE}: ${checks - failures} of ${checks} checks passed`);
console.log(failures === 0 ? `PASS  verify-voice --leg ${leg}  (${MACHINE})` : `FAIL  verify-voice --leg ${leg}  (${failures} of ${checks} on ${MACHINE})`);
process.exit(failures === 0 ? 0 : 1);
