#!/usr/bin/env node
// verify-one-console.mjs -- the TENANT-5 gate: one console, one login page, many customers.
//
// TENANT-2 gave every customer their own relay on their own hostname, and Jason read the shape of
// it back and said no: "The tenant console, if somebody's logged in to the console, is the same no
// matter what. Depending on their login, they get a specific set of agents in their own sandbox
// Docker container. In my mind there should only be one extra Docker container per tenant. Every
// time we add somebody new, we're basically duplicating everything. That sounds crazy."
//
// So there is now ONE relay, ONE console and ONE login page, and a tenant is one box container plus
// one data directory. Which customer a request belongs to is decided by the session cookie, and the
// relay looks that customer up in a registry it reads from the control plane. Everything that can
// go wrong with that arrangement is somebody seeing somebody else's agents, so that is what this
// gate spends its checks on.
//
// Four suites:
//
//   registry   GET /v1/relay/tenants on the CONTROL PLANE. It is the one route in that service that
//              deliberately hands out per-tenant gateway tokens and per-tenant derived session
//              keys, which amends the rule written at the top of cp/server.mjs, so all four cases
//              are measured here rather than only in a unit test: no bearer is 401, the ADMIN token
//              is 401, the relay token is 200, and the session master's own bytes appear nowhere in
//              the body. A fleet-wide key leak is the failure this is watching for.
//
//   rosters    Two customers sign in to the SAME console in two separate cookie jars and each one's
//              POST /api/listAgents reaches that customer's own box and nobody else's. Then the
//              cross-check, which is the leg that actually matters: neither roster contains one
//              name from the other, and each fake gateway was asked only by its own session.
//
//              Live, with one customer and no second, ONE_CONSOLE_GATEWAY_TOKEN makes the OPERATOR
//              the second party: a customer's roster and Jason's, from the one console, cross-checked
//              on agent IDS. That is the arrangement a real server is usually in, and it is the proof
//              the contract asks for in those words.
//
//   unknown    A session that names a tenant the registry does not know gets the login page and the
//              sentence "That workspace is not available right now." -- not a 500, not somebody
//              else's console, and not a sign-out, because a tenant is unknown while it is being
//              built and while the control plane is restarting.
//
//   operator   The instance password and the bearer are the operator, they resolve to tenant
//              "titanium", and that entry is built from the relay's own environment rather than
//              from the control plane. This is the compatibility half: with no CP_URL at all the
//              registry holds exactly one entry and the console is what it has always been, which
//              is what a developer Mac and a single-box install run.
//
//              SIGNIN-2 added a second door to that same workspace: an ACCOUNT on tenant
//              "titanium". It needs that slug's derived session key, which only the control plane
//              can produce, so the key travels on the registry row and the relay merges it onto the
//              entry it built for itself. The leg signs such an account in and then proves the
//              workspace it landed on is still the relay's own: the roster comes off the box named
//              in this relay's environment, with that environment's bearer, and carries none of a
//              customer's agents. Live, the account is a THROWAWAY minted through the control plane
//              and removed in a finally; Jason's own account is never signed in to.
//
// Run it two ways.
//
//   node scripts/verify-one-console.mjs
//     Everything local and nothing to install. The gate starts a fake control plane serving the
//     registry route, two fake gateways standing in for two customers' boxes, a stub `docker` on
//     PATH that answers the box-name lookup, and two relay copies of its own. No network, no
//     docker, no box, no control plane.
//
//   node scripts/verify-one-console.mjs --url https://console.titanium.bot --cp https://api.titanium.bot
//     Measures the live console instead. Credentials come from the environment, never the command
//     line, and any leg whose credential was not given reports SKIP by name.
//
// Exit 0 no leg failed, 1 a leg failed, 2 nothing was measured.
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gateUserAgent } from "./gate-agent.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// SIGNIN-1. Every request this gate makes names the gate, so the sign-in panel can tell its
// refusals from a stranger's. See scripts/gate-agent.mjs for what the header is and is not worth.
const GATE_AGENT = gateUserAgent(import.meta.url);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-one-console.mjs -- the TENANT-5 gate (docs/TENANCY.md).",
    "",
    "  node scripts/verify-one-console.mjs",
    "  node scripts/verify-one-console.mjs --url https://console.titanium.bot --cp https://api.titanium.bot",
    "",
    "With no --url it starts a fake control plane, two fake gateways and two relay copies of its",
    "own and measures everything locally. With --url it measures that console instead and reports",
    "SKIP by name for any leg whose credential was not given.",
    "",
    "  --url <base>     the console to measure (default: one this gate starts)",
    "  --cp <base>      the control plane to measure (default: a fake one this gate starts)",
    "  --only <suite>   registry, rosters, unknown or operator; all four by default",
    "",
    "Credentials come from the environment, never the command line:",
    "  ONE_CONSOLE_RELAY_TOKEN     the value of CP_RELAY_TOKEN, for the registry suite",
    "  ONE_CONSOLE_ADMIN_TOKEN     the value of CP_ADMIN_TOKEN. Two legs: the one that proves it is",
    "                              refused at the registry route, and SIGNIN-2's, which mints a",
    "                              throwaway account on the operator's own workspace, signs it in at",
    "                              the console and removes it again. Needs --cp as well",
    "  ONE_CONSOLE_EMAIL_A         a customer account, and its password",
    "  ONE_CONSOLE_PASSWORD_A",
    "  ONE_CONSOLE_EMAIL_B         a DIFFERENT customer's account, and its password",
    "  ONE_CONSOLE_PASSWORD_B",
    "  ONE_CONSOLE_INSTANCE_PASSWORD   the operator's own console password. Live, it also turns on",
    "                              the cross-check that the throwaway account on the operator's",
    "                              workspace sees the same agents the password session sees",
    "  ONE_CONSOLE_GATEWAY_TOKEN   the operator's box gateway bearer. With customer A and no",
    "                              customer B, this makes the OPERATOR the second party in the",
    "                              cross-check, which is a server with one customer on it and is",
    "                              the proof the contract actually asks for. Read it off the box:",
    "                                docker exec <the operator box> printenv SAND_GATEWAY_TOKEN",
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
const RUN = (suite) => ONLY == null || ONLY === suite;
const LIVE = URL_FLAG != null;
const BOOT_TIMEOUT_MS = Number(process.env.ONE_CONSOLE_TIMEOUT_MS ?? 25000);
const KEEP = process.env.ONE_CONSOLE_KEEP === "1";

// ---- the sentences the contract fixes ---------------------------------------------------------
// Written out here rather than imported. This file is the second opinion: if ui/ changes one of
// these, the gate is what notices, and a gate that imports the string it is checking checks
// nothing.
const COPY = {
  unknownTenant: "That workspace is not available right now.",
  accountLine: "Sign in with your Titanium Bot account",
  badLogin: "That email or password is not right.",
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
const RELAY_TOKEN = randomBytes(32).toString("hex");
const ADMIN_TOKEN = randomBytes(32).toString("hex");
const OPERATOR_SLUG = "titanium";
const OPERATOR_TOKEN = randomBytes(32).toString("hex");
const OPERATOR_BOX = `titanbot-box-${randomBytes(6).toString("hex")}`;
const INSTANCE_PASSWORD = randomBytes(18).toString("base64url");

// Two customers. Different slugs, different boxes, different gateway tokens, different rosters:
// every one of those has to be different or the cross-check is measuring nothing.
const A = {
  slug: "acme", name: "Acme Roofing",
  email: `owner+${randomBytes(4).toString("hex")}@example.com`,
  password: randomBytes(18).toString("base64url"),
  box: `titanbot-box-${randomBytes(6).toString("hex")}`,
  token: randomBytes(32).toString("hex"),
  agents: ["Acme Titan", "Acme Scribe"],
};
const B = {
  slug: "bolt", name: "Bolt Electric",
  email: `owner+${randomBytes(4).toString("hex")}@example.com`,
  password: randomBytes(18).toString("base64url"),
  box: `titanbot-box-${randomBytes(6).toString("hex")}`,
  token: randomBytes(32).toString("hex"),
  agents: ["Bolt Foreman"],
};
// SIGNIN-2. An account on the OPERATOR's own workspace, which is a door that did not work at all
// before this wave: the relay had no key for that slug, so a correct password read 503. Local only;
// live, the throwaway below is minted through the real control plane and removed again.
const OPERATOR_ACCOUNT = {
  slug: OPERATOR_SLUG, name: "Titanium",
  email: `operator+${randomBytes(4).toString("hex")}@example.com`,
  password: randomBytes(18).toString("base64url"),
};

// A tenant the control plane knows nothing about. The cookie for it is signed with a key the relay
// can derive, so the session itself is perfectly valid: what is missing is the registry entry, which
// is exactly the state a customer is in while their box is still being built.
const GHOST_SLUG = "ghostco";

// ---- the token, re-derived here ---------------------------------------------------------------
// v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(key, the payload segment))>, and a tenant's
// key is HMAC-SHA256(master, "titanbot-tenant-session-v1:<slug>") in hex. Both come out of the
// contract rather than out of the module under test.
const b64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tenantKey = (master, slug) => createHmac("sha256", master).update(`titanbot-tenant-session-v1:${slug}`, "utf8").digest("hex");
function mint(claims, key) {
  const now = Date.now();
  const payload = {
    sub: claims.sub ?? randomUUID(), email: claims.email, tenant: claims.tenant, host: claims.host,
    iat: claims.iat ?? now, exp: claims.exp ?? now + 12 * 60 * 60 * 1000, jti: claims.jti ?? randomUUID(),
  };
  const part = b64url(JSON.stringify(payload));
  return { token: `v1.${part}.${b64url(createHmac("sha256", key).update(part, "utf8").digest())}`, payload };
}

// ---- process plumbing -------------------------------------------------------------------------
const temps = [];
const children = [];
const servers = [];

const cleanup = () => {
  for (const child of children) { if (child.exitCode == null) { try { child.kill("SIGKILL"); } catch { /* gone */ } } }
  for (const server of servers) { try { server.close(); } catch { /* closed */ } }
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
    console.log("verify-one-console: FAIL (the run did not finish)");
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

const listen = async (handler) => {
  const port = await freePort();
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { port, base: `http://127.0.0.1:${port}` };
};

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

// ---- the two fake boxes -------------------------------------------------------------------------
// A gateway is a bearer and one route this gate cares about: POST /api/listAgents. Each records
// what it was asked and which bearer asked, which is how the cross-check proves the relay did not
// merely answer differently but actually reached a different box with a different token.
function fakeGateway(tenant) {
  const seen = [];
  return {
    seen,
    handler: async (req, res) => {
      const url = new URL(req.url, "http://box");
      await readBody(req);
      const auth = String(req.headers.authorization ?? "");
      seen.push({ path: url.pathname, bearer: auth.replace(/^Bearer\s+/i, "").trim() });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      if (auth !== `Bearer ${tenant.token}`) return send(401, { error: "unauthorized" });
      if (url.pathname === "/api/listAgents") {
        return send(200, { agents: tenant.agents.map((name, index) => ({ id: `${tenant.slug}-${index}`, name })) });
      }
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(": open\n\n");
      }
      return send(200, {});
    },
  };
}

// ---- the fake control plane ---------------------------------------------------------------------
// Two routes, and no more: POST /v1/sessions is how a customer signs in, GET /v1/relay/tenants is
// the registry. The recorder at the end is what proves the relay called nothing else, and the
// answers to a wrong or missing bearer are the ones the real service has to give, so the local run
// measures the same four cases the live run does.
const cpCalls = [];
let registryReads = 0;
let registryDown = false;
const ACCOUNTS = new Map([
  [A.email.toLowerCase(), A],
  [B.email.toLowerCase(), B],
  [OPERATOR_ACCOUNT.email.toLowerCase(), OPERATOR_ACCOUNT],
]);

function registryBody(gateways) {
  return {
    tenants: [
      // SIGNIN-2. The operator's own row in the shape the real control plane answers for an adopted
      // workspace: its slug and that slug's own derived key, and not one field more. No box, no
      // gateway, no token, no directories -- the relay builds all of those from its own environment
      // and merges only this one, which is the one it cannot derive.
      { slug: OPERATOR_SLUG, sessionKey: tenantKey(MASTER, OPERATOR_SLUG) },
    ].concat([A, B].map((tenant) => ({
      slug: tenant.slug,
      name: tenant.name,
      status: "running",
      box: tenant.box,
      gateway: gateways[tenant.slug],
      token: tenant.token,
      sessionKey: tenantKey(MASTER, tenant.slug),
      stateDir: `/data/titanbot/${tenant.slug}/state`,
      profileDir: `/data/titanbot/${tenant.slug}/profile`,
    }))),
    // A row the control plane holds but cannot serve is named rather than dropped, so the relay can
    // log why a customer is missing instead of answering them a bare 404.
    skipped: [
      { slug: "halfbuilt", why: "no gateway token on disk yet" },
      // The operator's own, and the reason the rest of its row is absent. The real control plane
      // says exactly this for an adopted workspace whose token it does not hold, and the relay is
      // deliberately silent about this one line rather than reading it as a fault every minute.
      { slug: OPERATOR_SLUG, what: "tenant", why: "this workspace has no gateway token on this server" },
    ],
  };
}

function fakeControlPlane(gateways) {
  return async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const raw = await readBody(req);
    if (req.headers["x-gate-self"] !== "1") cpCalls.push({ method: req.method, path: url.pathname });
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    // The registry suite calls this route itself, and those calls must not be counted as the
    // relay's: a leg that says "the relay read the registry" would otherwise pass on a relay that
    // never opened it. The gate marks its own with a header nothing else sends.
    const fromTheGate = req.headers["x-gate-self"] === "1";

    if (req.method === "GET" && url.pathname === "/v1/relay/tenants") {
      // Not an error status: a control plane that is DOWN does not answer at all, and the relay
      // holding its last good map is the thing under test.
      if (registryDown) { req.socket.destroy(); return; }
      if (bearer.length === 0) return send(401, { error: "unauthorized" });
      // The admin token is a different door and it does not open this one.
      if (bearer === ADMIN_TOKEN) return send(401, { error: "unauthorized" });
      if (bearer !== RELAY_TOKEN) return send(401, { error: "unauthorized" });
      if (!fromTheGate) registryReads += 1;
      return send(200, registryBody(gateways));
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "bad_request" }); }
      const account = ACCOUNTS.get(String(body.email ?? "").trim().toLowerCase());
      if (account == null || account.password !== body.password) return send(401, { error: "invalid_login" });
      const host = "console.titanium.bot";
      const { token, payload } = mint({ email: String(body.email), tenant: account.slug, host },
        tenantKey(MASTER, account.slug));
      return send(200, {
        token,
        expiresAt: new Date(payload.exp).toISOString(),
        account: { id: payload.sub, email: payload.email, name: account.name },
        tenant: { slug: account.slug, host, status: "running" },
      });
    }
    return send(404, { error: "not_found" });
  };
}

// ---- a stub docker ------------------------------------------------------------------------------
// The registry verifies a box name against `docker ps` rather than trusting the control plane's
// text, because a name that is not a container on this host is a request that must answer the
// sentence instead of reaching an arbitrary container. There is no docker on a gate runner and
// there are no boxes, so the gate provides one: a shell script on PATH that prints the names this
// run says exist. GHOST is deliberately not in the list.
function stubDockerDir(names) {
  const dir = mkdtempSync(path.join(tmpdir(), "one-console-path-"));
  temps.push(dir);
  const file = path.join(dir, "docker");
  writeFileSync(file, [
    "#!/bin/sh",
    "# A stand-in for docker, written by scripts/verify-one-console.mjs. It answers the two",
    "# read-only lookups the relay's registry makes and nothing else.",
    'case "$1" in',
    "  ps)",
    names.map((name) => `    echo ${name}`).join("\n"),
    "    ;;",
    "  inspect)",
    '    for name in ' + names.join(" ") + '; do',
    '      for arg in "$@"; do [ "$arg" = "$name" ] && echo "/$name"; done',
    "    done",
    "    ;;",
    "  *)",
    "    exit 0",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(file, 0o755);
  return dir;
}

// ---- a relay copy -------------------------------------------------------------------------------
// A copy of ui/, never ui/ itself: the operator's own auth.json and endpoints.json would change
// which branch runs, and a gate that quietly stops measuring is worse than no gate.
function relayTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "one-console-relay-"));
  temps.push(dir);
  cpSync(path.join(repoRoot, "ui"), dir, {
    recursive: true,
    // The login ledger and its key are on this list for the same reason the password file is: the
    // gate must not read the operator's record of who knocked, and it must not sign its own rows
    // with the operator's key. ADMIN-1.
    filter: (source) => !/(auth|endpoints|subscriptions|mail)\.json$/.test(source)
      && !/(mail-inbox|login-attempts)\.jsonl(\.1)?$/.test(source) && !/login-attempt-salt$/.test(source),
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

async function startRelay({ label, env = {}, pathValue }) {
  const dir = relayTree();
  await setPassword(dir, INSTANCE_PASSWORD);
  const stateDir = mkdtempSync(path.join(tmpdir(), "one-console-state-"));
  temps.push(stateDir);
  const profileDir = mkdtempSync(path.join(tmpdir(), "one-console-profile-"));
  temps.push(profileDir);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    env: {
      HOME: process.env.HOME, PATH: pathValue,
      SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
      // The operator's own instance, seeded from this environment and from nowhere else. That is
      // the compatibility story: with no CP_URL these five values ARE the whole registry.
      SAND_UI_STATE_DIR: stateDir,
      SAND_PROFILE_DIRS: profileDir,
      SAND_UI_AUTH_FILE: path.join(dir, "auth.json"),
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

// ---- HTTP ---------------------------------------------------------------------------------------
// Redirects are never followed: which status and which Location is half of what is being measured.
async function get(base, pathname, { cookie, accept = "text/html", bearer } = {}) {
  // The gate's own name first, then everything a caller asked for, so a caller can override it and
  // nothing here can silently drop what a caller sent.
  const headers = { "user-agent": GATE_AGENT, accept };
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}${pathname}`, { redirect: "manual", headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
async function postForm(base, pathname, fields, { cookie } = {}) {
  const headers = { "user-agent": GATE_AGENT, "content-type": "application/x-www-form-urlencoded", accept: "text/html" };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${pathname}`, {
    method: "POST", redirect: "manual", headers, body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
async function apiCall(base, method, cookie) {
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST", redirect: "manual",
    headers: { "user-agent": GATE_AGENT, "content-type": "application/json", cookie }, body: "{}",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}
// The control plane's own admin routes, for the one leg that has to create something and remove it
// again. `x-gate-self` keeps these out of the recorder that proves the RELAY called nothing else.
async function planCall(base, method, pathname, { token, body } = {}) {
  const headers = { "user-agent": GATE_AGENT, accept: "application/json", "x-gate-self": "1" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${pathname}`, {
    method, redirect: "manual", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

// Every agent id a roster answer carries, whatever shape the box wrapped it in. This host answers
// listAgents as a BARE ARRAY and other surfaces wrap it, so both are read rather than one assumed.
const agentIds = (json) => {
  const list = Array.isArray(json) ? json : (Array.isArray(json?.agents) ? json.agents : []);
  return [...new Set(list.map((agent) => String(agent?.id ?? "")).filter((id) => id.length > 0))].sort();
};

const sessionCookie = (res) => /(?:^|,\s*)(gb_session=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
// Every agent name a roster answer mentions, whatever shape the gateway wrapped it in. The gate is
// looking for one customer's names inside another customer's answer, and for that the flat text is
// a truer instrument than a schema this file would have to keep in step with the box.
const namesIn = (text) => [...A.agents, ...B.agents].filter((name) => String(text).includes(name));

// ---- the run ------------------------------------------------------------------------------------
console.log("verify-one-console.mjs -- TENANT-5, one console for every customer");
console.log(LIVE ? `  console: ${URL_FLAG}` : "  console: a copy this gate starts");
console.log(CP_FLAG ? `  plane:   ${CP_FLAG}` : (LIVE ? "  plane:   none given" : "  plane:   a fake one this gate starts"));

if (!existsSync(path.join(repoRoot, "ui", "server.mjs"))) die("ui/server.mjs is not in this tree.");
// The registry is what this gate is about. Without it there is nothing here to measure, and saying
// so is not the same as passing: exit 2, the same answer this gate gives when a relay will not
// start.
if (!LIVE && !existsSync(path.join(repoRoot, "ui", "tenant-registry.mjs"))) {
  die([
    "ui/tenant-registry.mjs is not in this tree, so this relay has no tenant registry and there is",
    "nothing for this gate to measure. That module is the TENANT-5 relay wave; docs/TENANCY.md",
    "describes what it holds. Run this gate again once it has landed.",
  ].join("\n"));
}

let relay = null;
let soloRelay = null;
let cpBase = CP_FLAG;
let gatewayA = null;
let gatewayB = null;

if (!LIVE) {
  gatewayA = fakeGateway(A);
  gatewayB = fakeGateway(B);
  const aBox = await listen(gatewayA.handler);
  const bBox = await listen(gatewayB.handler);
  const operatorBox = await listen(fakeGateway({ token: OPERATOR_TOKEN, slug: OPERATOR_SLUG, agents: ["Titan", "Scribe"] }).handler);

  const plane = await listen(fakeControlPlane({ [A.slug]: aBox.base, [B.slug]: bBox.base }));
  cpBase = plane.base;

  // The names the stub docker says are containers on this host. Both customers and the operator,
  // and deliberately not GHOST_SLUG's, which has no box at all.
  const dockerPath = stubDockerDir([A.box, B.box, OPERATOR_BOX]);
  const withDocker = `${dockerPath}:${process.env.PATH ?? ""}`;

  relay = await startRelay({
    label: "fleet", pathValue: withDocker,
    env: {
      CP_URL: cpBase,
      CP_RELAY_TOKEN: RELAY_TOKEN,
      SAND_BOX_CONTAINER: OPERATOR_BOX,
      SAND_HOST_GATEWAY_URL: operatorBox.base,
      SAND_HOST_GATEWAY_TOKEN: OPERATOR_TOKEN,
    },
  });

  // No control plane at all: the developer Mac and the single-box install. Without this copy the
  // operator suite would pass on a relay that only works when a control plane is up, which is the
  // regression that takes Jason's console down with the control plane.
  soloRelay = await startRelay({
    label: "solo", pathValue: withDocker,
    env: {
      SAND_BOX_CONTAINER: OPERATOR_BOX,
      SAND_HOST_GATEWAY_URL: operatorBox.base,
      SAND_HOST_GATEWAY_TOKEN: OPERATOR_TOKEN,
    },
  });
}

const CONSOLE = LIVE ? URL_FLAG : relay.base;

// The console has to be answering at all before any leg means anything.
{
  let reachable = false;
  for (let attempt = 0; attempt < 3 && !reachable; attempt += 1) {
    try { await get(CONSOLE, "/auth/state", { accept: "application/json" }); reachable = true; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!reachable) die(`${CONSOLE} did not answer /auth/state.`);
}

// Credentials, live only. Local mode has its own.
const liveRelayToken = process.env.ONE_CONSOLE_RELAY_TOKEN?.trim() || null;
const liveAdminToken = process.env.ONE_CONSOLE_ADMIN_TOKEN?.trim() || null;
const CRED = {
  relayToken: LIVE ? liveRelayToken : RELAY_TOKEN,
  adminToken: LIVE ? liveAdminToken : ADMIN_TOKEN,
  emailA: LIVE ? (process.env.ONE_CONSOLE_EMAIL_A?.trim() || null) : A.email,
  passwordA: LIVE ? (process.env.ONE_CONSOLE_PASSWORD_A ?? null) : A.password,
  emailB: LIVE ? (process.env.ONE_CONSOLE_EMAIL_B?.trim() || null) : B.email,
  passwordB: LIVE ? (process.env.ONE_CONSOLE_PASSWORD_B ?? null) : B.password,
  instance: LIVE ? (process.env.ONE_CONSOLE_INSTANCE_PASSWORD ?? null) : INSTANCE_PASSWORD,
  // The operator's OTHER door, live only. The bearer resolves to the same workspace the instance
  // password does, and unlike the password it is readable off the box by anyone who can already
  // reach the box, so it is the credential a gate can be given. It exists here because Jason's
  // console password is not written down anywhere a script should read, and without it the live
  // cross-check has only one party.
  gatewayToken: LIVE ? (process.env.ONE_CONSOLE_GATEWAY_TOKEN?.trim() || null) : null,
};

// ================================================================================================
// registry -- the control plane's one route that hands out keys
// ================================================================================================
if (RUN("registry")) {
  step("GET /v1/relay/tenants");
  if (cpBase == null) {
    skip("the registry route refuses a caller with no bearer", "no --cp was given");
    skip("the registry route refuses the ADMIN token", "no --cp was given");
    skip("the relay credential is let in", "no --cp was given");
    skip("the control plane's master signing secret is not in the answer", "no --cp was given");
  } else {
    const SELF = { "x-gate-self": "1", "user-agent": GATE_AGENT };
    const noBearer = await fetch(`${cpBase}/v1/relay/tenants`, { redirect: "manual", headers: SELF });
    check(noBearer.status === 401, "no bearer is refused", `status ${noBearer.status}`);

    if (CRED.adminToken == null) {
      skip("the ADMIN token does not open the registry route", "no ONE_CONSOLE_ADMIN_TOKEN");
    } else {
      const asAdmin = await fetch(`${cpBase}/v1/relay/tenants`, {
        redirect: "manual", headers: { ...SELF, authorization: `Bearer ${CRED.adminToken}` },
      });
      // The whole point of a second credential: the token that can create and delete customers is
      // not the token that reads their gateway tokens, and neither one is a way to the other.
      check(asAdmin.status === 401, "the admin token does not open it either", `status ${asAdmin.status}`);
    }

    if (CRED.relayToken == null) {
      skip("the relay credential is let in", "no ONE_CONSOLE_RELAY_TOKEN");
      skip("every tenant row carries a box, a gateway, a token and a session key", "no relay credential");
      skip("a row the control plane cannot serve is named rather than dropped", "no relay credential");
      skip("the control plane's master signing secret is not in the answer", "no relay credential");
    } else {
      const res = await fetch(`${cpBase}/v1/relay/tenants`, {
        redirect: "manual", headers: { ...SELF, authorization: `Bearer ${CRED.relayToken}` },
      });
      const raw = await res.text();
      check(res.status === 200, "the relay credential is let in", `status ${res.status}`);
      let body = null;
      try { body = JSON.parse(raw); } catch { /* not json */ }
      const rows = Array.isArray(body?.tenants) ? body.tenants : [];
      check(rows.length > 0, "and it answers with a list of tenants", `${rows.length} row(s)`);
      // The operator's own row is a different shape from a customer's and is measured as its own
      // leg below, so it comes out of the completeness count first. Both of these legs were wrong
      // against the live control plane from PROXY-1 until SIGNIN-2: that service has answered a
      // titanium row since PROXY-1 shipped, so a gate that counted it as incomplete and then
      // asserted its absence reported FAIL twice for a console that was working.
      const operatorRows = rows.filter((row) => row.slug === OPERATOR_SLUG);
      const customerRows = rows.filter((row) => row.slug !== OPERATOR_SLUG);
      const incomplete = customerRows.filter((row) => !row.box || !row.gateway || !row.token || !row.sessionKey);
      check(customerRows.length > 0 && incomplete.length === 0,
        "every customer row carries a box, a gateway, a token and a session key",
        incomplete.length === 0 ? customerRows.map((row) => row.slug).join(", ") || "(no customers)" : `${incomplete.map((r) => r.slug ?? "?").join(", ")} is missing a field`);
      check(Array.isArray(body?.skipped), "and a skipped list, so a customer who is missing can be explained",
        Array.isArray(body?.skipped) ? `${body.skipped.length} skipped` : "there is no skipped list");

      // SIGNIN-2. The operator's own workspace is adopted, so this service holds no box, no gateway
      // token and no directories for it: the relay builds every one of those from its own
      // environment, which is what keeps this console up when this service is not. What the row
      // carries is the two fields the relay cannot produce -- that slug's derived session key, and
      // the included set when a plan is on -- and a row carrying anything more is a field that is
      // ignored at best and points Jason's console at somebody else's box at worst.
      if (operatorRows.length === 0) {
        check(false, `the operator's own workspace carries its derived session key`,
          `no row for ${OPERATOR_SLUG}, so an account on that workspace cannot sign in`);
      } else {
        const operatorRow = operatorRows[0];
        check(operatorRows.length === 1 && typeof operatorRow.sessionKey === "string" && operatorRow.sessionKey.length === 64,
          `the operator's own workspace carries its derived session key`,
          `${operatorRows.length} row(s), key ${String(operatorRow.sessionKey ?? "").length} chars`);
        const extra = Object.keys(operatorRow).filter((field) => !["slug", "sessionKey", "included"].includes(field));
        check(extra.length === 0, "and nothing else: no box, no gateway, no token, no directories",
          extra.join(", ") || "(slug and sessionKey only)");
      }

      // CP-11, amended on purpose and gated here rather than only in a unit test. This route hands
      // out per-tenant DERIVED keys, and a derived key signs for one customer. The MASTER signs for
      // every customer on the fleet, and it must not be in these bytes in any form.
      if (LIVE) {
        skip("the control plane's master signing secret is not in the answer", "the master is only known to a plane this gate starts");
      } else {
        check(!raw.includes(MASTER), "the control plane's master signing secret is not in the answer");
        const derived = rows.filter((row) => row.sessionKey === tenantKey(MASTER, row.slug));
        check(rows.length > 0 && derived.length === rows.length,
          "each row's session key is that tenant's own derived key, the operator's included",
          `${derived.length} of ${rows.length}`);
        check(rows.every((row) => row.sessionKey !== MASTER), "and none of them is the master wearing a different name");
      }
    }
  }
}

// ================================================================================================
// rosters -- two customers, one console, and neither one sees the other
// ================================================================================================
let cookieA = "";
let cookieB = "";

if (RUN("rosters")) {
  step("two customers sign in to the same console");
  const page = await get(CONSOLE, "/login");
  check(page.status === 200, "GET /login answers 200", `status ${page.status}`);
  check(page.text.includes(COPY.accountLine), `the one login page says "${COPY.accountLine}"`);
  // No customer hostname anywhere in the copy. <slug>.titanium.bot is retired and a page that still
  // offers one is telling a customer to go somewhere that is not being kept up.
  check(!/\b[a-z0-9-]+\.titanium\.bot/.test(page.text.replace(/console\.titanium\.bot/g, "")),
    "and it names no per-customer hostname",
    (page.text.replace(/console\.titanium\.bot/g, "").match(/\b[a-z0-9-]+\.titanium\.bot/) ?? ["none"])[0]);

  // Live with ONE customer and the operator's bearer: that is the contract's own proof, a customer
  // and Jason, and it is the arrangement a real server is usually in. A second real customer exists
  // only when somebody has signed one up.
  const operatorIsTheSecondParty = LIVE
    && CRED.emailA != null && CRED.passwordA != null
    && (CRED.emailB == null || CRED.passwordB == null)
    && CRED.gatewayToken != null;

  if (operatorIsTheSecondParty) {
    const inA = await postForm(CONSOLE, "/login", { email: CRED.emailA, password: CRED.passwordA });
    check(inA.status === 302 && inA.headers.get("location") === "/", "the customer signs in and lands on the console", `status ${inA.status}`);
    cookieA = sessionCookie(inA);
    check(cookieA.length > 0, "with a session cookie");
    skip("customer B signs in at the same address", "no second customer; the operator is the other party");

    step("a customer's roster and the operator's, from the one console");
    const rosterA = await apiCall(CONSOLE, "listAgents", cookieA);
    check(rosterA.status === 200, "the customer's console answers listAgents", `status ${rosterA.status}`);
    const asOperator = await fetch(`${CONSOLE}/api/listAgents`, {
      method: "POST", redirect: "manual",
      headers: { "user-agent": GATE_AGENT, "content-type": "application/json", authorization: `Bearer ${CRED.gatewayToken}` },
      body: "{}",
    });
    const operatorText = await asOperator.text();
    check(asOperator.status === 200, "the operator's bearer answers listAgents", `status ${asOperator.status}`);

    // Ids, not names. Every fresh box calls its first agent "New Bot", so a customer and the
    // operator can have rosters that share a NAME and share no agent at all. The id is per box, so
    // an id on both lists is one box answering for two workspaces, which is the whole failure.
    const idsOf = (text) => [...String(text).matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((hit) => hit[1]);
    const idsA = idsOf(rosterA.text);
    const idsOperator = idsOf(operatorText);
    check(idsA.length > 0 && idsOperator.length > 0, "both rosters have agents on them",
      `customer ${idsA.length}, operator ${idsOperator.length}`);
    const shared = idsA.filter((id) => idsOperator.includes(id));
    check(shared.length === 0, "no agent is on both the customer's roster and the operator's",
      shared.length === 0 ? "none in common" : `both carry ${shared.join(", ")}`);
    check(rosterA.text !== operatorText, "and the two answers are not the same bytes");
  } else if (CRED.emailA == null || CRED.passwordA == null || CRED.emailB == null || CRED.passwordB == null) {
    skip("customer A signs in", "no ONE_CONSOLE_EMAIL_A / ONE_CONSOLE_PASSWORD_A");
    skip("customer B signs in at the same address",
      LIVE && CRED.emailA != null ? "no second customer, and no ONE_CONSOLE_GATEWAY_TOKEN to use the operator instead" : "no ONE_CONSOLE_EMAIL_B / ONE_CONSOLE_PASSWORD_B");
    skip("each roster is that customer's own", "no account credentials");
    skip("neither roster carries one name from the other", "no account credentials");
  } else {
    const inA = await postForm(CONSOLE, "/login", { email: CRED.emailA, password: CRED.passwordA });
    check(inA.status === 302 && inA.headers.get("location") === "/", "customer A signs in and lands on the console", `status ${inA.status}`);
    cookieA = sessionCookie(inA);
    check(cookieA.length > 0, "with a session cookie");

    const inB = await postForm(CONSOLE, "/login", { email: CRED.emailB, password: CRED.passwordB });
    check(inB.status === 302 && inB.headers.get("location") === "/",
      "customer B signs in at the SAME address, not a redirect to a host of their own", `status ${inB.status}`);
    cookieB = sessionCookie(inB);
    check(cookieB.length > 0, "with a session cookie of their own");
    check(cookieA !== cookieB, "and the two cookies are not the same value");

    step("two rosters");
    if (cookieA.length === 0 || cookieB.length === 0) {
      skip("each roster is that customer's own", "one of the two sign-ins minted nothing");
      skip("neither roster carries one name from the other", "one of the two sign-ins minted nothing");
    } else {
      const rosterA = await apiCall(CONSOLE, "listAgents", cookieA);
      const rosterB = await apiCall(CONSOLE, "listAgents", cookieB);
      check(rosterA.status === 200, "customer A's console answers listAgents", `status ${rosterA.status}`);
      check(rosterB.status === 200, "customer B's console answers listAgents", `status ${rosterB.status}`);

      if (LIVE) {
        // Live, the gate does not know the two rosters, so what it can measure is that they are
        // DIFFERENT. Two customers whose consoles answer byte for byte the same thing is either one
        // box serving both or an empty fleet, and both are the failure this gate exists for.
        check(rosterA.text !== rosterB.text,
          "the two customers do not get the same answer", rosterA.text === rosterB.text ? "both rosters are identical" : "they differ");
      } else {
        const inA2 = namesIn(rosterA.text);
        const inB2 = namesIn(rosterB.text);
        check(A.agents.every((name) => inA2.includes(name)), "customer A sees their own agents", inA2.join(", ") || "(none)");
        check(B.agents.every((name) => inB2.includes(name)), "customer B sees their own agents", inB2.join(", ") || "(none)");
        // The cross-check. This is the leg the whole gate is for.
        check(!B.agents.some((name) => inA2.includes(name)), "customer A does not see one of customer B's agents", inA2.join(", ") || "(none)");
        check(!A.agents.some((name) => inB2.includes(name)), "customer B does not see one of customer A's agents", inB2.join(", ") || "(none)");

        // And not merely a different answer: a different BOX, reached with a different token. A
        // relay that filtered one box's roster by tenant would pass the two legs above and fail
        // these two, and it is the arrangement that leaks the day the filter has an edge case.
        const askedA = gatewayA.seen.filter((call) => call.path === "/api/listAgents");
        const askedB = gatewayB.seen.filter((call) => call.path === "/api/listAgents");
        check(askedA.length > 0 && askedB.length > 0, "each customer's own box was the one asked",
          `A ${askedA.length} call(s), B ${askedB.length} call(s)`);
        check(askedA.every((call) => call.bearer === A.token), "customer A's box was asked with customer A's gateway token");
        check(askedB.every((call) => call.bearer === B.token), "customer B's box was asked with customer B's gateway token");
        check(!gatewayB.seen.some((call) => call.bearer === A.token) && !gatewayA.seen.some((call) => call.bearer === B.token),
          "and neither token was ever presented to the other customer's box");
      }
    }
  }
}

// ================================================================================================
// unknown -- a session for a tenant the registry does not know
// ================================================================================================
if (RUN("unknown")) {
  step("a workspace the registry does not know");
  if (LIVE) {
    skip("a session for an unknown tenant gets the sentence", "the cookie secret is only known to a relay this gate starts");
    skip("and the cookie is not cleared over it", "the cookie secret is only known to a relay this gate starts");
  } else {
    // The relay's own session cookie for a tenant that is not in the registry. Getting one takes the
    // relay's cookie secret, which this gate does not hold, so it is obtained the way a real
    // customer would: sign in as a customer the registry knows, then have the control plane stop
    // knowing them. That is exactly the live state of a customer whose box is being rebuilt.
    //
    // The sso door is the way in that needs no cookie secret: a token signed with the tenant's own
    // derived key, which the fake control plane's master gives this gate.
    const ghost = mint({ email: "nobody@example.com", tenant: GHOST_SLUG, host: "console.titanium.bot" },
      tenantKey(MASTER, GHOST_SLUG));
    const landed = await get(CONSOLE, `/login?sso=${encodeURIComponent(ghost.token)}`);
    // Two shapes are both correct here and the gate takes either: the relay may refuse the link
    // outright because the tenant is unknown, or accept the signature and then answer the sentence
    // on the console. What it must never do is 200 with somebody's roster on it.
    const refusedAtTheDoor = landed.status === 401 || landed.status === 503;
    const cookie = sessionCookie(landed);
    if (refusedAtTheDoor) {
      check(landed.text.includes(COPY.unknownTenant) || landed.text.includes("not valid here"),
        "an unknown workspace is answered in plain words at the door", `status ${landed.status}`);
      check(cookie.length === 0, "and nothing is minted for it");
    } else if (landed.status === 302 && cookie.length > 0) {
      check(true, "the link is accepted and the answer comes from the console", `status ${landed.status}`);
      const home = await get(CONSOLE, "/", { cookie });
      check(home.status === 503, "and the console answers 503 rather than a roster", `status ${home.status}`);
      check(home.text.includes(COPY.unknownTenant), `it says "${COPY.unknownTenant}"`);
      // Not cleared, deliberately. A tenant is unknown while it is provisioning and while the
      // control plane is restarting, and signing a customer out over a transient state is worse
      // than the sentence.
      const cleared = /gb_session=;/.test(home.headers.get("set-cookie") ?? "");
      check(!cleared, "and the customer is not signed out over it");
      const api = await apiCall(CONSOLE, "listAgents", cookie);
      check(api.status !== 200, "and no roster is served to it", `status ${api.status}`);
    } else {
      // Neither shape. The legs below all depend on a session that was never minted, and a check
      // that cannot reach its subject must not report PASS: it is one FAIL that says what happened.
      check(false, "an unknown workspace is either refused at the door or answered on the console",
        `GET /login?sso= for an unknown tenant answered ${landed.status} with ${cookie.length > 0 ? "a" : "no"} cookie`);
    }
  }
}

// ================================================================================================
// operator -- Jason's own instance, and a console with no control plane behind it
// ================================================================================================
if (RUN("operator")) {
  step("the operator's own door");
  if (CRED.instance == null) {
    skip("the instance password signs in", "no ONE_CONSOLE_INSTANCE_PASSWORD");
    skip("and it reaches the operator's own box", "no ONE_CONSOLE_INSTANCE_PASSWORD");
  } else {
    const ok = await postForm(CONSOLE, "/login", { password: CRED.instance });
    check(ok.status === 302, "the password Jason already has still works", `status ${ok.status}`);
    const cookie = sessionCookie(ok);
    check(cookie.length > 0, "and mints a session");
    if (cookie.length > 0) {
      const roster = await apiCall(CONSOLE, "listAgents", cookie);
      check(roster.status === 200, "the operator's console answers listAgents", `status ${roster.status}`);
      if (!LIVE) {
        const strays = namesIn(roster.text);
        check(strays.length === 0, "and no customer's agent is on the operator's roster", strays.join(", ") || "(none)");
        check(roster.text.includes("Titan"), "the operator sees their own", roster.text.slice(0, 120));
      }
    }
  }

  // ================================================================================================
  // SIGNIN-2 -- an ACCOUNT on the operator's own workspace
  // ================================================================================================
  // The second door to the same workspace, and before this wave it did not work at all: the relay
  // had no session key for tenant "titanium", so a correct password read 503 "That workspace is not
  // available right now." while the identical account on a customer's workspace signed in at once.
  // The key can only come from the control plane, so what is measured is that it arrived AND that
  // nothing else did: the roster behind the cookie still comes off the box named in this relay's own
  // environment, with that environment's bearer.
  step("an account on the operator's own workspace");
  if (!LIVE) {
    const inOperator = await postForm(CONSOLE, "/login", { email: OPERATOR_ACCOUNT.email, password: OPERATOR_ACCOUNT.password });
    check(inOperator.status === 302 && inOperator.headers.get("location") === "/",
      "an account on the operator's workspace signs in", `status ${inOperator.status}`);
    const cookie = sessionCookie(inOperator);
    check(cookie.length > 0, "with a session cookie");
    if (cookie.length > 0) {
      const roster = await apiCall(CONSOLE, "listAgents", cookie);
      // A 200 is itself the proof that the relay used its own environment: the fake operator gateway
      // refuses every bearer but SAND_HOST_GATEWAY_TOKEN, so a roster that comes back at all came
      // back from the box this relay was configured with and not from one the registry named.
      check(roster.status === 200, "and lands on the operator's own box", `status ${roster.status}`);
      check(roster.text.includes("Titan") && roster.text.includes("Scribe"),
        "with the operator's own agents on it", roster.text.slice(0, 120));
      const strays = namesIn(roster.text);
      check(strays.length === 0, "and no customer's agent anywhere on it", strays.join(", ") || "(none)");
    }
  } else if (CRED.adminToken == null || cpBase == null) {
    skip("a throwaway account on the operator's workspace signs in", "needs --cp and ONE_CONSOLE_ADMIN_TOKEN");
    skip("and lands on the operator's own workspace", "needs --cp and ONE_CONSOLE_ADMIN_TOKEN");
    skip("and the throwaway is removed again", "needs --cp and ONE_CONSOLE_ADMIN_TOKEN");
  } else {
    // A throwaway, never Jason's own account. An account on this slug IS an operator-level user --
    // it gets the operator's box, agents, settings and connectors, because there is no lesser role
    // on that workspace -- so the address is random, the password is random and never printed, the
    // cookie stays in memory, and the removal runs in a finally and is asserted. The control plane
    // says on its own DELETE that a session already minted keeps working until it expires, which is
    // the other reason this is a throwaway and not a reused probe.
    const probeEmail = `signin2-probe-${randomBytes(6).toString("hex")}@probe.invalid`;
    const probePassword = randomBytes(18).toString("base64url");
    let created = false;
    try {
      const add = await planCall(cpBase, "POST", "/v1/accounts", {
        token: CRED.adminToken, body: { email: probeEmail, password: probePassword, tenant: OPERATOR_SLUG, name: "SIGNIN-2 probe" },
      });
      created = add.status === 201;
      check(created, "a throwaway account on the operator's workspace is created", `status ${add.status}`);

      if (created) {
        const inProbe = await postForm(CONSOLE, "/login", { email: probeEmail, password: probePassword });
        check(inProbe.status === 302 && inProbe.headers.get("location") === "/",
          "a throwaway account on the operator's workspace signs in", `status ${inProbe.status}`);
        const cookie = sessionCookie(inProbe);
        check(cookie.length > 0, "with a session cookie");
        if (cookie.length > 0) {
          const roster = await apiCall(CONSOLE, "listAgents", cookie);
          check(roster.status === 200, "and the console answers its roster", `status ${roster.status}`);
          // The leg that proves WHICH workspace it landed on. The instance password resolves to the
          // operator's own workspace by definition, so the same set of agent ids from both sessions
          // is the evidence; a different set would mean the account landed somewhere else.
          if (CRED.instance == null) {
            skip("and lands on the operator's own workspace", "no ONE_CONSOLE_INSTANCE_PASSWORD to compare against");
          } else {
            const byPassword = await postForm(CONSOLE, "/login", { password: CRED.instance });
            const operatorCookie = sessionCookie(byPassword);
            const operatorRoster = operatorCookie.length > 0 ? await apiCall(CONSOLE, "listAgents", operatorCookie) : null;
            const mine = agentIds(roster.json);
            const theirs = operatorRoster == null ? [] : agentIds(operatorRoster.json);
            check(theirs.length > 0 && mine.length === theirs.length && mine.every((id, at) => id === theirs[at]),
              "and lands on the operator's own workspace",
              `${mine.length} agent id(s) from the account, ${theirs.length} from the instance password`);
          }
        }
      }
    } finally {
      if (created) {
        const gone = await planCall(cpBase, "DELETE", `/v1/accounts/${encodeURIComponent(probeEmail)}`, {
          token: CRED.adminToken, body: { confirm: probeEmail },
        });
        // A removal that did not happen is a FAIL, not a warning: what is left behind is a working
        // operator-level sign-in on Jason's own workspace.
        check(gone.status === 200, "and the throwaway is removed again", `status ${gone.status}`);
        const list = await planCall(cpBase, "GET", "/v1/accounts", { token: CRED.adminToken });
        const left = (Array.isArray(list.json?.accounts) ? list.json.accounts : [])
          .filter((account) => String(account?.email ?? "").includes("signin2-probe-"));
        check(list.status === 200 && left.length === 0, "and no probe account is left on the control plane",
          left.length === 0 ? "(none)" : `${left.length} left`);
      }
    }
  }

  if (LIVE) {
    skip("a console with no control plane behind it is unchanged", "that needs a relay this gate starts");
    skip("the relay asks the control plane for the registry and for sign-in, and nothing else", "the recorder is the fake plane's");
    skip("no gateway token is in the relay's log", "the log is the instance's own");
  } else {
    step("a console with no control plane at all");
    // The single-box install and every developer Mac. This is the leg that makes the whole change
    // safe to ship: the registry with no CP_URL holds exactly one entry, built from the relay's own
    // environment, and the console is what it has always been.
    const solo = await get(soloRelay.base, "/login");
    check(solo.status === 200, "the login page comes up with no CP_URL set", `status ${solo.status}`);
    check(!solo.text.includes(COPY.accountLine), "and it does not offer an account door it cannot use");
    const inSolo = await postForm(soloRelay.base, "/login", { password: INSTANCE_PASSWORD });
    const soloCookie = sessionCookie(inSolo);
    check(inSolo.status === 302 && soloCookie.length > 0, "the instance password gets in", `status ${inSolo.status}`);
    if (soloCookie.length > 0) {
      const roster = await apiCall(soloRelay.base, "listAgents", soloCookie);
      check(roster.status === 200 && roster.text.includes("Titan"),
        "and the roster comes off the box in this relay's own environment", `status ${roster.status}`);
    }

    step("what the relay tells the control plane");
    const paths = [...new Set(cpCalls.map((call) => `${call.method} ${call.path}`))];
    // A PREFIX rule, and it replaces a two-path list that had been FAILing since MAIL-2 shipped:
    // this relay legitimately calls the mail directory on the same credential, and an enumeration of
    // exact paths goes stale every time the relay edge grows a route (mail, voice and code each added
    // one). What is actually worth gating is that the relay never reaches a route outside its own
    // door: /v1/relay/* is the relay credential's own side of the control plane, POST /v1/sessions is
    // the sign-in, and anything else -- /v1/accounts, /v1/tenants, /v1/admin/* -- is a route only the
    // ADMIN token opens and a relay has no business on.
    const allowed = (one) => one === "POST /v1/sessions" || /^(GET|POST|DELETE) \/v1\/relay\//.test(one);
    check(paths.every(allowed), "its own relay routes and the sign-in, and nothing a relay has no business on",
      paths.join(", ") || "(no calls)");
    check(registryReads > 0, "and it did read the registry at least once", `${registryReads} read(s)`);

    const logs = `${relay.log()}${relay.errLog()}${soloRelay.log()}${soloRelay.errLog()}`;
    for (const [secret, what] of [[A.token, "customer A's gateway token"], [B.token, "customer B's gateway token"],
      [OPERATOR_TOKEN, "the operator's gateway token"], [RELAY_TOKEN, "the relay credential"],
      [MASTER, "the control plane's master"], [A.password, "customer A's password"],
      [OPERATOR_ACCOUNT.password, "the operator account's password"],
      [tenantKey(MASTER, OPERATOR_SLUG), "the operator's derived session key"],
      [INSTANCE_PASSWORD, "the instance password"]]) {
      check(!logs.includes(secret), `${what} is nowhere in the relay's log`);
    }
  }
}

console.log("");
if (skipped > 0) {
  console.log(`${skipped} leg(s) were not measured: ${skippedNames.join("; ")}`);
  console.log("Give the credentials named in --help to measure them.");
}
console.log(failures === 0 ? `verify-one-console: PASS (${skipped} not measured)` : `verify-one-console: FAIL (${failures} leg(s))`);
cleanup();
process.exit(failures === 0 ? 0 : 1);
