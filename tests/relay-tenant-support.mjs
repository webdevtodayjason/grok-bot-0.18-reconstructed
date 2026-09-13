// Shared scaffolding for the TENANT-5 relay tests: one console, several workspaces.
//
// Not a .test.mjs, so `npm test` never runs it on its own. It exists because three test files now
// need the same three things and a copy of them in each is how two of the three drift.
//
//   serverCopy()      a copy of ui/, never ui/ itself: the operator's own auth.json and
//                     endpoints.json would otherwise decide which branch runs.
//   startRelay()      that copy on a real port, with a real password, talking to whatever is passed.
//   tokenFor()        a control plane session token for a tenant, signed with that tenant's key.
//
// The registry is fed through SAND_UI_TENANTS_FILE rather than a control plane wherever the test is
// not about the control plane itself. It is the documented override, the same kind
// SAND_UI_AUTH_FILE is, and it means a test of the unknown-workspace answer needs no network.
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAuthRecord, writeAuthFile } from "../ui/auth.mjs";
import { mintSessionToken, tenantSessionSecret } from "../ui/session-token.mjs";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RELAY_PASSWORD = "an instance password no test types";
export const MASTER = "a control plane master key no tenant ever holds";
// Long enough that the control plane would accept it. The relay only ever sends it.
export const RELAY_TOKEN = "a relay credential of at least thirty two characters";

export const keyFor = (slug) => tenantSessionSecret(MASTER, slug);

export function serverCopy(prefix = "relay-tenant-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  for (const name of readdirSync(path.join(repo, "ui")).filter((file) => file.endsWith(".mjs"))) {
    copyFileSync(path.join(repo, "ui", name), path.join(dir, name));
  }
  writeAuthFile(path.join(dir, "auth.json"), newAuthRecord(RELAY_PASSWORD));
  return dir;
}

// One workspace's directories and its registry row. The box name is deliberately one that is not
// running, and the relay is started with no docker on PATH so the name verification learns nothing
// and takes the row at its word. A test that wants the unreachable answer says so with a row whose
// box exists nowhere AND a docker that answers, which is its own test.
export function tenantRow(slug, { box = `titanbot-box-${slug}`, gateway = null, token = `gateway-token-for-${slug}` } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `tenant-${slug}-`));
  const state = path.join(root, "state");
  const profile = path.join(root, "profile");
  mkdirSync(state, { recursive: true });
  mkdirSync(profile, { recursive: true });
  return {
    row: {
      slug, name: slug, box, token,
      gateway: gateway ?? `http://127.0.0.1:1`,
      sessionKey: keyFor(slug),
      stateDir: state, profileDir: profile, status: "running",
    },
    root, state, profile,
  };
}

export function tenantsFile(rows) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "relay-tenants-")), "tenants.json");
  writeFileSync(file, JSON.stringify({ tenants: rows }, null, 2));
  return file;
}

// There is no way to read back the port from a server started with SAND_UI_PORT=0 -- it prints the
// value it was given -- so a port is picked and retried, the same as tests/relay-login-guards.
export async function startRelay(env = {}, { prefix = "relay-tenant-", pathValue = null } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dir = serverCopy(prefix);
    const port = 34000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
      env: {
        ...process.env,
        SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_HOST_GATEWAY_TOKEN: "not-a-real-token",
        // Nothing answers here. Every request in these tests is decided before the relay reaches
        // upstream, so a 502 from a dead gateway is itself proof of getting past.
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
        CP_URL: "", CP_RELAY_TOKEN: "", SAND_UI_TENANTS_FILE: "",
        SAND_UI_STATE_DIR: "", SAND_UI_AUTH_FILE: "", SAND_UI_ENDPOINTS_FILE: "",
        SAND_PROFILE_DIRS: "", TITAN_JOB_TOKEN: "",
        // No docker, so the box-name verification learns nothing and every row is taken at its
        // word. A test that wants the unreachable answer arranges it deliberately.
        ...(pathValue == null ? {} : { PATH: pathValue }),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const listening = await new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("cfip ")) resolve(out); });
      child.on("exit", () => resolve(null));
      setTimeout(() => resolve(null), 20_000).unref();
    });
    if (listening != null) {
      return {
        base: `http://127.0.0.1:${port}`, dir, boot: listening,
        catalog: path.join(dir, "endpoints.json"),
        stop: () => child.kill("SIGKILL"),
      };
    }
    child.kill("SIGKILL");
  }
  throw new Error("the relay copy would not start on any of five ports");
}

// A counter, because `${tenant}-${Date.now()}` collides for two tokens minted in the same millisecond
// and the jti is the LINK ID since ONBOARD-5: two links sharing an id would mean clicking one spends
// the other. Callers that want a specific id pass one.
let mintedLinks = 0;

export function tokenFor(tenant, secret = keyFor(tenant), {
  host = "console.titanium.bot", ttlMs = 60 * 60 * 1000, now = Date.now(), jti = null,
} = {}) {
  mintedLinks += 1;
  return mintSessionToken({
    sub: `acct_${tenant}`, email: `${tenant}@titanium.bot`, tenant, host,
    iat: now, exp: now + ttlMs, jti: jti ?? `${tenant}-${now}-${mintedLinks}`,
  }, secret, now).token;
}

/**
 * A control plane that answers only the one question the sso door now asks (ONBOARD-5).
 *
 * Since 2026-09-12 a /login?sso= click is not decided by the signature alone: the relay asks
 * POST /v1/relay/sign-in-links/claim whether that link's id is still good, and refuses the click when it
 * cannot ask. So every test that signs a tenant in by link needs something on the other end of that
 * call, and `CP_URL: "http://127.0.0.1:1"` -- which is what these tests used when the door asked nobody
 * anything -- is now a console that refuses every link.
 *
 * It SPENDS a link the way the real store does: an id it has not seen before is good and is then
 * remembered, a second claim on the same id answers `used`. That keeps the default behaviour of
 * signInAsTenant honest -- each call mints a fresh link, so each call gets in -- while a test that
 * clicks one link twice sees the real refusal.
 *
 * `revoke(id)` and `refuse(verdict)` are for the tests that are about the door itself.
 */
export async function startLinkCp({ verdict = null } = {}) {
  const claims = [];
  const spent = new Set();
  const revoked = new Set();
  let forced = verdict;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://cp.invalid");
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
      const say = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (url.pathname !== "/v1/relay/sign-in-links/claim" || request.method !== "POST") {
        return say(404, { error: "not_found" });
      }
      // The real route is behind CP_RELAY_TOKEN, so this one is too: a relay that forgot the header
      // would otherwise pass every test here and refuse every link in production.
      if (String(request.headers.authorization ?? "") !== `Bearer ${RELAY_TOKEN}`) {
        return say(401, { error: "unauthorized" });
      }
      const id = String(body?.id ?? "");
      claims.push({ id, tenant: String(body?.tenant ?? ""), from: String(body?.from ?? "") });
      if (forced != null) return say(200, { ok: false, verdict: forced });
      if (revoked.has(id)) return say(200, { ok: false, verdict: "revoked" });
      if (spent.has(id)) return say(200, { ok: false, verdict: "used" });
      spent.add(id);
      return say(200, { ok: true, verdict: "good", tenant: String(body?.tenant ?? ""), singleUse: true });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    claims,
    revoke: (id) => revoked.add(String(id)),
    force: (value) => { forced = value; },
    // closeAllConnections first: the relay keeps the claim call's socket alive, and close() alone waits
    // for it, which is a test run that finishes and then hangs.
    stop: () => { server.closeAllConnections(); server.close(); },
  };
}

/**
 * A relay with a control plane behind it that can answer about sign-in links, which is what every test
 * signing a tenant in by link now needs.
 *
 * It is a wrapper and not a change to startRelay, because the tests that sign in only as the OPERATOR
 * need no control plane at all and a console with one it cannot reach is a real state worth keeping
 * testable. `stop()` takes the control plane down with the relay, so a caller's existing finally block
 * does not have to learn about it.
 */
export async function startRelayWithLinks(env = {}, options = {}) {
  const cp = await startLinkCp();
  const relay = await startRelay({ CP_URL: cp.base, CP_RELAY_TOKEN: RELAY_TOKEN, ...env }, options);
  const stopRelay = relay.stop;
  return { ...relay, linkCp: cp, stop: () => { stopRelay(); cp.stop(); } };
}

export const cookieOf = (response) =>
  /(?:^|,\s*)(gb_session=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";

export const form = (fields) => ({
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
  body: new URLSearchParams(fields).toString(),
});

// The operator's door: the instance password, which means the workspace "titanium".
export async function signInAsOperator(relay) {
  const res = await fetch(`${relay.base}/login`, form({ password: RELAY_PASSWORD }));
  const cookie = cookieOf(res);
  if (cookie.length === 0) throw new Error(`the instance password did not sign in (HTTP ${res.status})`);
  return cookie;
}

// A customer's door without a control plane in the way: a sign-in link, which this console verifies
// with that tenant's own key out of the registry exactly as it verifies an account sign-in.
export async function signInAsTenant(relay, slug, secret = keyFor(slug)) {
  const res = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor(slug, secret))}`,
    { redirect: "manual", headers: { accept: "text/html" } });
  const cookie = cookieOf(res);
  if (cookie.length === 0) throw new Error(`the sign-in link did not sign in ${slug} (HTTP ${res.status})`);
  return cookie;
}
