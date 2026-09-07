#!/usr/bin/env node
// verify-tenant.mjs -- the TENANT-2 gate: a customer's own instance, from the outside.
//
// A tenant relay differs from Jason's in two ways that a customer meets on their first minute:
// they sign in with a Titanium Bot ACCOUNT rather than an instance password, and their compose was
// rendered without /var/run/docker.sock, so the console features that reach the box by
// `docker exec` are honestly absent instead of quietly broken. This gate measures both, over HTTP,
// the way a browser does.
//
// Two suites:
//
//   login    the login page carries an email field in tenant mode and not otherwise; a wrong email
//            gets the plain sentence; the right email for THIS tenant mints a session that opens
//            the console; the right email for ANOTHER tenant is redirected to that tenant's own
//            host with ?sso=; that link signs in; a forged one does not; the instance password
//            still works; and a control plane that is not answering says so without taking the
//            instance password away
//   docker   the routes that need the box refuse in words a business owner can read, with the
//            console still serving underneath them; and the one route that does NOT need the box
//            but would reach into this server's network -- saving a provider endpoint -- refuses
//            an address inside it
//
// Run it two ways.
//
//   node scripts/verify-tenant.mjs
//     Everything local. The gate starts a FAKE control plane, then two relay copies of its own: a
//     tenant one pointed at the fake plane with no docker on its PATH, and a plain one with no
//     tenant environment at all (that second copy is the only way to prove the email field appears
//     BECAUSE of tenant mode rather than always). Needs no network, no box and no docker.
//
//   node scripts/verify-tenant.mjs --url https://demo.titanium.bot --cp https://api.titanium.bot
//     Against a live instance and its real control plane. The legs that need a credential run only
//     when one is given, and the ones that do not are reported SKIP by name -- never quietly
//     dropped, because a gate that silently shrinks is a gate nobody reads.
//
// Credentials, when running live, come from the environment and never from the command line, so
// they stay out of the shell history and out of the process list:
//
//   TENANT_GATE_EMAIL / TENANT_GATE_PASSWORD          an account on the instance being measured
//   TENANT_GATE_OTHER_EMAIL / TENANT_GATE_OTHER_PASSWORD   an account on a DIFFERENT tenant
//   TENANT_GATE_RELAY_PASSWORD                        that instance's own password
//
// Nothing here imports ui/session-token.mjs or cp/session.mjs. The tokens this gate mints and
// forges are built with node:crypto from the contract's own description, because a gate that asked
// the code under test whether its signature was right would be proving nothing.
//
// Exit status: 0 no leg failed, 1 a leg failed, 2 nothing could be measured at all (a relay would
// not start, or the URL given never answered). 2 is not a pass.
//
// Other env: TENANT_GATE_TIMEOUT_MS (boot wait, default 25000), TENANT_GATE_KEEP=1 to leave the
// temp directories behind for a look.
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-tenant.mjs -- the TENANT-2 gate (docs/TENANCY.md).",
    "",
    "  node scripts/verify-tenant.mjs",
    "  node scripts/verify-tenant.mjs --url https://demo.titanium.bot --cp https://api.titanium.bot",
    "",
    "With no --url it starts a fake control plane and two relay copies of its own and measures",
    "everything locally. With --url it measures that instance instead, and reports SKIP by name",
    "for any leg whose credential was not given.",
    "",
    "  --url <base>     the relay to measure (default: one this gate starts)",
    "  --cp <base>      the control plane to point at (default: a fake one this gate starts)",
    "  --only <suite>   login or docker; both by default",
    "",
    "Credentials come from the environment, never the command line:",
    "  TENANT_GATE_EMAIL, TENANT_GATE_PASSWORD, TENANT_GATE_OTHER_EMAIL,",
    "  TENANT_GATE_OTHER_PASSWORD, TENANT_GATE_RELAY_PASSWORD",
    "",
    "Exit 0 no leg failed, 1 a leg failed, 2 nothing was measured.",
  ].join("\n"));
  process.exit(0);
}

const flag = (name) => {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline != null) return inline.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const URL_FLAG = flag("url")?.replace(/\/+$/, "") ?? null;
const CP_FLAG = flag("cp")?.replace(/\/+$/, "") ?? null;
const ONLY = flag("only");
const RUN_LOGIN = ONLY == null || ONLY === "login";
const RUN_DOCKER = ONLY == null || ONLY === "docker";
const BOOT_TIMEOUT_MS = Number(process.env.TENANT_GATE_TIMEOUT_MS ?? 25000);
const KEEP = process.env.TENANT_GATE_KEEP === "1";
const LIVE = URL_FLAG != null;

// ---- the sentences the contract fixes ---------------------------------------------------------
// Written out here rather than imported, for the same reason the signatures are re-derived below:
// this file is the second opinion. If ui/ changes one of these, the gate is what notices.
const COPY = {
  accountLine: "Sign in with your Titanium Bot account",
  passwordLine: "or the instance password",
  badLogin: "That email or password is not right.",
  cpDown: "Titanium Bot sign-in is not answering right now. The instance password still works.",
  badLink: "That sign-in link is not valid here.",
  endpointsUse: "This instance cannot switch models from the console yet.",
  desktop: "The desktop view is not available on this instance yet.",
};

// ---- reporting --------------------------------------------------------------------------------
let failures = 0;
let skipped = 0;
const skippedNames = [];
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => {
  console.log(`  SKIP  ${label} -- ${why}`);
  skipped += 1;
  skippedNames.push(label);
};
const step = (title) => console.log(`\n== ${title}`);

// ---- the secrets this run mints ---------------------------------------------------------------
// All fake, all alive for one process, none of them ever printed.
const MASTER = randomBytes(32).toString("hex");
const TENANT = "gate";
const OTHER_TENANT = "othertenant";
const OTHER_HOST = "othertenant.titanium.bot";
const ACCOUNT_EMAIL = `owner+${randomBytes(4).toString("hex")}@example.com`;
const ACCOUNT_PASSWORD = randomBytes(18).toString("base64url");
const OTHER_EMAIL = `other+${randomBytes(4).toString("hex")}@example.com`;
const OTHER_PASSWORD = randomBytes(18).toString("base64url");
const RELAY_PASSWORD = randomBytes(18).toString("base64url");
const GATEWAY_TOKEN = randomBytes(32).toString("hex");
// A short git sha, which is the only shape the runtime route serves.
const STAGED_VERSION = randomBytes(4).toString("hex").slice(0, 7);

// ---- the token, re-derived here ---------------------------------------------------------------
// v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(key, the payload segment))>, and the key a
// tenant holds is HMAC-SHA256(master, "titanbot-tenant-session-v1:<slug>") in hex. Both come out of
// the contract, not out of the module under test.
const b64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tenantKey = (master, slug) => createHmac("sha256", master).update(`titanbot-tenant-session-v1:${slug}`, "utf8").digest("hex");
function mint(claims, key) {
  const now = Date.now();
  const payload = {
    sub: claims.sub ?? randomUUID(), email: claims.email, tenant: claims.tenant, host: claims.host,
    iat: claims.iat ?? now, exp: claims.exp ?? now + 12 * 60 * 60 * 1000, jti: claims.jti ?? randomUUID(),
  };
  const part = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac("sha256", key).update(part, "utf8").digest());
  return { token: `v1.${part}.${signature}`, payload };
}

// ---- the fake control plane -------------------------------------------------------------------
// POST /v1/sessions is the only route a relay is ever allowed to call, and the recorder at the end
// is what proves it called nothing else. `down` makes it stop answering, which is how the
// "sign-in is not answering" copy gets measured without unplugging anything.
const cpCalls = [];
let cpDown = false;
const ACCOUNTS = new Map([
  [ACCOUNT_EMAIL.toLowerCase(), { password: ACCOUNT_PASSWORD, tenant: TENANT, host: null, name: "A Business Owner" }],
  [OTHER_EMAIL.toLowerCase(), { password: OTHER_PASSWORD, tenant: OTHER_TENANT, host: OTHER_HOST, name: "Someone Else" }],
]);

function fakeControlPlane(req, res) {
  const url = new URL(req.url, "http://fake");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    cpCalls.push({ method: req.method, path: url.pathname, bytes: raw.length });
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    // Not an error status: a control plane that is DOWN does not answer at all, and the relay's
    // 15 second timeout is the thing under test. The socket is dropped.
    if (cpDown) { req.socket.destroy(); return; }
    if (req.method !== "POST" || url.pathname !== "/v1/sessions") return send(404, { error: "not_found" });
    let body = {};
    try { body = JSON.parse(raw); } catch { return send(400, { error: "bad_request" }); }
    const account = ACCOUNTS.get(String(body.email ?? "").trim().toLowerCase());
    if (account == null || account.password !== body.password) return send(401, { error: "invalid_login" });
    const host = account.host ?? `${account.tenant}.titanium.bot`;
    const { token, payload } = mint({ email: String(body.email), tenant: account.tenant, host },
      tenantKey(MASTER, account.tenant));
    return send(200, {
      token,
      expiresAt: new Date(payload.exp).toISOString(),
      account: { id: payload.sub, email: payload.email, name: account.name },
      tenant: { slug: account.tenant, host, status: "running" },
    });
  });
}

// ---- process plumbing --------------------------------------------------------------------------
const temps = [];
const children = [];
let fake = null;

const cleanup = () => {
  for (const child of children) { if (child.exitCode == null) { try { child.kill("SIGKILL"); } catch { /* gone */ } } }
  if (fake) { try { fake.close(); } catch { /* closed */ } }
  if (!KEEP) for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } }
};
const die = (message) => {
  console.log(`\n${message}`);
  console.log("exit 2: nothing was measured");
  cleanup();
  process.exit(2);
};
process.on("exit", cleanup);
// A gate that dies on a stack trace has reported nothing, and the half of the run it had already
// measured goes with it. Anything unexpected becomes a FAIL line and a non-zero exit instead.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.log(`  FAIL  the gate itself stopped -- ${error instanceof Error ? error.message : String(error)}`);
    console.log("verify-tenant: FAIL (the run did not finish)");
    cleanup();
    process.exit(1);
  });
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// A copy of ui/, never ui/ itself: the operator's own auth.json and endpoints.json would change
// which branch runs, and a gate that quietly stops measuring is worse than no gate.
function relayTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "tenant-gate-relay-"));
  temps.push(dir);
  cpSync(path.join(repoRoot, "ui"), dir, {
    recursive: true,
    filter: (source) => !/(auth|endpoints|subscriptions|mail)\.json$/.test(source) && !/mail-inbox\.jsonl$/.test(source),
  });
  return dir;
}

// The password goes in over stdin, the way the operator's own instructions say to set it, so this
// gate never writes a hash of its own and never learns the file's format.
function setPassword(dir, password) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, "set-password.mjs"), path.join(dir, "auth.json")], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`set-password exited ${code}: ${err.trim()}`))));
    child.stdin.end(password);
  });
}

// A relay copy on a real port. `pathValue` is what decides whether it has docker: an empty
// directory is a tenant instance, which is the whole second half of this gate.
async function startRelay({ label, env = {}, password = null, pathValue }) {
  const dir = relayTree();
  if (password != null) await setPassword(dir, password);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    env: {
      HOME: process.env.HOME, PATH: pathValue,
      SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
      // A dead port. Every leg here is decided before the relay reaches upstream.
      SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
      SAND_HOST_GATEWAY_TOKEN: GATEWAY_TOKEN,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const up = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), BOOT_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (/^auth /m.test(out)) { clearInterval(poll); clearTimeout(timer); resolve(true); }
      if (child.exitCode != null) { clearInterval(poll); clearTimeout(timer); resolve(false); }
    }, 50);
  });
  if (!up) die([`the ${label} relay copy would not start.`, out.trim(), err.trim()].filter(Boolean).join("\n"));
  return { base: `http://127.0.0.1:${port}`, log: () => out, errLog: () => err };
}

// An empty directory on PATH: `docker` is not findable, which is exactly a tenant relay.
function emptyPathDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "tenant-gate-path-"));
  temps.push(dir);
  return dir;
}

// ---- HTTP ---------------------------------------------------------------------------------------
// Redirects are never followed: which status and which Location is half of what is being measured.
async function get(base, pathname, { cookie, accept = "text/html" } = {}) {
  const headers = { accept };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${pathname}`, { redirect: "manual", headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
async function postForm(base, pathname, fields, { cookie } = {}) {
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "text/html" };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${pathname}`, {
    method: "POST", redirect: "manual", headers, body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const sessionCookie = (res) => /(?:^|,\s*)(gb_session=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

// ---- the run --------------------------------------------------------------------------------
console.log("verify-tenant.mjs -- TENANT-2, a customer's own instance");
console.log(LIVE ? `  relay: ${URL_FLAG}` : "  relay: two copies this gate starts");
console.log(CP_FLAG ? `  plane: ${CP_FLAG}` : (LIVE ? "  plane: none given" : "  plane: a fake one this gate starts"));

if (!existsSync(path.join(repoRoot, "ui", "server.mjs"))) die("ui/server.mjs is not in this tree.");

let tenantRelay = null;
let plainRelay = null;
let downRelay = null;
let cpBase = CP_FLAG;

if (!LIVE) {
  const fakePort = await freePort();
  cpBase = `http://127.0.0.1:${fakePort}`;
  fake = http.createServer(fakeControlPlane);
  await new Promise((resolve, reject) => { fake.once("error", reject); fake.listen(fakePort, "127.0.0.1", resolve); });

  const noDocker = emptyPathDir();
  const deadPort = await freePort();
  // A staged host bundle, so the runtime route gets past "nothing is staged" and reaches the one
  // thing on it that really does need docker. The version file is served off this directory with
  // no container involved, which is the half that must keep working on a tenant.
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "tenant-gate-runtime-"));
  temps.push(runtimeDir);
  writeFileSync(path.join(runtimeDir, "sand-host-bundle-latest.version"), `${STAGED_VERSION}\n`);
  tenantRelay = await startRelay({
    label: "tenant", pathValue: noDocker, password: RELAY_PASSWORD,
    env: {
      TENANT_ID: TENANT, CP_URL: cpBase, CP_SESSION_SECRET: tenantKey(MASTER, TENANT),
      SAND_HOST_RUNTIME_DIR: runtimeDir,
    },
  });
  // No tenant environment at all: the control for "the email field is there BECAUSE of tenant
  // mode". Without this copy the first leg would pass on a login page that always had one.
  plainRelay = await startRelay({ label: "plain", pathValue: noDocker, password: RELAY_PASSWORD });
  // Tenant mode pointed at a port with nothing on it: the "sign-in is not answering" copy.
  downRelay = await startRelay({
    label: "unreachable-plane", pathValue: noDocker, password: RELAY_PASSWORD,
    env: { TENANT_ID: TENANT, CP_URL: `http://127.0.0.1:${deadPort}`, CP_SESSION_SECRET: tenantKey(MASTER, TENANT) },
  });
}

const RELAY = LIVE ? URL_FLAG : tenantRelay.base;

// The relay has to be answering at all before any leg means anything.
{
  let reachable = false;
  for (let attempt = 0; attempt < 3 && !reachable; attempt += 1) {
    try { await get(RELAY, "/auth/state", { accept: "application/json" }); reachable = true; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!reachable) die(`${RELAY} did not answer /auth/state.`);
}

// Credentials, live only. Local mode has its own.
const liveEmail = process.env.TENANT_GATE_EMAIL?.trim() || null;
const livePassword = process.env.TENANT_GATE_PASSWORD ?? null;
const liveOtherEmail = process.env.TENANT_GATE_OTHER_EMAIL?.trim() || null;
const liveOtherPassword = process.env.TENANT_GATE_OTHER_PASSWORD ?? null;
const liveRelayPassword = process.env.TENANT_GATE_RELAY_PASSWORD ?? null;

const EMAIL = LIVE ? liveEmail : ACCOUNT_EMAIL;
const PASSWORD = LIVE ? livePassword : ACCOUNT_PASSWORD;
const OTHER_E = LIVE ? liveOtherEmail : OTHER_EMAIL;
const OTHER_P = LIVE ? liveOtherPassword : OTHER_PASSWORD;
const INSTANCE_PASSWORD = LIVE ? liveRelayPassword : RELAY_PASSWORD;

// The key this relay verifies sso tokens with. Local mode derived it; live mode cannot know it,
// so the forged-token leg still runs (a forgery is refused whatever the key is) and the valid-link
// leg does not.
const RELAY_KEY = LIVE ? null : tenantKey(MASTER, TENANT);
const RELAY_TENANT = LIVE ? (process.env.TENANT_GATE_TENANT?.trim() || null) : TENANT;

let signedInCookie = "";

if (RUN_LOGIN) {
  step("login page");
  const page = await get(RELAY, "/login");
  check(page.status === 200, "GET /login answers 200", `status ${page.status}`);
  const hasEmailField = /<input[^>]*type="email"/i.test(page.text) || /<input[^>]*name="email"/i.test(page.text);
  check(hasEmailField, "the page carries an email field in tenant mode");
  check(page.text.includes(COPY.accountLine), `the page says "${COPY.accountLine}"`);
  check(page.text.includes(COPY.passwordLine), `the page says "${COPY.passwordLine}"`);
  // One form and one button: the contract is explicit that this is not two doors side by side.
  check((page.text.match(/<form/gi) ?? []).length === 1, "one form, not two");
  check((page.text.match(/<button/gi) ?? []).length === 1, "one button, not two");
  check(/<input[^>]*type="password"/i.test(page.text), "the instance password field is still there");

  if (LIVE) {
    skip("the page has no email field without tenant mode", "that needs a relay this gate starts");
  } else {
    const plain = await get(plainRelay.base, "/login");
    const plainHasEmail = /<input[^>]*type="email"/i.test(plain.text) || /<input[^>]*name="email"/i.test(plain.text);
    check(plain.status === 200 && !plainHasEmail, "no tenant mode, no email field: the page is what it was");
    check(!plain.text.includes(COPY.accountLine), "and it does not offer an account it cannot use");
  }

  step("signing in with an account");
  {
    const wrong = await postForm(RELAY, "/login", { email: "nobody@example.com", password: "not-the-password" });
    check(wrong.status === 200 || wrong.status === 401, "a wrong email is refused", `status ${wrong.status}`);
    check(wrong.text.includes(COPY.badLogin), `it says "${COPY.badLogin}"`);
    check(sessionCookie(wrong).length === 0, "and it mints nothing");
  }

  if (EMAIL == null || PASSWORD == null) {
    skip("the right email for this tenant signs in", "no TENANT_GATE_EMAIL / TENANT_GATE_PASSWORD");
    skip("the console answers 200 to that session", "no account credential");
  } else {
    const ok = await postForm(RELAY, "/login", { email: EMAIL, password: PASSWORD });
    check(ok.status === 302, "the right email for this tenant is let in", `status ${ok.status}`);
    check(ok.headers.get("location") === "/", "it lands on the console", String(ok.headers.get("location")));
    signedInCookie = sessionCookie(ok);
    check(signedInCookie.length > 0, "a session cookie is minted");
    if (signedInCookie.length > 0) {
      const console200 = await get(RELAY, "/", { cookie: signedInCookie });
      check(console200.status === 200, "and the console answers 200 to it", `status ${console200.status}`);
    } else {
      check(false, "and the console answers 200 to it", "there was no cookie to try");
    }
  }

  step("an account that belongs to another tenant");
  if (OTHER_E == null || OTHER_P == null) {
    skip("another tenant's account is sent to its own instance", "no TENANT_GATE_OTHER_EMAIL / TENANT_GATE_OTHER_PASSWORD");
  } else {
    const away = await postForm(RELAY, "/login", { email: OTHER_E, password: OTHER_P });
    check(away.status === 302, "it is a redirect, not a refusal and not a session", `status ${away.status}`);
    const location = String(away.headers.get("location") ?? "");
    check(sessionCookie(away).length === 0, "this relay mints nothing for somebody else's tenant");
    let target = null;
    try { target = new URL(location); } catch { /* not a URL */ }
    check(target != null && target.protocol === "https:", "it goes to an https URL", location);
    check(target != null && target.pathname === "/login", "at that host's own login", location);
    const sso = target?.searchParams.get("sso") ?? "";
    check(sso.length > 0, "carrying the token as ?sso=");
    if (!LIVE) {
      check(target?.host === OTHER_HOST, "and the host is the other tenant's", String(target?.host));
      // The token has to be signed with the OTHER tenant's key, or the instance it is being sent
      // to cannot verify it. This is the leg that catches a control plane signing everything with
      // the master. Guarded on there being a token at all: a gate that throws where it should say
      // FAIL takes every leg after it down with it.
      const [, part, signature] = sso.split(".");
      if (part == null || signature == null) {
        check(false, "and it is signed with that tenant's own key, not ours", "there was no token to read");
        check(false, "and it claims that tenant", "there was no token to read");
      } else {
        const expected = b64url(createHmac("sha256", tenantKey(MASTER, OTHER_TENANT)).update(part, "utf8").digest());
        check(signature === expected, "and it is signed with that tenant's own key, not ours");
        let claims = null;
        try { claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { /* malformed */ }
        check(claims?.tenant === OTHER_TENANT, "and it claims that tenant", String(claims?.tenant));
      }
    }
  }

  step("the sign-in link");
  if (RELAY_KEY == null) {
    skip("a valid sso link signs in", "the tenant key is only known to a relay this gate starts");
  } else {
    const valid = mint({ email: ACCOUNT_EMAIL, tenant: TENANT, host: "gate.titanium.bot" }, RELAY_KEY);
    const landed = await get(RELAY, `/login?sso=${encodeURIComponent(valid.token)}`);
    check(landed.status === 302, "GET /login?sso=<valid> signs in", `status ${landed.status}`);
    check(landed.headers.get("location") === "/", "and lands on the console", String(landed.headers.get("location")));
    const cookie = sessionCookie(landed);
    check(cookie.length > 0, "with a session cookie of this relay's own");
    if (cookie.length > 0) {
      const opened = await get(RELAY, "/", { cookie });
      check(opened.status === 200, "which opens the console", `status ${opened.status}`);
      if (signedInCookie.length === 0) signedInCookie = cookie;
    }

    // Expired, and for the wrong tenant: both are valid signatures under a key this relay holds or
    // could hold, so they are the forgeries that a signature check alone would let through.
    //
    // 401 with the login page in the body, which is what the relay answers to a wrong password on
    // the same route. The page is what the person sees either way; the status is what tells a
    // script the sign-in did not happen. No WWW-Authenticate header goes with it, so no browser
    // pops its own password box over the page.
    const stale = mint({ email: ACCOUNT_EMAIL, tenant: TENANT, host: "gate.titanium.bot", iat: Date.now() - 2000, exp: Date.now() - 1000 }, RELAY_KEY);
    const staleRes = await get(RELAY, `/login?sso=${encodeURIComponent(stale.token)}`);
    check(staleRes.status === 401 && staleRes.text.includes(COPY.badLink), "an expired link is refused", `status ${staleRes.status}`);
    check(sessionCookie(staleRes).length === 0, "and mints nothing");

    const foreign = mint({ email: OTHER_EMAIL, tenant: OTHER_TENANT, host: OTHER_HOST }, tenantKey(MASTER, OTHER_TENANT));
    const foreignRes = await get(RELAY, `/login?sso=${encodeURIComponent(foreign.token)}`);
    check(foreignRes.status === 401 && foreignRes.text.includes(COPY.badLink), "another tenant's link is refused here", `status ${foreignRes.status}`);
    check(sessionCookie(foreignRes).length === 0, "and mints nothing");
  }
  {
    // A forgery needs no key at all: right shape, wrong signature. This one runs live too.
    const part = b64url(JSON.stringify({
      sub: randomUUID(), email: "attacker@example.com", tenant: RELAY_TENANT ?? "whatever",
      host: "wherever", iat: Date.now(), exp: Date.now() + 3_600_000, jti: randomUUID(),
    }));
    const forged = `v1.${part}.${b64url(createHmac("sha256", "not the key").update(part, "utf8").digest())}`;
    const res = await get(RELAY, `/login?sso=${encodeURIComponent(forged)}`);
    check(res.status === 401, "a forged sso token gets the login page, not a session", `status ${res.status}`);
    check(res.text.includes(COPY.badLink), `it says "${COPY.badLink}"`);
    check(sessionCookie(res).length === 0, "and mints nothing");
  }

  step("the instance password");
  if (INSTANCE_PASSWORD == null) {
    skip("the instance password still signs in", "no TENANT_GATE_RELAY_PASSWORD");
  } else {
    const ok = await postForm(RELAY, "/login", { password: INSTANCE_PASSWORD });
    check(ok.status === 302, "the password Jason already has still works", `status ${ok.status}`);
    const cookie = sessionCookie(ok);
    check(cookie.length > 0, "and mints a session");
    if (cookie.length > 0 && signedInCookie.length === 0) signedInCookie = cookie;
  }

  if (LIVE) {
    skip("a control plane that is not answering says so", "that needs a relay this gate starts");
    skip("the relay calls the control plane for nothing but sign-in", "the recorder is the fake plane's");
    skip("the password is never written to the log", "the log is the instance's own");
  } else {
    step("a control plane that is not answering");
    const down = await postForm(downRelay.base, "/login", { email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD });
    check(down.status === 200 || down.status === 502 || down.status === 503, "the page comes back rather than hanging", `status ${down.status}`);
    check(down.text.includes(COPY.cpDown), `it says "${COPY.cpDown}"`);
    check(sessionCookie(down).length === 0, "and nobody is signed in on a guess");
    // The instance password is the way through, and the page said so, so prove it is true.
    const rescue = await postForm(downRelay.base, "/login", { password: RELAY_PASSWORD });
    check(rescue.status === 302 && sessionCookie(rescue).length > 0, "and the instance password still gets in", `status ${rescue.status}`);

    step("what the relay tells the control plane");
    const paths = [...new Set(cpCalls.map((call) => `${call.method} ${call.path}`))];
    check(paths.every((p) => p === "POST /v1/sessions"), "sign-in and nothing else", paths.join(", ") || "(no calls)");
    check(cpCalls.length > 0, "and it did reach it at least once");
    const logs = `${tenantRelay.log()}${tenantRelay.errLog()}${downRelay.log()}${downRelay.errLog()}`;
    check(!logs.includes(ACCOUNT_PASSWORD), "the account password is nowhere in the relay's log");
    check(!logs.includes(RELAY_PASSWORD), "and neither is the instance password");

    step("the lockout counts email attempts");
    // Six in a row, the same way six wrong passwords are counted. The seventh is the answer.
    let locked = 0;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const res = await postForm(plainRelay.base, "/login", { email: "guesser@example.com", password: `wrong-${attempt}` });
      if (res.status === 429) locked += 1;
    }
    check(locked > 0, "a run of wrong emails hits the same rate limit a run of wrong passwords does");

    step("a sign-in for another instance is not a reset button");
    // The hole this closes: the redirect branch used to clear the failure counter for the address,
    // so anyone holding an account on any other instance could guess this relay's password four at
    // a time forever. Measured live against a console before the fix: eight consecutive wrong
    // passwords, zero lockouts.
    //
    // The instance password first, to zero the counter, so this leg measures itself and not what
    // the legs above left behind.
    await postForm(tenantRelay.base, "/login", { password: RELAY_PASSWORD });
    let refused = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await postForm(tenantRelay.base, "/login", { password: `reset-probe-${attempt}` });
      if (res.status === 401) refused += 1;
    }
    check(refused === 4, "four wrong instance passwords are refused one short of the lockout", `${refused} of 4 answered 401`);
    const away = await postForm(tenantRelay.base, "/login", { email: OTHER_EMAIL, password: OTHER_PASSWORD });
    check(away.status === 302, "a real account on another instance is still redirected", `status ${away.status}`);
    const fifth = await postForm(tenantRelay.base, "/login", { password: "reset-probe-4" });
    check(fifth.status === 401, "the fifth wrong password is still the fifth", `status ${fifth.status}`);
    const sixth = await postForm(tenantRelay.base, "/login", { password: "reset-probe-5" });
    check(sixth.status === 429, "and the sixth is locked out: the redirect cleared nothing", `status ${sixth.status}`);
  }
}

// Every route in the docker suite sits behind the login, like every other console route, so the
// suite needs a session. The account sign-in above may have minted one; when it did not (--only
// docker, or the account half not landed yet) the instance password is the way in, and this gate
// knows it in local mode.
if (RUN_DOCKER && signedInCookie.length === 0 && INSTANCE_PASSWORD != null) {
  signedInCookie = sessionCookie(await postForm(RELAY, "/login", { password: INSTANCE_PASSWORD }));
}

if (RUN_DOCKER) {
  step("an instance with no docker of its own");
  if (signedInCookie.length === 0) {
    skip("POST /endpoints/use answers 409 in plain words", "no session was minted, so the route is behind the login");
    skip("the console still answers 200", "no session was minted");
    skip("the desktop surface says so in plain words", "no session was minted");
    skip("GET /model still answers", "no session was minted");
  } else {
    const cookie = signedInCookie;
    const use = await fetch(`${RELAY}/endpoints/use`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: "anything" }),
    });
    const useBody = await use.json().catch(() => null);
    check(use.status === 409, "POST /endpoints/use answers 409", `status ${use.status}`);
    check(useBody?.error === "not_available", "with error not_available", String(useBody?.error));
    check(useBody?.detail === COPY.endpointsUse, `and the sentence "${COPY.endpointsUse}"`, String(useBody?.detail));

    const surface = await fetch(`${RELAY}/box/surface?app=browser`, { redirect: "manual", headers: { cookie } });
    const surfaceBody = await surface.json().catch(() => null);
    check(surface.status === 409, "GET /box/surface answers 409", `status ${surface.status}`);
    check(surfaceBody?.detail === COPY.desktop, `and the sentence "${COPY.desktop}"`, String(surfaceBody?.detail));

    const launch = await fetch(`${RELAY}/box/launch`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ app: "browser" }),
    });
    const launchBody = await launch.json().catch(() => null);
    check(launch.status === 409 && launchBody?.detail === COPY.desktop, "POST /box/launch says the same thing", `status ${launch.status}`);

    // The refusals must not spread. The console itself is the product and it comes up.
    const home = await get(RELAY, "/", { cookie });
    check(home.status === 200, "and the console still answers 200", `status ${home.status}`);
    const model = await fetch(`${RELAY}/model`, { redirect: "manual", headers: { cookie } });
    const modelBody = await model.json().catch(() => null);
    check(model.status === 200, "GET /model answers rather than refusing on every page load", `status ${model.status}`);
    check(modelBody != null && "note" in modelBody, "and it says the live model is not knowable here");

    // Where a tenant may point an endpoint. A refusal writes nothing, so this is safe to run
    // against a live instance: the catalog is not touched on any of these.
    for (const [baseUrl, what] of [
      ["https://127.0.0.1:7777/v1", "this relay itself"],
      ["https://192.168.32.1:8000/v1", "the host, which is where Coolify listens"],
      ["http://api.example.com/v1", "plain http"],
    ]) {
      const saved = await fetch(`${RELAY}/endpoints`, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ endpoints: [{ id: "gate-probe", name: "gate probe", baseUrl, model: "m", apiKey: "" }] }),
      });
      check(saved.status === 400, `POST /endpoints refuses ${what}`, `status ${saved.status}`);
    }
  }
  if (!LIVE) {
    // The version file is read straight off the mounted runtime directory, so it answers on a
    // tenant. The TARBALL genuinely needs docker: the archive is composed inside the box from the
    // box's own /home/box/sand-host so the supervisor's prune does not delete the parts of the
    // bundle that come from the image. That is the difference, and this is where it is written
    // down. The caller here is the box's own host process, which carries the token in the path.
    const version = await fetch(`${RELAY}/runtime/${GATEWAY_TOKEN}/sand-host-bundle-latest.version`, { redirect: "manual" });
    check(version.status === 200, "the staged version is served from the mounted runtime directory", `status ${version.status}`);
    check((await version.text()).trim() === STAGED_VERSION, "and it is the version that was staged");
    const tarball = await fetch(`${RELAY}/runtime/${GATEWAY_TOKEN}/sand-host-bundle-${STAGED_VERSION}.tgz`, { redirect: "manual" });
    const tarballBody = await tarball.json().catch(() => null);
    check(tarball.status === 409, "the tarball is refused rather than half-streamed", `status ${tarball.status}`);
    check(tarballBody?.error === "not_available", "with the same refusal shape", String(tarballBody?.error));
  }
}

console.log("");
if (skipped > 0) {
  console.log(`${skipped} leg(s) were not measured: ${skippedNames.join("; ")}`);
  console.log("Give the credentials named in --help to measure them.");
}
console.log(failures === 0 ? `verify-tenant: PASS (${skipped} not measured)` : `verify-tenant: FAIL (${failures} leg(s))`);
cleanup();
process.exit(failures === 0 ? 0 : 1);
