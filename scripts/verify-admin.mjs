#!/usr/bin/env node
// verify-admin.mjs -- the ADMIN-1 gate: the super admin console, end to end, against a control
// plane this script starts, a Coolify that is not Coolify, and a relay that is not a relay.
//
// Everything below goes through HTTP the way the console and the CLI reach it, and the page leg
// goes through a real headless Chrome the way Jason reaches it. The one thing this file imports
// from the tree under test is ui/login-ledger.mjs, and only so the relay-ledger leg can drive the
// writer directly: a gate that asked a service whether its own file was safe would be proving
// nothing, so that leg reads the bytes off the disk itself.
//
// The fixture is built in here. The fake relay serves a login-attempts file with three stories in
// it, because those three are what the panel exists to tell apart:
//
//   198.51.100.7    six different passwords in four minutes          -> must be flagged as an attack
//   203.0.113.44    the same password four times                     -> must NOT be flagged
//   192.0.2.10      one refusal and then a successful sign-in        -> an ordinary bad morning
//
// In order:
//   boot        the control plane starts on a free port with a throwaway data dir and answers health
//   promote     an account is added, `account promote` makes it a super admin, demote takes it back,
//               and the last super admin cannot be demoted into a console nobody can open
//   door        every /v1/admin route refuses no bearer, a wrong bearer, a NORMAL account's own
//               valid session, and a token minted under ANOTHER tenant's derived key carrying the
//               super admin's account id; the operator token opens them; a super admin's session
//               opens them
//   ledger      a refused sign-in lands in the control plane's own record with a keyed hash, and
//               the password TEXT is nowhere in the data directory (every file, byte by byte)
//   relay       the relay's own ledger writer: the hash is HMAC-SHA256 under the salt, the salt file
//               is 0600, a success carries no hash, the clear text is not in the file, and the
//               rotation at the cap keeps exactly one previous file
//   attack      six different passwords from one address inside ten minutes raises the flag, four of
//               the same password does not, and the merged list carries both ledgers
//   panels      GET /v1/admin/{overview,sign-ins,clients,boxes,system} answer, and the facts this
//               container cannot read say "not measured" rather than zero
//   page        headless Chrome signs in at /admin and all five panels render from the fixture
//   leak        no response body in the whole run carries the session secret, the admin token, the
//               relay token or any password
//
// Exit status: 0 every leg passed, 1 a leg failed, 2 nothing was measured (the control plane could
// not be started, or the browser leg could not resolve playwright).
//
//   node scripts/verify-admin.mjs
//   node scripts/verify-admin.mjs --no-browser     the API legs only
//
// Env: CP_GATE_PORT, CP_GATE_FAKE_PORT, CP_GATE_RELAY_PORT to pin ports instead of taking free
//      ones; CP_GATE_TIMEOUT_MS for the boot wait (default 20000); GROK_BOT_PLAYWRIGHT_DIR for the
//      browser leg, defaulting to .cache/playwright, which scripts/setup-gates.sh fills.

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createLoginLedger, hashTried } from "../ui/login-ledger.mjs";
import { mintSessionToken, tenantSessionSecret } from "../ui/session-token.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-admin.mjs -- the ADMIN-1 gate (docs/ADMIN.md).",
    "",
    "  node scripts/verify-admin.mjs",
    "  node scripts/verify-admin.mjs --no-browser",
    "",
    "Starts cp/server.mjs on a free port with a throwaway data dir, a fake Coolify and a fake relay",
    "serving a built-in login-attempts fixture, then walks the super admin console: promote and",
    "demote, the admin door against a normal account, the sign-in ledger and its keyed hash, the",
    "attack rule, the five read routes, and the page itself in headless Chrome. It kills every",
    "server and deletes every temp directory on the way out.",
    "",
    "Exit 0 every leg passed, 1 a leg failed, 2 nothing was measured.",
  ].join("\n"));
  process.exit(0);
}

const WANT_BROWSER = !process.argv.includes("--no-browser");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = process.env.CP_GATE_SERVER ? path.resolve(process.env.CP_GATE_SERVER) : path.join(repoRoot, "cp", "server.mjs");
const BOOT_TIMEOUT_MS = Number(process.env.CP_GATE_TIMEOUT_MS ?? 20000);

// Fake, minted for one process, never printed. The leak leg at the end searches every response body
// this run ever saw for all of them.
const SESSION_SECRET = randomBytes(32).toString("hex");
const ADMIN_TOKEN = randomBytes(24).toString("base64url");
const RELAY_TOKEN = randomBytes(24).toString("base64url");
const COOLIFY_KEY = `fake-${randomBytes(12).toString("hex")}`;
const BASE_DOMAIN = "titanium.bot";
const TENANT_SLUG = "titanium";
const SERVICE_UUID = "fakeserviceuuid00001";

const BOSS_EMAIL = `boss+${randomBytes(4).toString("hex")}@example.com`;
const BOSS_PASSWORD = randomBytes(18).toString("base64url");
const USER_EMAIL = `user+${randomBytes(4).toString("hex")}@example.com`;
const USER_PASSWORD = randomBytes(18).toString("base64url");
// The password the ledger legs try and then hunt for on disk. Distinctive on purpose: a random
// base64 string could in principle collide with sqlite's own bytes, and this one cannot.
const TRIED_PASSWORD = `NeverOnDisk-${randomBytes(8).toString("hex")}-Zz`;
// The customer's password as it stands right now. The reset-password leg replaces it, and the
// page leg has to sign in as that person afterwards to be refused for the RIGHT reason: "this
// console is not yours", not "that password is wrong".
let userPasswordNow = USER_PASSWORD;

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// ---- the fixture -------------------------------------------------------------------------------
//
// The relay's salt is its own, so these hashes are made with a salt this script owns. That is the
// truth of the shape: the control plane cannot recompute them and never tries to, it only counts
// how many DISTINCT ones came from one address.

const RELAY_SALT = randomBytes(32).toString("hex");
const fixtureHash = (password) => createHmac("sha256", RELAY_SALT).update(password, "utf8").digest("hex");
const ATTACK_IP = "198.51.100.7";
const SAME_IP = "203.0.113.44";
const ORDINARY_IP = "192.0.2.10";
const FIXTURE_AT = Date.now() - 5 * 60 * 1000;

const fixtureRows = [];
// Six different passwords inside four minutes from one address. This is the attack.
for (let index = 0; index < 6; index += 1) {
  fixtureRows.push({
    at: new Date(FIXTURE_AT + index * 40_000).toISOString(),
    door: "account",
    email: "owner@acme-roofing.example",
    ip: ATTACK_IP,
    userAgent: "curl/8.4.0",
    triedHash: fixtureHash(`guess-number-${index}`),
    outcome: "refused",
    tenant: "",
  });
}
// The same password four times from another address. Somebody's phone, and it must not be flagged.
for (let index = 0; index < 4; index += 1) {
  fixtureRows.push({
    at: new Date(FIXTURE_AT + 10_000 + index * 30_000).toISOString(),
    door: "account",
    email: USER_EMAIL,
    ip: SAME_IP,
    userAgent: "Mozilla/5.0 (iPhone)",
    triedHash: fixtureHash("one-stale-saved-password"),
    outcome: "refused",
    tenant: "",
  });
}
// One password against six accounts, one try each, a different address every time. A spray, and the
// shape of it is the point: no address bucket reaches anything, no account is locked out, and every
// row on its own looks like somebody mistyping. The by-address table cannot see this by
// construction, so it is the by-account table and the password summary that have to.
const SPRAY_EMAILS = [];
for (let index = 0; index < 6; index += 1) SPRAY_EMAILS.push(`sprayed${index}@acme-roofing.example`);
const SPRAY_IPS = SPRAY_EMAILS.map((_, index) => `203.0.113.${60 + index}`);
for (let index = 0; index < SPRAY_EMAILS.length; index += 1) {
  fixtureRows.push({
    at: new Date(FIXTURE_AT + 20_000 + index * 25_000).toISOString(),
    door: "account",
    email: SPRAY_EMAILS[index],
    ip: SPRAY_IPS[index],
    userAgent: "python-requests/2.31",
    triedHash: fixtureHash("one-common-password"),
    outcome: "refused",
    tenant: "",
  });
}

// One refusal and then a lockout and then a success. An ordinary bad morning.
fixtureRows.push({
  at: new Date(FIXTURE_AT + 60_000).toISOString(), door: "instance", email: "", ip: ORDINARY_IP,
  userAgent: "Mozilla/5.0", triedHash: fixtureHash("typo"), outcome: "refused", tenant: "",
});
fixtureRows.push({
  at: new Date(FIXTURE_AT + 90_000).toISOString(), door: "instance", email: "", ip: ORDINARY_IP,
  userAgent: "Mozilla/5.0", triedHash: "", outcome: "locked", tenant: "",
});
fixtureRows.push({
  at: new Date(FIXTURE_AT + 150_000).toISOString(), door: "instance", email: "", ip: ORDINARY_IP,
  userAgent: "Mozilla/5.0", triedHash: "", outcome: "ok", tenant: TENANT_SLUG,
});

const fixtureBoxes = [{
  slug: TENANT_SLUG, name: "Titanium", box: `titanbot-box-${SERVICE_UUID}`, operator: true,
  root: `/data/titanbot/${TENANT_SLUG}`,
  containerState: "running", containerStateWhy: "",
  memoryBytes: 1_476_395_008, memoryWhy: "",
  diskKb: 4_194_304, diskWhy: "",
  lastActivityAt: new Date(FIXTURE_AT).toISOString(), lastActivityWhy: "",
  gatewayAnswering: true, gatewayStatus: 200, gatewayMs: 14, gatewayWhy: "",
  measuredAt: new Date().toISOString(),
}];

// ---- the fake Coolify --------------------------------------------------------------------------
const coolifyCalls = [];
function fakeCoolifyHandler(req, res) {
  const url = new URL(req.url, "http://fake");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const authorized = (req.headers.authorization ?? "").startsWith("Bearer ");
    // Whether a key was sent, never the key. A recorder that prints bearers is a recorder that
    // leaks them.
    coolifyCalls.push({ method: req.method, path: url.pathname, authorized, bytes: body.length });
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (!authorized) return send(401, { message: "Unauthenticated." });
    const p = url.pathname.replace(/^\/api\/v1/, "");
    if (req.method === "GET" && /^\/projects\/?$/.test(p)) return send(200, [{ id: 1, uuid: "fakeprojectuuid00001", name: "Titanium Computing" }]);
    if (req.method === "GET" && /^\/servers\/?$/.test(p)) return send(200, [{ id: 1, uuid: "fakeserveruuid000001", name: "r750" }]);
    if (req.method === "POST" && /^\/services\/[^/]+\/(start|stop|restart)\/?$/.test(p)) return send(200, { message: "Service request queued." });
    if (req.method === "GET" && /^\/services\/[^/]+\/applications\/?$/.test(p)) {
      return send(200, [{ uuid: "app-box", name: "titanbot-box", status: "running", fqdn: null }]);
    }
    if (req.method === "GET" && /^\/services\/[^/]+\/?$/.test(p)) {
      return send(200, { id: 1, uuid: SERVICE_UUID, name: `titanbot-${TENANT_SLUG}`, status: "running:unknown", applications: [{ uuid: "app-box", name: "titanbot-box", status: "running", fqdn: null }] });
    }
    return send(404, { message: "Not found." });
  });
}

// ---- the fake relay ----------------------------------------------------------------------------
// One credential, CP_RELAY_TOKEN, and it is the same value the real relay checks. A request without
// it is refused here for the same reason it is refused there: this route is every failed sign-in on
// the fleet.
const relayCalls = [];
function fakeRelayHandler(req, res) {
  const url = new URL(req.url, "http://fake");
  const header = String(req.headers.authorization ?? "");
  const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  relayCalls.push({ method: req.method, path: url.pathname, authorized: presented === RELAY_TOKEN });
  const send = (status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  if (presented !== RELAY_TOKEN) return send(401, { error: "unauthorized" });
  if (url.pathname === "/admin/login-attempts") {
    const since = Date.parse(url.searchParams.get("since") ?? "");
    const outcome = String(url.searchParams.get("outcome") ?? "");
    const rows = fixtureRows.filter((row) => {
      if (Number.isFinite(since) && Date.parse(row.at) < since) return false;
      if (outcome.length > 0 && row.outcome !== outcome) return false;
      return true;
    });
    return send(200, { source: "relay", measuredAt: new Date().toISOString(), rows });
  }
  if (url.pathname === "/admin/boxes") {
    return send(200, { measuredAt: new Date().toISOString(), boxes: fixtureBoxes });
  }
  return send(404, { error: "not_found" });
}

// ---- the run -----------------------------------------------------------------------------------

const bodiesSeen = [];
let child = null;
let fakeCoolify = null;
let fakeRelay = null;
let dataDir = null;
let tenantRoot = null;
let ledgerDir = null;
let browser = null;
const childLog = [];

const cleanup = () => {
  if (browser) { try { void browser.close(); } catch { /* already gone */ } }
  if (child && child.exitCode == null) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  for (const server of [fakeCoolify, fakeRelay]) { if (server) { try { server.close(); } catch { /* already closed */ } } }
  for (const dir of [dataDir, tenantRoot, ledgerDir]) {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } }
  }
};
const die = (message) => {
  console.log(`\n${message}`);
  console.log("exit 2: nothing was measured");
  cleanup();
  process.exit(2);
};

if (!existsSync(SERVER)) die(`the control plane's entry point is not in this tree (looked at ${SERVER}).`);
if (!existsSync(path.join(repoRoot, "cp", "admin", "index.html"))) {
  die("cp/admin/index.html is not in this tree, so there is no console to measure.");
}

const CP_PORT = Number(process.env.CP_GATE_PORT ?? await freePort());
const FAKE_PORT = Number(process.env.CP_GATE_FAKE_PORT ?? await freePort());
const RELAY_PORT = Number(process.env.CP_GATE_RELAY_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${CP_PORT}`;

dataDir = mkdtempSync(path.join(tmpdir(), "admin-gate-data-"));
tenantRoot = mkdtempSync(path.join(tmpdir(), "admin-gate-tenants-"));
ledgerDir = mkdtempSync(path.join(tmpdir(), "admin-gate-ledger-"));

fakeCoolify = http.createServer(fakeCoolifyHandler);
await new Promise((resolve, reject) => { fakeCoolify.once("error", reject); fakeCoolify.listen(FAKE_PORT, "127.0.0.1", resolve); });
fakeRelay = http.createServer(fakeRelayHandler);
await new Promise((resolve, reject) => { fakeRelay.once("error", reject); fakeRelay.listen(RELAY_PORT, "127.0.0.1", resolve); });

const call = async (method, pathname, { body, token, admin, raw } = {}) => {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  else if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    return { status: 0, text: "", json: null, error: String(error?.message ?? error) };
  }
  const text = await res.text();
  if (!raw) bodiesSeen.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json, the leg says so */ }
  return { status: res.status, text, json, error: null, headers: res.headers };
};

console.log(`control plane on ${BASE}`);
console.log(`fake Coolify on http://127.0.0.1:${FAKE_PORT}, fake relay on http://127.0.0.1:${RELAY_PORT}`);
console.log(`data dir ${dataDir}`);

child = spawn(process.execPath, [SERVER], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    CP_PORT: String(CP_PORT),
    CP_DATA_DIR: dataDir,
    CP_SESSION_SECRET: SESSION_SECRET,
    CP_ADMIN_TOKEN: ADMIN_TOKEN,
    CP_RELAY_TOKEN: RELAY_TOKEN,
    CP_RELAY_URL: `http://127.0.0.1:${RELAY_PORT}`,
    CP_BASE_DOMAIN: BASE_DOMAIN,
    CP_COOLIFY_URL: `http://127.0.0.1:${FAKE_PORT}`,
    COOLIFY_API_KEY: COOLIFY_KEY,
    COOLIFY_PROJECT_UUID: "fakeprojectuuid00001",
    COOLIFY_SERVER_UUID: "fakeserveruuid000001",
    CP_TENANT_ROOT: tenantRoot,
    CP_RELEASE_ROOT: tenantRoot,
    CP_PUBLIC_URL: BASE,
    // Neither is mounted anywhere on this Mac, which is exactly the state the panel has to render
    // honestly. Left unset on purpose so the "not measured" leg measures the real default.
    CP_BACKUP_MANIFEST_DIR: "",
    CP_ISOLATION_REPORT: "",
  },
});
child.stdout.on("data", (chunk) => childLog.push(String(chunk)));
child.stderr.on("data", (chunk) => childLog.push(String(chunk)));
child.on("exit", (code, signal) => childLog.push(`\n[control plane exited code=${code} signal=${signal}]\n`));

const bootedBy = Date.now() + BOOT_TIMEOUT_MS;
let booted = false;
while (Date.now() < bootedBy) {
  const health = await call("GET", "/v1/health");
  if (health.status === 200) { booted = true; break; }
  if (child.exitCode != null) break;
  await sleep(200);
}
if (!booted) die(`the control plane never answered /v1/health.\n${childLog.join("")}`);

// ---- boot ---------------------------------------------------------------------------------------
step("boot");
{
  const health = await call("GET", "/v1/health");
  check(health.status === 200 && health.json?.ok === true, "the control plane answers /v1/health", `status ${health.status}`);
}

// ---- promote and demote ---------------------------------------------------------------------------
step("promote and demote");
{
  const adopt = await call("POST", `/v1/tenants/${TENANT_SLUG}/adopt`, {
    admin: true,
    body: { coolifyServiceUuid: SERVICE_UUID, host: `console.${BASE_DOMAIN}`, name: "Titanium" },
  });
  check(adopt.status === 200, "a workspace exists to sign in to", `status ${adopt.status}`);

  const boss = await call("POST", "/v1/accounts", { admin: true, body: { email: BOSS_EMAIL, password: BOSS_PASSWORD, tenant: TENANT_SLUG, name: "Jason" } });
  const user = await call("POST", "/v1/accounts", { admin: true, body: { email: USER_EMAIL, password: USER_PASSWORD, tenant: TENANT_SLUG, name: "A customer" } });
  check(boss.status === 201 && user.status === 201, "two accounts were added", `${boss.status} and ${user.status}`);
  check(boss.json?.account?.superAdmin === false, "a new account is not a super admin");

  const promoted = await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/promote`, { admin: true });
  check(promoted.status === 200 && promoted.json?.account?.superAdmin === true, "the operator token promotes an account", `status ${promoted.status}`);

  const listed = await call("GET", "/v1/accounts", { admin: true });
  const seen = (listed.json?.accounts ?? []).find((row) => row.email === BOSS_EMAIL);
  check(seen?.superAdmin === true, "the flag reads back on the account list");

  // Promote a second one so the demote below is not the last one standing.
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { admin: true });
  const demoted = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/demote`, { admin: true });
  check(demoted.status === 200 && demoted.json?.account?.superAdmin === false, "demote takes it back", `status ${demoted.status}`);

  // And now there is one left, which is the one that must not be demotable.
  const last = await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/demote`, { admin: true });
  check(last.status === 409 && last.json?.error === "last_super_admin", "the last super admin cannot be demoted into a console nobody can open", `status ${last.status}`);

  const missing = await call("POST", "/v1/admin/users/nobody@example.com/promote", { admin: true });
  check(missing.status === 404, "promoting somebody who does not exist is a 404", `status ${missing.status}`);
}

// ---- the door -------------------------------------------------------------------------------------
step("the admin door");
const ADMIN_ROUTES = ["/v1/admin/overview", "/v1/admin/sign-ins", "/v1/admin/clients", "/v1/admin/boxes", "/v1/admin/system"];
let bossToken = "";
let userToken = "";
{
  for (const route of ADMIN_ROUTES) {
    const bare = await call("GET", route);
    check(bare.status === 401, `${route} refuses a caller with no bearer`, `status ${bare.status}`);
  }
  const wrong = await call("GET", "/v1/admin/overview", { token: randomBytes(24).toString("base64url") });
  check(wrong.status === 401, "a made-up bearer opens nothing", `status ${wrong.status}`);

  const relayTried = await call("GET", "/v1/admin/overview", { token: RELAY_TOKEN });
  check(relayTried.status === 401, "the relay's own credential does not open the admin console", `status ${relayTried.status}`);

  const userSession = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: USER_PASSWORD } });
  userToken = String(userSession.json?.token ?? "");
  check(userSession.status === 200 && userToken.length > 0, "a normal account signs in to its workspace", `status ${userSession.status}`);
  check(userSession.json?.account?.superAdmin === false, "and the answer says it is not a super admin");

  for (const route of ADMIN_ROUTES) {
    const refused = await call("GET", route, { token: userToken });
    check(refused.status === 401, `${route} refuses a normal account's valid session`, `status ${refused.status}`);
  }
  const escalate = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { token: userToken });
  check(escalate.status === 401, "a normal account cannot promote itself", `status ${escalate.status}`);

  // A token minted under ANOTHER tenant's own key, carrying the super admin's account id.
  //
  // This is the shape of the real attack and not a theoretical one. Every tenant relay is handed
  // its own derived session key, that key sits in that customer's Coolify environment, and anyone
  // who can run code in that customer's relay holds it. A signature made with it proves which key
  // was used and nothing about who the person is, so the account the token NAMES has to be the
  // account the token was issued for. Without that binding this mints a super admin out of one
  // ordinary customer's key.
  const roster = await call("GET", "/v1/accounts", { admin: true });
  const bossId = String((roster.json?.accounts ?? []).find((row) => row.email === BOSS_EMAIL)?.id ?? "");
  check(bossId.length > 0, "the gate knows the super admin's account id, which is what a forgery would carry");
  const forgedAt = Date.now();
  const { token: forged } = mintSessionToken({
    sub: bossId,
    email: BOSS_EMAIL,
    tenant: "a-different-customer",
    host: "a-different-customer.titanium.bot",
    iat: forgedAt,
    exp: forgedAt + 60 * 60 * 1000,
    jti: randomBytes(16).toString("hex"),
  }, tenantSessionSecret(SESSION_SECRET, "a-different-customer"), forgedAt);
  for (const route of ADMIN_ROUTES) {
    const refused = await call("GET", route, { token: forged });
    check(refused.status === 401, `${route} refuses a token signed with another customer's key`, `status ${refused.status}`);
  }
  const forgedPromote = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { token: forged });
  check(forgedPromote.status === 401, "and it cannot promote anybody, which is the escalation that would outlive the token", `status ${forgedPromote.status}`);

  const bossSession = await call("POST", "/v1/sessions", { body: { email: BOSS_EMAIL, password: BOSS_PASSWORD } });
  bossToken = String(bossSession.json?.token ?? "");
  check(bossSession.status === 200 && bossSession.json?.account?.superAdmin === true, "the super admin signs in and the answer says so", `status ${bossSession.status}`);

  const opened = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(opened.status === 200, "and that session opens the console", `status ${opened.status}`);

  // Demoted while the tab is open. The flag is read from the store on every request, so the very
  // next call must fail: this is the leg that proves it is not a claim inside the token.
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { admin: true });
  await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/demote`, { admin: true });
  const afterDemote = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(afterDemote.status === 401, "a demotion takes effect on the next request, not when the token expires", `status ${afterDemote.status}`);
  await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/promote`, { admin: true });
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/demote`, { admin: true });
  const backIn = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(backIn.status === 200, "and promoting again lets the same session back in", `status ${backIn.status}`);
}

// ---- the control plane's own ledger, and the password that is not on disk -------------------------
step("the sign-in ledger");
{
  const before = await call("GET", "/v1/admin/sign-ins?hours=24&limit=500", { token: bossToken });
  const countBefore = (before.json?.rows ?? []).filter((row) => row.source === "control plane").length;

  const refused = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: TRIED_PASSWORD } });
  check(refused.status === 401, "a wrong password is refused", `status ${refused.status}`);

  const after = await call("GET", "/v1/admin/sign-ins?hours=24&limit=500", { token: bossToken });
  const ours = (after.json?.rows ?? []).filter((row) => row.source === "control plane");
  check(ours.length > countBefore, "the refusal is in the merged ledger", `${countBefore} then ${ours.length}`);

  const row = ours.find((entry) => entry.email === USER_EMAIL && entry.outcome === "refused");
  check(row != null, "with the email that was typed");
  check(/^[0-9a-f]{64}$/.test(String(row?.triedHash ?? "")), "and a 64 character keyed hash of the password", String(row?.triedHash ?? "").slice(0, 12));
  check(String(row?.triedHash ?? "") !== TRIED_PASSWORD, "which is not the password");
  check(row?.tenant === TENANT_SLUG, "and the workspace the email maps to, filled in by the control plane", String(row?.tenant));

  const ok = ours.find((entry) => entry.outcome === "ok");
  check(ok != null && String(ok.triedHash ?? "").length === 0, "a successful sign-in is recorded with no hash at all");

  // Every file in the data directory, byte by byte. The sqlite store, its two WAL sidecars and the
  // salt. If the password text is anywhere in any of them, this leg is the one that says so.
  const searched = [];
  let found = "";
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      searched.push(path.relative(dataDir, full));
      const bytes = readFileSync(full);
      if (bytes.includes(Buffer.from(TRIED_PASSWORD, "utf8"))) found = path.relative(dataDir, full);
    }
  };
  walk(dataDir);
  check(searched.length > 0, "the data directory has files to search", searched.join(", "));
  check(found === "", "the password that was tried is in no file in the data directory", found ? `found in ${found}` : "");
}

// ---- the relay's own ledger writer ----------------------------------------------------------------
step("the relay's ledger");
{
  const ledger = createLoginLedger({ dir: ledgerDir, maxBytes: 4096 });
  await ledger.record({ door: "account", email: "Owner@Acme.Example", ip: ORDINARY_IP, userAgent: "x".repeat(400), outcome: "refused", password: TRIED_PASSWORD });
  await ledger.record({ door: "instance", ip: ORDINARY_IP, outcome: "ok", password: TRIED_PASSWORD, tenant: TENANT_SLUG });
  await ledger.record({ door: "instance", ip: ORDINARY_IP, outcome: "locked" });

  const rows = await ledger.rows();
  check(rows.length === 3, "three rows were written", String(rows.length));
  check(rows[0].email === "owner@acme.example", "the email is lowercased as typed", rows[0].email);
  check(rows[0].userAgent.length === 120, "the user agent is clipped to 120 characters", String(rows[0].userAgent.length));
  check(rows[0].triedHash === hashTried(TRIED_PASSWORD, readFileSync(path.join(ledgerDir, "login-attempt-salt"), "utf8").trim()),
    "the hash is HMAC-SHA256 of the password under the salt file, recomputed here");
  check(rows[1].triedHash === "", "a successful sign-in carries no hash");
  check(rows[2].triedHash === "", "a lockout carries no hash either");

  const mode = statSync(path.join(ledgerDir, "login-attempt-salt")).mode & 0o777;
  check(mode === 0o600, "the salt file is 0600", `0${mode.toString(8)}`);
  const ledgerMode = statSync(path.join(ledgerDir, "login-attempts.jsonl")).mode & 0o777;
  check(ledgerMode === 0o600, "and so is the ledger", `0${ledgerMode.toString(8)}`);

  const raw = readFileSync(path.join(ledgerDir, "login-attempts.jsonl"), "utf8");
  check(!raw.includes(TRIED_PASSWORD), "the password text is not in the ledger file");
  check(raw.includes(rows[0].triedHash), "the keyed hash is");

  // Rotation, counted rather than guessed at: rows are written one at a time until the rename
  // actually happens, then three more into the fresh file. A fixed number of rows would depend on
  // how wide a row happens to be, which is how a gate starts passing for the wrong reason.
  const live = path.join(ledgerDir, "login-attempts.jsonl");
  const kept = `${live}.1`;
  let written = 3;
  let rotatedAfter = 0;
  for (let index = 0; index < 500 && rotatedAfter === 0; index += 1) {
    await ledger.record({ door: "account", email: `filler${index}@example.com`, ip: ATTACK_IP, outcome: "refused", password: `filler-${index}` });
    written += 1;
    if (existsSync(kept)) rotatedAfter = written;
  }
  check(rotatedAfter > 0, "past the cap the file rotates", `after ${rotatedAfter} rows`);
  for (let index = 0; index < 3; index += 1) {
    await ledger.record({ door: "account", email: `after${index}@example.com`, ip: ATTACK_IP, outcome: "refused", password: `after-${index}` });
    written += 1;
  }
  check(statSync(live).size < 4096, "and the live file starts again under the cap", `${statSync(live).size} bytes`);
  const files = readdirSync(ledgerDir).filter((name) => name.startsWith("login-attempts.jsonl"));
  check(files.length === 2, "exactly one previous file is kept", files.join(", "));
  const all = await ledger.rows();
  check(all.length === written, "and both files are read back together, oldest first", `${all.length} of ${written}`);
  check(all[0].email === "owner@acme.example", "with the oldest row first");
  check(!readFileSync(kept, "utf8").includes(TRIED_PASSWORD), "the rotated file has no password text either");
}

// ---- the attack rule --------------------------------------------------------------------------------
step("the attack rule");
{
  const answer = await call("GET", "/v1/admin/sign-ins?hours=24&limit=1000", { token: bossToken });
  check(answer.status === 200, "the merged ledger answers", `status ${answer.status}`);
  const addresses = answer.json?.addresses ?? [];
  const attack = addresses.find((row) => row.ip === ATTACK_IP);
  const same = addresses.find((row) => row.ip === SAME_IP);
  const ordinary = addresses.find((row) => row.ip === ORDINARY_IP);

  check(attack != null, "the attacking address is in the summary");
  check(attack?.distinctPasswords === 6, "six different passwords were counted", String(attack?.distinctPasswords));
  check(attack?.attack === true, "and the address is flagged as an attack");
  check(attack?.passwordStory === "6 different passwords", "and the panel's sentence says so in plain words", String(attack?.passwordStory));

  check(same != null && same.attack === false, "the address that tried one password four times is NOT flagged");
  check(same?.passwordStory === "the same password 4 times", "and its sentence says the same password", String(same?.passwordStory));
  check(same?.distinctPasswords === 1, "one distinct password", String(same?.distinctPasswords));

  check(ordinary != null && ordinary.attack === false, "and one refusal then a lockout then a sign-in is not an attack");
  check(ordinary?.ok === 1 && ordinary?.locked === 1 && ordinary?.refused === 1, "with all three outcomes counted",
    `${ordinary?.refused}/${ordinary?.locked}/${ordinary?.ok}`);

  const bySource = new Set((answer.json?.rows ?? []).map((row) => row.source));
  check(bySource.has("relay") && bySource.has("control plane"), "and both ledgers are in the one list", [...bySource].join(", "));
  check(relayCalls.some((row) => row.path === "/admin/login-attempts" && row.authorized), "the control plane read the relay's ledger with the relay token");

  // The spray, which every other brake in the product misses.
  const sprayAddresses = new Set(SPRAY_IPS);
  const sprayBuckets = addresses.filter((row) => sprayAddresses.has(row.ip));
  check(sprayBuckets.length === SPRAY_IPS.length, "the spray's addresses are all in the by-address table", String(sprayBuckets.length));
  check(sprayBuckets.every((row) => row.attack === false), "and not one of them is flagged, which is exactly why the address table cannot catch this");

  const accounts = answer.json?.accounts ?? [];
  const sprayed = accounts.filter((row) => row.sprayed);
  check(sprayed.length === SPRAY_EMAILS.length, "the by-account table flags every account the one password was tried on", `${sprayed.length} of ${SPRAY_EMAILS.length}`);
  check(sprayed.every((row) => row.addresses.length === 1), "each of those accounts saw one address and one attempt");
  check(accounts.some((row) => row.email === USER_EMAIL && row.sprayed === false), "and an ordinary account in the same window is not flagged");

  const password = (answer.json?.passwords ?? []).find((row) => row.spray);
  check(password?.accountsInWindow === SPRAY_EMAILS.length, "one password reached six accounts inside the window", String(password?.accountsInWindow));
  check((password?.addresses ?? []).length === SPRAY_IPS.length, "from six different addresses", String((password?.addresses ?? []).length));
  check(String(answer.json?.sprayRule ?? "").includes("spray"), "and the panel carries the rule in plain words", String(answer.json?.sprayRule ?? "").slice(0, 60));

  const refusedOnly = await call("GET", "/v1/admin/sign-ins?hours=24&outcome=refused&limit=1000", { token: bossToken });
  check((refusedOnly.json?.rows ?? []).every((row) => row.outcome === "refused"), "the outcome filter filters");
  const oneHour = await call("GET", "/v1/admin/sign-ins?hours=1&limit=1000", { token: bossToken });
  check((oneHour.json?.rows ?? []).length > 0, "and the hours filter still finds this run's own rows");
}

// ---- the five read routes -----------------------------------------------------------------------------
step("the five panels' data");
{
  const overview = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(overview.status === 200 && overview.json?.counts?.clients === 1, "overview counts the workspaces", JSON.stringify(overview.json?.counts));
  check(overview.json?.signIns?.attackAddresses?.includes(ATTACK_IP), "and names the attacking address");
  check((overview.json?.signIns?.sprayedAccounts ?? []).length === SPRAY_EMAILS.length,
    "and names the accounts one password was sprayed across", String((overview.json?.signIns?.sprayedAccounts ?? []).length));

  const clients = await call("GET", "/v1/admin/clients", { token: bossToken });
  const client = (clients.json?.clients ?? [])[0];
  check(clients.status === 200 && client != null, "clients answers", `status ${clients.status}`);
  check(client?.slug === TENANT_SLUG, "with the workspace", String(client?.slug));
  check((client?.users ?? []).length === 2, "and the people who can sign in to it", String((client?.users ?? []).length));
  check(client?.plan === "none", "and a plan of none, said out loud rather than left blank");
  check((client?.users ?? []).some((row) => row.lastSignInAt != null), "and a last sign-in for somebody who has signed in");
  check(client?.coolify?.reachable === true && client?.coolify?.status === "running", "and what Coolify says right now", String(client?.coolify?.status));

  const boxes = await call("GET", "/v1/admin/boxes", { token: bossToken });
  const box = (boxes.json?.boxes ?? [])[0];
  check(boxes.status === 200 && box != null, "boxes answers", `status ${boxes.status}`);
  check(box?.containerState === "running", "the container state came from the relay", String(box?.containerState));
  check(box?.gatewayAnswering === true, "the gateway answering came from the relay");
  check(box?.diskKb === 4_194_304 && box?.memoryBytes === 1_476_395_008, "and so did disk and memory");
  check(box?.lastBackupStamp === null && String(box?.lastBackupWhy).includes("not mounted"),
    "the backup stamp is not measured, and says why", String(box?.lastBackupWhy).slice(0, 60));

  const system = await call("GET", "/v1/admin/system", { token: bossToken });
  check(system.status === 200, "system answers", `status ${system.status}`);
  check(system.json?.coolify?.reachable === true, "Coolify is reachable");
  check(system.json?.relay?.reachable === true, "the relay is reachable");
  check(system.json?.backup?.measured === false && String(system.json?.backup?.why).length > 0, "the nightly backup is not measured, and says why");
  check(system.json?.isolation?.measured === false && String(system.json?.isolation?.why).includes("box-isolation.sh"),
    "the box isolation check is not measured, and names the script that would write one");
  check(system.json?.mailWebhook?.measured === false, "the mail webhook is not measured from this container");
  check(Array.isArray(system.json?.disks) && system.json.disks.length === 2, "two disks are reported, one of them the archives mount that is not there");
  check(system.json?.disks?.[1]?.freeBytes === null, "and the one that is not mounted reads null rather than zero");
  check(Array.isArray(system.json?.stuckProvisioning), "stuck builds are a list");
  // The one card that says whether the sign-in panel's numbers mean anything. Without it, a data
  // directory this service cannot write reads as a quiet day rather than as a broken ledger.
  check(system.json?.signInRecord?.signing === true, "the sign-in record says it is being written", String(system.json?.signInRecord?.why ?? "").slice(0, 60));
  check(system.json?.counts?.superAdmins === 1, "and there is one super admin", String(system.json?.counts?.superAdmins));

  // The named actions. Coolify is the fake one, so this measures that the route reaches it with the
  // service uuid and writes the ledger, not that a container moved.
  const restart = await call("POST", `/v1/admin/clients/${TENANT_SLUG}/restart`, { token: bossToken, body: {} });
  check(restart.status === 200, "a super admin can restart a customer's workspace", `status ${restart.status}`);
  check(coolifyCalls.some((row) => /\/services\/[^/]+\/restart$/.test(row.path)), "and Coolify was actually asked");

  // The adopted guard is shared with /v1/tenants, and this is the leg that proves the admin console
  // did not get its own copy without it. Tenant "titanium" is Jason's live console.
  const rebuild = await call("POST", `/v1/admin/clients/${TENANT_SLUG}/provision`, { token: bossToken, body: {} });
  check(rebuild.status === 409 && rebuild.json?.error === "adopted",
    "and cannot rebuild an adopted instance into a second copy of the live console", `status ${rebuild.status}`);

  const disabled = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/disable`, { token: bossToken, body: {} });
  check(disabled.status === 200 && disabled.json?.account?.disabled === true, "a person's sign-in can be turned off", `status ${disabled.status}`);
  const shut = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: USER_PASSWORD } });
  check(shut.status === 403 && shut.json?.error === "disabled", "and that person can no longer sign in", `status ${shut.status}`);
  const self = await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/disable`, { token: bossToken, body: {} });
  check(self.status === 409, "a super admin cannot disable their own sign-in from the console", `status ${self.status}`);
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/enable`, { token: bossToken, body: {} });

  const reset = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/reset-password`, { token: bossToken, body: {}, raw: true });
  const temporary = String(reset.json?.temporaryPassword ?? "");
  check(reset.status === 200 && temporary.length >= 8, "a password reset hands back one temporary password", `status ${reset.status}`);
  const withTemporary = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: temporary } });
  check(withTemporary.status === 200, "which works", `status ${withTemporary.status}`);
  userPasswordNow = temporary;
  const again = await call("GET", "/v1/admin/clients", { token: bossToken });
  check(!again.text.includes(temporary), "and is not readable anywhere afterwards");
}

// ---- the page --------------------------------------------------------------------------------------
step("the page");
if (!WANT_BROWSER) {
  console.log("  SKIP  --no-browser was passed, so the page was not measured");
} else {
  const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
    ?? process.env.PLAYWRIGHT_DIR
    ?? path.join(repoRoot, ".cache", "playwright");
  const tried = [];
  let playwright = null;
  try { playwright = createRequire(path.join(PW_DIR, "package.json"))("playwright-core"); }
  catch (error) { tried.push(`playwright-core in ${PW_DIR}: ${String(error.message).split("\n")[0]}`); }
  if (playwright == null) {
    try { const mod = await import(`${PW_DIR}/playwright/index.js`); playwright = mod.chromium ? mod : (mod.default ?? mod); }
    catch (error) { tried.push(`playwright in ${PW_DIR}/playwright: ${String(error.message).split("\n")[0]}`); }
  }
  if (playwright == null) {
    try { const mod = await import("playwright"); playwright = mod.chromium ? mod : (mod.default ?? mod); }
    catch (error) { tried.push(`playwright from this repo: ${String(error.message).split("\n")[0]}`); }
  }
  if (playwright == null) {
    console.log("playwright is not resolvable, so the page leg measured nothing.");
    for (const line of tried) console.log(`  ${line}`);
    console.log("Run scripts/setup-gates.sh, or set GROK_BOT_PLAYWRIGHT_DIR, or pass --no-browser.");
    die("the page could not be opened");
  }

  browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });

  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  check(await page.locator("#door").isVisible(), "the console opens on a sign-in form and nothing else");
  check(!(await page.locator("#console").isVisible()), "and the panels are not on screen before anyone signs in");

  // A normal account, first. The page must refuse it in plain words, with no panel behind it.
  await page.fill("#email", USER_EMAIL);
  await page.fill("#password", userPasswordNow);
  await page.click("#signinButton");
  await page.waitForFunction(() => document.getElementById("doorMessage").textContent.length > 0, null, { timeout: 15_000 }).catch(() => {});
  const refusedText = await page.locator("#doorMessage").textContent();
  check(String(refusedText).includes("not a super admin"), "a normal account is told the console is not theirs", String(refusedText).slice(0, 70));
  check(!(await page.locator("#console").isVisible()), "and still sees no panel");

  await page.fill("#email", BOSS_EMAIL);
  await page.fill("#password", BOSS_PASSWORD);
  await page.click("#signinButton");
  await page.waitForFunction(() => document.body.getAttribute("data-admin-loaded") === "true", null, { timeout: 30_000 })
    .catch(() => {});
  const live = await page.evaluate(() => window.__adminLive ?? null);
  check(live != null, "the super admin gets in and the page finishes loading", live ? `${live.panels} panels at ${live.at}` : "no readiness flag");

  const panels = ["panel-signins", "panel-clients", "panel-boxes", "panel-system", "panel-payments"];
  for (const id of panels) {
    check(await page.locator(`#${id}`).isVisible(), `the ${id.replace("panel-", "")} panel renders`);
  }
  check((await page.locator(".panel").count()) === 5, "five panels and no more", String(await page.locator(".panel").count()));

  const attackChips = await page.locator("#addresses .chip.attack").count();
  check(attackChips === 1, "one Attack chip, on the address that earned it", String(attackChips));
  const attackRow = await page.locator("#addresses tbody tr", { hasText: ATTACK_IP }).first().textContent();
  check(String(attackRow).includes("6 different passwords"), "and its row says six different passwords", String(attackRow).replace(/\s+/g, " ").slice(0, 90));
  const sameRow = await page.locator("#addresses tbody tr", { hasText: SAME_IP }).first().textContent();
  check(String(sameRow).includes("the same password 4 times"), "the other address's row says the same password four times", String(sameRow).replace(/\s+/g, " ").slice(0, 90));

  const sprayChips = await page.locator("#accounts .chip.attack").count();
  check(sprayChips === SPRAY_EMAILS.length, "a Spray chip on every account the one password was tried on", String(sprayChips));
  const sprayRow = await page.locator("#accounts tbody tr", { hasText: SPRAY_EMAILS[0] }).first().textContent();
  check(String(sprayRow).includes("the same password 1 time"), "and that row says one password, once, which is why nothing else caught it",
    String(sprayRow).replace(/\s+/g, " ").slice(0, 90));

  const clientCards = await page.locator(".client").count();
  check(clientCards === 1, "the clients panel drew the workspace", String(clientCards));
  const boxRows = await page.locator("#boxes tbody tr").count();
  check(boxRows === 1, "the box health panel drew a row", String(boxRows));
  const cards = await page.locator("#system .card").count();
  check(cards >= 8, "the system panel drew its cards", String(cards));

  const systemText = await page.locator("#system").textContent();
  check(String(systemText).includes("not measured"), "and says 'not measured' for what it cannot read, rather than a zero");
  const payments = await page.locator("#panel-payments .placeholder").textContent();
  check(String(payments).trim() === "Not connected yet. Plan and billing appear here when Stripe is wired in.",
    "the payments panel says exactly what it was asked to say", String(payments).trim().slice(0, 60));

  // No em dashes anywhere on the screen. Jason's rule, and the panel is copy a business owner reads.
  const visible = await page.evaluate(() => document.body.innerText);
  check(!visible.includes("—"), "no em dash on the whole screen");

  check(pageErrors.length === 0, "and the page threw nothing", pageErrors.slice(0, 2).join(" | "));

  await browser.close();
  browser = null;
}

// ---- leak -----------------------------------------------------------------------------------------
step("nothing leaked");
{
  const secrets = [
    ["the session secret", SESSION_SECRET],
    ["the admin token", ADMIN_TOKEN],
    ["the relay token", RELAY_TOKEN],
    ["the Coolify key", COOLIFY_KEY],
    ["the super admin's password", BOSS_PASSWORD],
    ["the customer's password", USER_PASSWORD],
    ["the password that was tried", TRIED_PASSWORD],
    ["the relay's ledger salt", RELAY_SALT],
  ];
  const haystack = bodiesSeen.join("\n");
  for (const [label, secret] of secrets) {
    check(!haystack.includes(secret), `no response body in this run carried ${label}`);
  }
  const log = childLog.join("");
  for (const [label, secret] of secrets) {
    check(!log.includes(secret), `and the control plane's log did not print ${label}`);
  }
}

// ---- out ------------------------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log("PASS  the super admin console holds: the flag, the door, the ledger, the attack rule and the five panels.");
} else {
  console.log(`FAIL  ${failures} check${failures === 1 ? "" : "s"} did not hold.`);
  if (childLog.length > 0) {
    console.log("\n--- the control plane said ---");
    console.log(childLog.join("").slice(-4000));
  }
}
cleanup();
process.exit(failures === 0 ? 0 : 1);
