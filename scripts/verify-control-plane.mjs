#!/usr/bin/env node
// verify-control-plane.mjs -- the TENANT-1 gate: the control plane's public surface, end to end,
// against a Coolify that is not Coolify.
//
// Everything below goes through HTTP on a server this script starts itself, the way the console
// and the CLI reach it. Nothing here imports cp/store.mjs or cp/session.mjs, so a token that
// verifies inside the process and not on the wire fails here rather than on the day a customer
// signs in. The one thing it does import is node:crypto, to re-derive the session signature
// itself: a gate that asked the code under test whether its own signature was right would be
// proving nothing.
//
// The fake Coolify is an in-process http server that records every call and answers the way the
// openapi says (201 {uuid, domains} for a service, 201 {uuid} for an env, 200 {uuid, domains} for
// the urls PATCH, "Service starting request queued." for a start). It exists here for one
// assertion above all: a dry run must not reach it. If the recorder is empty at the end of the
// dry-run leg, the --dry-run promise held.
//
// In order:
//   boot      the server starts on a free port with a temp data dir and answers /v1/health
//   health    ok, a version, and counts only: no emails, no tenant list, no secret
//   door      the admin routes refuse no bearer and refuse a wrong bearer of the same length
//   account   an account is added, a duplicate is 409, and the list carries no hash and no salt
//   session   the right password mints a v1 token; a wrong password and an unknown email give
//             the same 401 invalid_login; the token's payload and HMAC are re-derived here
//   current   the token opens /v1/sessions/current, a tampered payload does not, no bearer does not
//   revoke    DELETE /v1/sessions/current, and the same token is then refused
//   dry run   a tenant plan carries the create, the envs, the urls PATCH and the start; no call
//             reached the fake Coolify; no directory was created under CP_TENANT_ROOT; and the
//             plan does not carry the session secret in clear
//   adopt     an existing service becomes a tenant, and the tenant reads back adopted with its
//             uuid and host
//   slugs     the reserved names and the malformed shapes are all refused, and none of them
//             created a tenant
//   counts    /v1/health's tenants and accounts moved
//   leak      no response body seen in the whole run contains the session secret, the admin
//             token or the account password
//
// Exit status: 0 every leg passed, 1 a leg failed, 2 the control plane could not be started at
// all (cp/server.mjs is not there yet, or it never answered health). 2 is not a pass: it is this
// gate saying it measured nothing.
//
//   node scripts/verify-control-plane.mjs
//
// It needs no box, no docker and no network. Env it accepts: CP_GATE_PORT and CP_GATE_FAKE_PORT
// to pin the two ports instead of taking free ones, CP_GATE_TIMEOUT_MS for the boot wait
// (default 20000), and CP_GATE_SERVER to point at an entry point other than cp/server.mjs.
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-control-plane.mjs -- the TENANT-1 gate (docs/TENANCY.md).",
    "",
    "  node scripts/verify-control-plane.mjs",
    "",
    "Starts cp/server.mjs on a free port with a throwaway data dir, a throwaway tenant root and a",
    "fake Coolify, then walks the surface a customer and an operator actually touch: health, the",
    "admin door, adding an account, minting a session and verifying its signature here, reading",
    "the session back, revoking it, a tenant dry run that must not reach Coolify or the disk, an",
    "adopt, and the reserved and malformed slugs. It kills the server and deletes both temp",
    "directories on the way out.",
    "",
    "Exit 0 every leg passed, 1 a leg failed, 2 the control plane could not be started.",
    "",
    "Env: CP_GATE_PORT, CP_GATE_FAKE_PORT, CP_GATE_TIMEOUT_MS (default 20000), and",
    "     CP_GATE_SERVER to run an entry point other than cp/server.mjs.",
  ].join("\n"));
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// CP_GATE_SERVER exists so this gate can be proven against a stub before the control plane lands,
// and so a fork that moves the entry point does not have to patch the gate. Nothing on the R750
// sets it; the default is the real one.
const SERVER = process.env.CP_GATE_SERVER
  ? path.resolve(process.env.CP_GATE_SERVER)
  : path.join(repoRoot, "cp", "server.mjs");
const BOOT_TIMEOUT_MS = Number(process.env.CP_GATE_TIMEOUT_MS ?? 20000);

// Secrets this run mints. They are fake, they live for one process, and they are never printed:
// the leak leg at the end searches every response body for all three, and a gate that had echoed
// them into its own log would be searching a log that already lost.
const SESSION_SECRET = randomBytes(32).toString("hex");
const ADMIN_TOKEN = randomBytes(24).toString("base64url");
const COOLIFY_KEY = `fake-${randomBytes(12).toString("hex")}`;
const ACCOUNT_EMAIL = `owner+${randomBytes(4).toString("hex")}@example.com`;
const ACCOUNT_PASSWORD = randomBytes(18).toString("base64url");
const ACCOUNT_NAME = "A Business Owner";
const TENANT_SLUG = `gate-${randomBytes(3).toString("hex")}`;
const ADOPT_SLUG = `adopt-${randomBytes(3).toString("hex")}`;
const ADOPT_UUID = "p927bfqm83ioloibamlvyd7g";
const ADOPT_HOST = "console.titanium.bot";
const BASE_DOMAIN = "titanium.bot";

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

// ---- the fake Coolify ---------------------------------------------------------------------
// Answers shaped by the openapi at coolify-openapi.yaml: POST /services -> 201 {uuid, domains},
// POST /services/{uuid}/envs -> 201 {uuid}, PATCH /services/{uuid} -> 200 {uuid, domains},
// POST /services/{uuid}/start -> 200 {message}. GET /services/{uuid}/applications is the untyped
// array Coolify really returns, which is the only place a container status is readable.
const coolifyCalls = [];
const SERVICE_UUID = "fakeserviceuuid00001";

function fakeCoolifyHandler(req, res) {
  const url = new URL(req.url, "http://fake");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const authorized = (req.headers.authorization ?? "").startsWith("Bearer ");
    // The key itself is never recorded, only whether one was sent. This recorder is printed on a
    // failure and a recorder that prints bearers is a recorder that leaks them.
    coolifyCalls.push({ method: req.method, path: url.pathname, authorized, bytes: body.length });
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (!authorized) return send(401, { message: "Unauthenticated." });
    const p = url.pathname.replace(/^\/api\/v1/, "");
    if (req.method === "POST" && /^\/services\/?$/.test(p)) return send(201, { uuid: SERVICE_UUID, domains: [] });
    if (req.method === "POST" && /^\/services\/[^/]+\/envs\/?$/.test(p)) return send(201, { uuid: randomUUID() });
    if (req.method === "PATCH" && /^\/services\/[^/]+\/envs\/bulk\/?$/.test(p)) return send(201, []);
    if (req.method === "PATCH" && /^\/services\/[^/]+\/?$/.test(p)) {
      return send(200, { uuid: SERVICE_UUID, domains: [`https://${TENANT_SLUG}.${BASE_DOMAIN}`] });
    }
    if (req.method === "POST" && /^\/services\/[^/]+\/start\/?$/.test(p)) return send(200, { message: "Service starting request queued." });
    if (req.method === "POST" && /^\/services\/[^/]+\/stop\/?$/.test(p)) return send(200, { message: "Service stopping request queued." });
    if (req.method === "POST" && /^\/services\/[^/]+\/restart\/?$/.test(p)) return send(200, { message: "Service restaring request queued." });
    if (req.method === "DELETE" && /^\/services\/[^/]+\/?$/.test(p)) return send(200, { message: "Service deletion request queued." });
    if (req.method === "GET" && /^\/services\/[^/]+\/applications\/?$/.test(p)) {
      return send(200, [
        { uuid: "app-relay", name: "titanbot-relay", status: "running:healthy", fqdn: `https://${TENANT_SLUG}.${BASE_DOMAIN}` },
        { uuid: "app-box", name: "titanbot-box", status: "running", fqdn: null },
      ]);
    }
    if (req.method === "GET" && /^\/services\/[^/]+\/?$/.test(p)) {
      return send(200, { id: 1, uuid: SERVICE_UUID, name: `titanbot-${TENANT_SLUG}`, service_type: null, docker_compose_raw: "" });
    }
    if (req.method === "GET" && /^\/projects\/?$/.test(p)) return send(200, [{ id: 1, uuid: "fakeprojectuuid00001", name: "Titanium Computing" }]);
    if (req.method === "GET" && /^\/servers\/?$/.test(p)) return send(200, [{ id: 1, uuid: "fakeserveruuid000001", name: "r750" }]);
    return send(404, { message: "Not found." });
  });
}

// ---- the run ---------------------------------------------------------------------------------
const bodiesSeen = [];
let child = null;
let fake = null;
let dataDir = null;
let tenantRoot = null;
const childLog = [];

const cleanup = () => {
  if (child && child.exitCode == null) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  if (fake) { try { fake.close(); } catch { /* already closed */ } }
  for (const dir of [dataDir, tenantRoot]) {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } }
  }
};
const die = (message) => {
  console.log(`\n${message}`);
  console.log("exit 2: nothing was measured");
  cleanup();
  process.exit(2);
};

if (!existsSync(SERVER)) {
  die([
    `the control plane's entry point is not in this tree (looked at ${SERVER}).`,
    "This gate is written against the TENANT-1 contract and runs once the control plane lands.",
  ].join("\n"));
}

const CP_PORT = Number(process.env.CP_GATE_PORT ?? await freePort());
const FAKE_PORT = Number(process.env.CP_GATE_FAKE_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${CP_PORT}`;
const COOLIFY_URL = `http://127.0.0.1:${FAKE_PORT}`;

dataDir = mkdtempSync(path.join(tmpdir(), "cp-gate-data-"));
tenantRoot = mkdtempSync(path.join(tmpdir(), "cp-gate-tenants-"));

fake = http.createServer(fakeCoolifyHandler);
await new Promise((resolve, reject) => {
  fake.once("error", reject);
  fake.listen(FAKE_PORT, "127.0.0.1", resolve);
});

// One request, recorded. Every body the server ever sends this run lands in bodiesSeen, which the
// last leg searches for the three secrets.
const call = async (method, pathname, { body, token, admin } = {}) => {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  else if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return { status: 0, text: "", json: null, error: String(error?.message ?? error) };
  }
  const text = await res.text();
  bodiesSeen.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json, the leg says so */ }
  return { status: res.status, text, json, error: null };
};

console.log(`control plane on ${BASE}, fake Coolify on ${COOLIFY_URL}`);
console.log(`data dir ${dataDir}`);
console.log(`tenant root ${tenantRoot}`);

child = spawn(process.execPath, [SERVER], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    CP_PORT: String(CP_PORT),
    CP_DATA_DIR: dataDir,
    CP_SESSION_SECRET: SESSION_SECRET,
    CP_ADMIN_TOKEN: ADMIN_TOKEN,
    CP_BASE_DOMAIN: BASE_DOMAIN,
    COOLIFY_URL,
    COOLIFY_API_KEY: COOLIFY_KEY,
    COOLIFY_PROJECT_UUID: "fakeprojectuuid00001",
    COOLIFY_SERVER_UUID: "fakeserveruuid000001",
    COOLIFY_ENVIRONMENT_NAME: "production",
    CP_TENANT_ROOT: tenantRoot,
    CP_RELEASE_ROOT: "/home/sem/titanbot",
    CP_PUBLIC_URL: `https://api.${BASE_DOMAIN}`,
    // Explicitly off, so an operator who happens to have CP_DRY_RUN=1 in their shell does not turn
    // every leg below into a plan and get a green run that measured nothing.
    CP_DRY_RUN: "0",
  },
});
const keepLine = (buffer) => {
  for (const line of String(buffer).split("\n")) {
    if (line.trim().length === 0) continue;
    childLog.push(line);
    if (childLog.length > 40) childLog.shift();
  }
};
child.stdout.on("data", keepLine);
child.stderr.on("data", keepLine);
child.on("exit", (code, signal) => { if (code !== 0 && code != null) childLog.push(`(server exited with ${code}${signal ? ` on ${signal}` : ""})`); });

// Boot: poll health until it answers or the clock runs out. A server that never answers is exit
// 2, with its own last lines, because "the gate failed" and "the gate never started" are
// different problems and only one of them is the control plane's fault.
const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
let booted = false;
while (Date.now() < bootDeadline) {
  if (child.exitCode != null) break;
  const health = await call("GET", "/v1/health");
  if (health.status === 200) { booted = true; break; }
  await sleep(200);
}
if (!booted) {
  die([
    `the control plane never answered GET /v1/health on ${BASE} within ${BOOT_TIMEOUT_MS} ms.`,
    childLog.length > 0 ? `its last lines:\n  ${childLog.join("\n  ")}` : "it printed nothing.",
  ].join("\n"));
}

try {
  // ---- health -------------------------------------------------------------------------------
  step("health");
  const health = await call("GET", "/v1/health");
  check(health.status === 200, "GET /v1/health is 200 with no bearer", `status ${health.status}`);
  check(health.json?.ok === true, "it says ok", JSON.stringify(health.json ?? health.text).slice(0, 120));
  check(typeof health.json?.version === "string" && health.json.version.length > 0, "it names a version", String(health.json?.version));
  check(typeof health.json?.tenants === "number", "tenants is a count", String(health.json?.tenants));
  check(typeof health.json?.accounts === "number", "accounts is a count", String(health.json?.accounts));
  const healthKeys = Object.keys(health.json ?? {}).sort();
  check(
    healthKeys.every((key) => ["ok", "version", "tenants", "accounts"].includes(key)),
    "it carries counts only, no list and no name",
    healthKeys.join(", "),
  );
  const accountsAtStart = health.json?.accounts ?? 0;
  const tenantsAtStart = health.json?.tenants ?? 0;

  // ---- the admin door -----------------------------------------------------------------------
  step("the admin door");
  const noBearer = await call("GET", "/v1/accounts");
  check(noBearer.status === 401, "GET /v1/accounts with no bearer is 401", `status ${noBearer.status}`);
  // Same length, one byte different. A length check that passes for this and a constant-time
  // compare that passes for this are the same answer, which is the point: the refusal must not
  // depend on where the difference is.
  const nearMiss = `${ADMIN_TOKEN.slice(0, -1)}${ADMIN_TOKEN.endsWith("A") ? "B" : "A"}`;
  const wrongBearer = await call("GET", "/v1/accounts", { token: nearMiss });
  check(wrongBearer.status === 401, "a wrong bearer of the same length is 401", `status ${wrongBearer.status}`);
  const tenantNoBearer = await call("POST", "/v1/tenants", { body: { slug: "nope", name: "Nope" } });
  check(tenantNoBearer.status === 401, "POST /v1/tenants with no bearer is 401", `status ${tenantNoBearer.status}`);
  const accountNoBearer = await call("POST", "/v1/accounts", { body: { email: "x@example.com", password: "whatever12", tenant: "titanium" } });
  check(accountNoBearer.status === 401, "POST /v1/accounts with no bearer is 401", `status ${accountNoBearer.status}`);

  // ---- an account ---------------------------------------------------------------------------
  step("an account");
  // The tenant has to exist before an account can name it. cp/server.mjs refuses an account whose
  // instance is not there, because that account would sign in and land nowhere, so the gate does
  // what the operator does first (docs/TENANCY.md sections 6 and 7): adopt console.titanium.bot as
  // tenant `titanium`, then add the person who signs into it. Adopt is used rather than create
  // because create would reach Coolify, and this leg is about the account.
  const homeTenant = await call("POST", "/v1/tenants/titanium/adopt", {
    admin: true,
    body: { coolifyServiceUuid: ADOPT_UUID, host: ADOPT_HOST },
  });
  check(
    homeTenant.status === 200 || homeTenant.status === 201,
    "the account's tenant is adopted first",
    `status ${homeTenant.status} ${homeTenant.text.slice(0, 120)}`,
  );
  const created = await call("POST", "/v1/accounts", {
    admin: true,
    body: { email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD, name: ACCOUNT_NAME, tenant: "titanium" },
  });
  check(created.status === 201, "POST /v1/accounts is 201", `status ${created.status} ${created.text.slice(0, 120)}`);
  const accountId = created.json?.account?.id ?? created.json?.id ?? null;
  check(typeof accountId === "string" && accountId.length > 0, "it answers with an account id", String(accountId));
  const dup = await call("POST", "/v1/accounts", {
    admin: true,
    body: { email: ACCOUNT_EMAIL.toUpperCase(), password: ACCOUNT_PASSWORD, name: ACCOUNT_NAME, tenant: "titanium" },
  });
  check(dup.status === 409, "the same email in a different case is 409", `status ${dup.status}`);
  const list = await call("GET", "/v1/accounts", { admin: true });
  check(list.status === 200, "GET /v1/accounts with the admin bearer is 200", `status ${list.status}`);
  const rows = Array.isArray(list.json) ? list.json : list.json?.accounts;
  check(Array.isArray(rows) && rows.some((row) => row?.email === ACCOUNT_EMAIL), "the account is in the list", `${Array.isArray(rows) ? rows.length : "no"} rows`);
  const listText = list.text.toLowerCase();
  check(
    !listText.includes("\"hash\"") && !listText.includes("\"salt\"") && !listText.includes("scrypt"),
    "the list carries no hash, no salt and no algorithm",
    listText.slice(0, 160),
  );

  // ---- a session ----------------------------------------------------------------------------
  step("a session");
  const minted = await call("POST", "/v1/sessions", { body: { email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD } });
  check(minted.status === 200, "the right password mints a session", `status ${minted.status} ${minted.text.slice(0, 120)}`);
  const token = minted.json?.token ?? "";
  check(typeof token === "string" && token.startsWith("v1."), "the token is a v1 token", token.slice(0, 12));
  check(minted.json?.account?.email === ACCOUNT_EMAIL, "it names the account", String(minted.json?.account?.email));
  check(typeof minted.json?.tenant?.slug === "string" && minted.json.tenant.slug.length > 0, "it names the tenant", String(minted.json?.tenant?.slug));
  check(
    minted.json?.tenant?.host === `${minted.json?.tenant?.slug}.${BASE_DOMAIN}` || String(minted.json?.tenant?.host ?? "").endsWith(BASE_DOMAIN),
    "it names the tenant's host under the base domain",
    String(minted.json?.tenant?.host),
  );
  check(!minted.text.includes("password"), "the answer says nothing about the password", minted.text.slice(0, 120));

  const parts = String(token).split(".");
  check(parts.length === 3 && parts[0] === "v1", "the token is three parts and version one", `${parts.length} parts`);
  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")); } catch { /* the leg says so */ }
  check(payload != null, "its middle part decodes as json", payload == null ? parts[1]?.slice(0, 24) : "");
  for (const field of ["sub", "email", "tenant", "host", "iat", "exp", "jti"]) {
    check(payload?.[field] != null, `the payload carries ${field}`, String(payload?.[field]));
  }
  check(payload?.email === ACCOUNT_EMAIL, "the payload's email is this account", String(payload?.email));
  // Seconds or milliseconds, whichever the core chose, as long as the answer is twelve hours.
  const span = Number(payload?.exp) - Number(payload?.iat);
  const twelveHours = span === 12 * 3600 || span === 12 * 3600 * 1000;
  check(twelveHours, "exp is iat plus twelve hours", `${span} (${span === 43200 ? "seconds" : span === 43200000 ? "milliseconds" : "neither"})`);
  // Re-derived here, not asked of the code under test. If the signature is over the decoded json
  // instead of over the encoded part, the detail says which, because that is the one thing the
  // relay wave has to match byte for byte.
  const overPart = createHmac("sha256", SESSION_SECRET).update(parts[1] ?? "").digest("base64url");
  const overJson = createHmac("sha256", SESSION_SECRET).update(Buffer.from(parts[1] ?? "", "base64url")).digest("base64url");
  check(
    parts[2] === overPart,
    "the signature is HMAC-SHA256 of the payload part under CP_SESSION_SECRET",
    parts[2] === overPart ? "" : parts[2] === overJson ? "it signs the decoded json instead of the encoded part" : "neither convention matches",
  );

  // ---- the session reads back -----------------------------------------------------------------
  step("the session reads back");
  const current = await call("GET", "/v1/sessions/current", { token });
  check(current.status === 200, "GET /v1/sessions/current with the token is 200", `status ${current.status}`);
  check(current.json?.account?.email === ACCOUNT_EMAIL, "it names the account", String(current.json?.account?.email));
  check(current.json?.tenant?.slug != null, "it names the tenant", String(current.json?.tenant?.slug));
  check(current.json?.expiresAt != null, "it says when it expires", String(current.json?.expiresAt));
  const noToken = await call("GET", "/v1/sessions/current");
  check(noToken.status === 401, "with no bearer it is 401", `status ${noToken.status}`);
  // One byte of the payload changed, signature untouched.
  const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, tenant: "somebody-else" }), "utf8").toString("base64url");
  const tampered = await call("GET", "/v1/sessions/current", { token: `v1.${tamperedPayload}.${parts[2]}` });
  check(tampered.status === 401, "a payload changed under the same signature is 401", `status ${tampered.status}`);

  // ---- the two refusals -----------------------------------------------------------------------
  // Two attempts, well inside the ten the lockout allows, so this leg cannot lock the account the
  // legs after it use.
  step("a wrong login says nothing");
  const wrongPassword = await call("POST", "/v1/sessions", { body: { email: ACCOUNT_EMAIL, password: `${ACCOUNT_PASSWORD}x` } });
  const unknownEmail = await call("POST", "/v1/sessions", { body: { email: `nobody+${randomBytes(3).toString("hex")}@example.com`, password: ACCOUNT_PASSWORD } });
  check(wrongPassword.status === 401, "a wrong password is 401", `status ${wrongPassword.status}`);
  check(unknownEmail.status === 401, "an unknown email is 401", `status ${unknownEmail.status}`);
  check(wrongPassword.json?.error === "invalid_login", "the error is invalid_login", String(wrongPassword.json?.error));
  check(wrongPassword.text === unknownEmail.text, "both answers are the same body", `${wrongPassword.text.slice(0, 60)} / ${unknownEmail.text.slice(0, 60)}`);

  // ---- revoke ---------------------------------------------------------------------------------
  step("revoke");
  const revoked = await call("DELETE", "/v1/sessions/current", { token });
  check(revoked.status === 204 || revoked.status === 200, "DELETE /v1/sessions/current is 204", `status ${revoked.status}`);
  const afterRevoke = await call("GET", "/v1/sessions/current", { token });
  check(afterRevoke.status === 401, "the same token is then 401", `status ${afterRevoke.status}`);

  // ---- the dry run ------------------------------------------------------------------------------
  step("a tenant dry run");
  const rootBefore = readdirSync(tenantRoot).sort();
  const callsBefore = coolifyCalls.length;
  const plan = await call("POST", "/v1/tenants", { admin: true, body: { slug: TENANT_SLUG, name: "Gate Tenant", dryRun: true } });
  check(plan.status === 200 || plan.status === 201, "POST /v1/tenants with dryRun is answered", `status ${plan.status} ${plan.text.slice(0, 140)}`);
  const steps = plan.json?.plan?.steps ?? plan.json?.steps ?? [];
  check(Array.isArray(steps) && steps.length > 0, "the plan has steps", `${Array.isArray(steps) ? steps.length : "no"} steps`);
  const stepAt = (predicate) => (Array.isArray(steps) ? steps.findIndex(predicate) : -1);
  const createAt = stepAt((s) => s?.method === "POST" && /\/services\/?$/.test(String(s?.path ?? "")));
  const envAt = stepAt((s) => s?.method === "POST" && /\/envs\/?$/.test(String(s?.path ?? "")));
  const urlAt = stepAt((s) => s?.method === "PATCH" && /\/services\/[^/]+\/?$/.test(String(s?.path ?? "")));
  const startAt = stepAt((s) => s?.method === "POST" && /\/start\/?$/.test(String(s?.path ?? "")));
  check(createAt >= 0, "it plans POST /services", `index ${createAt}`);
  check(envAt >= 0, "it plans POST /services/{uuid}/envs", `index ${envAt}`);
  check(urlAt >= 0, "it plans the urls PATCH on the service", `index ${urlAt}`);
  check(startAt >= 0, "it plans POST /services/{uuid}/start", `index ${startAt}`);
  check(
    createAt >= 0 && envAt > createAt && urlAt > envAt && startAt > urlAt,
    "they are in the order create, envs, urls, start",
    `${createAt}, ${envAt}, ${urlAt}, ${startAt}`,
  );
  check(coolifyCalls.length === callsBefore, "no call reached Coolify", `${coolifyCalls.length - callsBefore} calls: ${coolifyCalls.slice(callsBefore).map((c) => `${c.method} ${c.path}`).join(", ")}`);
  const rootAfter = readdirSync(tenantRoot).sort();
  check(rootAfter.join(",") === rootBefore.join(","), "no directory was created under CP_TENANT_ROOT", `${rootBefore.join(",") || "(empty)"} then ${rootAfter.join(",") || "(empty)"}`);
  check(!plan.text.includes(SESSION_SECRET), "the plan does not carry CP_SESSION_SECRET in clear", "");
  check(!plan.text.includes(ADMIN_TOKEN), "the plan does not carry CP_ADMIN_TOKEN", "");
  const composeStep = Array.isArray(steps) ? steps[createAt] : null;
  const composePreview = JSON.stringify(composeStep?.bodyPreview ?? "");
  check(
    createAt < 0 || composePreview.includes(TENANT_SLUG) || composePreview.includes("docker_compose_raw"),
    "the create step previews the tenant's own service",
    composePreview.slice(0, 160),
  );

  // ---- adopt ------------------------------------------------------------------------------------
  // Straight to adopt, with no create before it, because that is the whole point of the route:
  // Jason's console.titanium.bot becomes a tenant without anything provisioning a second service
  // on top of it. A create first would be the flow that builds the thing being adopted.
  step("adopt an instance that already exists");
  const beforeAdopt = coolifyCalls.length;
  const adopted = await call("POST", `/v1/tenants/${ADOPT_SLUG}/adopt`, {
    admin: true,
    body: { coolifyServiceUuid: ADOPT_UUID, host: ADOPT_HOST },
  });
  check(adopted.status === 200 || adopted.status === 201, "POST /v1/tenants/{slug}/adopt is accepted", `status ${adopted.status} ${adopted.text.slice(0, 140)}`);
  check(
    !coolifyCalls.slice(beforeAdopt).some((c) => c.method === "POST" && /\/services\/?$/.test(c.path)),
    "adopting created no service on Coolify",
    coolifyCalls.slice(beforeAdopt).map((c) => `${c.method} ${c.path}`).join(", "),
  );
  const readBack = await call("GET", `/v1/tenants/${ADOPT_SLUG}`, { admin: true });
  check(readBack.status === 200, "the tenant reads back", `status ${readBack.status}`);
  const row = readBack.json?.tenant ?? readBack.json;
  check(row?.status === "adopted", "its status is adopted", String(row?.status));
  check(row?.coolifyServiceUuid === ADOPT_UUID, "it carries the Coolify service uuid", String(row?.coolifyServiceUuid));
  check(row?.host === ADOPT_HOST, "it carries the host it was adopted on", String(row?.host));
  const adoptNoBearer = await call("POST", `/v1/tenants/${ADOPT_SLUG}/adopt`, { body: { coolifyServiceUuid: ADOPT_UUID, host: ADOPT_HOST } });
  check(adoptNoBearer.status === 401, "adopt with no bearer is 401", `status ${adoptNoBearer.status}`);

  // ---- the slugs --------------------------------------------------------------------------------
  step("the slugs that must be refused");
  const reserved = ["www", "console", "api", "mail", "app", "admin", "status", "docs", "blog", "help", "support", "titanium", "titan", "resend", "send", "rsend", "_dmarc"];
  const malformed = ["ab", "Bad-Slug", "under_score", "-leading", "trailing-", "x".repeat(33), "spaced out", "dots.here"];
  const beforeRefusals = coolifyCalls.length;
  for (const slug of reserved) {
    const answer = await call("POST", "/v1/tenants", { admin: true, body: { slug, name: "Reserved" } });
    check(answer.status >= 400 && answer.status < 500, `reserved slug ${slug} is refused`, `status ${answer.status}`);
  }
  for (const slug of malformed) {
    const answer = await call("POST", "/v1/tenants", { admin: true, body: { slug, name: "Malformed" } });
    check(answer.status >= 400 && answer.status < 500, `malformed slug ${JSON.stringify(slug)} is refused`, `status ${answer.status}`);
  }
  check(coolifyCalls.length === beforeRefusals, "no refused slug reached Coolify", `${coolifyCalls.length - beforeRefusals} calls`);
  const listTenants = await call("GET", "/v1/tenants", { admin: true });
  const tenantRows = Array.isArray(listTenants.json) ? listTenants.json : listTenants.json?.tenants ?? [];
  const refusedNames = new Set([...reserved, ...malformed]);
  // `titanium` is on the reserved list and is also the name this gate adopted, which is the
  // documented exception: reserved means no CUSTOMER may claim the name through POST /v1/tenants,
  // not that the operator may not adopt an instance that already carries it. So the check is that
  // no refused name reached the ledger by any route other than the adopt this run made itself.
  const adoptedHere = new Set(["titanium", ADOPT_SLUG]);
  check(
    Array.isArray(tenantRows) && !tenantRows.some((t) => refusedNames.has(String(t?.slug)) && !adoptedHere.has(String(t?.slug))),
    "none of them is in the ledger",
    Array.isArray(tenantRows) ? tenantRows.map((t) => t?.slug).join(", ") : String(listTenants.status),
  );
  const titaniumRow = tenantRows.find((t) => String(t?.slug) === "titanium");
  check(
    titaniumRow?.status === "adopted",
    "the one reserved name in the ledger is there because it was adopted",
    String(titaniumRow?.status),
  );

  // ---- the counts moved ---------------------------------------------------------------------------
  step("the counts moved");
  const healthAfter = await call("GET", "/v1/health");
  check((healthAfter.json?.accounts ?? 0) > accountsAtStart, "health counts the account that was added", `${accountsAtStart} then ${healthAfter.json?.accounts}`);
  check((healthAfter.json?.tenants ?? 0) >= tenantsAtStart, "health counts tenants", `${tenantsAtStart} then ${healthAfter.json?.tenants}`);
  check(!healthAfter.text.includes(ACCOUNT_EMAIL), "health still names nobody", healthAfter.text.slice(0, 120));

  // ---- the leak sweep ------------------------------------------------------------------------------
  step("nothing leaked");
  const everything = bodiesSeen.join("\n");
  check(!everything.includes(SESSION_SECRET), "no answer carried CP_SESSION_SECRET", "");
  check(!everything.includes(ADMIN_TOKEN), "no answer carried CP_ADMIN_TOKEN", "");
  check(!everything.includes(ACCOUNT_PASSWORD), "no answer carried the account password", "");
  check(!everything.includes(COOLIFY_KEY), "no answer carried the Coolify api key", "");
} catch (error) {
  check(false, "the run reached the end", String(error?.stack ?? error?.message ?? error));
} finally {
  if (failures > 0 && childLog.length > 0) {
    console.log("\nthe control plane's last lines:");
    for (const line of childLog) console.log(`  ${line}`);
  }
  cleanup();
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
