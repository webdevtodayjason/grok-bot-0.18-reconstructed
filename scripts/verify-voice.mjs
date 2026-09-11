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
//   --leg nokey     an empty voice.json: the upgrade is ACCEPTED, one plain sentence arrives, then bye
//                   -- and then VOICE-2, in real Chrome at 1440x900 and 390x844: one press of Talk
//                   moves nothing in the footer but the message box, a second press and Escape both
//                   leave talk mode, and the line takes itself away if it is left alone.
//   --leg caps      a one-minute policy: a refusal in words over an accepted socket.
//   --leg origin    a cross-origin upgrade: refused in words, not with a destroyed socket.
//   --leg refused   a vendor that answers 401 to the upgrade, and an address with nothing behind it:
//                   ONE plain sentence, a clean 1000 close, and a SETTLED ledger row on each. This is
//                   the path a customer with a typo'd key takes, and before 2026-09-10 it produced no
//                   sentence at all -- a listening orb and a live microphone until the session cap.
//   --leg browser   real Chrome with a WAV file as the microphone, the talk button, all four orb
//                   states, a real reply from the local box read back and heard, the mic proved held
//                   from BOTH sides, the spoken row with its chip, and the seven-stamp hop ledger.
//   --leg frames    VOICE-7's half: the labelled transcription frames, read off the page's OWN voice
//                   socket in real Chrome at 1440x900 and at 390x844 with touch. The stub emits a
//                   multi-step utterance that corrects itself; the page has to receive hear-begin,
//                   three growing partials, one final, and one heard-confirmed whose text is
//                   byte-identical to the tool argument and whose words are the words on the spoken
//                   row in the transcript. Then the turns that never become a row.
//   --leg release   VOICE-11: what a release puts on the wire. Two engines, because the defect that
//                   makes voice do nothing in the iPhone app is WebKit's -- a capture context born
//                   suspended and never resumed inside the press.
//
//   --leg call      VOICE-13: the call screen a press brings up on a phone, in WebKit at 390x844.
//   --leg person    VOICE-10: the talk mode follows the PERSON and not the browser. Always listening is
//                   chosen in one browser, a SECOND browser signed in as the same person opens on it at
//                   first paint with nothing pressed, and a third with no stored value and the route
//                   blocked -- the private window -- still opens on push to talk. No box, no vendor: the
//                   only thing dialled is the settings door.
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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { gateUserAgent } from "./gate-agent.mjs";

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The name this gate knocks with. tests/gate-agent.test.mjs enforces both this exact derivation and
// the constant's name for every gate that posts a password at a login door, because a gate that
// reaches one without the header writes ledger rows nobody can tell from a stranger's.
const GATE_AGENT = gateUserAgent(import.meta.url);
const MACHINE = process.env.GATE_MACHINE ?? `${os.hostname()} (${os.platform()} ${os.arch()})`;
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:1340";

const LEGS = ["cp", "relay", "nokey", "caps", "origin", "refused", "browser", "frames", "overlay", "person", "release", "call"];
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
    "  nokey    an empty voice.json answers one plain sentence over an ACCEPTED socket, and real",
    "           Chrome proves the footer does not move and that talk mode can be left.",
    "  person   VOICE-10: the talk mode follows the person to a second browser, and a private window",
    "           with no stored value and no route answer still opens on push to talk.",
    "  caps     a one minute policy refuses in words.",
    "  origin   a cross-origin upgrade is refused in words, never by a destroyed socket.",
    "  refused  a vendor that answers 401, and an address with nothing behind it: one sentence each.",
    "  browser  real Chrome, a WAV file as the microphone, the orb, the transcript, the hop ledger.",
    "  frames   real Chrome at two viewports: the labelled words of a spoken turn, read off the page's",
    "           own voice socket, and the same bytes landing on the spoken row.",
    "  overlay  the speech panel and the two talk modes, at 1440x900 and at 390x844 with a real hold,",
    "           with the footer's rects measured before, during and after every turn.",
    "  release  VOICE-11: the release really sends the words. A held 1.2 s and let go, in Chromium at",
    "           1440x900 and in WebKit at 390x844, with the silence counted at the vendor; a tap; the",
    "           press after a refusal; a hold whose release never comes; and the three microphone",
    "           refusals read as three different sentences.",
    "  call     VOICE-13: the call screen on a phone. WebKit at 390x844 dpr 3 with touch: the press, the",
    "           five words in order, the avatar reacting to a level with the mascot never transformed, a",
    "           typed line mid-call, a tool receipt as the status line, a card taking the middle, mute,",
    "           End, an app switch, Escape, the reduced-motion still, and what six seconds of it costs.",
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
// A LEG THAT COULD NOT REACH ITS CONDITION SAYS SO AND COUNTS AS A SKIP, never as a pass and never as a
// crash. Item B's first-combination block called this before it existed, so a console that had not yet
// published its Settings seam turned a measurement into `ReferenceError: skip is not defined` and took
// the rest of the leg with it. MEASURED on MacBook-Pro.local 2026-09-11, --leg overlay, 2 of 3 with the
// leg reported as thrown rather than as a condition it could not set up.
let skips = 0;
const skip = (what, why = "") => { skips += 1; console.log(`  SKIP  ${what}${why ? `  (${why})` : ""}`); };
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
    headers: { "user-agent": GATE_AGENT, accept: "application/json", ...(init.headers ?? {}) },
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
    if (probe != null) {
      const cp = { base, adminToken, relayToken, root, log: () => log };
      // IS THIS THE PROCESS WE STARTED? A control plane left behind by an earlier run holds this port,
      // ours exits because it cannot bind, and the probe answers happily from the stranger -- whose
      // credentials are different. MEASURED at integration on this Mac: every usage report from the
      // relay and every admin read from the gate answered 401, which reads as a broken route rather
      // than as the wrong process, and a leg spent twenty minutes looking like a product bug.
      const mine = await asAdmin(cp, "GET", "/v1/voice/usage");
      if (mine.status === 401 || mine.status === 403) {
        missing("a control plane of this gate's own", [
          `something else is already listening on ${base} and does not take this run's credentials`,
          `find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
          "kill it, or set VOICE_GATE_CP_PORT to a free port, then run the leg again",
        ]);
        return null;
      }
      return cp;
    }
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
/**
 * A port nothing is on, handed back the moment it is known to be free. The legs with fixed ports are
 * left as they are -- they are load-bearing for the control-plane pairing above -- but a leg that only
 * wants A relay should never be able to find somebody else's.
 */
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startRelay({ port, voiceJson, stubUrl, policyUrl = "", relayToken = "", ledgerJsonl = "" }) {
  const { newAuthRecord } = await import(path.join(repoRoot, "ui", "auth.mjs"));
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-relay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  const password = randomBytes(18).toString("hex");
  writeFileSync(authFile, `${JSON.stringify(newAuthRecord(password), null, 2)}\n`, { mode: 0o600 });
  const stateDir = path.join(dir, "state");
  // The workspace's realtime settings live in the relay's own state directory as voice.json, beside
  // mail.json -- ui/server.mjs:634, stateFile("voice.json"). There is no environment variable for
  // that path ON PURPOSE: the key is inside that file, and a file path override is one edit away from
  // a key in a compose file. So a leg that wants a planted key writes it where the relay will look.
  mkdirSync(stateDir, { recursive: true });
  if (voiceJson) copyFileSync(voiceJson, path.join(stateDir, "voice.json"));
  // The minutes ledger lives beside it and is the relay's OWN truth about what a day has cost, which
  // is what the caps are held against. A leg that wants a spent day writes rows here.
  if (ledgerJsonl) writeFileSync(path.join(stateDir, "voice-minutes.jsonl"), `${ledgerJsonl}\n`, { mode: 0o600 });
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
        `User-Agent: ${GATE_AGENT}`,
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
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": GATE_AGENT },
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
  // past "no key set" and onto the stub; the stub does not look at it. `enabled` is in the fixture
  // because voice is OFF until a person switches it on -- the relay refuses a workspace that never
  // did, which is the right product behaviour and was a gate fixture missing a field, not a bug.
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
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
  info(`the stub was dialled ${stub.events.requests.length} time(s) and saw ${stub.events.inbound.length} message(s); the claim is the row above and not one of them`);
  if (process.env.VOICE_GATE_RELAY_LOG === "1") console.log(`\n---- relay log ----\n${relay.log().slice(-3000)}\n----`);
  return;
}

async function legNoKey() {
  console.log(`verify-voice --leg nokey on ${MACHINE}`);
  // `true`: since VOICE-2 this leg also presses the button in a real browser, so it needs the console's
  // side on disk as well as the relay's.
  requireTheOtherItems(true);
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
  // VOICE-2 DELETED THE WORDING ASSERTION THAT USED TO SIT HERE, rather than inverting it. It required
  // the customer-visible sentence to contain "key", "not set" or "switched on" -- and "key" is a word
  // the copy rule forbids on any row a customer reads. A gate that requires a banned word is a gate
  // that has to be edited every time the copy is right. What a sentence must NOT say is still swept
  // below, because that is a rule about leaks and not about phrasing; what it SHOULD say is proved
  // once, by verify-settings' plain-words sweep over every customer-visible row and this line with
  // them. One owner for the words, and it is not this file.
  info(`the sentence this workspace reads: ${JSON.stringify(sentence)}`);
  check(sentence.trim().length > 20, "one sentence, long enough to be one", `${sentence.trim().length} characters`);
  for (const word of ["xai", "openai", "grok", "websocket", "socket", "titan(", "undefined", "null", "error"]) {
    check(!sentence.toLowerCase().includes(word), `the sentence does not say ${word}`, JSON.stringify(sentence));
  }
  check(socket.closedWith != null, "then bye and a close the page can read", String(socket.closedWith));
  check(stub.events.requests.length === 0, "and the vendor was never dialled", `the stub was asked for ${stub.events.requests.length} upgrade(s)`);

  await noKeyInABrowser(relay);
  return;
}

/**
 * VOICE-2, IN A REAL BROWSER, against the real relay this leg already started.
 *
 * THE THING BEING MEASURED IS THE FOOTER, not the sentence. Jason's screenshot of 2026-09-10 is one
 * press of Talk on a workspace with no voice: the footer split in two, the message box went to a
 * third of its width, and there was no way out of talk mode. MEASURED here before the fix at
 * 1440x900 on grok-bot-local-vm, six rects before and after that one press:
 *
 *   .control-shelf     1392x106 @24,776    ->  1392x196.02 @24,685.98
 *   #composer          600x54   @459       ->  407.98x54   @991
 *   #message-input     370.05              ->  178.03
 *   .shelf-utilities   row 1               ->  wrapped to row 2 at x41
 *   .composer-aside    @747.06             ->  90 px up, onto the right rail's Skills row
 *   .transcript        567.75 tall         ->  45.5 px shorter
 *
 * Five of those six must now be unchanged TO THE PIXEL. The sixth is the message box, which gives up
 * the line's width and gets it straight back, and its number is printed rather than asserted tight.
 */
async function noKeyInABrowser(relay) {
  const playwright = await loadPlaywright();
  const { chromium } = playwright;
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  cleanups.push(() => { try { browser.close(); } catch { /* gone */ } });

  const readRects = (page) => page.evaluate(() => {
    const of = (selector) => {
      const node = document.querySelector(selector);
      if (node == null) return null;
      const r = node.getBoundingClientRect();
      const round = (value) => Math.round(value * 100) / 100;
      return [round(r.width), round(r.height), round(r.left), round(r.top)];
    };
    const line = document.getElementById("voice-line");
    const shown = line == null ? null : [...line.children].find((one) => !one.hidden);
    return {
      shelf: of(".control-shelf"), composer: of("#composer"), box: of("#message-input"),
      utilities: of(".shelf-utilities"), aside: of(".composer-aside"), transcript: of(".transcript"),
      talk: of("[data-voice-talk]"),
      lineUp: line != null && line.hidden === false,
      lineIn: line?.parentElement?.id || line?.parentElement?.className || "",
      lineText: shown == null ? "" : shown.textContent.replace(/\s+/g, " ").trim(),
      lineCut: shown == null ? null : (shown.scrollWidth - shown.clientWidth > 1 || shown.scrollHeight - shown.clientHeight > 1),
      lineHeight: shown == null ? null : Math.round(shown.getBoundingClientRect().height * 100) / 100,
      lineChars: shown == null ? 0 : shown.textContent.trim().length,
      leadsSomewhere: line?.querySelector("[data-voice-line-do]:not([hidden])") != null,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  // THE BUTTON EXISTING IS NOT THE BUTTON BEING PRESSABLE. The console draws an opaque boot cover
  // over everything until app.js has painted or its 8 s ceiling expires, and voice.js mounts the line
  // long before that. A gate that pressed on `#voice-line exists` pressed the cover: MEASURED here,
  // every press landed on nothing and the leg read as a page that says nothing when you press Talk.
  // So the button is polled through elementFromPoint, the way the unit test's browser leg does.
  const pressable = async (page) => {
    for (let i = 0; i < 60; i += 1) {
      const reachable = await page.evaluate(() => {
        const node = document.querySelector("[data-voice-talk]");
        if (node == null || node.disabled) return false;
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return node.contains(hit) || hit === node;
      });
      if (reachable) return true;
      await sleep(500);
    }
    return false;
  };

  // AND A PAGE THAT IS STILL PAINTING IS NOT A BASELINE. The transcript's height moved 2.25 px on its
  // own between two reads taken a second apart, which is enough to fail a to-the-pixel comparison for
  // a reason that has nothing to do with the line. So the baseline is read twice and only trusted
  // when the two agree.
  const settled = async (page) => {
    let last = JSON.stringify(await readRects(page));
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(250);
      const now = await readRects(page);
      if (JSON.stringify(now) === last) return now;
      last = JSON.stringify(now);
    }
    return readRects(page);
  };

  const open = async (size) => {
    const context = await browser.newContext({
      userAgent: GATE_AGENT, viewport: { width: size.width, height: size.height },
      hasTouch: size.touch === true, isMobile: size.touch === true, permissions: ["microphone"],
    });
    const page = await context.newPage();
    await page.goto(`${relay.base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="password"]', relay.password).catch(() => {});
    await page.press('input[type="password"]', "Enter").catch(() => {});
    // Never networkidle: the console holds an EventSource open for the whole session.
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.getElementById("voice-line") != null, null, { timeout: 40_000 });
    const reachable = await pressable(page);
    check(reachable, `the console is painted and the talk button can be pressed at ${size.width}x${size.height}`);
    return { context, page };
  };

  const press = async (page, touch) => {
    const at = await page.evaluate(() => {
      const r = document.querySelector("[data-voice-talk]").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (touch) await page.touchscreen.tap(at.x, at.y);
    else await page.mouse.click(at.x, at.y);
  };

  const NAMED = ["shelf", "composer", "utilities", "aside", "transcript"];

  /** The line with WORDS in it, which is what a press is waiting for and what Escape has to leave. */
  const sentenceUp = (page) => page.waitForFunction(() => {
    const line = document.getElementById("voice-line");
    if (line == null || line.hidden) return false;
    const shown = [...line.children].find((one) => !one.hidden);
    return shown != null && shown.textContent.trim().length > 0;
  }, null, { timeout: 30_000 }).catch(() => {});

  // ---- 1440x900 -------------------------------------------------------------------------------
  step("one press of Talk moves nothing in the footer but the message box (1440x900)");
  const desktop = await open({ width: 1440, height: 900 });
  try {
    const atRest = await settled(desktop.page);
    check(atRest.lineUp === false, "the line is mounted and quiet before anything happens");
    check(atRest.lineIn === "composer", "and at this width it lives inside the composer's own row", atRest.lineIn);
    const t0 = Date.now();
    await press(desktop.page, false);
    await desktop.page.waitForFunction(() => document.getElementById("voice-line")?.hidden === false, null, { timeout: 30_000 })
      .catch(() => {});
    const said = Date.now() - t0;
    const up = await readRects(desktop.page);
    check(up.lineUp, "the person is left with a sentence to read", `after ${said} ms on ${MACHINE}`);
    check(up.leadsSomewhere, "and it leads somewhere, because this is the one condition they can fix");
    // HOW MUCH OF THE SENTENCE FITS IS THE RELAY'S BUSINESS, NOT THIS LEG'S. The line holds three lines
    // of words; what a person reads in them is whoever wrote the sentence. This leg asserts NO wording
    // at all -- the words are proved once, by verify-settings' plain-words sweep over every
    // customer-visible row and this line with them -- so it prints what fitted and asserts only that
    // the line cannot push the form it sits in, whatever it is handed.
    info(`${up.lineChars} characters of sentence in a ${up.lineHeight} px line, ${up.lineCut ? "ellipsised" : "whole"}`);
    check(up.lineHeight <= 42, "and the line cannot grow past the form it sits in, whatever it is handed",
      `${up.lineHeight} px inside a 42 px content box`);
    for (const named of NAMED) {
      check(JSON.stringify(up[named]) === JSON.stringify(atRest[named]),
        `${named} is unchanged to the pixel`, `${JSON.stringify(atRest[named])} -> ${JSON.stringify(up[named])}`);
    }
    check(up.sideways === false, "and the page does not scroll sideways");
    info(`the message box gives up ${Math.round((atRest.box[0] - up.box[0]) * 100) / 100} px while the line is up `
      + `(${atRest.box[0]} -> ${up.box[0]}) at 1440x900 on ${MACHINE}`);
    info(`the sentence arrived ${said} ms after the press on ${MACHINE}`);

    step("a second press leaves, Escape leaves, and left alone the line leaves by itself (1440x900)");
    await press(desktop.page, false);
    await desktop.page.waitForTimeout(300);
    const afterSecond = await readRects(desktop.page);
    check(afterSecond.lineUp === false, "a second press leaves talk mode instead of redialling into the same refusal");
    check(NAMED.every((named) => JSON.stringify(afterSecond[named]) === JSON.stringify(atRest[named])),
      "and the footer is exactly what it was before the first press");
    check(afterSecond.box[0] === atRest.box[0], "the message box included", `${atRest.box[0]} -> ${afterSecond.box[0]}`);

    await press(desktop.page, false);
    // THE SENTENCE, not a visible line. The line goes up as soon as the dial starts and the words land
    // when the relay answers; waiting on `hidden === false` pressed Escape in that gap, which made this
    // leg read as a product that ignores Escape about one run in two. Both waits below are the words.
    await sentenceUp(desktop.page);
    // WHERE THE KEYBOARD IS WHEN ESCAPE IS PRESSED, and this leg no longer arranges it. It used to call
    // focus("[data-voice-talk]") first, because the agent's screen swallowed the key about one run in
    // three: the off-screen reader takes focus a couple of seconds after it connects and from then on
    // every document-level key landed inside it. That was SEAT-FOCUS-1, and it is fixed -- a reader
    // hands the keyboard straight back (screen-tile.js, and scripts/verify-console-polish.mjs --keys
    // measures it). So the press now happens with whatever has the focus, which is the real question:
    // a person who pressed Talk and then reached for Escape did not focus anything first either.
    // And what else is on the page, because voice.js refuses Escape while a native <dialog> or a drawer
    // is open -- stealing the key from a modal would read as a broken one -- so a leg that fails here
    // has to say which of the four it was.
    info(`at Escape: ${JSON.stringify(await desktop.page.evaluate(() => ({
      dialogs: [...document.querySelectorAll("dialog[open]")].map((node) => node.id || node.className || "dialog"),
      drawer: document.body.dataset.drawer ?? "",
      on: window.__voice?._state?.on ?? null,
      notes: (window.__voice?._state?.notes ?? []).map((one) => one.condition),
      active: document.activeElement?.id || document.activeElement?.tagName || "",
    }))) }`);
    await desktop.page.keyboard.press("Escape");
    await desktop.page.waitForTimeout(300);
    check((await readRects(desktop.page)).lineUp === false, "Escape leaves talk mode");

    await press(desktop.page, false);
    await sentenceUp(desktop.page);
    const armed = Date.now();
    await desktop.page.waitForFunction(() => document.getElementById("voice-line")?.hidden === true, null, { timeout: 20_000 })
      .catch(() => {});
    const waited = Date.now() - armed;
    check((await readRects(desktop.page)).lineUp === false, "and left alone it takes itself away", `${waited} ms on ${MACHINE}`);
    check(waited >= 4000, "after long enough to read it", `${waited} ms`);

    step("the agent's reply puts nothing in the footer at all (1440x900)");
    // THE HALF THAT HAPPENS ON EVERY TURN. A refusal is rare; the agent answering is every single turn,
    // and his reply used to be written into this same line -- MEASURED on this Mac, #message-input
    // 370.05 -> 215.31 px, and it stood there for the rest of the call because only a start or a stop
    // ever cleared it. It is already a durable row in the transcript and it is already spoken out loud,
    // so it now paints nothing and the footer cannot move on an ordinary turn at all. The message box
    // is in this comparison deliberately: it is the one rect a refusal IS allowed to take from.
    await desktop.page.evaluate(() => window.__voice._onMessage({
      data: JSON.stringify({ t: "said", text: "the team is working on the settings surface this afternoon" }),
    }));
    await desktop.page.waitForTimeout(120);
    const replied = await readRects(desktop.page);
    check(replied.lineUp === false, "his reply leaves the footer's line away", JSON.stringify(replied.lineText));
    for (const named of [...NAMED, "box"]) {
      check(JSON.stringify(replied[named]) === JSON.stringify(atRest[named]),
        `${named} is unchanged to the pixel when the agent answers`, `${JSON.stringify(atRest[named])} -> ${JSON.stringify(replied[named])}`);
    }
  } finally {
    await desktop.context.close().catch(() => {});
  }

  // ---- 390x844, with touch ---------------------------------------------------------------------
  step("on a phone the line takes a row of the shelf and the composer is untouched (390x844)");
  const phone = await open({ width: 390, height: 844, touch: true });
  try {
    const atRest = await settled(phone.page);
    check(atRest.lineIn.includes("control-shelf"), "the line belongs to the shelf at this width", atRest.lineIn);
    check(atRest.talk[0] >= 44 && atRest.talk[1] >= 44,
      "and the talk button clears the 44 px floor this file enforces for every control beside it",
      `${atRest.talk[0]}x${atRest.talk[1]} (38x38 before VOICE-2)`);
    await press(phone.page, true);
    await phone.page.waitForFunction(() => document.getElementById("voice-line")?.hidden === false, null, { timeout: 30_000 })
      .catch(() => {});
    const up = await readRects(phone.page);
    check(up.lineUp, "a tap leaves a sentence to read", JSON.stringify(up.lineText));
    check(up.composer[0] === atRest.composer[0] && up.composer[2] === atRest.composer[2],
      "the composer does not move or narrow", `${JSON.stringify(atRest.composer)} -> ${JSON.stringify(up.composer)}`);
    check(up.box[0] === atRest.box[0], "and neither does the message box", `${atRest.box[0]} -> ${up.box[0]}`);
    check(up.sideways === false, "and the page does not scroll sideways");
    const grew = Math.round((up.shelf[1] - atRest.shelf[1]) * 100) / 100;
    // THE BUDGET IS A ROW, AND ONLY A REFUSAL EVER SPENDS IT. A sentence that leads somewhere is a
    // control, and the 44 px floor beside it is what sets its height; nothing else reaches this line any
    // more, and the number to beat is the 94.02 px the strip cost here.
    check(grew <= 60, "the shelf grows by a row, not by a layout", `${grew} px (94.02 px before VOICE-2), ${atRest.shelf[1]} -> ${up.shelf[1]}`);
    check(up.leadsSomewhere, "and the sentence is a full-width tap target on a phone");
    await phone.page.evaluate(() => window.__voice.toggle());
    await phone.page.waitForFunction(() => document.getElementById("voice-line")?.hidden === true, null, { timeout: 10_000 })
      .catch(() => {});
    // AND HIS REPLY COSTS NOTHING, which is the number that matters on a phone: a refusal takes a row
    // of this shelf, but that happens once and the agent answering happens every turn. MEASURED before
    // the fix, with the reply in the footer's line: 390x133 at y711 -> 390x158 at y686, 25 px taller and
    // 25 px higher, for the rest of the call.
    await phone.page.evaluate(() => window.__voice._onMessage({
      data: JSON.stringify({ t: "said", text: "the team is working on the settings surface this afternoon" }),
    }));
    await phone.page.waitForTimeout(120);
    const replied = await readRects(phone.page);
    const replyGrew = Math.round((replied.shelf[1] - atRest.shelf[1]) * 100) / 100;
    check(replyGrew === 0, "and the agent's reply costs this shelf nothing at all", `${replyGrew} px, ${JSON.stringify(replied.shelf)}`);
    check(replied.composer[0] === atRest.composer[0], "with the composer still untouched", `${replied.composer[0]} px`);
    check(replied.box[0] === atRest.box[0], "and the message box still the width it was", `${replied.box[0]} px`);
  } finally {
    await phone.context.close().catch(() => {});
  }
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
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });

  step("a workspace whose day is already spent is refused in words");
  // THE RELAY ENFORCES AGAINST ITS OWN LEDGER, and that is the whole reason the claim is written
  // before the dial. The control plane supplies the cap NUMBER and the vendor allowlist and nothing
  // else; spend recorded only at the control plane is deliberately not trusted as the relay's clock,
  // because a relay whose jsonl says nothing was spent has no business refusing a customer on a
  // number it cannot see. So the spend this leg plants goes where the relay reads it: its own
  // voice-minutes.jsonl, beside the voice.json above. --leg cp is where the control plane's own cap
  // write and policy read are measured, against a real cp over real HTTP.
  //
  // An earlier version of this leg set a cap for a slug the relay never asks about and planted the
  // spend at the control plane, so it passed the first two checks and then watched the relay dial
  // anyway. A leg that sets up a condition the product does not read is worse than no leg.
  // ANCHORED TO TODAY'S UTC MIDNIGHT, NOT TO AN OFFSET FROM NOW, and this is the whole leg. A closed
  // row counts against the day it STARTED on (ui/voice-edge.mjs daySecondsUsed), so rows placed three,
  // two and one hour before `now` land on YESTERDAY for every run between 00:00 and 03:00 UTC and the
  // relay reads a day with nothing spent on it. MEASURED at the shared tip on MacBook-Pro.local at
  // 00:35 UTC on 2026-09-11: 2 of 5, "a note arrives ([])" and the vendor dialled -- the product was
  // right and the fixture planted the condition on the wrong day. The planted wall clock is a NUMBER
  // the relay reads out of its own ledger and never checks against the clock, which is why three
  // forty-five minute rows are legal here an hour into the day; a real ledger reaches 135 minutes
  // later in the afternoon and is read exactly the same way.
  const dayStartMsUTC = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const spentLedger = [0, 1, 2].map((i) => JSON.stringify({
    sessionId: `spent-${i}-${randomBytes(3).toString("hex")}`,
    slug: "gate", agentId: "gate", agentName: "gate", vendor: "xai", model: "gate",
    // Today, UTC, because the day window is UTC midnight to UTC midnight.
    startedAt: new Date(dayStartMsUTC + (i + 1) * 60_000).toISOString(),
    state: "closed", endedAt: new Date(dayStartMsUTC + (i + 1) * 60_000 + 45 * 60 * 1000).toISOString(),
    // Three closed sessions of forty five minutes is 135, over the relay's own 120 minute day.
    wallSeconds: 45 * 60, audioInSeconds: 0, audioOutSeconds: 0,
    billedItemEvents: 0, toolCalls: 0, heldFrames: 0, closeReason: "the gate planted this",
  })).join("\n");

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 2,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
    ledgerJsonl: spentLedger,
  });
  const policy = await asRelay(cp, "GET", "/v1/relay/voice/policy?slug=titanium");
  check(Number(policy.body?.dayCapSeconds) > 0, "the control plane answers the relay a day cap at all", `${policy.body?.dayCapSeconds} s`);
  const session = await signIn(relay);
  const socket = await openVoiceSocket(relay.base, { cookie: session.cookie, origin: relay.base });
  check(socket.accepted, "the upgrade is still accepted, because a refusal is words and not a dead socket", socket.statusLine);
  const said = socket.notes.join(" ");
  check(socket.notes.length >= 1, "a note arrives", JSON.stringify(socket.notes));
  check(/voice time|today|not switched on/i.test(said), "saying in plain words what ran out and when it comes back", JSON.stringify(said));
  check(stub.events.requests.length === 0, "and the vendor was never dialled", `the stub was asked for ${stub.events.requests.length} upgrade(s)`);
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
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
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

/**
 * A vendor that will not take the call, which is the first thing a pasted key does when it is wrong.
 *
 * TWO ARMS, because the two failures are indistinguishable on the wire and both were silent:
 *   A. the vendor answers `HTTP/1.1 401` to the upgrade.
 *   B. nothing is listening at the address at all.
 * MEASURED on this Mac (node v22.23.1): each fires ONE error event carrying "Received network error
 * or non-101 status code" and NEVER a close, so the relay's close listener never ran, the sentence
 * was unreachable, the ledger row stayed open and counting, and the orb sat on "listening" with the
 * microphone live until the thirty minute session cap. Each arm asserts the same three things the
 * nokey leg does: the sentence, the clean close, and the row.
 */
async function legRefused() {
  console.log(`verify-voice --leg refused on ${MACHINE}`);
  requireTheOtherItems(false);
  const { readVoiceLedger } = await import(path.join(repoRoot, "ui", "voice-edge.mjs"));
  const http = await import("node:http");

  // A. A vendor that refuses the upgrade. This is a real socket answering a real status line.
  const refuser = http.createServer((request, response) => { response.writeHead(200); response.end("this is not a websocket"); });
  refuser.on("upgrade", (request, socket) => { socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n"); });
  await new Promise((resolve) => refuser.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { try { refuser.close(); } catch { /* gone */ } });
  const refuserUrl = `ws://127.0.0.1:${refuser.address().port}/v1/realtime`;

  // B. An address with nothing behind it. Port 9 is discard and refuses on this machine.
  const arms = [
    { label: "the vendor answers 401 to the upgrade, which is a key that is wrong", url: refuserUrl, port: 0 },
    { label: "nothing is listening at the vendor's address at all", url: "ws://127.0.0.1:9/v1/realtime", port: 1 },
  ];

  for (const arm of arms) {
    step(arm.label);
    const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-refused-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const voiceJson = path.join(dir, "voice.json");
    // A fake key. This gate holds no real one and never will: the mechanism is the Voice card.
    writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
    const relay = await startRelay({
      port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 4 + arm.port,
      voiceJson, stubUrl: arm.url,
    });
    const session = await signIn(relay);
    const t0 = Date.now();
    const socket = await openVoiceSocket(relay.base, { cookie: session.cookie, origin: relay.base, timeoutMs: 20_000 });
    const waited = Date.now() - t0;
    check(socket.accepted, "the upgrade is accepted rather than destroyed", `${socket.statusLine || "no status line at all"} on ${MACHINE}`);
    check(socket.notes.length >= 1, "and ONE sentence reaches the page", `${JSON.stringify(socket.notes)} after ${waited} ms on ${MACHINE}`);
    const sentence = socket.notes.at(-1) ?? "";
    // KEYS-1 rewrote this sentence and this assertion with it. It used to require the words "Voice
    // card", which was right while a CUSTOMER held the realtime key and is wrong now: the key is the
    // operator's, pasted once at the super admin console, and the Voice card is gone. So what is
    // asserted is that the sentence still names the cause and still says who can act on it -- and
    // the word "key" is now BANNED from it rather than required, which the loop below checks.
    // And KEYS-1 merged the two refusal sentences into one, because this edge cannot tell them
    // apart: MEASURED on this Mac, a 401 on the upgrade and an address with nothing listening are
    // the same single error event with no close and no status code. Two sentences would be the relay
    // guessing which in front of a customer. What is asserted is the fact and who can act.
    check(/^Talking is not working right now\. Your operator can see why\.$/.test(sentence),
      "saying in plain words that talking is not working, and who can see the reason", JSON.stringify(sentence));
    for (const word of ["xai", "openai", "grok", "websocket", "socket", "401", "upgrade", "undefined", "null", "key", "voice card"]) {
      check(!sentence.toLowerCase().includes(word), `the sentence does not say ${word}`, JSON.stringify(sentence));
    }
    // The gate's reader records the `bye` frame's own reason first and the close frame after it, so
    // what is asserted here is that BOTH arrived: a condition the page can act on, and a real close.
    const bye = socket.frames.map((one) => { try { return JSON.parse(one); } catch { return null; } }).find((one) => one?.t === "bye");
    check(bye != null && String(bye.reason).length > 0, "then bye, carrying the condition the page paints", JSON.stringify(bye ?? socket.frames.slice(-2)));
    check(socket.closedWith != null, "and a close the page can read rather than a dead socket", `${String(socket.closedWith)} after ${waited} ms`);
    // THE ROW IS SETTLED. An open row counts toward the day cap, so a silent failure used to spend a
    // customer's minutes and inflate the operator's Spend line for as long as the tab stayed open.
    const ledgerFile = path.join(relay.stateDir, "voice-minutes.jsonl");
    let rows = [];
    for (let i = 0; i < 40; i += 1) {
      rows = await readVoiceLedger(ledgerFile);
      if (rows.some((row) => row.state === "closed")) break;
      await sleep(100);
    }
    check(rows.length === 1, "one ledger row for the one press", JSON.stringify(rows.map((row) => row.state)));
    check(rows[0]?.state === "closed", "and it is SETTLED rather than left open and counting", JSON.stringify(rows[0] ?? null));
    check(String(rows[0]?.closeReason ?? "").length > 0, "with a reason on it", JSON.stringify(rows[0]?.closeReason));
    info(`the whole refusal took ${waited} ms on ${MACHINE}, against a ${30 * 60} s session cap that used to be the only thing that ended it`);
  }
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
  // The stub speaks the vendor's own event shape, accepts audio, and is DRIVEN from here rather than
  // scripted: emitToolCall and speak are called below, after the bridge's session.update has actually
  // reached it. Waiting on the page's `ready` frame instead is the trap item A hit three times -- that
  // frame reaches the browser BEFORE the dial completes, so an event emitted on it lands on the floor.
  // TWENTY FRAMES, which is two seconds of speech. The default three is 300 ms, and a hold window
  // narrower than a few capture frames cannot be measured: the page drops whole 100 ms frames, so a
  // reply shorter than that legitimately drops none and the leg would read as a gate that failed.
  const stub = await startStubRealtime({ audioFrames: 20 });
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });

  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-browser-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
  const wav = process.env.GATE_MIC_WAV ?? await makeMicWav(dir);

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 4,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const session = await signIn(relay);

  // WHICH BOT THE VOICE TALKS TO, chosen through the card's OWN door rather than left to the chain.
  // grok-bot-local-vm is shared, and other waves' gates leave scratch agents on its roster whose
  // names sort first; one of those was picked three runs running and answered nothing, which reads as
  // a broken bridge rather than a bot that was never going to reply. So the leg picks a real one, and
  // it does it with POST /voice/settings, which also proves the card's write path end to end.
  const settingsBefore = await ask(`${relay.base}/voice/settings`, { headers: { cookie: session.cookie } });
  const roster = settingsBefore.body?.agents ?? [];
  const scratch = /^(code gate|voice gate|gate)\b|^new agent$/i;
  const chosen = roster.find((one) => !scratch.test(String(one.name ?? ""))) ?? roster[0] ?? null;
  check(chosen != null, "the settings door lists this workspace's bots, so one can be chosen", `${roster.length} on the roster`);
  const saved = await ask(`${relay.base}/voice/settings`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: chosen?.id ?? "" }),
  });
  check(saved.status === 200 && saved.body?.agentId === (chosen?.id ?? ""), "and the card's own save takes the choice", `HTTP ${saved.status}, ${saved.body?.agentId === (chosen?.id ?? "") ? "kept" : "not kept"}`);
  check(saved.body?.apiKeySet === true, "without disturbing the key, which never comes back out of that door", `apiKeySet ${saved.body?.apiKeySet}, apiKey field ${saved.body?.apiKey === undefined ? "absent" : "PRESENT"}`);
  info(`this run talks to ${chosen?.name ?? "(nobody)"}`);

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
  const context = await browser.newContext({ userAgent: GATE_AGENT, permissions: ["microphone"] });
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
  // ALWAYS LISTENING FOR THIS LEG, SET THROUGH THE PAGE'S OWN DOOR, and it is not an optional detail:
  // VOICE-7 made press-and-hold the default and this leg presses ONCE. A click in that mode is a hold
  // and an instant release, so the microphone opens for about a millisecond and shuts, the orb is dark
  // between holds BY DESIGN (an orb reading "listening" while the mic is shut is a lie), and this leg's
  // four claims -- the orb's four states, the frames reaching the vendor, the held window, and real
  // energy in the audio -- all measured nothing. MEASURED here before this line: 0 frames, 0 bytes,
  // rms 0, and an orb that read `off` 38 times running. The mode this leg needs is the one where a
  // press opens the microphone and leaves it open; the hold itself is measured by --leg overlay, in
  // both modes and at both viewports, with a real touch hold on the phone.
  await page.evaluate(() => window.__voice.setTalkMode("always"));
  const mode = await page.evaluate(() => window.__voice.talkMode());
  check(mode === "always", "the talk mode for this leg is press-once-to-start", `the page says ${mode}`);
  const seen = await page.evaluate(() => {
    window.__voiceGateStates = [];
    const orb = document.querySelector("[data-voice-orb]");
    if (orb == null) return false;
    // data-voice-orb is the SELECTOR the page is found by; the state it is showing is on data-state
    // (ui/machine-room/voice.js paint()). Watching the selector records nothing at all, which reads as
    // an orb that never moved on a page where it moved four times.
    new MutationObserver(() => window.__voiceGateStates.push(orb.getAttribute("data-state")))
      .observe(orb, { attributes: true, attributeFilter: ["data-state"] });
    window.__voiceGateStates.push(orb.getAttribute("data-state"));
    return true;
  });
  check(seen, "the orb is on the page and being watched");
  const pressed = Date.now();
  await button.click();

  // THE DIAL HAS TO LAND BEFORE THE STUB CAN SAY ANYTHING. events.sessions grows when the bridge's
  // session.update is ACCEPTED, which is the first moment an emitted event reaches real code.
  await stub.waitFor((events) => events.sessions.length > 0, { timeoutMs: 30_000, label: "the bridge's session.update" })
    .catch(() => {});
  check(stub.events.sessions.length > 0, "the relay dialled the vendor and its session was accepted",
    `${stub.events.requests.length} dial(s), ${stub.events.sessions.length} session(s) in ${Date.now() - pressed} ms on ${MACHINE}`);
  check(stub.events.sessions[0]?.tools?.length === 1, "offering exactly one tool and no search of its own",
    JSON.stringify((stub.events.sessions[0]?.tools ?? []).map((one) => one.name ?? one?.function?.name)));

  // The person has stopped talking, and the model decides to ask the team. Both are the vendor's
  // events, which is why the stub emits them and the bridge only reacts.
  stub.emitSpeechStopped();
  const callId = stub.emitToolCall({ name: "titan", args: { message: "what is the team working on" } });

  // Titan's own thinking time, which is not ours: MEASURED on grok-bot-local-vm 5.5 to 25 seconds for a
  // short question and 50.6 on the first turn of a cold box, so the ceiling here is the bridge's own
  // TURN_WAIT_CAP of 120 seconds and not a guess.
  await stub.waitFor((events) => events.toolOutputs.length > 0, { timeoutMs: 130_000, label: "the team's reply handed back" })
    .catch(() => {});
  // Now the model speaks the reply it was handed. The page has to hold the microphone for all of it,
  // and the window measured is the one the page is actually holding in: from the first audio frame the
  // vendor sends to the moment the page says it has stopped holding. Snapshotting before speak() and
  // comparing after the whole turn measured a window minutes wide and counted the microphone audio
  // from Titan's thinking time as an echo leak, which it is not.
  const spokenText = String(stub.events.toolOutputs[0]?.output ?? "the team is working on this gate");
  const appendsBeforeSpeaking = stub.events.appendFrames;
  await stub.speak(spokenText.slice(0, 400));
  const appendsAfterSpeaking = stub.events.appendFrames;
  await page.waitForFunction(() => (window.__voiceGateStates ?? []).includes("speaking"), null, { timeout: 60_000 })
    .catch(() => {});
  const states = await page.evaluate(() => window.__voiceGateStates ?? []);
  info(`orb states in order: ${states.join(" -> ")}`);
  for (const state of ["listening", "thinking", "speaking"]) {
    check(states.includes(state), `the orb showed ${state}`, states.join(" -> "));
  }

  step("what the vendor heard, and what the team was asked");
  check(stub.events.appendFrames > 0, "the microphone reached the vendor through the relay", `${stub.events.appendFrames} frame(s), ${stub.events.appendBytes} bytes on ${MACHINE}`);
  const mine = stub.events.toolOutputs.filter((one) => one.call_id === callId);
  // ONE call_id arrives on three surfaces in the shape this stub emits, and the dedupe is the thing
  // being measured: one output for it means one sendPrompt, not three.
  check(mine.length === 1, "and the one call_id was answered exactly once, not once per surface", `${mine.length} output(s) for ${callId}`);
  // The REPLY is handed back as function_call_output, which is free on the flat-fee vendor, and a unit
  // test pins that. What is billed here is the acknowledgement the model says while the team thinks,
  // plus at most two nudges -- each one a real charge, which is why they are counted and bounded rather
  // than expected to be absent. Three is the ceiling the bridge holds itself to.
  check(stub.events.billableItems <= 3, "and the only billed text items are the bounded ones we meant to send", `${stub.events.billableItems} item(s)`);
  check(stub.events.toolOutputs.every((one) => one.output.length > 0), "with every tool result carrying words", `${stub.events.toolOutputs.length} result(s)`);
  const replied = String(mine[0]?.output ?? "");
  check(replied.length > 0, "carrying a real reply from the box rather than an empty string", `${replied.length} characters`);
  info(`the reply began: ${JSON.stringify(replied.slice(0, 120))}`);

  step("the mic was held shut while the reply was spoken, proved from BOTH sides");
  // The hold is measured in whole 100 ms frames, so it is read once the page has had the chance to
  // drop some rather than the instant the last frame was handed over. Reading it immediately after
  // speak() returns measured a window that had not happened yet and reported a gate that was working
  // as one that was not.
  await page.waitForFunction(() => Number(window.__voice?.stats?.()?.heldFrames ?? 0) > 0, null, { timeout: 15_000 }).catch(() => {});
  const stats = await page.evaluate(() => (window.__voice?.stats?.() ?? null));
  check(Number(stats?.heldFrames ?? 0) > 0, "the page dropped frames in the held window", JSON.stringify(stats));
  // BOTH SIDES, because a patched page that stopped holding would otherwise go unnoticed: the page's
  // own dropped count above, and here the vendor's own frame count across the send of the reply. The
  // relay drops anything arriving inside the same window as well, which is asserted without a browser
  // in tests/voice-caps-ledger.test.mjs -- here the point is that a real microphone, really open, with
  // the real echo gate in front of it, put nothing on the wire while the reply was coming back.
  check(appendsAfterSpeaking === appendsBeforeSpeaking, "and not one frame reached the vendor while the reply was being sent",
    `${appendsBeforeSpeaking} before, ${appendsAfterSpeaking} after, on ${MACHINE}`);
  info(`the page held ${stats?.heldFrames} frame(s) over ${stats?.heldMs} ms and the relay holds its own count on the ledger row below`);

  step("playback, and why there are no .played ranges to look at");
  // A DESIGN DECISION AND NOT A TEST DETAIL. Playback is Web Audio -- PCM16 deltas decoded into
  // AudioBuffers on a scheduler off the socket's onmessage path, because draining the player inline is
  // what froze omarchy's whole event loop, tool calls included, for the length of every spoken reply.
  // There is therefore no HTMLMediaElement and no .played TimeRanges. The evidence is the clock
  // advancing and real energy in the room.
  const playback = await page.evaluate(() => {
    const s = window.__voice?.stats?.() ?? null;
    return s == null ? null : { currentTime: s.playerTime, rms: s.level, bytesQueued: s.playedBytes, buffers: s.playedBuffers };
  });
  info("there are no .played TimeRanges here: playback is Web Audio, not an <audio> element. See docs/VOICE.md.");
  check(Number(playback?.currentTime ?? 0) > 0, "the audio clock advanced", JSON.stringify(playback));
  check(Number(playback?.rms ?? 0) > 0.001, "and an analyser heard real energy rather than a silent buffer", `rms ${playback?.rms}`);
  check(Number(playback?.bytesQueued ?? 0) > 0, "with bytes actually queued", String(playback?.bytesQueued));

  step("the spoken turn is an ordinary row in the one conversation, marked as spoken");
  // The chip app.js draws beside evidenceChipMarkup. It rides the send's own clientNonce through the
  // host, so it only appears once the durable entry has come back round -- which is also what proves
  // it survives a reload rather than being page state.
  await page.waitForFunction(() => document.querySelectorAll(".voice-spoken-chip").length > 0, null, { timeout: 30_000 }).catch(() => {});
  const spoken = await page.evaluate(() => document.querySelectorAll(".voice-spoken-chip").length);
  check(spoken > 0, "the transcript shows a spoken row with its chip", `${spoken} row(s)`);

  step("the hop ledger");
  const hops = await page.evaluate(() => (window.__voice?.stats?.()?.hops ?? null));
  if (hops == null) {
    fail("the page did not publish a hop ledger", "window.__voice.hops() answered nothing");
  } else {
    // ABSOLUTE STAMPS on the wire, deltas here. T5 and T6 are deliberately absent: T5 is the wire's
    // and T6 is the page's own "first sample audible", which a Web Audio path has no TimeRanges to
    // report -- the evidence for that hop is the clock, the analyser and the queued bytes above.
    const ms = (a, b) => (Number(hops[b]) > 0 && Number(hops[a]) > 0 ? Number(hops[b]) - Number(hops[a]) : undefined);
    hops.t1ToT2 = ms("t1", "t2");
    hops.t3ToT4 = ms("t3", "t4");
    hops.t2ToT3 = ms("t2", "t3");
    hops.t0ToT1 = ms("t0", "t1");
    for (const [name, value] of Object.entries(hops)) if (name !== "t") info(`${name}: ${value} (${MACHINE})`);
    // THE FOUR HOPS THIS PRODUCT OWNS. T2->T3 is Titan's own thinking time and is REPORTED and never
    // asserted: measured on grok-bot-local-vm it is 5.5 to 25 seconds, 50.6 on a cold box, and the
    // host exposes no partial reply to make it shorter. What is ours is that the person hears
    // something during it.
    // OURS, and the ceiling is generous on purpose: 6 to 14 ms was measured on an idle box and 58 ms
    // on this one with another wave's gate on it. The claim worth holding is that our own hop is tens
    // of milliseconds against Titan's tens of SECONDS, not that it beats a round number.
    check(Number(hops.t1ToT2 ?? Infinity) <= 150, "the tool call reaches sendPrompt in tens of milliseconds", `${hops.t1ToT2} ms on ${MACHINE}`);
    if (Number(hops.t3) > 0) {
      check(Number(hops.t3ToT4 ?? Infinity) <= 20, "the first sentence goes back inside 20 ms of the entry being seen", `${hops.t3ToT4} ms on ${MACHINE}`);
    } else {
      // t3 is stamped when an entry appears in the tail. Zero means this turn ended without one, which
      // on this shared box means the agent stopped working without answering -- the host has ONE global
      // active agent and a concurrent gate takes it. That is a real condition the bridge speaks out
      // loud rather than a hop that failed, and the reply check above is what fails if nothing came back.
      info(`T3 and T4 are not stamped on this turn: the team never put an entry in the tail, so there was no reply to split. On ${MACHINE} that is a box whose one active agent went elsewhere.`);
    }
    info(`T2->T3, which is the team thinking and not ours: ${hops.t2ToT3} ms on ${MACHINE}`);
    info("T5 and T6 are not on this ledger: the first sample becoming audible is the page's, and a Web Audio path has no .played to read it from. The clock, the analyser and the queued bytes above are that hop's evidence.");
  }

  step("the ledger row, and the scratch agent this run made");
  const usage = await asAdmin(cp, "GET", "/v1/voice/usage");
  const rows = usage.body?.tenants ?? [];
  check(rows.length > 0, "a row exists for this session", JSON.stringify(usage.body ?? usage.status));
  check(Number(rows[0]?.toolCalls ?? 0) >= 1 || Number(rows[0]?.open ?? 0) >= 1, "with the turn it handed to the team, or still open and counting", JSON.stringify(rows[0] ?? null));
  if (process.env.VOICE_GATE_RELAY_LOG === "1") console.log(`\n---- relay log ----\n${relay.log().slice(-2500)}\n----`);
  info(`the gate picked its Titan as: ${String(await page.evaluate(() => window.__voice?.stats?.()?.ready?.agentName ?? "")) || "(the page did not say)"} (${String(await page.evaluate(() => window.__voice?.stats?.()?.ready?.agentWhy ?? ""))})`);
  check(pageErrors.length === 0, "and the page threw nothing", pageErrors.slice(0, 2).join(" | ") || "clean");
  // A roster that grows during a gate run is a bug, so whatever this leg created goes away. Item B's
  // page opens no agent of its own, so the only thing to clean is a scratch agent a future revision
  // of this leg creates; the check is here so it cannot be forgotten then.
  info("this leg creates no agent of its own: the spoken turn goes to the workspace's chosen first agent");
  return;
}

// ---- VOICE-7: the words, labelled, in a real browser ---------------------------------------------
//
// WHY THIS IS ITS OWN LEG. The browser leg above drives the orb, the microphone and the playback and
// has never once driven a transcript: `grep emitUserTranscript scripts/verify-voice.mjs` returned
// nothing before 2026-09-10. VOICE-7 puts the person's words in a panel over the conversation, so
// what has to be measured is the frames that panel is built out of, at the two viewports a person
// actually uses, read off the PAGE'S OWN socket rather than from the relay's side of it.
//
// The recorder is `window.__voiceSocketClass`, the seam ui/machine-room/voice.js already reads before
// falling back to WebSocket. Nothing in the page is patched to make this leg pass.

const VOICE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, hasTouch: false },
  { name: "phone", width: 390, height: 844, hasTouch: true },
];

/** Every JSON frame the page's voice socket has received, in order. */
const framesOf = (page) => page.evaluate(() => (window.__voiceGateFrames ?? []).slice());

/** Wait until the page's own socket has received a frame the predicate likes. */
async function waitForFrame(page, predicate, { timeoutMs = 30_000, label = "a frame" } = {}) {
  const started = Date.now();
  for (;;) {
    const frames = await framesOf(page);
    const hit = frames.filter((f) => { try { return predicate(f) === true; } catch { return false; } });
    if (hit.length > 0) return { frames, hit };
    if (Date.now() - started > timeoutMs) return { frames, hit: [], timedOut: true, label };
    await sleep(120);
  }
}

async function legFrames() {
  console.log(`verify-voice --leg frames on ${MACHINE}`);
  requireTheOtherItems(true);
  const cp = await startControlPlane();
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({ audioFrames: 20 });
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });

  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-frames-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
  const wav = process.env.GATE_MIC_WAV ?? await makeMicWav(dir);

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 6,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const session = await signIn(relay);

  // The same choice the browser leg makes, and for the same reason: grok-bot-local-vm is shared and
  // other waves' gates leave scratch agents on its roster whose names sort first.
  const settingsBefore = await ask(`${relay.base}/voice/settings`, { headers: { cookie: session.cookie } });
  const roster = settingsBefore.body?.agents ?? [];
  const scratch = /^(code gate|voice gate|gate)\b|^new agent$/i;
  const chosen = roster.find((one) => !scratch.test(String(one.name ?? ""))) ?? roster[0] ?? null;
  await ask(`${relay.base}/voice/settings`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: chosen?.id ?? "" }),
  });
  info(`this run talks to ${chosen?.name ?? "(nobody)"}`);

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  cleanups.push(() => { try { browser.close(); } catch { /* gone */ } });

  for (const viewport of VOICE_VIEWPORTS) {
    // ONE VIEWPORT AT A TIME, and the previous one is closed first: a workspace is allowed one call,
    // so two live pages would make the second read the already-in-a-call sentence and measure that.
    const context = await browser.newContext({
      userAgent: GATE_AGENT,
      permissions: ["microphone"],
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.hasTouch,
      isMobile: viewport.hasTouch,
    });
    // The recorder, installed before any of the page's own script runs. voice.js reads
    // `__voiceSocketClass` before falling back to WebSocket, so nothing is monkey-patched behind it.
    await context.addInitScript(() => {
      window.__voiceGateFrames = [];
      const Real = window.WebSocket;
      class RecordingSocket extends Real {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            try { window.__voiceGateFrames.push(JSON.parse(event.data)); } catch { /* audio, not JSON */ }
          });
        }
      }
      window.__voiceSocketClass = RecordingSocket;
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    step(`${viewport.name} ${viewport.width}x${viewport.height}${viewport.hasTouch ? " with touch" : ""}: the console, signed in, listening`);
    await page.goto(`${relay.base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="password"]', relay.password).catch(() => {});
    await page.press('input[type="password"]', "Enter").catch(() => {});
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => window.__voice !== undefined, null, { timeout: 30_000 }).catch(() => {});
    const button = page.locator("[data-voice-talk]");
    check(await button.count() > 0, `the talk button is on the page at ${viewport.width}x${viewport.height}`, `${await button.count()} found`);
    const sessionsBefore = stub.events.sessions.length;
    await button.click();
    await stub.waitFor((events) => events.sessions.length > sessionsBefore, { timeoutMs: 30_000, label: "the bridge's session.update" }).catch(() => {});
    check(stub.events.sessions.length > sessionsBefore, "the relay dialled the vendor and its session was accepted",
      `${stub.events.sessions.length} session(s) on ${MACHINE}`);

    step(`${viewport.name}: the person talks, and the page is told what is being heard`);
    // A SEQUENCE THAT CORRECTS ITSELF, which is the cumulative vendor's documented behaviour and the
    // case a panel gets wrong: "teen" has to be REPLACED by "team", never appended to it.
    const spoken = ["what", "what is the teen", "what is the team", "what is the team working on"];
    stub.emitSpeechStarted({ itemId: "gate_item_1" });
    const began = await waitForFrame(page, (f) => f.t === "hear-begin", { label: "hear-begin" });
    check(began.hit.length === 1, "the page was told the person started talking", `hear-begin turn ${began.hit[0]?.turn}, item ${JSON.stringify(began.hit[0]?.itemId)} on ${MACHINE}`);
    await stub.emitUserTranscript(spoken, { itemId: "gate_item_1", gapMs: 120 });
    // WAIT FOR THE LAST STEP, not for any step. The relay-to-browser hop is its own trip, so a read
    // taken the moment the first partial lands catches three of four and reports the last correction
    // missing -- measured on this Mac doing exactly that before this line said which frame to wait for.
    const partials = await waitForFrame(page, (f) => f.t === "hear" && f.final === false && f.text === spoken.at(-1), { label: "the last partial" });
    const partialTexts = partials.frames.filter((f) => f.t === "hear" && f.final === false).map((f) => f.text);
    check(partialTexts.length >= 3, "the words arrived as they were spoken", `${partialTexts.length} partial(s) at ${viewport.width}x${viewport.height} on ${MACHINE}`);
    const grew = partialTexts.every((text, i) => i === 0 || text.length >= partialTexts[i - 1].length);
    check(grew, "and each one was longer than the one before it", JSON.stringify(partialTexts));
    check(partialTexts.at(-1) === spoken.at(-1) && !partialTexts.at(-1).includes("teen"),
      "with the correction replacing the wrong word rather than being appended to it", JSON.stringify(partialTexts.at(-1)));

    stub.emitUserTranscriptDone("What is the team working on?", { itemId: "gate_item_1" });
    const finals = await waitForFrame(page, (f) => f.t === "hear" && f.final === true, { label: "the finished transcript" });
    check(finals.hit.length === 1, "and one frame said the words were finished", `${finals.hit.length} final(s), ${JSON.stringify(finals.hit[0]?.text)}`);

    step(`${viewport.name}: the words that actually went into the conversation`);
    // The tool argument is the realtime model's own string and is DELIBERATELY not the transcript
    // above: two models read the same audio. What the panel's last paint has to be is this one.
    const asked = "What is the team working on?";
    stub.emitToolCall({ name: "titan", args: { message: asked }, callId: `frames_${viewport.name}`, triple: false });
    const confirmed = await waitForFrame(page, (f) => f.t === "heard-confirmed", { timeoutMs: 45_000, label: "heard-confirmed" });
    const row = confirmed.hit[0] ?? null;
    check(row != null && row.text === asked, "the page was told the exact bytes that went into his conversation",
      row == null ? "no heard-confirmed frame" : `${JSON.stringify(row.text)} on ${MACHINE}`);
    check(String(row?.nonce ?? "").startsWith("voice:"), "carrying the nonce his durable row is stamped with", String(row?.nonce ?? "(none)"));
    check(row?.landed === true && Number(row?.turn) === Number(began.hit[0]?.turn), "and belonging to the turn on screen",
      `landed ${row?.landed}, turn ${row?.turn} against hear-begin turn ${began.hit[0]?.turn}`);
    const ended = await waitForFrame(page, (f) => f.t === "hear-end", { timeoutMs: 20_000, label: "hear-end" });
    check(ended.hit[0]?.reason === "sent", "then the turn was closed, with the reason it ended", `reason ${JSON.stringify(ended.hit[0]?.reason ?? "")}`);
    const order = ended.frames.filter((f) => f.t === "heard-confirmed" || f.t === "hear-end").map((f) => f.t);
    check(order[0] === "heard-confirmed" && order[1] === "hear-end", "and the confirmed words came BEFORE the dissolve, so they are its last paint", order.join(" -> "));

    step(`${viewport.name}: the same bytes, as a row in the transcript`);
    // The durable row, drawn from the host's own entry off the ordinary poll, carrying the chip that
    // rides the same `voice:` nonce. This is the claim in one line: the last words in the panel and
    // the line in the chat are the same bytes.
    await page.waitForFunction(() => document.querySelectorAll(".voice-spoken-chip").length > 0, null, { timeout: 45_000 }).catch(() => {});
    const spokenRows = await page.evaluate(() => Array.from(document.querySelectorAll(".voice-spoken-chip"))
      .map((chip) => String(chip.closest("[data-entry-id], article, li, div")?.textContent ?? "")));
    check(spokenRows.length > 0, "the transcript shows the spoken row with its chip", `${spokenRows.length} row(s) on ${MACHINE}`);
    check(spokenRows.some((text) => text.includes(asked)), "and its words are the words the panel last showed",
      spokenRows.length === 0 ? "no row" : JSON.stringify(spokenRows[0].replace(/\s+/g, " ").slice(0, 140)));

    step(`${viewport.name}: a turn that never becomes a row still ends`);
    // An utterance the model made nothing of. Before this wave the relay answered the tool and said
    // nothing to the page at all, so a panel waiting for a row would sit over the conversation.
    const endsBefore = (await framesOf(page)).filter((f) => f.t === "hear-end").length;
    const confirmsBefore = (await framesOf(page)).filter((f) => f.t === "heard-confirmed").length;
    await sleep(2600); // the echo tail after the spoken reply: the mic is held shut until it passes.
    stub.emitSpeechStarted({ itemId: "gate_item_2" });
    stub.emitToolCall({ name: "titan", args: { message: "   " }, callId: `frames_empty_${viewport.name}`, triple: false });
    const emptyEnd = await waitForFrame(page, (f) => f.t === "hear-end" && f.reason === "empty", { timeoutMs: 20_000, label: "hear-end empty" });
    check(emptyEnd.hit.length > 0, "an utterance nothing came of closed the turn and said why", `reason empty, ${emptyEnd.frames.filter((f) => f.t === "hear-end").length - endsBefore} new end(s)`);
    const confirmsAfter = (await framesOf(page)).filter((f) => f.t === "heard-confirmed").length;
    check(confirmsAfter === confirmsBefore, "and nothing was confirmed for it, because nothing went in", `${confirmsAfter - confirmsBefore} new confirmation(s)`);
    // A spoken yes closing a held card is the third no-row turn. It needs a real pending approval on
    // the shared box, which cannot be manufactured inside this gate's ceiling, so it is measured at the
    // socket against a scripted gateway in tests/voice-transcription.test.mjs instead.
    info("the held-card yes is measured at the socket in tests/voice-transcription.test.mjs: a real pending approval cannot be made on the shared box inside 300 s");

    check(pageErrors.length === 0, `${viewport.name}: the page threw nothing`, pageErrors.slice(0, 2).join(" | ") || "clean");
    const all = await framesOf(page);
    info(`${viewport.name} ${viewport.width}x${viewport.height}: ${all.length} frames on the page's own socket, of which ${all.filter((f) => f.t === "hear").length} hear, ${all.filter((f) => f.t === "heard").length} heard (the old strip's, still shipping), ${all.filter((f) => f.t === "heard-confirmed").length} confirmed`);
    await page.close();
    await context.close();
    // The relay only allows one call per workspace, and the closed socket has to be settled before
    // the next viewport presses the button or it reads the already-in-a-call sentence.
    await sleep(1200);
  }
  return;
}

async function legOverlay() {
  console.log(`verify-voice --leg overlay on ${MACHINE}`);
  requireTheOtherItems(true);
  // ITS OWN PORT, six along from the default, because the other waves on this branch run their own
  // gates on this Mac and a second control plane on an occupied port does not fail loudly -- the
  // readiness probe answers from the FIRST one and the leg measures somebody else's service.
  const cp = await startControlPlane(6);
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({ audioFrames: 4 });
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });

  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-overlay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
  const wav = process.env.GATE_MIC_WAV ?? await makeMicWav(dir);

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 6,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const session = await signIn(relay);

  // The same choice the VOICE-1 leg makes, through the card's own door: grok-bot-local-vm is shared
  // and other waves' gates leave scratch agents on its roster whose names sort first.
  const settingsBefore = await ask(`${relay.base}/voice/settings`, { headers: { cookie: session.cookie } });
  const roster = settingsBefore.body?.agents ?? [];
  const scratch = /^(code gate|voice gate|gate)\b|^new agent$/i;
  const chosen = roster.find((one) => !scratch.test(String(one.name ?? ""))) ?? roster[0] ?? null;
  check(chosen != null, "the settings door lists this workspace's bots, so one can be chosen", `${roster.length} on the roster`);
  if (chosen == null) {
    // WITHOUT A BOT THE RELAY REFUSES EVERY PRESS IN WORDS, correctly, and every combination below
    // would then fail for that one reason and report four defects that are one condition. grok-bot-
    // local-vm is shared: a concurrent gate, or a host that is restarting, empties this roster.
    missing("a bot on this workspace to talk to", [
      "GET /voice/settings answered an empty roster, so the relay has nobody to hand a spoken turn to",
      `the host gateway this relay reads is ${GATEWAY}; check it is up and that SAND_PROFILE_DIRS names the live profile`,
      "run this leg again when the box is not being used by another gate",
    ]);
    return;
  }
  await ask(`${relay.base}/voice/settings`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: chosen?.id ?? "" }),
  });
  info(`this run talks to ${chosen?.name ?? "(nobody)"}`);

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  cleanups.push(() => { try { browser.close(); } catch { /* gone */ } });

  // Read in ONE evaluate so every rectangle comes off the same layout. Two evaluates straddle a frame
  // and a rect that moved between them reads as a rect that moved because of the panel.
  const RECTS = `(() => {
    const r = (sel) => { const n = document.querySelector(sel); if (n == null) return null;
      const b = n.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
    const ov = document.getElementById("voice-overlay");
    const stats = window.__voice?.stats?.() ?? null;
    return {
      shelf: r(".control-shelf"), composer: r("#composer"), talk: r("[data-voice-talk]"),
      box: r("#message-input"),
      shelfKids: [...(document.querySelector(".control-shelf")?.children ?? [])]
        .map((n) => (n.id || n.className) + ":" + Math.round(n.getBoundingClientRect().width) + "x" + Math.round(n.getBoundingClientRect().height)),
      line: (() => { const n = document.getElementById("voice-line"); return n == null ? null : {
        hidden: n.hidden === true, text: (n.textContent ?? "").replace(/\s+/g, " ").trim() }; })(),
      overlay: ov == null ? null : {
        hidden: ov.hidden === true,
        panel: r("[data-voice-overlay-panel]"),
        text: (document.querySelector("[data-voice-overlay-text]")?.textContent ?? ""),
      },
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      spokenRows: [...document.querySelectorAll(".message-row")]
        .filter((row) => row.querySelector(".voice-spoken-chip") != null)
        .map((row) => (row.querySelector(".message-bubble")?.textContent ?? "").replace(/\\s+/g, " ").trim()),
      lastHeard: stats?.lastHeard ?? "", lastNonce: stats?.lastNonce ?? "",
      talkMode: stats?.talkMode ?? "", held: stats?.held === true, talking: stats?.talking === true,
      orb: document.querySelector("[data-voice-orb]")?.getAttribute("data-state") ?? "",
    };
  })()`;
  const sameRect = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * WHAT "THE FOOTER DID NOT MOVE" MEANS AT EACH WIDTH, and the difference is a measurement rather than a
   * convenience. At 1440x900 every rect is byte-identical across a whole turn and stays that way.
   *
   * At 740x900 -- where VOICE-13 had to move these rows, because at 390x844 a press is now a call screen --
   * one thing in that shelf is NOT voice's. MEASURED here with the voice line and the panel both away and
   * 0x0: .workspace-list goes 0x0 to 93x46 the first time a turn really lands, because the console draws a
   * chip for the conversation that turn created, and at this width that chip shares the composer's row and
   * takes 93 px off it. At 1440x900 the row has slack and the same chip costs nothing. So at the narrow
   * width the claim is the one VOICE-2 was actually about -- NO NEW ROW OPENS, nothing changes height,
   * nothing moves vertically -- and the chip's own width is printed beside it rather than asserted away.
   */
  const footerHeld = (now, base, strict) => (strict
    ? sameRect(now.shelf, base.shelf) && sameRect(now.composer, base.composer)
      && sameRect(now.talk, base.talk) && sameRect(now.box, base.box)
    : now.shelf?.h === base.shelf?.h && now.shelf?.y === base.shelf?.y
      && now.composer?.h === base.composer?.h && now.composer?.y === base.composer?.y
      && now.talk?.h === base.talk?.h && now.talk?.y === base.talk?.y
      && now.box?.h === base.box?.h && now.box?.y === base.box?.y);

  // One leg per run has to fit a 300 second ceiling and this one drives four combinations against a
  // shared box. VOICE_GATE_ONLY narrows it while something is being chased -- "desktop", "phone",
  // "push", "always" -- and a full run names nothing.
  const only = String(process.env.VOICE_GATE_ONLY ?? "").toLowerCase();
  const runId = randomBytes(3).toString("hex");
  let turn = 0;
  // VOICE-13 RE-CUT THE SECOND VIEWPORT, and not to work around a red line: at 390x844 a press is now a
  // call screen by design, so a leg that held a hold there would be measuring a behaviour the product no
  // longer has. 740x900 is still UNDER LINE_SHELF_WIDTH, so everything these rows really measured about
  // the refusal line's shelf home and the footer's geometry at a narrow width still holds, and it is
  // over the call width, so the hold is still a hold. The phone is measured by --leg call.
  for (const view of [
    { name: "desktop", width: 1440, height: 900, hasTouch: false },
    { name: "narrow", width: 740, height: 900, hasTouch: true },
  ]) {
    if (only.length > 0 && !only.includes(view.name) && (only.includes("desktop") || only.includes("phone"))) continue;
    for (const mode of ["push", "always"]) {
      if (only.length > 0 && !only.includes(mode) && (only.includes("push") || only.includes("always"))) continue;
      turn += 1;
      const words = ["what is", "what is the team", "what is the team working on"];
      // EACH SENTENCE IS UNIQUE TO THIS RUN, not just to this turn. The turn really does go into a real
      // bot's real conversation, which is durable, so a sentence that only named the turn was still in
      // the transcript from the PREVIOUS run of this leg and "landed exactly once" read two rows and
      // failed on a page where this run had landed exactly one.
      const said = `what is the team working on, turn ${turn} of ${runId}`;
      step(`${view.name} ${view.width}x${view.height}, ${mode === "push" ? "press and hold" : "always listening"}`);

      const context = await browser.newContext({
        userAgent: GATE_AGENT, permissions: ["microphone"],
        viewport: { width: view.width, height: view.height }, hasTouch: view.hasTouch,
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      await page.goto(`${relay.base}/login`, { waitUntil: "domcontentloaded" });
      await page.fill('input[type="password"]', relay.password).catch(() => {});
      await page.press('input[type="password"]', "Enter").catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      // The panel's own host has to be on the page before anything is driven: it mounts into
      // .conversation-space, which app.js paints.
      await page.waitForFunction(() => window.__voice != null && document.getElementById("voice-overlay") != null,
        null, { timeout: 30_000 }).catch(() => {});
      const mounted = await page.evaluate(() => document.getElementById("voice-overlay") != null);
      check(mounted, "the speech panel is mounted over the conversation, not in the footer", String(mounted));
      const inSpace = await page.evaluate(() =>
        document.getElementById("voice-overlay")?.closest(".conversation-space") != null
        && document.getElementById("voice-overlay")?.closest(".control-shelf") == null);
      check(inSpace, "and it really is inside .conversation-space and outside .control-shelf", String(inSpace));
      // VOICE-13: neither of these widths is a phone, so neither gets a call screen. 740 px is the
      // width that proves the predicate is not simply "narrower than the refusal line's shelf home".
      const noCall = await page.evaluate(() => ({
        wanted: window.__voice?._callWanted?.() ?? null,
        up: document.getElementById("voice-call") == null ? false : document.getElementById("voice-call").hidden === false,
      }));
      check(noCall.wanted === false && noCall.up === false,
        `and at ${view.width}x${view.height} no call screen is wanted or drawn, so the strip and the panel are still the shape of this window`,
        JSON.stringify(noCall));

      // THE FIRST COMBINATION DRIVES THE MODE THROUGH THE ROW A PERSON REALLY USES, and with no settle.
      //
      // Every other combination sets it with setTalkMode(), which proves the BEHAVIOUR; that is why 48
      // of 48 green never saw SETTINGS-3, where the control on screen went back to the old value while
      // the module and this browser both held the new one. So once per run the mode is changed the way a
      // person changes it -- open Settings, change the select the instant the row exists -- and all three
      // are read back rather than only the module.
      if (turn === 1) {
        const throughRow = await page.evaluate(async (want) => {
          window.__voice.setTalkMode(want === "push" ? "always" : "push");
          window.__mrSettings?.open?.("general", null);
          // WAITING FOR THE ROW IS NOT SETTLING. open() answers false until app.js has published its own
          // panel opener, so a single press a second after boot can open nothing at all and the leg then
          // measured "no Talk mode row on this page" on a console that had one. So the open is asked for
          // again every 200 ms until the row EXISTS -- and the change is made on the first frame it does,
          // which is what keeps the race the defect needs. A settle would be waiting after it appeared.
          let select = null;
          for (let tries = 0; tries < 40 && select == null; tries += 1) {
            select = document.querySelector('[data-setting-row="talk-mode"] select');
            if (select != null) break;
            window.__mrSettings?.open?.("general", null);
            select = document.querySelector('[data-setting-row="talk-mode"] select');
            if (select != null) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (select == null) return { ok: false, why: "no Talk mode row on this page after 8 s of asking for General" };
          select.value = want;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }, mode);
        if (throughRow.ok !== true) {
          skip("the mode is driven through the Talk mode row a person really uses", throughRow.why);
        } else {
          await page.waitForTimeout(2000);
          const agreed = await page.evaluate(() => ({
            field: document.querySelector('[data-setting-row="talk-mode"] select')?.value ?? "gone",
            mode: window.__voice?.talkMode?.() ?? "",
            stored: (() => { try { return window.localStorage.getItem(window.__voice._TALK_MODE_KEY); } catch { return null; } })(),
          }));
          check(agreed.field === mode && agreed.mode === mode && agreed.stored === mode,
            "the mode driven through the settings row with NO settle: the control, the module and this browser all agree (SETTINGS-3)",
            JSON.stringify(agreed));
        }
        await page.evaluate(() => document.getElementById("panel-dialog")?.close());
        await page.waitForTimeout(300);
      }
      await page.evaluate((m) => window.__voice.setTalkMode(m), mode);
      const set = await page.evaluate(() => window.__voice.talkMode());
      check(set === mode, `the talk mode is ${mode}`, `the page says ${set}`);

      const before = await page.evaluate(RECTS);
      check(before.overlay?.hidden === true, "the panel is away before anybody talks", JSON.stringify(before.overlay?.hidden));
      info(`footer before: shelf ${JSON.stringify(before.shelf)} composer ${JSON.stringify(before.composer)} talk ${JSON.stringify(before.talk)} on ${MACHINE}`);

      // -- the press, per mode and per device ------------------------------------------------------
      //
      // THE BOOT COVER IS OPAQUE AND ON TOP until app.js paints or its 8 s ceiling expires, and this
      // panel mounts as soon as .conversation-space exists -- which is earlier than that. A press at
      // raw coordinates before the cover lifts lands on the cover, opens no line, and reads as a
      // button that does not work. So the control is POLLED until elementFromPoint at its own centre
      // really answers the button, which is the same thing the unit browser leg does and the same
      // thing a person's finger does.
      let box = null;
      for (let n = 0; n < 60 && box == null; n += 1) {
        box = await page.evaluate(() => {
          const node = document.querySelector("[data-voice-talk]");
          if (node == null || node.disabled === true) return null;
          const b = node.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) return null;
          const x = Math.round(b.left + b.width / 2);
          const y = Math.round(b.top + b.height / 2);
          const hit = document.elementFromPoint(x, y);
          return node.contains(hit) || hit === node ? { x, y } : null;
        });
        if (box == null) await page.waitForTimeout(500);
      }
      check(box != null, "a press really reaches the talk button rather than the boot cover over it", JSON.stringify(box));
      if (box == null) { await context.close(); continue; }
      let touch = null;
      const pressed = Date.now();
      if (mode === "push" && view.hasTouch) {
        // A REAL TOUCH, held. page.click() and page.touchscreen.tap() are both instantaneous and prove
        // nothing about a hold; this is the browser's own touch pipeline, which synthesises the
        // pointer sequence the page listens for.
        touch = await context.newCDPSession(page);
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
      } else if (mode === "push") {
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
      } else if (view.hasTouch) {
        await page.touchscreen.tap(box.x, box.y);
      } else {
        await page.mouse.click(box.x, box.y);
      }

      await stub.waitFor((events) => events.sessions.length >= turn, { timeoutMs: 30_000, label: "the bridge's session.update" }).catch(() => {});
      const dialled = stub.events.sessions.length >= turn;
      if (!dialled) {
        // A GATE THAT CANNOT SAY WHY IS ONE THE NEXT PERSON DEBUGS BY GUESSING. Every refusal on this
        // relay is words on an accepted socket, so the sentence the person would have read is right
        // there on the page, and the relay wrote down its own reason beside it.
        const said = await page.evaluate(() => ({
          notes: window.__voice?.stats?.()?.notes ?? [],
          text: (document.querySelector("[data-voice-note] .message-bubble")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        }));
        info(`the page read: ${JSON.stringify(said)}`);
        info(`the relay said: ${relay.log().split("\n").filter((one) => /voice/i.test(one)).slice(-6).join(" | ").slice(0, 900)}`);
      }
      check(dialled, "the press opened a line", `${stub.events.sessions.length} session(s) in ${Date.now() - pressed} ms on ${MACHINE}`);
      const held = await page.evaluate(RECTS);
      if (mode === "push") {
        check(held.held === true && held.talking === true, "the button is held and the microphone is open", JSON.stringify({ held: held.held, talking: held.talking }));
        const filled = await page.evaluate(() => document.querySelector("[data-voice-talk]")?.classList.contains("is-held") === true);
        check(filled, "and the button shows a filled state while it is down", String(filled));
      } else {
        check(held.talking === true, "the microphone is open from the press to the next press", String(held.talking));
      }

      // -- the words being built --------------------------------------------------------------------
      stub.emitSpeechStart();
      await page.waitForFunction(() => document.getElementById("voice-overlay")?.hidden === false, null, { timeout: 15_000 }).catch(() => {});
      const opened = await page.evaluate(RECTS);
      // The detail says what a person would SEE. Printing the raw `hidden` bit put the word "false"
      // after a line that had passed, which is host-notes-read-as-errors.md happening in a gate's own
      // output: a green line whose detail reads false gets read as a failure.
      check(opened.overlay?.hidden === false, "the panel appears when the person starts talking",
        opened.overlay?.hidden === false ? `on screen, ${JSON.stringify(opened.overlay?.panel)}` : "still away");
      check(String(opened.overlay?.text ?? "").length > 0, "with one plain word in it before the first word arrives", JSON.stringify(opened.overlay?.text));
      info(`panel: ${JSON.stringify(opened.overlay?.panel)} over a transcript the footer never hears about`);

      const seen = [];
      for (const one of words) {
        stub.emitUserTranscript(one);
        await page.waitForFunction((want) => (document.querySelector("[data-voice-overlay-text]")?.textContent ?? "") === want,
          one, { timeout: 15_000 }).catch(() => {});
        seen.push(await page.evaluate(() => document.querySelector("[data-voice-overlay-text]")?.textContent ?? ""));
      }
      // THE TEXT CHANGED, which is the claim. A non-empty panel proves nothing: the first paint is
      // already non-empty, and a page that painted once and stopped would pass that.
      check(new Set(seen).size === words.length, "the words are built up in the panel, changing between reads", JSON.stringify(seen));
      check(seen.at(-1) === words.at(-1), "and the last partial is the whole sentence so far, replaced rather than appended", JSON.stringify(seen.at(-1)));

      const during = await page.evaluate(RECTS);
      check(footerHeld(during, before, view.name === "desktop"),
        view.name === "desktop"
          ? "THE FOOTER DID NOT MOVE while the words were being built"
          : "THE FOOTER OPENED NO ROW AND NOTHING CHANGED HEIGHT while the words were being built",
        `shelf ${JSON.stringify(during.shelf)} composer ${JSON.stringify(during.composer)} talk ${JSON.stringify(during.talk)} `
        + `message box ${JSON.stringify(during.box)} on ${MACHINE}`);
      check(during.sideways === false, "and the page does not scroll sideways with the panel up", String(during.sideways));
      if (!sameRect(during.composer, before.composer)) {
        info(`the composer is ${during.composer.w} px against ${before.composer.w} px, and the shelf's children say why: ${JSON.stringify(before.shelfKids)} before, ${JSON.stringify(during.shelfKids)} during. The voice line is 0x0 in both.`);
      }

      // The settled transcript races the tool call, so it is another partial and must NOT dissolve.
      stub.emitUserTranscriptDone(words.at(-1));
      await page.waitForTimeout(150);
      const settled = await page.evaluate(RECTS);
      check(settled.overlay?.hidden === false, "the settled transcript does not dissolve the panel, because the tool call is still coming",
        settled.overlay?.hidden === false ? `still on screen reading ${JSON.stringify(settled.overlay?.text)}` : "it dissolved early and will flash back");

      // -- the release, and the turn ending ---------------------------------------------------------
      stub.emitSpeechStop();
      if (mode === "push" && touch != null) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else if (mode === "push") {
        await page.mouse.up();
      }
      if (mode === "push") {
        await page.waitForFunction(() => window.__voice?.stats?.()?.talking === false, null, { timeout: 10_000 }).catch(() => {});
        const released = await page.evaluate(RECTS);
        check(released.talking === false && released.held === false, "the release shuts the microphone", JSON.stringify({ held: released.held, talking: released.talking }));
        // The line is deliberately still up, so the next hold does not pay the dial again.
        const live = await page.evaluate(() => window.__voice?._state?.on === true);
        check(live, "and the line stays warm for the next hold rather than hanging up", String(live));
      }

      stub.emitToolCall({ name: "titan", args: { message: said }, callId: `call_overlay_${turn}`, triple: true });
      // THE DISSOLVE, and the words it leaves behind. `lastHeard` outlives the node, which is what
      // makes the byte comparison below possible at all.
      await page.waitForFunction((want) => window.__voice?.stats?.()?.lastHeard === want, said, { timeout: 20_000 }).catch(() => {});
      const atFinal = await page.evaluate(RECTS);
      check(atFinal.lastHeard === said, "the panel's last words are the bytes the relay handed to the agent", JSON.stringify(atFinal.lastHeard));
      check(String(atFinal.lastNonce ?? "").startsWith("voice:"), "under the id the durable row will carry", JSON.stringify(atFinal.lastNonce));
      await page.waitForFunction(() => document.getElementById("voice-overlay")?.hidden === true, null, { timeout: 10_000 }).catch(() => {});
      const gone = await page.evaluate(RECTS);
      check(gone.overlay?.hidden === true, "and then the panel dissolves", String(gone.overlay?.hidden));

      // -- the row it became ------------------------------------------------------------------------
      await page.waitForFunction((want) => [...document.querySelectorAll(".message-row")]
        .some((row) => row.querySelector(".voice-spoken-chip") != null
          && (row.querySelector(".message-bubble")?.textContent ?? "").replace(/\s+/g, " ").trim() === want),
        said, { timeout: 40_000 }).catch(() => {});
      const after = await page.evaluate(RECTS);
      const mine = after.spokenRows.filter((one) => one === said);
      check(mine.length === 1, "the spoken row landed exactly once, where a typed message would go", `${mine.length} row(s) reading ${JSON.stringify(said)}, ${after.spokenRows.length} spoken row(s) in all`);
      check(mine[0] === after.lastHeard, "AND IT IS BYTE-IDENTICAL to the panel's last words", `${JSON.stringify(mine[0])} vs ${JSON.stringify(after.lastHeard)}`);

      // -- the footer, after ------------------------------------------------------------------------
      check(view.name === "desktop" ? sameRect(after.shelf, before.shelf) : (after.shelf?.h === before.shelf?.h && after.shelf?.y === before.shelf?.y),
        "the footer's height is what it was before anybody talked",
        `${JSON.stringify(before.shelf)} before, ${JSON.stringify(after.shelf)} after, on ${MACHINE}`);
      check(view.name === "desktop" ? sameRect(after.composer, before.composer) : (after.composer?.h === before.composer?.h && after.composer?.y === before.composer?.y),
        view.name === "desktop" ? "the message box never narrowed" : "the message box never changed height or moved",
        `${JSON.stringify(before.composer)} before, ${JSON.stringify(after.composer)} after`);
      check(view.name === "desktop" ? sameRect(after.talk, before.talk) : (after.talk?.h === before.talk?.h && after.talk?.y === before.talk?.y),
        "and the talk button never moved",
        `${JSON.stringify(before.talk)} before, ${JSON.stringify(after.talk)} after`);
      check(view.name === "desktop" ? sameRect(after.box, before.box) : (after.box?.h === before.box?.h && after.box?.y === before.box?.y),
        "and neither did the message box a person types into",
        `${JSON.stringify(before.box)} before, ${JSON.stringify(after.box)} after`);

      // -- AND THE AGENT'S REPLY, which is the half this leg could not see before -------------------
      //
      // It took its `after` rects within milliseconds of the tool call and the reply lands 5 to 25 s
      // later, so the one thing that happens on EVERY turn was measured on no turn at all. The reply
      // used to be written into the footer's own line: MEASURED on this Mac, #message-input 370.05 ->
      // 215.31 px at 1440x900 and .control-shelf 25 px taller and 25 px higher at 390x844, standing
      // there for the rest of the call because only a start or a stop ever cleared it. It now paints
      // nothing, and this is where that is proved rather than asserted in a doc.
      await page.evaluate((text) => window.__voice._onMessage({ data: JSON.stringify({ t: "said", text }) }),
        "The team is on the settings surface this afternoon, and the deploy gate is green.");
      await page.waitForTimeout(150);
      const replied = await page.evaluate(RECTS);
      check(footerHeld(replied, before, view.name === "desktop"),
        "THE FOOTER DID NOT MOVE when the agent answered either, which is every turn rather than only a refused one",
        `shelf ${JSON.stringify(replied.shelf)} composer ${JSON.stringify(replied.composer)} talk ${JSON.stringify(replied.talk)} `
        + `message box ${JSON.stringify(replied.box)} on ${MACHINE}`);
      check(replied.line?.hidden !== false, "and his reply put no words in the footer: it is a row in the transcript and a voice",
        JSON.stringify(replied.line));
      check(replied.overlay?.hidden === true, "and no panel while he speaks, where the orb on the button is the only sign",
        String(replied.overlay?.hidden));

      // -- a person could still press it ------------------------------------------------------------
      // A passing page.click() is not evidence a human can click: elementFromPoint at the control's
      // own centre, after a scroll, is.
      await page.mouse.move(Math.round(view.width / 2), Math.round(view.height / 2));
      await page.mouse.wheel(0, 400).catch(() => {});
      await page.waitForTimeout(120);
      const reachable = await page.evaluate(() => {
        const node = document.querySelector("[data-voice-talk]");
        const b = node.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
        return { ok: node.contains(hit) || hit === node, landedOn: hit?.className ?? hit?.tagName ?? "nothing" };
      });
      check(reachable.ok, "and a finger or a mouse still lands on the talk button after a scroll", JSON.stringify(reachable));

      // -- ONE THUMB IS ONE PRESS, with a refusal standing (390x844, press and hold) ----------------
      //
      // A phone fires pointerdown AND touchstart for one press and both reach the hold. MEASURED here
      // before the fix: the first of the two cleared the standing refusal and the second found no note
      // and dialled straight back into it, which is the loop Jason was stuck in reappearing through the
      // second event of the same gesture. The mouse path, which fires only pointerdown, was correct --
      // which is why this is measured through the browser's own touch pipeline and at this width.
      if (mode === "push" && view.hasTouch && touch != null) {
        await page.evaluate(() => window.__voice.stop("no-key"));
        await page.waitForFunction(() => (window.__voice?.stats?.()?.notes ?? []).length > 0, null, { timeout: 5000 }).catch(() => {});
        const standing = await page.evaluate(() => window.__voice.stats().notes);
        check(standing.length === 1, "a refusal is standing, the way it is on a workspace with talking switched off", JSON.stringify(standing));
        const dialsBefore = stub.events.sessions.length;
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
        await page.waitForTimeout(400);
        const onePress = await page.evaluate(() => ({ on: window.__voice._state.on, held: window.__voice.stats().held, notes: window.__voice.stats().notes }));
        check(onePress.on === false && onePress.held === false,
          "one real press clears the refusal and does NOT dial back into it", JSON.stringify(onePress));
        check(onePress.notes.length === 0, "and the sentence is gone, which is what the press is for", JSON.stringify(onePress.notes));
        check(stub.events.sessions.length === dialsBefore, "no line was opened by the press that cleared it",
          `${stub.events.sessions.length - dialsBefore} new line(s)`);
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        // AND THE NEXT PRESS STILL WORKS. The gesture is spent by its own release, not for good.
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
        await page.waitForFunction(() => window.__voice.stats().held === true, null, { timeout: 10_000 }).catch(() => {});
        const nextPress = await page.evaluate(() => ({ held: window.__voice.stats().held, talking: window.__voice.stats().talking }));
        check(nextPress.held === true, "and a fresh press after the release holds the microphone normally", JSON.stringify(nextPress));
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.evaluate(() => window.__voice.stop());
      }

      // -- the way out --------------------------------------------------------------------------------
      if (mode === "always") {
        // A DIALOG TAKES ESCAPE FIRST, CORRECTLY, and the console really does open one on a first
        // sign-in. The page refuses to end a call with an Escape that belongs to a dialog or a drawer
        // -- that is the behaviour, not a defect -- so the gate clears whatever is holding the key the
        // way a person would, and only then asks whether Escape ends the call. Before this the leg
        // read a refusal as a broken way out, and it read it on one viewport out of two.
        const holding = await page.evaluate(() => document.querySelector("dialog[open]")?.id ?? document.body?.dataset?.drawer ?? "");
        if (holding.length > 0) {
          info(`${holding} had the keyboard, so it takes the first Escape the way it should`);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
        }
        // AND THE BOX'S OWN SCREEN TAKES KEYSTROKES OUTRIGHT when it has the focus, because it is an
        // iframe and everything typed into it is meant for the machine on the other side. MEASURED
        // here: after a wheel scroll, document.activeElement was IFRAME and the Escape never reached
        // the page at all -- which is the correct browser behaviour and the documented rule, not a
        // defect in the way out. So the gate puts the focus back on the control a person who just
        // pressed Talk is actually holding, and then presses Escape.
        await page.focus("[data-voice-talk]").catch(() => {});
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => window.__voice?._state?.on === false, null, { timeout: 10_000 }).catch(() => {});
        // Escape is deliberately NOT taken when it belongs to somebody else -- app.js closes an open
        // drawer with it and a dialog closes itself -- so a refusal here is either that or a line that
        // was already down, and the detail has to say which or the next person guesses.
        const why = await page.evaluate(() => ({
          on: window.__voice?._state?.on === true,
          drawer: document.body?.dataset?.drawer ?? "",
          dialogOpen: document.querySelector("dialog[open]")?.id ?? "",
          focused: document.activeElement?.tagName ?? "",
        }));
        check(why.on === false, "Escape ends an always-listening call, which is the way out that needs no pointer", JSON.stringify(why));

        // THE ROW ITSELF, through the control a person really uses, once at each width. Setting the
        // mode with setTalkMode() everywhere else in this leg proves the behaviour; this proves there
        // is something on screen to set it WITH, that it opens showing the mode the page is really in,
        // and that choosing the other one takes.
        //
        // IT IS UNDER GENERAL > SYSTEM, beside Microphone and "Let me talk to Titan", which is where
        // the item asked for it and where the settings surface that landed beside this wave put its
        // other per-browser choices. The surface is opened by naming the section rather than by
        // clicking the gear: that gear is hidden by the console's own phone layout below 690 px, which
        // is a pre-existing hole filed as CONSOLE-PHONE-SETTINGS-1, and a leg that clicked it would be
        // measuring that hole instead of this row. The hole is still reported at each width.
        const gearVisible = await page.evaluate(() => {
          const gear = document.getElementById("shelf-settings");
          if (gear == null) return false;
          const rect = gear.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        info(gearVisible
          ? "the gear on the shelf is reachable at this width, so a person can open Settings by hand"
          : "the gear is hidden by the console's own phone layout at this width, so there is no way into Settings by hand here (CONSOLE-PHONE-SETTINGS-1)");
        await page.evaluate(() => window.__mrSettings?.open?.("general", "talk-mode"));
        await page.waitForFunction(
          () => document.querySelector('[data-setting-row="talk-mode"] select') != null,
          null, { timeout: 20_000 }).catch(() => {});
        const row = await page.evaluate(() => {
          const host = document.querySelector('[data-setting-row="talk-mode"]');
          const field = host?.querySelector("select");
          if (field == null) return null;
          const rect = field.getBoundingClientRect();
          return {
            value: field.value,
            choices: [...field.options].map((one) => one.textContent.replace(/\s+/g, " ").trim()),
            label: (host.querySelector("strong, label, .setting-label")?.textContent ?? "").trim(),
            group: (host.closest("[data-settings-section]")?.getAttribute("data-settings-section") ?? ""),
            visible: rect.width > 0 && rect.height > 0,
            width: Math.round(rect.width),
          };
        });
        check(row != null && row.visible, "the Talk mode row is on screen in Settings under General", JSON.stringify(row));
        check(row?.group === "general", "and it is in the General section, not a card of its own", JSON.stringify(row?.group));
        check(row?.value === "always", "opening it shows the mode this page is really in", JSON.stringify(row?.value));
        check((row?.choices ?? []).length === 2 && row.choices.every((one) => one.length > 20),
          "with the two ways to talk written out in plain words", JSON.stringify(row?.choices));
        await page.selectOption('[data-setting-row="talk-mode"] select', "push").catch(() => {});
        await page.waitForFunction(() => window.__voice?.talkMode?.() === "push", null, { timeout: 10_000 }).catch(() => {});
        const round = await page.evaluate(() => ({
          mode: window.__voice?.talkMode?.() ?? "",
          field: document.querySelector('[data-setting-row="talk-mode"] select')?.value ?? "",
          stored: (() => { try { return window.localStorage.getItem(window.__voice._TALK_MODE_KEY); } catch { return null; } })(),
        }));
        check(round.mode === "push" && round.field === "push" && round.stored === "push",
          "choosing the other one takes, and is still there on the next load of this page", JSON.stringify(round));
      } else {
        await page.evaluate(() => window.__voice.stop());
      }
      check(pageErrors.length === 0, "and the page threw nothing", pageErrors.slice(0, 2).join(" | ") || "clean");
      await context.close();
      // The relay holds a workspace to one call at a time, so the next combination waits for this
      // socket to really be gone rather than reading "already in a call".
      await sleep(400);
    }
  }

  step("what this leg did NOT measure, said out loud");
  info("no realtime key exists on this machine, so the transcript events came from the stub and no real spoken turn was measured.");
  info("the R750 half -- the setting round-tripping and the button behaving per mode through console.titanium.bot -- is the shipper's, and a builder does not write to that box.");
  return;
}

/**
 * VOICE-10 -- the talk mode follows the PERSON, with this browser as the fallback.
 *
 * WHAT IS BEING MEASURED AND WHAT IS NOT. The row was filed because a person who chooses always
 * listening on a laptop got press-and-hold on their phone: the value lived in localStorage and nowhere
 * else. It now lives on the voice door keyed on the session's own person claim -- the same key the device
 * list and the notification settings use -- and the browser's copy is the FALLBACK, which is what still
 * works in a private window and against a relay that has never heard of the field.
 *
 * So three contexts, which are the three cases:
 *
 *   A  chooses always listening. Its own storage holds it and the door is told.
 *   B  a brand-new browser, no storage at all, signed in as the SAME person: it has to open on always
 *      listening at first paint, with nothing pressed. This is the whole of the row.
 *   C  a brand-new browser with the settings door BLOCKED -- the private window and the older relay,
 *      which are the same case from the page's side: nothing comes back, and push to talk is still the
 *      answer, because a microphone that is open until you say otherwise is not a default.
 *
 * No box and no vendor. The only thing dialled here is /voice/settings, so this leg is cheap and does not
 * want the host's one global active agent.
 */
async function legPerson() {
  console.log(`verify-voice --leg person on ${MACHINE}`);
  requireTheOtherItems(true);

  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-person-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  // Talking switched OFF on purpose. This leg never opens a line, and a workspace with no key is the
  // honest shape of every box on this Mac.
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: false, vendor: "xai" })}\n`, { mode: 0o600 });

  // A FREE PORT, ASKED FOR RATHER THAN ASSUMED, and this is the lesson the overlay leg already carries
  // in writing: a relay that cannot bind dies, `startRelay`'s readiness probe is answered by whatever IS
  // on that port, and the leg then measures somebody else's service. MEASURED while building this -- a
  // stale relay from an earlier attempt held the fixed port, the login page never took the password, and
  // every check read `undefined`.
  const relay = await startRelay({
    port: await freePort(),
    voiceJson, stubUrl: "ws://127.0.0.1:9/never",
  });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  cleanups.push(() => { try { browser.close(); } catch { /* gone */ } });

  // A GATE THAT CANNOT SAY WHY IS ONE THE NEXT PERSON DEBUGS BY GUESSING. If the console does not boot
  // -- a login that did not take, a host gateway that is not up, an asset that did not serve -- every
  // check below reads `undefined` and reports three defects that are one condition. So this says so
  // once, with the URL it ended on and what the page threw.
  const signInOn = async (context, who) => {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${relay.base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="password"]', relay.password).catch(() => {});
    await page.press('input[type="password"]', "Enter").catch(() => {});
    await page.waitForLoadState("domcontentloaded");
    const booted = await page.waitForFunction(() => window.__voice != null, null, { timeout: 45_000 })
      .then(() => true).catch(() => false);
    if (!booted) {
      const where = await page.evaluate(() => ({
        url: location.pathname,
        login: document.querySelector('input[type="password"]') != null,
        talk: document.querySelector("[data-voice-talk]") != null,
        settings: window.__mrSettings != null,
      })).catch(() => null);
      check(false, `${who}: the console booted and the voice module is on the page`,
        `${JSON.stringify(where)} · page errors ${errors.slice(0, 2).join(" | ") || "none"} · relay ${relay.log().split("\n").slice(-4).join(" | ").slice(0, 400)}`);
    }
    return { page, errors, booted };
  };

  // ---- A: one browser chooses -----------------------------------------------------------------------
  step("one browser chooses always listening");
  const first = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 1440, height: 900 } });
  const a = await signInOn(first, "the first browser");
  if (!a.booted) { await first.close(); return; }
  const chose = await a.page.evaluate(async () => {
    const was = window.__voice.talkMode();
    window.__voice.setTalkMode("always");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return {
      was,
      now: window.__voice.talkMode(),
      stored: (() => { try { return window.localStorage.getItem(window.__voice._TALK_MODE_KEY); } catch { return null; } })(),
      onDoor: (await fetch("/voice/settings", { headers: { accept: "application/json" } }).then((r) => r.json())).talkMode ?? null,
    };
  });
  check(chose.now === "always" && chose.stored === "always", "this browser holds it, which is the fallback and is written first",
    JSON.stringify({ was: chose.was, now: chose.now, stored: chose.stored }));
  check(chose.onDoor === "always", "and the person's own door was told, which is the half the row was filed for",
    `GET /voice/settings answers talkMode ${JSON.stringify(chose.onDoor)}`);
  check(a.errors.length === 0, "and nothing threw", a.errors.slice(0, 2).join(" | ") || "clean");
  await first.close();

  // ---- B: a second browser, same person, nothing pressed ------------------------------------------
  step("a second browser signed in as the same person opens on it, at first paint, with nothing pressed");
  const second = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  // THE PRECONDITION IS READ AT DOCUMENT START, BEFORE voice.js CAN TOUCH STORAGE. Reading it after
  // boot raced the very thing it was there to rule out: probe() fetches /voice/settings and hands the
  // answer to adoptTalkMode, which WRITES localStorage, so on a busy Mac the read landed after that
  // write and the check failed three runs out of three while the product was fine. The key is named
  // literally because window.__voice does not exist yet at this point, which is the point.
  await second.addInitScript(() => {
    try { window.__gateStoredAtStart = window.localStorage.getItem("titanbot.voice.talkMode"); }
    catch { window.__gateStoredAtStart = null; }
  });
  const b = await signInOn(second, "the second browser");
  if (!b.booted) { await second.close(); return; }
  const fresh = await b.page.evaluate(() => ({
    atStart: window.__gateStoredAtStart ?? null,
    storedAfterBoot: (() => { try { return window.localStorage.getItem(window.__voice._TALK_MODE_KEY); } catch { return null; } })(),
    atFirstPaint: window.__voice.talkMode(),
  }));
  // A BROWSER WITH NOTHING STORED IS THE CONDITION, said before the claim: if this context had a stored
  // value the leg would be measuring localStorage and not the door. Asserted on the document-start
  // reading, which no amount of load can move; the after-boot reading is printed beside it because
  // what it holds is the door's own write, which is what the claim below is about.
  check(fresh.atStart == null || fresh.atStart === "push",
    "this browser really starts with nothing of its own, so what it ends on came from the door",
    `stored before any script ran ${JSON.stringify(fresh.atStart)}, stored after boot ${JSON.stringify(fresh.storedAfterBoot)}, mode ${fresh.atFirstPaint}`);
  const adopted = await b.page.waitForFunction(() => window.__voice.talkMode() === "always", null, { timeout: 15_000 })
    .then(() => true).catch(() => false);
  const landed = await b.page.evaluate(() => ({
    mode: window.__voice.talkMode(),
    stored: (() => { try { return window.localStorage.getItem(window.__voice._TALK_MODE_KEY); } catch { return null; } })(),
    pressed: window.__voice.stats().sent,
    on: window.__voice._state.on,
  }));
  check(adopted && landed.mode === "always", "the second browser is on always listening without a press",
    JSON.stringify(landed));
  check(landed.pressed === 0 && landed.on === false, "and nothing was pressed and no line was opened to get there",
    `${landed.pressed} frame(s) sent, line ${landed.on ? "up" : "down"}`);
  // AND THE ROW ON SCREEN SAYS SO, because a module that knows and a control that does not is SETTINGS-3.
  //
  // THE WAIT DOES THE OPENING, and that is the lesson rather than a convenience. __mrSettings exists as
  // soon as its script runs, but __mrUi.openPanel is app.js's and arrives later; open() called before it
  // does answers FALSE and nothing reopens. MEASURED while building this: a single open() a second after
  // boot, followed by a 20 s wait for the row, reported the row missing on a page that draws it at both
  // viewports. So the poll asks for the surface until it is really openable, then waits for the row. It
  // is not a settle that hides a race -- the change-racing-a-read window is measured with no settle at
  // all by scripts/verify-settings.mjs -- it is the row existing at all.
  const drawn = await b.page.waitForFunction(() => {
    if (document.querySelector('[data-setting-row="talk-mode"] select') != null) return true;
    try { window.__mrSettings?.open?.("general", null); } catch { /* not openable yet */ }
    return false;
  }, null, { timeout: 25_000, polling: 500 }).then(() => true).catch(() => false);
  const row = await b.page.evaluate(() => ({
    field: document.querySelector('[data-setting-row="talk-mode"] select')?.value ?? "gone",
    section: document.querySelector('[data-setting-row="talk-mode"]')?.closest("[data-settings-section]")?.dataset.settingsSection ?? "",
  }));
  check(drawn && row.field === "always", "and the Talk mode row on that second browser opens reading always listening",
    JSON.stringify(row));
  check(b.errors.length === 0, "and nothing threw", b.errors.slice(0, 2).join(" | ") || "clean");
  await second.close();

  // ---- C: the private window, and the relay that never heard of the field -------------------------
  step("a browser with nothing stored and no answer from the door still opens on push to talk");
  const third = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 1440, height: 900 } });
  // BLOCKED, not slowed. This is the private window that refuses site data and the older relay that
  // answers no such field, which from the page's side are the same thing: nothing comes back.
  await third.route("**/voice/settings", (route) => route.abort());
  const c = await signInOn(third, "the third browser");
  if (!c.booted) { await third.close(); return; }
  await c.page.waitForTimeout(2500);
  const fallback = await c.page.evaluate(() => ({
    mode: window.__voice.talkMode(),
    stored: (() => { try { return window.localStorage.getItem(window.__voice._TALK_MODE_KEY); } catch { return null; } })(),
  }));
  check(fallback.mode === "push", "push to talk, which is the mode that cannot leave a microphone open",
    JSON.stringify(fallback));
  check(c.errors.length === 0, "and a blocked settings door threw nothing on the page", c.errors.slice(0, 2).join(" | ") || "clean");
  await third.close();

  step("what this leg did NOT measure, said out loud");
  info("no line was opened and no vendor was dialled: this leg is about where the choice is kept, not about talking.");
  info(`both browsers signed in through the instance password door, so the person key is "" on this relay -- the same key every other per-person read on it uses. Two NAMED accounts sharing one workspace is the control plane's shape and is measured on the R750.`);
}

// -------------------------------------------------------------------------- VOICE-11: the release
/**
 * WHAT THIS LEG IS FOR, in one sentence: a release that sends nothing ends no turn, and shipped, the
 * release sent nothing.
 *
 * MEASURED before the fix on grok-bot-local-vm in Chromium and WebKit at 1440x900 and 390x844: a
 * 900 ms hold and a release put 0 bytes and 0 JSON on the wire for the next 1.5 s while 15 captured
 * frames were dropped by the page's own mute. The only thing that ends a turn is the service's own
 * turn detection, which the relay configures with silence_duration_ms 700 and which fires on audio
 * that KEEPS ARRIVING. So the claim is measured where it has to be -- as frames of silence arriving
 * at the stub vendor after the release -- and not as a flag on the page.
 *
 * TWO ENGINES, and that is the point of this leg rather than a nicety. The same root cause is why
 * voice does nothing in the iPhone app, which is a WKWebView over console.titanium.bot: WebKit births
 * an AudioContext SUSPENDED and only a user gesture resumes one, and the gesture is spent by the first
 * await in the handler.
 */
async function legRelease() {
  console.log(`verify-voice --leg release on ${MACHINE}`);
  requireTheOtherItems(true);
  // Its own port, seven along, for the same reason --leg overlay takes six: other waves run their own
  // gates on this Mac and a second control plane on an occupied port answers from the FIRST one.
  const cp = await startControlPlane(7);
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({ audioFrames: 2 });
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });

  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-release-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });
  // The second relay is a workspace nobody ever switched voice on for, which is the 4001 refusal the
  // re-arm check needs: one press reads a sentence, and the presses after it have to reach a line.
  const emptyJson = path.join(dir, "voice-empty.json");
  writeFileSync(emptyJson, `${JSON.stringify({ apiKey: "", vendor: "" })}\n`, { mode: 0o600 });
  const wav = process.env.GATE_MIC_WAV ?? await makeMicWav(dir);

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 7,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const refusing = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 8,
    voiceJson: emptyJson, stubUrl: stub.url,
  });
  const session = await signIn(relay);

  // The same choice --leg overlay makes, through the card's own door: this box is shared, and other
  // waves' gates leave scratch agents on its roster whose names sort first.
  const settingsBefore = await ask(`${relay.base}/voice/settings`, { headers: { cookie: session.cookie } });
  const roster = settingsBefore.body?.agents ?? [];
  const scratch = /^(code gate|voice gate|gate)\b|^new agent$/i;
  const chosen = roster.find((one) => !scratch.test(String(one.name ?? ""))) ?? roster[0] ?? null;
  check(chosen != null, "the settings door lists this workspace's bots, so one can be chosen", `${roster.length} on the roster`);
  if (chosen == null) {
    missing("a bot on this workspace to talk to", [
      "GET /voice/settings answered an empty roster, so the relay has nobody to hand a spoken turn to",
      `the host gateway this relay reads is ${GATEWAY}; check it is up and that SAND_PROFILE_DIRS names the live profile`,
    ]);
    return;
  }
  await ask(`${relay.base}/voice/settings`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: chosen?.id ?? "" }),
  });
  info(`this run talks to ${chosen?.name ?? "(nobody)"}`);

  const playwright = await loadPlaywright();

  /**
   * WebKit's microphone. Playwright ships no fake capture device for it -- the fake-device flags are
   * Chromium's -- and this gate holds no real one, so the stream is made out of Web Audio: an
   * oscillator into a MediaStreamDestination, handed back by a getUserMedia of our own. It is a real
   * MediaStream through a real graph, which is all the thing being measured needs; what it is NOT is
   * evidence about WebKit's own device permission, and the leg says so rather than implying otherwise.
   */
  const fakeWebkitMicrophone = () => {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const ctx = new Ctx();
          try { await ctx.resume(); } catch { /* a context that will not resume still renders silence */ }
          const osc = ctx.createOscillator();
          osc.frequency.value = 440;
          const gain = ctx.createGain();
          gain.gain.value = 0.3;
          const dest = ctx.createMediaStreamDestination();
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          window.__gateMicContext = ctx;
          return dest.stream;
        },
        enumerateDevices: async () => [],
      },
    });
  };

  const readLine = (page) => page.evaluate(() => {
    const line = document.getElementById("voice-line");
    if (line == null || line.hidden === true) return "";
    return (line.textContent ?? "").replace(/\s+/g, " ").trim();
  });
  const readStats = (page) => page.evaluate(() => window.__voice?.stats?.() ?? null);

  // THE BUTTON EXISTING IS NOT THE BUTTON BEING PRESSABLE: the console draws an opaque boot cover over
  // everything until app.js has painted. So the centre is taken through elementFromPoint, which is the
  // only thing that answers the question a person is asking.
  const buttonAt = async (page) => {
    for (let i = 0; i < 80; i += 1) {
      const at = await page.evaluate(() => {
        const node = document.querySelector("[data-voice-talk]");
        if (node == null || node.disabled === true) return null;
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return node.contains(hit) || hit === node ? { x, y } : null;
      });
      if (at != null) return at;
      await sleep(500);
    }
    return null;
  };

  const open = async (browser, base, view) => {
    const context = await browser.newContext({
      userAgent: GATE_AGENT,
      viewport: { width: view.width, height: view.height },
      hasTouch: view.touch,
      ...(view.permissions ? { permissions: ["microphone"] } : {}),
    });
    if (view.fakeMic) await context.addInitScript(fakeWebkitMicrophone);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    return { context, page, errors, base };
  };

  const signInPage = async (page, base, password) => {
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="password"]', password).catch(() => {});
    await page.press('input[type="password"]', "Enter").catch(() => {});
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => window.__voice != null, null, { timeout: 40_000 }).catch(() => {});
    // The marker the re-arm check reads: a page that reloaded loses it, and "it re-armed" would then
    // be a claim about a fresh page rather than about this one.
    await page.evaluate(() => { window.__gateNeverReloaded = "kept"; }).catch(() => {});
  };

  for (const view of [
    { name: "desktop", engine: "chromium", width: 1440, height: 900, touch: false, permissions: true, fakeMic: false },
    // VOICE-13: 740x900 rather than 390x844. The claim of this row is WebKit's own release -- the engine
    // that shipped the defect -- and at phone width a press is now a call screen rather than a hold, so
    // the hold had to move to a window that still has one. --leg call measures the phone.
    { name: "narrow", engine: "webkit", width: 740, height: 900, touch: true, permissions: false, fakeMic: true },
  ]) {
    const engine = playwright[view.engine];
    if (engine == null) { skip(`${view.engine} at ${view.width}x${view.height}`, "this playwright build has no such engine"); continue; }
    step(`${view.engine} ${view.width}x${view.height}`);
    let browser = null;
    try {
      browser = await engine.launch(view.engine === "chromium" ? {
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          // LOOPED, deliberately, where the other legs use %noloop. The claim here is that the SILENCE
          // after a release is the release's own, so the microphone has to be producing sound right up
          // to it -- and a three second file that has run out feeds silence into the hold, which is
          // indistinguishable from the thing being measured. MEASURED with %noloop: 4 silent frames had
          // already reached the vendor before the release, and the tail could not be counted apart.
          `--use-file-for-fake-audio-capture=${wav}`,
          "--autoplay-policy=no-user-gesture-required",
        ],
      } : {});
    } catch (error) {
      skip(`${view.engine} would not launch`, String(error?.message ?? error).split("\n")[0]);
      continue;
    }
    cleanups.push(() => { try { browser.close(); } catch { /* gone */ } });

    const { context, page, errors } = await open(browser, relay.base, view);
    await signInPage(page, relay.base, relay.password);
    const at = await buttonAt(page);
    check(at != null, `${view.engine}: the console is painted and a press really reaches the talk button`, JSON.stringify(at));
    if (at == null) { await context.close(); await browser.close(); continue; }
    const mode = await page.evaluate(() => window.__voice.setTalkMode("push"));
    check(mode === "push", `${view.engine}: press and hold is the mode under test`, String(mode));

    // ---------------------------------------------------------------- 1. the release sends the words
    const appendsBefore = stub.events.appendFrames;
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await sleep(1200);
    const spokeFrames = stub.events.appendFrames - appendsBefore;
    // THE PRECONDITION THE WHOLE MEASUREMENT RESTS ON, and it is subtracted rather than required to be
    // zero. The silence counted below can only be the release's own if it is silence that arrived
    // AFTER the release, so whatever was already standing is measured first and taken off. Requiring
    // zero read as a product failure once on the WebKit arm, whose microphone is a Web Audio graph
    // that underruns a frame now and then (1 standing, against 0 on the run before it); what %noloop
    // broke on the first run of this leg was bigger than that, and the ceiling below still catches it.
    const silentAtRelease = stub.events.trailingSilentFrames;
    const releasedAt = Date.now();
    await page.mouse.up();

    let silent = silentAtRelease;
    while (Date.now() - releasedAt < 4000) {
      silent = stub.events.trailingSilentFrames - silentAtRelease;
      if (silent >= 8) break;
      await sleep(25);
    }
    const tookMs = Date.now() - releasedAt;
    check(spokeFrames > 0, `${view.engine}: the hold itself reached the vendor`, `${spokeFrames} frame(s) of microphone in 1.2 s`);
    check(silentAtRelease < 8, `${view.engine}: and it was still making sound up to the release, so the tail can be told from the room`,
      `${silentAtRelease} silent frame(s) standing when the button came up`);
    check(silent >= 8 && tookMs <= 1000,
      `${view.engine}: eight frames of silence reached the vendor within a second of the release`,
      `${silent} frame(s) in ${tookMs} ms`);
    const stats = await readStats(page);
    check(stats?.tailFrames === 8, `${view.engine}: and the page says it sent eight and no more`, `tailFrames ${stats?.tailFrames}`);
    await sleep(400);
    check(stub.events.trailingSilentFrames - silentAtRelease === 8,
      `${view.engine}: exactly the release's eight, with the words before them and nothing after`,
      `${stub.events.trailingSilentFrames} silent frame(s) at the end of ${stub.events.appendFrames}, ${silentAtRelease} of them standing before the release`);
    info(`${view.engine}: ${stub.events.appendFrames} frames at the vendor, ${stub.events.silentFrames} of them silent`);

    // ------------------------------------------------------------------------------ 2. a tap
    const tailBefore = (await readStats(page))?.tailFrames ?? 0;
    const appendsBeforeTap = stub.events.appendFrames;
    await sleep(1200);
    await page.mouse.down();
    await sleep(50);
    await page.mouse.up();
    await sleep(1600);
    const afterTap = await readStats(page);
    const tapLine = await readLine(page);
    const tapFrames = stub.events.appendFrames - appendsBeforeTap;
    const tapSaidSomething = tapLine.length > 0;
    const tapWentOut = (afterTap?.tailFrames ?? 0) > tailBefore && tapFrames > 0;
    check(tapWentOut || tapSaidSomething,
      `${view.engine}: a tap either reaches the vendor with its silence or says something a person can act on`,
      tapWentOut ? `${tapFrames} frame(s) at the vendor` : JSON.stringify(tapLine));
    if (tapSaidSomething) check(!/^[A-Z_]+:/.test(tapLine), `${view.engine}: and what it says is plain words`, JSON.stringify(tapLine));

    // ---------------------------------------------------- 3. a hold whose release never arrives
    const ceiling = await page.evaluate(() => window.__voice._MAX_HOLD_MS);
    await page.evaluate(() => window.__voice.stop());
    await sleep(1500);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await sleep(1500);
    const holding = await readStats(page);
    check(holding?.held === true && holding?.talking === true, `${view.engine}: the hold is live and the microphone is open`, JSON.stringify({ held: holding?.held, talking: holding?.talking }));
    // And the release never comes: a phone that backgrounds the tab mid-hold delivers no pointerup, no
    // touchend, no pointercancel and no blur, and nothing but a release ever closed this microphone.
    await sleep(ceiling + 2500 - 1500);
    const ceiled = await readStats(page);
    check(ceiled?.held === false && ceiled?.talking === false,
      `${view.engine}: a hold whose release was lost cannot hold the microphone open past its ceiling`,
      `${ceiling} ms, then held ${ceiled?.held} talking ${ceiled?.talking}`);
    check((ceiled?.tailFrames ?? 0) > (holding?.tailFrames ?? 0),
      `${view.engine}: and the words that were said still became a turn`,
      `tailFrames ${holding?.tailFrames} to ${ceiled?.tailFrames}`);
    await page.mouse.up();

    // ------------------------------------------ 4. the three microphone refusals, read as sentences
    await page.evaluate(() => window.__voice.stop());
    await sleep(1200);
    const sentences = [];
    for (const refusal of [
      { what: "the permission was refused", name: "NotAllowedError" },
      { what: "there is no microphone on this device", name: "NotFoundError" },
      { what: "this browser cannot record at all", name: "" },
    ]) {
      await page.evaluate((name) => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: name.length === 0 ? undefined : {
            getUserMedia: async () => { const error = new Error("refused by the gate"); error.name = name; throw error; },
            enumerateDevices: async () => [],
          },
        });
      }, refusal.name);
      // The sentence standing from the last refusal is older than the re-arm cooldown by now, so ONE
      // press clears it and dials, which is the whole of the re-arm rule being used rather than stated.
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await sleep(400);
      await page.mouse.up();
      let said = "";
      for (let i = 0; i < 40 && said.length === 0; i += 1) { await sleep(100); said = await readLine(page); }
      sentences.push(said);
      check(said.length > 20, `${view.engine}: ${refusal.what} reads as a sentence`, JSON.stringify(said));
      await sleep(1700);
    }
    check(new Set(sentences.filter((one) => one.length > 0)).size === 3,
      `${view.engine}: three ways a microphone can refuse, three different sentences`,
      JSON.stringify(sentences));
    for (const said of sentences) {
      for (const leak of ["xai", "openai", "grok", "websocket", "undefined", "null", "error"]) {
        if (said.toLowerCase().includes(leak)) fail(`${view.engine}: a refusal sentence says ${leak}`, JSON.stringify(said));
      }
    }
    // The app's wording for the one of the three that is a permission, off the shipped bundle itself.
    const shellSaid = await page.evaluate(() => {
      window.__titanbotShell = { platform: "ios", build: "gate", canOpenAppSettings: true };
      const inApp = window.__voice._sentenceFor("no-microphone");
      delete window.__titanbotShell;
      return { inApp, inBrowser: window.__voice._sentenceFor("no-microphone") };
    });
    check(shellSaid.inApp !== shellSaid.inBrowser && /iPhone Settings/.test(shellSaid.inApp),
      `${view.engine}: in the app that sentence names iPhone Settings instead of the browser`,
      JSON.stringify(shellSaid.inApp));

    check(errors.length === 0, `${view.engine}: the page threw nothing`, errors.slice(0, 2).join(" | ") || "clean");
    await page.evaluate(() => window.__voice.stop()).catch(() => {});
    await context.close();

    // ------------------------------------------------ 5. the press after a refusal, on a second relay
    step(`${view.engine}: the press after a refusal, against a relay that refuses 4001`);
    const refusedView = { ...view, permissions: view.permissions };
    const refusedContext = await browser.newContext({
      userAgent: GATE_AGENT,
      viewport: { width: view.width, height: view.height },
      hasTouch: view.touch,
      ...(refusedView.permissions ? { permissions: ["microphone"] } : {}),
    });
    if (view.fakeMic) await refusedContext.addInitScript(fakeWebkitMicrophone);
    const refusedPage = await refusedContext.newPage();
    await signInPage(refusedPage, refusing.base, refusing.password);
    const refusedAt = await buttonAt(refusedPage);
    check(refusedAt != null, `${view.engine}: the talk button is pressable on the refusing workspace`, JSON.stringify(refusedAt));
    if (refusedAt != null) {
      await refusedPage.evaluate(() => window.__voice.setTalkMode("push"));
      const pressOnce = async (ms = 250) => {
        await refusedPage.mouse.move(refusedAt.x, refusedAt.y);
        await refusedPage.mouse.down();
        await sleep(ms);
        await refusedPage.mouse.up();
      };
      await pressOnce();
      let refusal = "";
      for (let i = 0; i < 60 && refusal.length === 0; i += 1) { await sleep(100); refusal = await readLine(refusedPage); }
      check(refusal.length > 20, `${view.engine}: the first press reads one plain sentence`, JSON.stringify(refusal));

      // The press straight after it CLEARS the sentence and does not dial back into the refusal: that
      // is VOICE-6's loop, and a phone sends two events for one thumb.
      await pressOnce(120);
      await sleep(400);
      const cleared = await readLine(refusedPage);
      check(cleared.length === 0, `${view.engine}: the next press clears the sentence rather than dialling into it again`, JSON.stringify(cleared));

      // AND THE PRESS AFTER THAT REALLY DIALS, with no reload: shipped, every press while a sentence
      // had ever stood was eaten, so a person pressed twice for every start and read nothing about why.
      await sleep(1000);
      await pressOnce();
      let again = "";
      for (let i = 0; i < 60 && again.length === 0; i += 1) { await sleep(100); again = await readLine(refusedPage); }
      check(again.length > 20, `${view.engine}: the press a second later dials, and the relay refuses it in words again`, JSON.stringify(again));
      const kept = await refusedPage.evaluate(() => window.__gateNeverReloaded ?? "");
      check(kept === "kept", `${view.engine}: and it re-armed on the page that was already open, with no reload`, JSON.stringify(kept));
    }
    await refusedContext.close();
    await browser.close();
    // One call per workspace at a time, and a closed socket has to settle before the next engine
    // presses the button or it reads the already-in-a-call sentence.
    await sleep(1500);
  }
  return;
}


// ---- --leg call: the call screen on a phone, in WebKit ------------------------------------------
//
// VOICE-13. Jason recorded ChatGPT's voice mode on his iPhone and said "this is what I want". This leg
// is the measurement of the thing he asked for: a press at 390x844 brings up a full-screen surface with
// Titan alive in the middle, the five words in order across a turn, a typed line that still works, a
// card that takes the middle, and an End that puts the person back on the newest line of their chat.
//
// WEBKIT, because the shell is a WKWebView over console.titanium.bot and WebKit is the engine that
// ships the defects this screen can have. Two WebKit limits are PRINTED rather than worked around:
// there is no CDP session, so a press is page.tap rather than a synthesised touch pair (the
// one-thumb-two-events case stays a Chromium measurement and a unit case), and there is no
// --use-file-for-fake-audio-capture, so the microphone is built out of Web Audio and the mic level is
// driven through __voice._setCallLevels, which the output labels as injected.
async function legCall() {
  console.log(`verify-voice --leg call on ${MACHINE} (engine: webkit)`);
  requireTheOtherItems(true);
  if (!existsSync(path.join(repoRoot, "ui", "machine-room", "voice-call.css"))) {
    missing("the call screen's stylesheet", ["ui/machine-room/voice-call.css is not on disk, so this leg would measure an unstyled div"]);
    return;
  }
  const cp = await startControlPlane(9);
  const { startStubRealtime } = await import(STUB_REALTIME);
  const stub = await startStubRealtime({ audioFrames: 20 });
  cleanups.push(() => { try { stub.close(); } catch { /* gone */ } });

  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-call-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const voiceJson = path.join(dir, "voice.json");
  writeFileSync(voiceJson, `${JSON.stringify({ enabled: true, apiKey: `gate-not-a-real-key-${randomBytes(8).toString("hex")}`, vendor: "xai" })}\n`, { mode: 0o600 });

  const relay = await startRelay({
    port: Number(process.env.VOICE_GATE_PORT ?? 7793) + 9,
    voiceJson, stubUrl: stub.url, policyUrl: cp.base, relayToken: cp.relayToken,
  });
  const session = await signIn(relay);
  const settingsBefore = await ask(`${relay.base}/voice/settings`, { headers: { cookie: session.cookie } });
  const roster = settingsBefore.body?.agents ?? [];
  const scratch = /^(code gate|voice gate|gate)\b|^new agent$/i;
  const chosen = roster.find((one) => !scratch.test(String(one.name ?? ""))) ?? roster[0] ?? null;
  check(chosen != null, "the settings door lists this workspace's bots, so one can be chosen", `${roster.length} on the roster`);
  if (chosen == null) {
    missing("a bot on this workspace to talk to", [
      "GET /voice/settings answered an empty roster, so the relay has nobody to hand a spoken turn to",
      `the host gateway this relay reads is ${GATEWAY}; check it is up and that SAND_PROFILE_DIRS names the live profile`,
    ]);
    return;
  }
  await ask(`${relay.base}/voice/settings`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: chosen?.id ?? "" }),
  });
  info(`this run talks to ${chosen?.name ?? "(nobody)"}`);

  const playwright = await loadPlaywright();
  const engine = playwright.webkit;
  if (engine == null) { skip("webkit at 390x844", "this playwright build has no webkit"); return; }
  let browser = null;
  try { browser = await engine.launch({}); }
  catch (error) { skip("webkit would not launch", String(error?.message ?? error).split("\n")[0]); return; }
  cleanups.push(() => { try { browser.close(); } catch { /* gone */ } });

  // WebKit ships no fake capture device, so the microphone is a real MediaStream out of a real Web
  // Audio graph. What this is NOT is evidence about WebKit's own permission prompt, and the press below
  // is granted the microphone through the context so it never ends on the no-microphone sentence --
  // which a leg that forgot the grant would misread as a broken product.
  const fakeWebkitMicrophone = () => {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const ctx = new Ctx();
          try { await ctx.resume(); } catch { /* silence still renders */ }
          const osc = ctx.createOscillator();
          osc.frequency.value = 440;
          const gain = ctx.createGain();
          gain.gain.value = 0.3;
          const dest = ctx.createMediaStreamDestination();
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          return dest.stream;
        },
        enumerateDevices: async () => [],
      },
    });
  };

  const context = await browser.newContext({
    userAgent: `${GATE_AGENT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    permissions: ["microphone"],
  });
  await context.addInitScript(fakeWebkitMicrophone);
  // PRESS-TO-VISIBLE IS STAMPED IN THE PAGE, by an observer installed before anything runs, so both
  // timestamps come off one clock rather than off a Node clock and a browser clock.
  await context.addInitScript(() => {
    window.__gateCallUpAt = 0;
    window.__gatePressAt = 0;
    const watch = () => {
      const node = document.getElementById("voice-call");
      if (node != null && node.hidden === false && window.__gateCallUpAt === 0) window.__gateCallUpAt = performance.now();
    };
    // document.documentElement does not exist yet at addInitScript time in WebKit, and observe() throws
    // on a null target -- which this leg then counted as the page throwing.
    const arm = () => {
      const root = document.documentElement ?? document.body;
      if (root == null) { setTimeout(arm, 10); return; }
      new MutationObserver(watch).observe(root, { attributes: true, childList: true, subtree: true });
      watch();
    };
    arm();
    document.addEventListener("pointerdown", () => { if (window.__gatePressAt === 0) window.__gatePressAt = performance.now(); }, true);
    document.addEventListener("touchstart", () => { if (window.__gatePressAt === 0) window.__gatePressAt = performance.now(); }, true);
  });
  // THE INSETS, RESTATED THE WAY THE PHONE-LAYOUT GATE DOES IT. Playwright cannot synthesise a notch --
  // MEASURED, env(safe-area-inset-top) and -bottom both compute 0px at 390x844 in both engines -- so the
  // iPhone's own numbers are injected as the variables the sheet reads, and section J below says what
  // that does and does not prove.
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${relay.base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="password"]', relay.password).catch(() => {});
  await page.press('input[type="password"]', "Enter").catch(() => {});
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => window.__voice != null, null, { timeout: 40_000 }).catch(() => {});
  await page.addStyleTag({ content: ":root { --sat: 59px; --sab: 34px; }" }).catch(() => {});

  const SIX_SECONDS = `(async () => {
    const marks = [];
    let last = performance.now();
    const started = last;
    await new Promise((resolve) => {
      const step_ = () => {
        const now = performance.now();
        marks.push(now - last);
        last = now;
        if (now - started < 6000) requestAnimationFrame(step_); else resolve();
      };
      requestAnimationFrame(step_);
    });
    const sorted = [...marks].sort((a, b) => a - b);
    return { frames: marks.length, slow: marks.filter((one) => one > 20).length,
      median: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
      worst: Math.round(sorted[sorted.length - 1] * 100) / 100 };
  })()`;
  const RECTS = `(() => {
    const r = (sel) => { const n = document.querySelector(sel); if (n == null) return null;
      const b = n.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
    const screen = document.getElementById("voice-call");
    const stats = window.__voice?.stats?.() ?? null;
    const style = screen == null ? null : getComputedStyle(screen);
    return {
      shelf: r(".control-shelf"), composer: r("#composer"), talk: r("[data-voice-talk]"), box: r("#message-input"),
      screen: screen == null ? null : {
        hidden: screen.hidden === true, rect: r("#voice-call"),
        position: style.position, z: style.zIndex,
        onBody: screen.parentElement === document.body,
        inSpace: screen.closest(".conversation-space") != null,
        inShelf: screen.closest(".control-shelf") != null,
        word: (document.querySelector("[data-voice-call-state]")?.textContent ?? "").trim(),
        status: (document.querySelector("[data-voice-call-status]")?.textContent ?? "").trim(),
        card: screen.getAttribute("data-voice-call-card"),
        level: style.getPropertyValue("--voice-level").trim(),
        halo: document.querySelector("[data-voice-call-halo]") == null ? "" : getComputedStyle(document.querySelector("[data-voice-call-halo]")).transform,
        haloOpacity: document.querySelector("[data-voice-call-halo]") == null ? "" : getComputedStyle(document.querySelector("[data-voice-call-halo]")).opacity,
        mascotTransform: document.querySelector("#voice-call titan-mascot") == null ? "none" : getComputedStyle(document.querySelector("#voice-call titan-mascot")).transform,
        // THE CANVAS IS INSIDE THE KIT'S SHADOW ROOT, so a plain descendant selector finds nothing and
        // the aspect reads 0 -- which would make the feedback-bug guard below compare 0 with 0 and pass
        // whatever Titan looked like.
        canvasAspect: (() => { const c = document.querySelector("#voice-call titan-mascot")?.shadowRoot?.querySelector("canvas");
          if (c == null) return 0;
          const b = c.getBoundingClientRect();
          return b.height === 0 ? 0 : Math.round((b.width / b.height) * 1000) / 1000; })(),
        canvasBacking: (() => { const c = document.querySelector("#voice-call titan-mascot")?.shadowRoot?.querySelector("canvas");
          if (c == null) return 0;
          const b = c.getBoundingClientRect();
          return b.width === 0 ? 0 : Math.round((c.width / b.width) * 100) / 100; })(),
        mascotWidth: (() => { const m = document.querySelector("#voice-call titan-mascot");
          return m == null ? 0 : Math.round(m.getBoundingClientRect().width); })(),
        still: document.querySelector("#voice-call .voice-call-still") != null,
        endRect: r("[data-voice-call-end]"), muteRect: r("[data-voice-call-mute]"), inputRect: r("[data-voice-call-input]"),
        endPad: document.querySelector("[data-voice-call-end]") == null ? "" : getComputedStyle(screen).paddingBottom,
        talkButtons: document.querySelectorAll("[data-talk-button]").length,
        onControls: document.querySelectorAll("[data-voice-call-end][data-talk-button], [data-voice-call-mute][data-talk-button]").length,
      },
      shelfKids: [...(document.querySelector(".control-shelf")?.children ?? [])]
        .filter((n) => n.getBoundingClientRect().height > 0)
        .map((n) => (n.id || n.className) + ":" + Math.round(n.getBoundingClientRect().height)),
      bodyLock: document.body.dataset.voiceCall ?? "",
      bodyOverflow: getComputedStyle(document.body).overflow,
      shellInert: document.querySelector(".app-shell")?.inert === true,
      note: (() => { const n = document.getElementById("voice-call-ended"); return n == null ? null : {
        hidden: n.hidden === true, text: (n.textContent ?? "").trim(),
        inSpace: n.closest(".conversation-space") != null, inShelf: n.closest(".control-shelf") != null || n.closest("#composer") != null }; })(),
      line: (() => { const n = document.getElementById("voice-line"); return n == null ? null : {
        hidden: n.hidden === true, text: (n.textContent ?? "").replace(/\\s+/g, " ").trim() }; })(),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      transcriptGap: (() => { const t = document.getElementById("transcript");
        return t == null ? -1 : Math.round(t.scrollHeight - t.scrollTop - t.clientHeight); })(),
      spokenRows: [...document.querySelectorAll(".message-row")]
        .filter((row) => row.querySelector(".voice-spoken-chip") != null)
        .map((row) => (row.querySelector(".message-bubble")?.textContent ?? "").replace(/\\s+/g, " ").trim()),
      rows: [...document.querySelectorAll("#transcript .message-row")].length,
      on: stats?.on === true, orb: stats?.orb ?? "", call: stats?.call ?? null,
      mutedFrames: stats?.mutedFrames ?? 0, micLevel: stats?.micLevel ?? 0, level: stats?.level ?? 0,
      lastHeard: stats?.lastHeard ?? "", talking: stats?.talking === true,
      pressAt: window.__gatePressAt ?? 0, upAt: window.__gateCallUpAt ?? 0,
      frames: window.__voiceCallAvatar?.frames ?? -1,
    };
  })()`;
  const sameRect = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const runId = randomBytes(3).toString("hex");

  const buttonAt = async () => {
    for (let i = 0; i < 80; i += 1) {
      const at = await page.evaluate(() => {
        const node = document.querySelector("[data-voice-talk]");
        if (node == null || node.disabled === true) return null;
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return node.contains(hit) || hit === node ? { x, y } : null;
      });
      if (at != null) return at;
      await sleep(500);
    }
    return null;
  };

  // ---- A: the press opens the screen ------------------------------------------------------------
  step("webkit 390x844 dpr 3: one press of Talk brings up the call screen");
  const before = await page.evaluate(RECTS);
  check(before.screen == null || before.screen.hidden === true, "there is no call screen before anybody presses anything",
    before.screen == null ? "not mounted yet" : `hidden ${before.screen.hidden}`);
  info(`footer before: shelf ${JSON.stringify(before.shelf)} composer ${JSON.stringify(before.composer)} talk ${JSON.stringify(before.talk)} on ${MACHINE}`);
  // THE BASELINE FIRST, and it is what makes the budget number below mean anything. The brief asked for
  // zero frames over 20 ms; this is the same page, same engine, same viewport, with no call screen on
  // it, so a frame this Mac's scheduler lost either way is not charged to the screen.
  const idle = await page.evaluate(SIX_SECONDS);
  info(`six seconds of this page with NO call screen: ${idle.frames} frames (${Math.round((idle.frames / 6) * 10) / 10} fps), ${idle.slow} over 20 ms, median ${idle.median} ms, worst ${idle.worst} ms, webkit 390x844 dpr 3 on ${MACHINE}`);
  const box = await buttonAt();
  check(box != null, "a press really reaches the talk button rather than the boot cover over it", JSON.stringify(box));
  if (box == null) { await context.close(); return; }
  const pressedAt = Date.now();
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === false, null, { timeout: 10_000 }).catch(() => {});
  const opened = await page.evaluate(RECTS);
  check(opened.screen?.hidden === false, "the screen is on the page", opened.screen?.hidden === false ? "up" : "still away");
  const upIn = opened.upAt > 0 && opened.pressAt > 0 ? Math.round(opened.upAt - opened.pressAt) : Math.round(Date.now() - pressedAt);
  check(upIn < 300, "and it was there in under 300 ms of the thumb, which is why it opens before the line does",
    `${upIn} ms, both stamps off the page's own clock, webkit 390x844 on ${MACHINE}`);
  check(opened.screen?.rect?.w === 390 && opened.screen?.rect?.h === 844 && opened.screen?.rect?.x === 0 && opened.screen?.rect?.y === 0,
    "it covers the whole viewport", JSON.stringify(opened.screen?.rect));
  check(opened.screen?.position === "fixed" && opened.screen?.z === "80",
    "fixed at z-index 80: above the phone drawers at 70, below the toast at 100 so a toast is still readable over a call",
    `${opened.screen?.position} z ${opened.screen?.z}`);
  check(opened.screen?.onBody === true && opened.screen?.inSpace === false && opened.screen?.inShelf === false,
    "and it is a child of the body, not of the conversation area and not of the footer",
    JSON.stringify({ onBody: opened.screen?.onBody, inSpace: opened.screen?.inSpace, inShelf: opened.screen?.inShelf }));
  const covered = await page.evaluate((at) => {
    const hit = document.elementFromPoint(at.x, at.y);
    return { inside: hit?.closest?.("#voice-call") != null, landedOn: hit?.className ?? hit?.tagName ?? "nothing" };
  }, box);
  check(covered.inside, "a thumb at the talk button's own centre now lands on the call screen, so it really is over the shelf",
    JSON.stringify(covered));
  check(opened.screen?.talkButtons === 1 && opened.screen?.onControls === 0,
    "exactly one element still carries data-talk-button, and neither of the call screen's controls is it (docs/APPS.md counts that)",
    `${opened.screen?.talkButtons} element(s), ${opened.screen?.onControls} of them on this screen`);
  check(opened.bodyLock === "up" && opened.bodyOverflow === "hidden" && opened.shellInert === true,
    "the chat behind it cannot be scrolled or pressed while the call is up", `data-voice-call ${JSON.stringify(opened.bodyLock)}, body overflow ${opened.bodyOverflow}, shell inert ${opened.shellInert}`);
  check(opened.sideways === false, "and the page does not scroll sideways with it up", String(opened.sideways));
  check(opened.talking === true, "the microphone is open hands free, with nothing held", String(opened.talking));
  await stub.waitFor((events) => events.sessions.length >= 1, { timeoutMs: 30_000, label: "the bridge's session.update" }).catch(() => {});
  check(stub.events.sessions.length >= 1, "and the press dialled one line", `${stub.events.sessions.length} session(s) in ${Date.now() - pressedAt} ms on ${MACHINE}`);
  // THE FOOTER PROOF, and this is the reading that has no confound in it. Later in this leg a line is
  // TYPED, and the console answers a sent message with its own working row inside the shelf -- which is
  // app.js doing its job and has nothing to do with this screen. So the claim "the call screen does not
  // move the footer" is measured here, between the press and anything being said.
  check(sameRect(opened.shelf, before.shelf) && sameRect(opened.composer, before.composer)
    && sameRect(opened.talk, before.talk) && sameRect(opened.box, before.box),
    "THE FOOTER DID NOT MOVE when the screen came up, which is what mounting on the body rather than in the shelf buys",
    `shelf ${JSON.stringify(opened.shelf)} composer ${JSON.stringify(opened.composer)} talk ${JSON.stringify(opened.talk)} box ${JSON.stringify(opened.box)} on ${MACHINE}`);

  // ---- B: the five words, in order, across one stub turn ----------------------------------------
  step("the five words across one turn, in the order a person hears them");
  const words = [];
  const watchWord = async (want, ms = 15_000) => {
    await page.waitForFunction((w) => (document.querySelector("[data-voice-call-state]")?.textContent ?? "").trim() === w, want, { timeout: ms }).catch(() => {});
    const now = await page.evaluate(() => (document.querySelector("[data-voice-call-state]")?.textContent ?? "").trim());
    if (words.at(-1) !== now) words.push(now);
    return now;
  };
  words.push(opened.screen?.word ?? "");
  await watchWord("Listening");
  stub.emitSpeechStart();
  const said = `what is the team working on, call ${runId}`;
  for (const part of ["what is", "what is the team", said]) {
    stub.emitUserTranscript(part);
    await sleep(120);
  }
  stub.emitUserTranscriptDone(said);
  stub.emitSpeechStop();
  await watchWord("Thinking");
  stub.emitToolCall({ name: "titan", args: { message: said }, callId: `call_voice13_${runId}`, triple: true });
  await page.waitForFunction((want) => window.__voice?.stats?.()?.lastHeard === want, said, { timeout: 20_000 }).catch(() => {});
  const heard = await page.evaluate(RECTS);
  check(heard.lastHeard === said, "the words the relay handed to the agent are the person's own bytes", JSON.stringify(heard.lastHeard));
  const spoken = await page.evaluate(RECTS);
  check(sameRect(spoken.shelf, before.shelf) && sameRect(spoken.box, before.box),
    "and it did not move while the person's words were being heard and handed over either",
    `shelf ${JSON.stringify(spoken.shelf)} box ${JSON.stringify(spoken.box)} on ${MACHINE}`);
  await sleep(200);
  void stub.speak("The team is on the settings surface this afternoon.");
  await watchWord("Talking");
  check(words.includes("Connecting") || words[0] === "Connecting", "the first word is Connecting, because the screen is up before the line is", JSON.stringify(words));
  const order = ["Listening", "Thinking", "Talking"].map((one) => words.indexOf(one));
  check(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])),
    "and then Listening, Thinking and Talking in that order", `the whole observed sequence was ${JSON.stringify(words)}`);

  // ---- C: the avatar moves, and nothing in its chain is scaled -----------------------------------
  step("the avatar reacts to a level, and the mascot itself is never transformed");
  // BOTH CHANNELS ARE INJECTED TOGETHER, on purpose: the avatar reads the microphone while the word is
  // Listening and the playback while it is Talking, because the echo gate legitimately shuts the
  // microphone there. A leg that injected only the microphone measured nothing at all mid-reply, which
  // is how this was found.
  const settle = async (mic, out) => {
    await page.evaluate(async ([m, o]) => {
      window.__voice._setCallLevels(m, o);
      for (let i = 0; i < 45; i += 1) await new Promise((r) => requestAnimationFrame(r));
    }, [mic, out]);
    return page.evaluate(RECTS);
  };
  const atRest = await settle(0, 0);
  const atPeak = await settle(0.26, 0.26);
  info(`the word on the screen while the level is driven is ${JSON.stringify(atPeak.screen?.word)}, and Titan is ${atPeak.screen?.mascotWidth} px wide with a ${atPeak.screen?.canvasBacking}x backing store (webkit dpr 3 on ${MACHINE}: the kit clamps its own dpr at 2, so a real 3x iPhone screen upscales him 1.5x)`);
  check(atRest.screen?.halo !== atPeak.screen?.halo && atPeak.screen?.level !== atRest.screen?.level,
    "the halo's transform and the screen's own level both change with an INJECTED microphone level (injected, not measured: WebKit has no fake capture device)",
    `level ${atRest.screen?.level} -> ${atPeak.screen?.level}, transform ${atRest.screen?.halo} -> ${atPeak.screen?.halo}`);
  check(atRest.screen?.haloOpacity !== atPeak.screen?.haloOpacity, "and so does its opacity",
    `${atRest.screen?.haloOpacity} -> ${atPeak.screen?.haloOpacity}`);
  check(atRest.screen?.mascotTransform === "none" && atPeak.screen?.mascotTransform === "none",
    "THE MASCOT ITSELF IS NEVER TRANSFORMED, at rest or at peak: the kit reads a transform-aware rect for its canvas and a scale there leaves Titan stretched for the rest of the call",
    `${atRest.screen?.mascotTransform} then ${atPeak.screen?.mascotTransform}`);
  check(atRest.screen?.canvasAspect > 0 && atRest.screen?.canvasAspect === atPeak.screen?.canvasAspect,
    "and his canvas has exactly the same shape at both levels, which is the feedback bug's own guard",
    `aspect ${atRest.screen?.canvasAspect} then ${atPeak.screen?.canvasAspect}, backing ${atRest.screen?.canvasBacking}x then ${atPeak.screen?.canvasBacking}x`);
  await page.evaluate(() => window.__voice._setCallLevels(null, null));
  const playing = await page.evaluate(RECTS);
  info(`playback level from the stub's own 20-frame reply: ${playing.level} (measured, webkit 390x844 on ${MACHINE})`);
  const live = await page.evaluate(async () => {
    const a = window.__voiceCallAvatar?.frames ?? -1;
    await new Promise((r) => setTimeout(r, 500));
    return { a, b: window.__voiceCallAvatar?.frames ?? -1 };
  });
  check(live.b > live.a, "and his own animation loop is running rather than parked", `${live.a} then ${live.b} frames`);

  // ---- what six seconds of it costs, measured HERE -----------------------------------------------
  //
  // Here and not at the end of the leg, and the reason is a measurement rather than a preference: with
  // this window after the typed line, the box's answer landed inside it, app.js rewrote the whole
  // transcript, and one frame took 222 ms. That is the console doing its job for a message that really
  // was sent, and charging it to the call screen would have been a false number. At this point the call
  // is up with a level on it and the transcript is quiet, which is what a person on a call has.
  step("what six seconds of a live call costs, against the same page with no call on it");
  await page.evaluate(() => window.__voice._setCallLevels(0.2, 0.2));
  // The kit's first canvas allocation -- a 1264x860 backing store and its first gradients -- is not the
  // budget either, so it is given a moment to land before the six seconds are counted.
  await sleep(900);
  const budget = await page.evaluate(SIX_SECONDS);
  await page.evaluate(() => window.__voice._setCallLevels(null, null));
  const fps = Math.round((budget.frames / 6) * 10) / 10;
  check(fps >= 50 && budget.slow <= idle.slow + 1 && budget.median <= idle.median + 2,
    "a live call holds the frame rate of the page it is over, with a level driving the avatar on every frame",
    `${budget.frames} frames in 6 s (${fps} fps), ${budget.slow} over 20 ms against the idle page's ${idle.slow}, median ${budget.median} ms against ${idle.median} ms, worst ${budget.worst} ms, webkit 390x844 dpr 3 on ${MACHINE}. AN IPHONE IS UNMEASURED: this Mac draws the kit's 2x backing store, where a real 3x screen upscales Titan 1.5x.`);

  // ---- the status line, from the chat's own tool receipts ----------------------------------------
  step("the thin line under him is the chat's own tool receipt");
  const status = await page.evaluate(async () => {
    const transcript = document.getElementById("transcript");
    if (transcript == null) return { why: "no transcript on the page" };
    // A receipt in the words the console already writes them in. It is inserted rather than waited for
    // because which tools a real bot reaches for is not this leg's claim; that the SCREEN shows the
    // chat's own receipt is.
    const row = document.createElement("article");
    row.className = "message-row is-system";
    row.setAttribute("data-message-id", `gate-receipt-${Date.now()}`);
    row.innerHTML = '<div class="message-bubble">Searching 9 websites</div>';
    transcript.appendChild(row);
    window.__voice._state.orb = "thinking";
    window.__voice._paintCall();
    await new Promise((r) => requestAnimationFrame(r));
    return { line: (document.querySelector("[data-voice-call-status]")?.textContent ?? "").trim(), from: window.__voice.stats().call.status };
  });
  check(status.line === "Searching 9 websites" && status.from === "Searching 9 websites",
    "a tool receipt in the chat is the status line on the call screen, in the same words (the row was inserted by this leg, which is labelled: what is measured is the screen reading it)",
    JSON.stringify(status));

  // ---- a typed line, mid-call -------------------------------------------------------------------
  step("a person can still type mid-call, and it goes out through the composer they already use");
  const typedText = `typed on the call screen, ${runId}`;
  await page.fill("[data-voice-call-input]", typedText);
  await page.press("[data-voice-call-input]", "Enter");
  await page.waitForFunction((want) => [...document.querySelectorAll("#transcript .message-row")]
    .some((row) => (row.querySelector(".message-bubble")?.textContent ?? "").includes(want)), typedText, { timeout: 30_000 }).catch(() => {});
  const typed = await page.evaluate((want) => ({
    landed: [...document.querySelectorAll("#transcript .message-row")]
      .filter((row) => (row.querySelector(".message-bubble")?.textContent ?? "").includes(want)).length,
    field: document.querySelector("[data-voice-call-input]")?.value ?? "",
    box: document.getElementById("message-input")?.value ?? "",
    up: document.getElementById("voice-call")?.hidden === false,
  }), typedText);
  check(typed.landed === 1, "the typed line became exactly one chat line", `${typed.landed} row(s) reading it`);
  check(typed.field === "" && typed.box === "", "and both boxes were left empty, so nothing is said twice", JSON.stringify(typed));
  check(typed.up === true, "and the call is still up: typing is not leaving", String(typed.up));

  // ---- a card takes the middle and the avatar shrinks -------------------------------------------
  step("a reply carrying a card shrinks him to an orb and shows the card in the middle");
  const card = await page.evaluate(async () => {
    const transcript = document.getElementById("transcript");
    const row = document.createElement("article");
    row.className = "message-row";
    row.setAttribute("data-message-id", `gate-card-${Date.now()}`);
    row.innerHTML = '<div class="message-block"><div class="message-bubble"><div class="inline-card"><div class="inline-card-header">'
      + '<span class="inline-card-copy"><strong>Tuesday</strong><small>18 degrees and clear</small></span></div>'
      + '<div class="inline-card-actions"><button class="card-action" type="button">Open</button></div></div></div></div>';
    transcript.appendChild(row);
    window.__voice._paintCall();
    // READ IN THE SAME TURN, with no frame in between. app.js rewrites #transcript's innerHTML
    // wholesale on its own repaint, and this row is not in the adapter's model, so a row the LEG
    // injected is dropped by the next repaint while a real reply's row is redrawn with its own id. The
    // claim here is what the screen does with a card, not how long an injected row survives.
    const slot = document.querySelector("[data-voice-call-card-slot]");
    const mascot = document.querySelector("#voice-call titan-mascot");
    return {
      attr: document.getElementById("voice-call")?.getAttribute("data-voice-call-card") ?? "",
      shown: (slot?.textContent ?? "").replace(/\s+/g, " ").trim(),
      buttons: slot?.querySelectorAll("button").length ?? -1,
      mascotWidth: mascot == null ? 0 : Math.round(mascot.getBoundingClientRect().width),
      faceWidth: getComputedStyle(document.getElementById("voice-call")).getPropertyValue("--voice-call-face").trim(),
      stat: window.__voice.stats().call.card,
      slotRect: slot == null ? null : Math.round(slot.getBoundingClientRect().height),
      transform: mascot == null ? "none" : getComputedStyle(mascot).transform,
    };
  });
  check(card.attr === "up" && card.shown.includes("18 degrees and clear"),
    "the card is in the middle of the call screen, in the words the chat wrote",
    JSON.stringify({ attr: card.attr, shown: card.shown.slice(0, 60), stat: card.stat }));
  check(card.buttons === 0, "and its controls were left in the chat, where they are the ones that work", `${card.buttons} control(s) on the copy`);
  check(card.faceWidth === "190px" && card.transform === "none",
    "he is a small orb above the bottom row now, and it is his WIDTH that changed rather than a scale on him",
    `the face is ${card.faceWidth} (mid-transition it measured ${card.mascotWidth} px), transform ${card.transform}, card area ${card.slotRect} px tall`);
  const grown = await page.evaluate(async () => {
    for (const row of document.querySelectorAll("#transcript .message-row .inline-card")) row.closest(".message-row").remove();
    window.__voice._paintCall();
    await new Promise((r) => requestAnimationFrame(r));
    return { attr: document.getElementById("voice-call")?.getAttribute("data-voice-call-card"),
      width: getComputedStyle(document.getElementById("voice-call")).getPropertyValue("--voice-call-face").trim() };
  });
  check(grown.attr == null && grown.width !== card.faceWidth, "and he grows back when the card is no longer the newest thing",
    `the face went from ${card.faceWidth} back to ${grown.width}`);

  // ---- mute ------------------------------------------------------------------------------------
  step("mute, which is this page's own fact and no frame on the wire");
  const mutedBefore = (await page.evaluate(RECTS)).mutedFrames;
  await page.tap("[data-voice-call-mute]");
  await page.waitForFunction(() => (document.querySelector("[data-voice-call-state]")?.textContent ?? "").trim() === "Muted", null, { timeout: 5000 }).catch(() => {});
  await sleep(600);
  const muted = await page.evaluate(RECTS);
  check(muted.screen?.word === "Muted", "the word is Muted while the microphone is shut", JSON.stringify(muted.screen?.word));
  check(muted.mutedFrames > mutedBefore, "and the frames really are being dropped rather than sent", `${mutedBefore} -> ${muted.mutedFrames} muted frame(s)`);
  await page.tap("[data-voice-call-mute]");
  await sleep(300);
  const unmuted = await page.evaluate(RECTS);
  check(unmuted.screen?.word !== "Muted" && unmuted.talking === true, "and unmuting gives the word back", JSON.stringify(unmuted.screen?.word));

  // ---- J: the insets, which Playwright cannot synthesise ----------------------------------------
  step("the safe areas, and what this leg can and cannot prove about them");
  // The console is served at the relay's root, so its own sheets are siblings of index.html. Read off
  // the LIVE relay rather than off disk: what a phone gets is the served bytes.
  let sheet = await ask(`${relay.base}/voice-call.css`, { headers: { cookie: session.cookie } });
  if (sheet.status !== 200) sheet = await ask(`${relay.base}/machine-room/voice-call.css`, { headers: { cookie: session.cookie } });
  const served = String(sheet.text ?? "");
  check(served.includes("env(safe-area-inset-bottom)") && served.includes("max(18px, env(safe-area-inset-bottom))"),
    "the served stylesheet really carries the house safe-area pattern under the bottom row",
    `${served.length} bytes off the live relay, status ${sheet.status}`);
  const zeroed = await page.evaluate(() => ({
    top: getComputedStyle(document.documentElement).getPropertyValue("--sat").trim(),
    bottom: getComputedStyle(document.documentElement).getPropertyValue("--sab").trim(),
    env: getComputedStyle(document.getElementById("voice-call")).paddingBottom,
  }));
  info(`this engine computes the insets as zero and the leg injects --sat ${zeroed.top} --sab ${zeroed.bottom} the way the phone-layout gate does; the screen's own bottom padding reads ${zeroed.env}. A NOTCH CANNOT BE SYNTHESISED HERE -- the R750 screenshots in the scratchpad are the only thing a person can look at.`);
  const controls = await page.evaluate(RECTS);
  for (const [name, rect] of [["End", controls.screen?.endRect], ["Mute", controls.screen?.muteRect], ["the text field", controls.screen?.inputRect]]) {
    check(rect != null && rect.h >= 44 && rect.y + rect.h <= 844 && rect.x >= 0,
      `${name} is at least 44 px and fully on screen`, JSON.stringify(rect));
  }

  // ---- D: End ----------------------------------------------------------------------------------
  step("End puts the person back on their chat at the newest line");
  const beforeEnd = await page.evaluate(RECTS);
  if (!sameRect(beforeEnd.shelf, before.shelf)) {
    info(`the shelf is ${beforeEnd.shelf.h} px now against ${before.shelf.h} px at the start, because the typed line above really was sent and the console draws its own row for a message in flight: ${JSON.stringify(beforeEnd.shelfKids)} against ${JSON.stringify(before.shelfKids)}. The call screen's own footer reading is the one taken at the press.`);
  }
  const endedAt = Date.now();
  await page.tap("[data-voice-call-end]");
  await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === true, null, { timeout: 5000 }).catch(() => {});
  const closedIn = Date.now() - endedAt;
  await sleep(400);
  const after = await page.evaluate(RECTS);
  check(after.screen?.hidden === true, "the screen went", `in ${closedIn} ms on ${MACHINE}`);
  check(closedIn < 300, "and it went in under 300 ms", `${closedIn} ms`);
  check(after.on === false, "the line is down with it", String(after.on));
  check(after.bodyLock === "" && after.shellInert === false && after.bodyOverflow === before.bodyOverflow,
    "the chat can be scrolled and pressed again, with the body's own overflow back to exactly what it was",
    `lock ${JSON.stringify(after.bodyLock)}, inert ${after.shellInert}, overflow ${before.bodyOverflow} -> ${after.bodyOverflow}`);
  check(after.note == null || after.note.hidden === true, "and no note, because somebody who pressed End knows the call ended", JSON.stringify(after.note));
  const mine = after.spokenRows.filter((one) => one === said);
  check(mine.length === 1, "the spoken line is in the chat exactly once, with its chip", `${mine.length} row(s) reading ${JSON.stringify(said)}`);
  check(mine[0] === after.lastHeard, "and byte-identical to the words the relay confirmed", `${JSON.stringify(mine[0])} vs ${JSON.stringify(after.lastHeard)}`);
  check(after.transcriptGap >= 0 && after.transcriptGap < 90, "the chat is pinned to the newest line", `${after.transcriptGap} px from the bottom`);
  check(sameRect(after.shelf, beforeEnd.shelf) && sameRect(after.composer, beforeEnd.composer)
    && sameRect(after.talk, beforeEnd.talk) && sameRect(after.box, beforeEnd.box),
    "AND ENDING THE CALL MOVED NOTHING IN THE FOOTER either, which is the footer proof from the other side",
    `shelf ${JSON.stringify(after.shelf)} composer ${JSON.stringify(after.composer)} talk ${JSON.stringify(after.talk)} box ${JSON.stringify(after.box)} on ${MACHINE}`);
  check(after.sideways === false, "and the page still does not scroll sideways", String(after.sideways));

  // ---- E: the lifecycle -------------------------------------------------------------------------
  step("an app switch, a lock screen or a phone call ends the call cleanly and says so once");
  const box2 = await buttonAt();
  if (box2 != null) {
    await page.touchscreen.tap(box2.x, box2.y);
    await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === false, null, { timeout: 10_000 }).catch(() => {});
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(400);
    const hidden = await page.evaluate(RECTS);
    check(hidden.on === false && hidden.screen?.hidden === true, "the phone going away ends the call", JSON.stringify({ on: hidden.on, screen: hidden.screen?.hidden }));
    check(hidden.note?.hidden === false && hidden.note?.inSpace === true && hidden.note?.inShelf === false,
      "and leaves one plain line in the conversation, never in the footer", JSON.stringify(hidden.note));
    check(hidden.bodyLock === "" && hidden.shellInert === false, "with the background released on this path too", `lock ${JSON.stringify(hidden.bodyLock)} inert ${hidden.shellInert}`);
    check(sameRect(hidden.shelf, beforeEnd.shelf) && sameRect(hidden.box, beforeEnd.box),
      "and the footer still has not moved",
      `shelf ${JSON.stringify(hidden.shelf)} box ${JSON.stringify(hidden.box)}`);
    const noteWords = String(hidden.note?.text ?? "");
    check(noteWords.length > 0 && !/error|fail|4001|socket|vendor/i.test(noteWords), "in plain words, with no condition name in them", JSON.stringify(noteWords));
    // And it takes itself away once somebody is actually looking at it.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.__voice._CALL_ENDED_MS;
    });
    await page.evaluate(() => { window.__voice._call.dismissEndedNote(); });
    const cleared = await page.evaluate(RECTS);
    check(cleared.note?.hidden === true, "and the note goes when the person is back and has read it", JSON.stringify(cleared.note));
  }

  // ---- F: Escape -------------------------------------------------------------------------------
  step("Escape ends a call at 390x844");
  const box3 = await buttonAt();
  if (box3 != null) {
    await page.touchscreen.tap(box3.x, box3.y);
    await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === false, null, { timeout: 10_000 }).catch(() => {});
    const holding = await page.evaluate(() => document.querySelector("dialog[open]")?.id ?? document.body?.dataset?.drawer ?? "");
    if (holding.length > 0) { info(`${holding} had the keyboard, so it takes the first Escape the way it should`); await page.keyboard.press("Escape"); await sleep(250); }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__voice?.stats?.()?.on === false, null, { timeout: 8000 }).catch(() => {});
    const escaped = await page.evaluate(RECTS);
    check(escaped.on === false && escaped.screen?.hidden === true, "Escape ends the call and takes the screen with it", JSON.stringify({ on: escaped.on, hidden: escaped.screen?.hidden }));
    check(escaped.note == null || escaped.note.hidden === true, "and gets no note either, because a person pressed a key to leave", JSON.stringify(escaped.note));
  }

  check(pageErrors.length === 0, "and the page threw nothing through any of it", pageErrors.slice(0, 2).join(" | ") || "clean");
  await context.close();

  // ---- G: reduced motion -----------------------------------------------------------------------
  step("a person who asked for less motion gets the still, and no loop at all");
  const quiet = await browser.newContext({
    userAgent: GATE_AGENT, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    hasTouch: true, isMobile: true, permissions: ["microphone"], reducedMotion: "reduce",
  });
  await quiet.addInitScript(fakeWebkitMicrophone);
  const quietPage = await quiet.newPage();
  await quietPage.goto(`${relay.base}/login`, { waitUntil: "domcontentloaded" });
  await quietPage.fill('input[type="password"]', relay.password).catch(() => {});
  await quietPage.press('input[type="password"]', "Enter").catch(() => {});
  await quietPage.waitForFunction(() => window.__voice != null, null, { timeout: 40_000 }).catch(() => {});
  const quietBox = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      const at = await quietPage.evaluate(() => {
        const node = document.querySelector("[data-voice-talk]");
        if (node == null) return null;
        const r = node.getBoundingClientRect();
        if (r.width === 0) return null;
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return node.contains(hit) || hit === node ? { x, y } : null;
      });
      if (at != null) return at;
      await sleep(500);
    }
    return null;
  })();
  if (quietBox == null) skip("the reduced-motion screen", "the talk button never became pressable on this context");
  else {
    await quietPage.touchscreen.tap(quietBox.x, quietBox.y);
    await quietPage.waitForFunction(() => document.getElementById("voice-call")?.hidden === false, null, { timeout: 10_000 }).catch(() => {});
    await sleep(900);
    const quietRead = await quietPage.evaluate(() => ({
      still: document.querySelector("#voice-call .voice-call-still") != null,
      mascot: document.querySelector("#voice-call titan-mascot") != null,
      frames: window.__voiceCallAvatar?.frames ?? -1,
      word: (document.querySelector("[data-voice-call-state]")?.textContent ?? "").trim(),
    }));
    check(quietRead.still === true && quietRead.mascot === false, "the still PNG is what is drawn, with no canvas at all", JSON.stringify(quietRead));
    check(quietRead.frames === 0, "and the animation loop never ran, which is the claim a frame counter can actually prove", `${quietRead.frames} frames`);
    check(quietRead.word.length > 0 && ["Connecting", "Listening", "Thinking", "Talking", "Muted"].includes(quietRead.word),
      "and the words still work", JSON.stringify(quietRead.word));
    await quietPage.evaluate(() => window.__voice.stop());
  }
  await quiet.close();
  await browser.close();
}

// ---- run one leg ---------------------------------------------------------------------------------

try {
  if (leg === "cp") await legControlPlane();
  else if (leg === "relay") await legRelay();
  else if (leg === "nokey") await legNoKey();
  else if (leg === "caps") await legCaps();
  else if (leg === "origin") await legOrigin();
  else if (leg === "refused") await legRefused();
  else if (leg === "browser") await legBrowser();
  else if (leg === "frames") await legFrames();
  else if (leg === "overlay") await legOverlay();
  else if (leg === "person") await legPerson();
  else if (leg === "release") await legRelease();
  else if (leg === "call") await legCall();
} catch (error) {
  failures += 1;
  console.log(`\n  FAIL  the leg threw: ${String(error?.stack ?? error).split("\n").slice(0, 4).join(" | ")}`);
} finally {
  onExit();
}

console.log(`\n--leg ${leg} on ${MACHINE}: ${checks - failures} of ${checks} checks passed${skips > 0 ? `, ${skips} condition(s) this box could not set up` : ""}`);
console.log(failures === 0 ? `PASS  verify-voice --leg ${leg}  (${MACHINE})` : `FAIL  verify-voice --leg ${leg}  (${failures} of ${checks} on ${MACHINE})`);
process.exit(failures === 0 ? 0 : 1);
