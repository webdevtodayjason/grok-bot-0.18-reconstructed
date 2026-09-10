#!/usr/bin/env node
// verify-keys.mjs -- the KEYS-1 gate: the keys the product uses, end to end.
//
// WHAT THIS WAVE DID AND WHY THIS GATE EXISTS. Until 2026-09-10 two vendor keys were typed by a
// CUSTOMER into their own console: the realtime voice key on the Voice card and the mail sending key
// on the Email card. Jason, looking at that panel: "A user is never going to put a resend key in.
// That's on the backend." They are the operator's now -- pasted once at the super admin console,
// held write-only, read by the one relay behind CP_RELAY_TOKEN and kept in memory.
//
// Four things make that safe rather than merely tidier, and each is a leg here:
//
//   door       the relay's read answers 401 with no credential and NOT 404, refuses a wrong method
//              BEFORE it looks at the credential, and answers values only to the relay's own token.
//              The 404 half is the point: this product already has a void route of exactly that
//              class (POST /v1/relay/code/e2b-key 404s on the live control plane while its sibling
//              answers 401, the caller swallows it, and cloud coding is refused as "no key" for
//              ever), and a gate that only checked "not 200" would have passed that too.
//   closed     taking the key field off a screen is not enough. A customer with a browser console
//              could still POST one into their own workspace, so both settings doors REFUSE it in
//              words -- and a 200 that silently drops the field would be the same failure wearing a
//              success, so the refusal is what is measured. The operator's own workspace still
//              writes, because that is what keeps a single-box install working.
//   send       the order: the control plane first, the workspace's own file second. The fallback IS
//              the migration -- there is no code that pushes a file value up -- so both arms are
//              measured, one relay with a control plane holding the key and one without.
//   claimants  the inbound webhook signing secret DELIBERATELY did not move. It is a routing
//              discriminator, not a vendor credential: when two workspaces claim one mail domain the
//              one whose secret verifies THIS body gets the message, so one global value would let
//              the first claimant read another customer's mail. Two tenants claim one domain here
//              and the one holding the matching FILE secret is the one that is handed the message.
//
// Everything is spawned by this script on loopback: a real cp/server.mjs on a throwaway data
// directory, a real ui/server.mjs against a tenants file, a stub vendor for the key proof, a stub
// Resend that records the Authorization header it was sent, and a stub gateway standing in for two
// boxes. No key in this file is real and none ever will be: every value is minted for one run.
//
//   timeout 300 node scripts/verify-keys.mjs
//   KEYS_GATE_PORT=7860 node scripts/verify-keys.mjs
//
// Exit 0 every check passed, 1 a check failed, 2 nothing was measured.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSession, newAuthRecord, serializeCookie } from "../ui/auth.mjs";
import { signSvix } from "../ui/mail-svix.mjs";
import { OPERATOR_SLUG } from "../ui/tenant-registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MACHINE = `${os.hostname()} (${os.platform()} ${os.arch()}, node ${process.versions.node})`;
/** Every HTTP leg of every gate in this tree says who it is at the door. */
const GATE_AGENT = "titanbot-gate/verify-keys.mjs";
const PORT = Number(process.env.KEYS_GATE_PORT ?? 7860);
// A container that really is running on this host, so the registry's docker sweep calls these two
// fake workspaces reachable. The gate never touches it: the gateway below is this script's own stub.
const BOX = String(process.env.KEYS_GATE_BOX ?? "grok-bot-local-vm");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-keys.mjs -- the KEYS-1 gate (docs/ADMIN.md, docs/MAIL.md, docs/VOICE.md).",
    "",
    "  timeout 300 node scripts/verify-keys.mjs",
    "",
    "Spawns a control plane, two relays, a stub vendor, a stub Resend and a stub gateway on loopback,",
    "then measures: the relay key door's refusals, both settings doors refusing a customer's key, the",
    "send preferring the control plane and falling back to the file, and the webhook claimants loop",
    "still being decided by each workspace's OWN file secret. Every value is minted for one run.",
    "",
    "Exit 0 every check passed, 1 a check failed, 2 nothing was measured.",
  ].join("\n"));
  process.exit(0);
}

let failures = 0;
let checks = 0;
const step = (what) => console.log(`\n== ${what}`);
const pass = (what, detail = "") => { checks += 1; console.log(`  PASS  ${what}${detail ? `  (${detail})` : ""}`); };
const fail = (what, detail = "") => { checks += 1; failures += 1; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); };
const check = (ok, what, detail = "") => (ok ? pass(what, detail) : fail(what, detail));
const info = (line) => console.log(`  INFO  ${line}`);
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });
const missing = (what, tried) => {
  console.error(`\n${what} is not available, so this gate measured nothing.`);
  for (const line of tried) console.error(`  ${line}`);
  onExit();
  process.exit(2);
};

const cleanups = [];
function onExit() { while (cleanups.length > 0) { try { cleanups.pop()(); } catch { /* best effort */ } } }
// SIGTERM never reaches a finally (node's default handler ends the process) and this gate runs under
// `timeout`, which sends exactly that. A child left behind holds the port for the next run.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { onExit(); process.exit(143); });

const ask = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { "user-agent": GATE_AGENT, accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(Number(init.timeoutMs ?? 10_000)),
  });
  const text = await response.text();
  let body = null;
  if (text.length > 0) { try { body = JSON.parse(text); } catch { body = null; } }
  return { status: response.status, text, body };
};

/** Minted for one run and never printed. Every sweep below looks for these bytes. */
const CP_MAIL_KEY = `cpmail-${randomBytes(16).toString("hex")}`;
const FILE_MAIL_KEY = `filemail-${randomBytes(16).toString("hex")}`;
const CP_VOICE_KEY = `cpvoice-${randomBytes(16).toString("hex")}`;
const CUSTOMER_TRIES = `customer-tried-to-paste-${randomBytes(12).toString("hex")}`;

// ---- the stubs ----------------------------------------------------------------------------------

/** A vendor that takes any key. The proof is one authenticated GET, so this is the whole of one. */
async function startVendor() {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: String(request.url), authorization: String(request.headers.authorization ?? "") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "a-model" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { try { server.close(); } catch { /* gone */ } });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A Resend that accepts anything and records which credential it was handed. */
async function startResend() {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: String(request.url), authorization: String(request.headers.authorization ?? ""), body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `stub-${seen.length}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { try { server.close(); } catch { /* gone */ } });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** Two boxes' gateway, told apart by the bearer, recording every command it was asked for. */
async function startGateway(tokens) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const bearer = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const command = String(request.url ?? "").replace(/^\/api\//, "");
      seen.push({ command, who: tokens[bearer] ?? "nobody", body });
      response.writeHead(200, { "content-type": "application/json" });
      if (command === "listAgents") {
        response.end(JSON.stringify([{ id: "a1", name: "Titan", isRunning: true, isGroup: false }]));
        return;
      }
      if (command === "getAgentCapacity") { response.end(JSON.stringify({ maxAgents: 13, bots: 1 })); return; }
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { try { server.close(); } catch { /* gone */ } });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

// ---- the control plane --------------------------------------------------------------------------

async function startControlPlane({ vendorUrl, resendUrl, port }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "keys-gate-cp-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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
      CP_MARKETPLACE_VERIFY: "0",
      // The three proof addresses, the same shape CP_GITHUB_API_URL already is. No gate ever asks a
      // real vendor about a key: this one is a stub two ports away.
      CP_XAI_API_URL: vendorUrl,
      CP_OPENAI_API_URL: vendorUrl,
      CP_RESEND_API_URL: resendUrl,
      COOLIFY_URL: "",
      COOLIFY_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += String(chunk); });
  child.stderr.on("data", (chunk) => { log += String(chunk); });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60 && child.exitCode == null; i += 1) {
    const probe = await ask(`${base}/v1/health`).catch(() => null);
    if (probe != null) {
      // IS THIS OUR PROCESS? One left behind by an earlier run holds the port, ours exits because it
      // cannot bind, and the probe answers happily from the stranger with different credentials.
      const mine = await ask(`${base}/v1/keys`, { headers: { authorization: `Bearer ${adminToken}` } });
      if (mine.status !== 200) {
        missing("a control plane of this gate's own", [
          `something else is listening on ${base} and does not take this run's credentials`,
          `find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
          `kill it, or set KEYS_GATE_PORT to a free port, then run the gate again`,
          `it answered HTTP ${mine.status} to GET /v1/keys`,
        ]);
      }
      return { base, adminToken, relayToken, log: () => log };
    }
    await sleep(250);
  }
  missing("a control plane", [`node cp/server.mjs on ${base} never answered`, log.slice(-600)]);
  return null;
}

// ---- the relay ----------------------------------------------------------------------------------

/**
 * One relay with an operator workspace and one customer workspace, both pointed at this gate's own
 * stub gateway. `cp` null is a console with NO control plane at all, which is every single-box
 * install and is the fallback arm of the send leg.
 */
async function startRelay({ port, cp, resendUrl, gatewayUrl, tenants }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "keys-gate-relay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  writeFileSync(authFile, `${JSON.stringify(newAuthRecord(randomBytes(18).toString("hex")), null, 2)}\n`, { mode: 0o600 });
  const cookieSecret = JSON.parse(readFileSync(authFile, "utf8")).cookieSecret;

  const operatorState = path.join(dir, "state");
  mkdirSync(operatorState, { recursive: true });
  const rows = [];
  for (const one of tenants) {
    const stateDir = path.join(dir, "tenants", one.slug);
    mkdirSync(stateDir, { recursive: true });
    if (one.mail) writeFileSync(path.join(stateDir, "mail.json"), `${JSON.stringify(one.mail, null, 2)}\n`, { mode: 0o600 });
    if (one.voice) writeFileSync(path.join(stateDir, "voice.json"), `${JSON.stringify(one.voice, null, 2)}\n`, { mode: 0o600 });
    rows.push({
      slug: one.slug, name: one.name, box: BOX, gateway: gatewayUrl, token: one.token,
      sessionKey: randomBytes(32).toString("hex"), stateDir, profileDir: stateDir, status: "running",
    });
  }
  // The OPERATOR's own workspace reads its state out of the relay's own directory and is seeded from
  // this relay's environment, never from a registry row. Its mail.json is where the sending key lives
  // today, which is the file the migration falls back to.
  const operator = tenants.find((one) => one.slug === OPERATOR_SLUG);
  if (operator?.mail) writeFileSync(path.join(operatorState, "mail.json"), `${JSON.stringify(operator.mail, null, 2)}\n`, { mode: 0o600 });
  if (operator?.voice) writeFileSync(path.join(operatorState, "voice.json"), `${JSON.stringify(operator.voice, null, 2)}\n`, { mode: 0o600 });

  const tenantsFile = path.join(dir, "tenants.json");
  writeFileSync(tenantsFile, `${JSON.stringify({ tenants: rows.filter((row) => row.slug !== OPERATOR_SLUG) }, null, 2)}\n`);

  const child = spawn(process.execPath, [path.join(repoRoot, "ui", "server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SAND_UI_PORT: String(port),
      SAND_UI_BIND_HOST: "127.0.0.1",
      SAND_UI_AUTH_FILE: authFile,
      SAND_UI_STATE_DIR: operatorState,
      SAND_PROFILE_DIRS: "",
      SAND_HOST_GATEWAY_URL: gatewayUrl,
      SAND_HOST_GATEWAY_TOKEN: operator?.token ?? "",
      SAND_BOX_CONTAINER: BOX,
      // The tenants come from a file rather than from the control plane, so this gate can stand up
      // two workspaces with no provisioning; the KEYS door is still read from the control plane,
      // which is the pair this leg needs.
      SAND_UI_TENANTS_FILE: tenantsFile,
      GROK_BOT_MAIL_API_BASE: resendUrl,
      CP_URL: cp?.base ?? "",
      CP_RELAY_TOKEN: cp?.relayToken ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += String(chunk); });
  child.stderr.on("data", (chunk) => { log += String(chunk); });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60 && child.exitCode == null; i += 1) {
    const probe = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (probe != null) {
      const cookieFor = (tenant, sub = "") => serializeCookie("gb_session", createSession(cookieSecret, { tenant, sub })).split(";")[0];
      return { base, dir, cookieFor, log: () => log };
    }
    await sleep(250);
  }
  missing("a relay", [`node ui/server.mjs on ${base} never answered`, log.slice(-600)]);
  return null;
}

// ---- the run ------------------------------------------------------------------------------------

const OPERATOR_TOKEN = `operator-box-token-${randomBytes(12).toString("hex")}`;
const CUSTOMER_TOKEN = `customer-box-token-${randomBytes(12).toString("hex")}`;
const DOMAIN = "shared.example";

console.log(`verify-keys on ${MACHINE}`);

const vendor = await startVendor();
const resend = await startResend();
const gateway = await startGateway({ [OPERATOR_TOKEN]: OPERATOR_SLUG, [CUSTOMER_TOKEN]: "roofing" });
const cp = await startControlPlane({ vendorUrl: vendor.url, resendUrl: resend.url, port: PORT + 1 });

// ---- leg: the door ------------------------------------------------------------------------------

step("the relay's key door refuses a wrong method before it looks at a credential");
for (const method of ["POST", "PUT", "DELETE"]) {
  const answer = await ask(`${cp.base}/v1/relay/keys`, { method, headers: { "content-type": "application/json" }, body: "{}" });
  check(answer.status === 405, `${method} /v1/relay/keys with NO credential answers 405`, `HTTP ${answer.status} ${answer.text.slice(0, 80)}`);
}

step("and 401 without the relay's credential, and NOT 404");
{
  const none = await ask(`${cp.base}/v1/relay/keys`);
  // 404 IS THE FAILURE THIS DESIGN EXISTS TO RULE OUT. A route that is not there and a route that
  // refuses you look identical to a caller that only checks for 200, and this product has already
  // shipped one of the first kind that nobody noticed for weeks.
  check(none.status === 401, "no credential answers 401 and not 404", `HTTP ${none.status} ${none.text.slice(0, 80)}`);
  const wrong = await ask(`${cp.base}/v1/relay/keys`, { headers: { authorization: `Bearer ${randomBytes(24).toString("hex")}` } });
  check(wrong.status === 401, "a wrong credential answers 401", `HTTP ${wrong.status}`);
  const operator = await ask(`${cp.base}/v1/relay/keys`, { headers: { authorization: `Bearer ${cp.adminToken}` } });
  check(operator.status === 401, "the OPERATOR's own bearer does not open the relay's door either", `HTTP ${operator.status}`);
  const relay = await ask(`${cp.base}/v1/relay/keys`, { headers: { authorization: `Bearer ${cp.relayToken}` } });
  check(relay.status === 200 && relay.body?.keys != null, "the relay's credential answers 200", `HTTP ${relay.status} ${relay.text.slice(0, 80)}`);
  check(JSON.stringify(relay.body?.keys ?? {}) === "{}", "and a control plane with nothing pasted answers nothing", relay.text.slice(0, 120));
}

step("the operator pastes the two keys, and nothing reads either one back");
{
  const asAdmin = (pathname, body) => ask(`${cp.base}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cp.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const mail = await asAdmin("/v1/keys/keys.mail.send", { value: CP_MAIL_KEY });
  check(mail.status === 200, "the mail sending key is accepted", `HTTP ${mail.status} ${mail.text.slice(0, 120)}`);
  check(!mail.text.includes(CP_MAIL_KEY), "and the answer does not carry it", mail.text.slice(0, 120));
  check(/characters, sha256/.test(String(mail.body?.evidence ?? "")), "it carries a length and a digest instead", String(mail.body?.evidence));
  const voice = await asAdmin("/v1/keys/keys.voice.xai", { value: CP_VOICE_KEY });
  check(voice.status === 200, "the realtime voice key is accepted", `HTTP ${voice.status} ${voice.text.slice(0, 120)}`);
  const bad = await asAdmin("/v1/keys/keys.not.a.name", { value: CP_MAIL_KEY });
  check(bad.status === 400, "a name outside the allowlist is refused", `HTTP ${bad.status} ${bad.text.slice(0, 100)}`);

  const door = await ask(`${cp.base}/v1/keys`, { headers: { authorization: `Bearer ${cp.adminToken}` } });
  check(door.status === 200, "the super admin's own read answers", `HTTP ${door.status}`);
  check(!door.text.includes(CP_MAIL_KEY) && !door.text.includes(CP_VOICE_KEY), "presence only, never a value", door.text.slice(0, 160));
  check(!door.text.includes(CP_MAIL_KEY.slice(0, 10)), "and not a ten character prefix either");
  const stored = (door.body?.keys ?? []).filter((one) => one.stored).map((one) => one.name);
  check(stored.length === 2, "two of the three names are set", stored.join(", "));

  const relay = await ask(`${cp.base}/v1/relay/keys`, { headers: { authorization: `Bearer ${cp.relayToken}` } });
  check(relay.body?.keys?.["keys.mail.send"] === CP_MAIL_KEY, "the relay is handed the value, which is the one route that answers with one");
  check(relay.body?.keys?.["keys.voice.openai"] === undefined, "and a name nobody pasted is OMITTED rather than answered empty", relay.text.slice(0, 160));
  info(`the vendor was asked ${vendor.seen.length} time(s) and Resend ${resend.seen.filter((one) => one.url.includes("domains")).length} time(s), each before anything was stored`);
}

// ---- leg: the doors that used to take a customer's key -------------------------------------------

const TENANTS = [
  {
    slug: OPERATOR_SLUG,
    name: "Titanium",
    token: OPERATOR_TOKEN,
    // The operator's own file, which is where the sending key lives until he pastes it once.
    mail: { enabled: true, domain: DOMAIN, apiKey: FILE_MAIL_KEY, webhookSecret: `whsec_${randomBytes(24).toString("base64")}`, fromName: "Titan", catchAllAgentId: "a1" },
    voice: { enabled: true, vendor: "xai", apiKey: "" },
  },
  {
    slug: "roofing",
    name: "Roofing",
    token: CUSTOMER_TOKEN,
    // A CUSTOMER, and after this wave a customer's own files hold no key at all.
    mail: { enabled: true, domain: DOMAIN, apiKey: "", webhookSecret: `whsec_${randomBytes(24).toString("base64")}`, fromName: "Bot", catchAllAgentId: "a1" },
    voice: { enabled: true, vendor: "xai", apiKey: "" },
  },
];

const relay = await startRelay({ port: PORT, cp, resendUrl: resend.url, gatewayUrl: gateway.url, tenants: TENANTS });
const asCustomer = { cookie: relay.cookieFor("roofing", "acct-1") };
const asOperator = { cookie: relay.cookieFor(OPERATOR_SLUG) };

step("a customer's save carrying a key is REFUSED in words, and nothing is stored");
for (const [what, pathname, patch] of [
  ["the voice door", "/voice/settings", { apiKey: CUSTOMER_TRIES }],
  ["the mail door", "/mail/settings", { apiKey: CUSTOMER_TRIES }],
  ["the mail door's signing secret", "/mail/settings", { webhookSecret: CUSTOMER_TRIES }],
]) {
  const answer = await ask(`${relay.base}${pathname}`, {
    method: "POST",
    headers: { ...asCustomer, "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  // A 200 THAT SILENTLY DROPS THE FIELD WOULD BE WORSE THAN THE OLD BEHAVIOUR: the caller believes
  // it worked and nothing anywhere says otherwise. So the refusal is what is measured.
  check(answer.status === 400, `${what} refuses it with 400 rather than dropping it quietly`, `HTTP ${answer.status} ${answer.text.slice(0, 120)}`);
  check(answer.body?.error === "not_yours", "  naming the condition", String(answer.body?.error));
  check(String(answer.body?.message ?? "").includes("set by your operator"), "  in words a business owner can act on", String(answer.body?.message));
}
{
  const customerFile = path.join(relay.dir, "tenants", "roofing", "mail.json");
  const onDisk = readFileSync(customerFile, "utf8");
  check(!onDisk.includes(CUSTOMER_TRIES), "and the customer's own file is untouched", `${onDisk.length} bytes`);
  const voiceFile = path.join(relay.dir, "tenants", "roofing", "voice.json");
  check(!readFileSync(voiceFile, "utf8").includes(CUSTOMER_TRIES), "including their voice settings");
}

step("the operator's own workspace still writes, which is what keeps a single-box install working");
{
  const operatorKey = `operator-pasted-${randomBytes(10).toString("hex")}`;
  const saved = await ask(`${relay.base}/voice/settings`, {
    method: "POST",
    headers: { ...asOperator, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: operatorKey }),
  });
  check(saved.status === 200, "the operator's voice save is taken", `HTTP ${saved.status} ${saved.text.slice(0, 120)}`);
  check(saved.body?.apiKeySet === true, "and the file half reports itself set");
  check(saved.body?.apiKey === undefined && !saved.text.includes(operatorKey), "with the value never coming back out of that door", saved.text.slice(0, 140));
}

step("a customer reads whether talking is available at all, and never a key");
{
  const answer = await ask(`${relay.base}/voice/settings`, { headers: asCustomer });
  check(answer.status === 200, "the customer's own voice door answers", `HTTP ${answer.status}`);
  // THIS IS THE FIELD THE SETTINGS SWITCH READS. The customer has no key of their own anywhere, and
  // talking is available because the OPERATOR pasted one at the admin console.
  check(answer.body?.available === true, "available is true from the operator's key alone", JSON.stringify({ available: answer.body?.available, apiKeySet: answer.body?.apiKeySet }));
  check(answer.body?.apiKeySet === false, "while the file half is honestly false");
  check(!answer.text.includes(CP_VOICE_KEY) && !answer.text.includes(CP_VOICE_KEY.slice(0, 10)), "and no fragment of the key reaches the browser", answer.text.slice(0, 160));
}

step("who this is, for the settings surface");
{
  const asOne = await ask(`${relay.base}/me`, { headers: asCustomer });
  check(asOne.status === 200, "GET /me answers below the gate", `HTTP ${asOne.status} ${asOne.text.slice(0, 120)}`);
  check(asOne.body?.operator === false, "a customer is not the operator", JSON.stringify(asOne.body?.operator));
  check(asOne.body?.workspace?.slug === "roofing", "and it names their own workspace", JSON.stringify(asOne.body?.workspace));
  const asBoss = await ask(`${relay.base}/me`, { headers: asOperator });
  check(asBoss.body?.operator === true, "the operator is", JSON.stringify(asBoss.body?.operator));
  check(Number(asBoss.body?.botCap) === 13, "the bot ceiling is read off the box rather than a file", JSON.stringify(asBoss.body?.botCap));
  const none = await ask(`${relay.base}/me`);
  check(none.status === 401 || none.status === 302, "and it is behind the gate", `HTTP ${none.status}`);
}

// ---- leg: the send ------------------------------------------------------------------------------

/** One bot asking the relay to send, with the box's own gateway bearer. */
const sendAs = (token, base) => ask(`${base}/mail/send`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ agentId: "a1", to: "somebody@example.com", subject: "a gate", text: "hello" }),
});

step("the send uses the operator's key from the control plane, over the file that also has one");
{
  const before = resend.seen.length;
  const answer = await sendAs(OPERATOR_TOKEN, relay.base);
  const sends = resend.seen.slice(before).filter((one) => one.url.includes("emails"));
  check(sends.length === 1, "one send reached the vendor", `HTTP ${answer.status} ${answer.text.slice(0, 120)}, ${sends.length} request(s)`);
  const whichKey = (auth) => (auth === `Bearer ${CP_MAIL_KEY}` ? "the control plane's" : auth === `Bearer ${FILE_MAIL_KEY}` ? "the file's" : "neither");
  check(sends[0]?.authorization === `Bearer ${CP_MAIL_KEY}`, "carrying the CONTROL PLANE's key and not the file's",
    `${whichKey(sends[0]?.authorization)} key was on the wire`);
  check(!JSON.stringify(sends).includes(FILE_MAIL_KEY), "and the file's key was nowhere on that request");
}

step("and with a control plane holding NOTHING it falls back to the file, which IS the whole migration");
{
  // A SECOND CONTROL PLANE AND A SECOND RELAY, because the first relay has already cached what the
  // first control plane holds, and because this is the exact state the R750 is in today: the door
  // exists, nobody has pasted the sending key yet, and the operator's own file is the only place it
  // lives. If this arm broke, pasting the key would be a cutover rather than a migration.
  //
  // The second control plane is also what keeps the directory working, so the bot still has an
  // address to send from -- which is what makes this a measurement of the KEY and nothing else.
  const emptyPlane = await startControlPlane({ vendorUrl: vendor.url, resendUrl: resend.url, port: PORT + 3 });
  const lonely = await startRelay({ port: PORT + 2, cp: emptyPlane, resendUrl: resend.url, gatewayUrl: gateway.url, tenants: TENANTS });
  const before = resend.seen.length;
  const answer = await sendAs(OPERATOR_TOKEN, lonely.base);
  const sends = resend.seen.slice(before).filter((one) => one.url.includes("emails"));
  check(sends.length === 1, "one send reached the vendor", `HTTP ${answer.status} ${answer.text.slice(0, 120)}`);
  check(sends[0]?.authorization === `Bearer ${FILE_MAIL_KEY}`, "carrying the workspace's OWN file key",
    sends[0]?.authorization === `Bearer ${CP_MAIL_KEY}` ? "the other plane's key won, which means the reader is shared" : "neither key");
  // THE DOOR IS THERE, so the reader must not have said it was missing. That sentence is reserved for
  // a control plane that really has no route, which is a deploy fact and not an empty door.
  check(!lonely.log().includes("does not have the keys door"), "and the reader did not call an EMPTY door a MISSING one", lonely.log().slice(-200));
  for (const value of [CP_MAIL_KEY, FILE_MAIL_KEY, CP_VOICE_KEY]) {
    check(!lonely.log().includes(value) && !lonely.log().includes(value.slice(0, 10)), "no key is in a relay log line");
  }
}

// ---- leg: the claimants loop ---------------------------------------------------------------------

step("two workspaces claim one mail domain, and the FILE secret still decides which one is handed the message");
{
  // THE SIGNING SECRET DELIBERATELY DID NOT MOVE. It is a routing discriminator and not a vendor
  // credential: one global value in front of every edge would let the first claimant read another
  // customer's mail. So it stays on each workspace's own file, and this is the proof that the
  // control plane holding a mail key changed nothing about that decision.
  const customer = TENANTS.find((one) => one.slug === "roofing");
  const body = JSON.stringify({
    type: "email.received",
    data: { email_id: `gate-${randomBytes(8).toString("hex")}`, to: [`titan@${DOMAIN}`], from: "someone@elsewhere.example", subject: "which workspace" },
  });
  const id = `msg_${randomBytes(12).toString("hex")}`;
  const at = Math.floor(Date.now() / 1000);
  // Signed with the SHIPPED signer over the CUSTOMER's own file secret, so what this leg measures is
  // the relay's own verification and not a second implementation of it written here.
  const signature = signSvix(customer.mail.webhookSecret, { id, timestamp: String(at) }, body);
  const before = gateway.seen.length;
  const answer = await ask(`${relay.base}/hooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id, "svix-timestamp": String(at), "svix-signature": signature,
    },
    body,
  });
  const after = gateway.seen.slice(before).filter((one) => one.command === "sendPrompt");
  check(answer.status === 200, "the hook answers", `HTTP ${answer.status} ${answer.text.slice(0, 140)}`);
  // Either the message reached the workspace holding the matching secret, or nobody was handed it.
  // What must NEVER happen is the OTHER workspace being handed it, which is what a shared secret buys.
  const wrong = after.filter((one) => one.who === OPERATOR_SLUG);
  check(wrong.length === 0, "the workspace that does NOT hold the matching secret was handed nothing", JSON.stringify(after.map((one) => one.who)));
  check(after.some((one) => one.who === "roofing"), "and the one that DOES hold it was handed the message",
    `${JSON.stringify(after.map((one) => one.who))}, ${answer.text.slice(0, 120)}`);
  // And the relay's own log never carries a control-plane value in this path.
  check(!relay.log().includes(CP_MAIL_KEY) && !relay.log().includes(CP_MAIL_KEY.slice(0, 10)),
    "no control-plane key is in the relay's log at all");
}

// ---- the sweep ------------------------------------------------------------------------------------

step("nothing this run ever said carried a key");
{
  const cpLog = cp.log();
  const relayLog = relay.log();
  for (const [what, text] of [["the control plane's log", cpLog], ["the relay's log", relayLog]]) {
    for (const value of [CP_MAIL_KEY, CP_VOICE_KEY, FILE_MAIL_KEY, CUSTOMER_TRIES]) {
      check(!text.includes(value) && !text.includes(value.slice(0, 10)), `${what} carries no key or prefix of one`);
    }
  }
}

onExit();
console.log(`\nverify-keys on ${MACHINE}: ${checks - failures} of ${checks} checks passed`);
console.log(failures === 0 ? `PASS  verify-keys  (${MACHINE})` : `FAIL  verify-keys  (${failures} of ${checks} on ${MACHINE})`);
process.exit(failures === 0 ? 0 : 1);
