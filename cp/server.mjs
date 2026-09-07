// cp/server.mjs -- the control plane's HTTP API.
//
// Two audiences, and they are kept apart by which bearer they carry:
//
//   customers  POST /v1/sessions with an email and a password, and the answer is a signed session
//              that names their tenant. Their own relay verifies that token with the key it was
//              given and lets them in without the relay password. Nothing else on this service is
//              reachable with a customer session. That key is theirs alone: CP_SESSION_SECRET here
//              is a master, and what a tenant gets is HMAC-SHA256(master, its own name), so a
//              customer who reads it out of their own container can sign for themselves and for
//              nobody else. cp/session.mjs, tenantSessionSecret, is where that lives.
//   the operator  every route that adds an account, adds a tenant or touches Coolify, behind
//              CP_ADMIN_TOKEN and a constant-time compare.
//
// Node's http, node:sqlite and node:crypto. No npm dependency, because this thing sits in front of
// every customer's console and the smallest supply chain is the one with nothing in it.
//
// What this service will never do: return a password hash, return CP_SESSION_SECRET, return
// CP_ADMIN_TOKEN, or print any of the three. There is a test that walks every route and asserts it.

import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { clientAddress, parseTrustedProxies } from "../ui/auth.mjs";
import { mintSessionToken, tenantOfUnverifiedToken, tenantSessionSecret, verifySessionToken, SESSION_TTL_MS } from "./session.mjs";
import { openStore, burnPasswordTime, normalizeEmail } from "./store.mjs";
import {
  NEW_TENANTS_BLOCKED,
  configProblems,
  createCoolifyClient,
  loadConfig,
  provisionTenant,
  readCoolifyState,
  tenantHost,
  tenantDirectory,
  validateSlug,
} from "./provision.mjs";

// Its own number, not the repository's. The control plane ships and updates on its own clock and
// the image does not carry package.json.
export const CP_VERSION = "1.0.0";

// The shortest password this service will store. An online guesser gets ten tries in ten minutes
// through the lockout, so length is the only defence that matters; eight is the floor, not a
// recommendation, and it is the same floor ui/set-password.mjs uses.
const MIN_PASSWORD_LENGTH = 8;
const MAX_BODY_BYTES = 64 * 1024;
const HARD_BODY_CEILING = 8 * 1024 * 1024;

const json = (response, status, body, headers = {}) => {
  const text = JSON.stringify(body ?? {});
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text, "utf8"),
    ...headers,
  });
  response.end(text);
};

const noContent = (response) => { response.writeHead(204, { "cache-control": "no-store" }); response.end(); };

// The body, up to the cap. Over the cap it keeps draining rather than walking away: an unread
// request stream leaves the connection half spoken, the client waits for a response it can never
// finish reading, and the symptom is a request that hangs instead of a request that is refused.
// Past the hard ceiling the socket is closed instead, because at that size draining is the attack.
async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      if (total > HARD_BODY_CEILING) { request.destroy(); break; }
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) { const error = new Error("that request body is too large"); error.code = "too_large"; throw error; }
  if (total === 0) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("that request body is not JSON"); error.code = "bad_json"; throw error; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("that request body is not a JSON object"); error.code = "bad_json"; throw error;
  }
  return parsed;
}

// Hash both sides to a fixed width first, so the compare is constant time over the length as well
// as over the bytes. Comparing the raw strings would answer "wrong length" instantly and hand an
// attacker the token's length for free.
function secretsMatch(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function bearer(request) {
  const header = String(request.headers.authorization ?? "");
  if (!/^bearer\s+/i.test(header)) return "";
  return header.replace(/^bearer\s+/i, "").trim();
}

// How many password derivations may be running at once.
//
// scrypt at these parameters runs on the libuv threadpool, which is four threads by default, and
// the sign-in route is open to strangers. Without a cap, a trickle of attempts fills the queue and
// every customer's sign-in waits behind it; with one, the attempts past the cap are refused
// immediately and cheaply, which is the difference between a slow service and no service.
const MAX_CONCURRENT_DERIVATIONS = 4;

const publicAccount = (account) => (account == null ? null : {
  id: account.id, email: account.email, name: account.name, tenant: account.tenant,
  createdAt: new Date(account.createdAt).toISOString(),
});

const publicTenant = (tenant) => (tenant == null ? null : {
  slug: tenant.slug,
  name: tenant.name,
  host: tenant.host,
  status: tenant.status,
  coolifyServiceUuid: tenant.coolifyServiceUuid,
  ownerEmail: tenant.ownerEmail,
  createdAt: new Date(tenant.createdAt).toISOString(),
  lastError: tenant.lastError,
});

export function createApp(options = {}) {
  const config = options.config ?? loadConfig();
  const store = options.store ?? openStore({ dataDir: config.dataDir });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const client = createCoolifyClient({ config, fetchImpl });

  // The address the lockout counts against, decided by the relay's own code (ui/auth.mjs) with the
  // relay's own two settings.
  //
  // The rule it enforces, and the reason the settings exist: X-Forwarded-For is a header the caller
  // writes, so it is read only when the peer that sent it is one the operator named in
  // CP_TRUSTED_PROXIES, and CF-Connecting-IP is read only when that peer is inside
  // CP_CLOUDFLARE_RANGES. Without them the visitor is the socket address, which cannot be forged.
  // The old code here trusted the header from any private peer, so a forged list from a loopback
  // caller gave a fresh bucket per guess and the address half of the lockout never fired.
  const trustedProxies = parseTrustedProxies(config.trustedProxies);
  const cloudflareRanges = parseTrustedProxies(config.cloudflareRanges);
  const clientOf = (request) => clientAddress(request, trustedProxies, cloudflareRanges);

  // In-flight scrypt derivations. See MAX_CONCURRENT_DERIVATIONS.
  let derivations = 0;

  // Was this instance already running when it was claimed? Read from the ledger rather than from
  // the status column, because the status column moves: a stop writes "stopped" over "adopted", and
  // a guard that read only the column could be walked around by stopping first.
  const wasAdopted = (slug, row) => row?.status === "adopted" || store.completedSteps(slug).has("adopt");

  const requireAdmin = (request, response) => {
    if (secretsMatch(bearer(request), config.adminToken)) return true;
    json(response, 401, { error: "unauthorized" });
    return false;
  };

  // A tenant row plus the live Coolify state when we can get it. The ledger is what this service
  // knows; the live read is what the server says right now, and when they disagree about a tenant
  // we created, the live read wins and the ledger is corrected. An adopted tenant keeps its status:
  // "adopted" is a fact about how it got here, not a container state.
  async function tenantView(row) {
    const live = await readCoolifyState(row.coolifyServiceUuid, client);
    let current = row;
    if (live.reachable && ["provisioning", "running", "stopped"].includes(row.status) && ["running", "stopped"].includes(live.status) && live.status !== row.status) {
      current = store.updateTenant(row.slug, { status: live.status }) ?? row;
    }
    return { ...publicTenant(current), coolify: live };
  }

  async function handleSessionCreate(request, response, body) {
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    if (email.length === 0 || password.length === 0) return json(response, 400, { error: "bad_request", message: "Send an email address and a password." });

    const ip = clientOf(request);
    const at = now();
    store.pruneLoginFailures(at);
    const lock = store.loginLock({ email, ip, at });
    if (lock.locked) {
      return json(response, 429, { error: "locked", retryAfter: lock.retryAfter }, { "retry-after": String(lock.retryAfter) });
    }

    // The cap goes on before the derivation and comes off after it, in a finally, because a
    // counter that leaks on a throw is a service that stops answering sign-ins for good.
    if (derivations >= MAX_CONCURRENT_DERIVATIONS) {
      return json(response, 429, {
        error: "busy",
        retryAfter: 1,
        message: "Too many people are signing in at once. Wait a moment and try again.",
      }, { "retry-after": "1" });
    }
    derivations += 1;
    let attempt;
    try {
      attempt = await store.verifyAccountPasswordAsync(email, password);
      if (!attempt.ok) {
        // An address with no account still costs a scrypt derivation, so the two answers take the
        // same time and this route cannot be used to find out who has an account here.
        if (store.getAccountByEmail(email) == null) await burnPasswordTime(password);
      }
    } finally { derivations -= 1; }

    if (!attempt.ok) {
      store.recordLoginFailure({ email, ip, at });
      return json(response, 401, { error: "invalid_login" });
    }

    const tenant = store.getTenant(attempt.account.tenant);
    if (tenant == null) {
      return json(response, 409, {
        error: "tenant_missing",
        message: "Your account is set up but its instance is not registered yet. Please contact support.",
      });
    }

    store.clearLoginFailures({ email, ip });
    store.pruneRevocations(at);
    const host = tenant.host || tenantHost(tenant.slug, config);
    const { token, payload } = mintSessionToken({
      sub: attempt.account.id,
      email: attempt.account.email,
      tenant: tenant.slug,
      host,
      iat: at,
      exp: at + SESSION_TTL_MS,
      jti: randomUUID(),
      // Signed with this tenant's own key, which is the only key their relay is given.
    }, tenantSessionSecret(config.sessionSecret, tenant.slug), at);

    return json(response, 200, {
      token,
      expiresAt: new Date(payload.exp).toISOString(),
      account: { id: attempt.account.id, email: attempt.account.email, name: attempt.account.name },
      tenant: { slug: tenant.slug, host, status: tenant.status },
    });
  }

  function currentSession(request) {
    const token = bearer(request);
    // Which key to check with is decided by the tenant the token names, read before anything is
    // verified. Naming a tenant you were not issued for picks a key your signature was not made
    // with, so the check below fails: the claim selects the key, it never grants anything.
    const claimed = tenantOfUnverifiedToken(token);
    if (claimed.length === 0) return { ok: false };
    let secret;
    try { secret = tenantSessionSecret(config.sessionSecret, claimed); }
    catch { return { ok: false }; }
    const verdict = verifySessionToken(token, secret, now());
    if (!verdict.ok) return { ok: false };
    if (store.isSessionRevoked(verdict.payload.jti)) return { ok: false };
    return { ok: true, payload: verdict.payload };
  }

  async function handle(request, response) {
    let url;
    try { url = new URL(request.url ?? "/", "http://control-plane.invalid"); }
    catch { return json(response, 400, { error: "bad_request" }); }
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method ?? "GET";

    let body = {};
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      try { body = await readJsonBody(request); }
      catch (error) { return json(response, 400, { error: error.code === "too_large" ? "too_large" : "bad_json", message: String(error.message) }); }
    }

    if (segments[0] !== "v1") return json(response, 404, { error: "not_found" });

    // ---- health ------------------------------------------------------------------------------
    // Counts only, no auth. It is what a load balancer and an operator both watch, and it tells a
    // stranger nothing but that this instance is up and roughly how big it is.
    if (segments[1] === "health" && segments.length === 2 && method === "GET") {
      return json(response, 200, { ok: true, version: CP_VERSION, tenants: store.countTenants(), accounts: store.countAccounts() });
    }

    // ---- sessions ----------------------------------------------------------------------------
    if (segments[1] === "sessions" && segments.length === 2 && method === "POST") {
      return handleSessionCreate(request, response, body);
    }

    if (segments[1] === "sessions" && segments[2] === "current" && segments.length === 3) {
      const session = currentSession(request);
      if (method === "GET") {
        if (!session.ok) return json(response, 401, { error: "unauthorized" });
        const account = store.getAccountById(session.payload.sub);
        const tenant = store.getTenant(session.payload.tenant);
        return json(response, 200, {
          account: account == null
            ? { id: session.payload.sub, email: session.payload.email, name: "" }
            : { id: account.id, email: account.email, name: account.name },
          tenant: { slug: session.payload.tenant, host: session.payload.host, status: tenant?.status ?? "unknown" },
          expiresAt: new Date(session.payload.exp).toISOString(),
        });
      }
      if (method === "DELETE") {
        if (!session.ok) return json(response, 401, { error: "unauthorized" });
        store.revokeSession(session.payload.jti, session.payload.exp);
        return noContent(response);
      }
      return json(response, 405, { error: "method_not_allowed" });
    }

    // ---- accounts (operator) -------------------------------------------------------------------
    if (segments[1] === "accounts") {
      if (!requireAdmin(request, response)) return undefined;

      if (segments.length === 2 && method === "GET") {
        return json(response, 200, { accounts: store.listAccounts().map(publicAccount) });
      }

      if (segments.length === 2 && method === "POST") {
        const email = normalizeEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        const tenant = String(body.tenant ?? "").trim();
        if (!email.includes("@") || email.length < 3) return json(response, 400, { error: "bad_request", message: "Send a real email address." });
        if (password.length < MIN_PASSWORD_LENGTH) return json(response, 400, { error: "bad_request", message: `The password has to be at least ${MIN_PASSWORD_LENGTH} characters.` });
        if (tenant.length === 0) return json(response, 400, { error: "bad_request", message: "Send the tenant this account signs in to." });
        // Not in the written contract, and here because the alternative is an account that can
        // sign in and be told its instance does not exist. Add the tenant first, then the people.
        if (store.getTenant(tenant) == null) {
          return json(response, 400, { error: "bad_request", message: `There is no tenant called ${tenant} yet. Add the tenant first, then add the account.` });
        }
        try {
          const account = store.createAccount({ email, password, name: String(body.name ?? ""), tenant });
          const row = store.getTenant(tenant);
          // The tenant's real hostname, not one rebuilt from the name. An adopted tenant answers
          // somewhere else entirely: tenant "titanium" is console.titanium.bot, and telling the
          // operator to send their customer to titanium.titanium.bot would be a broken link.
          return json(response, 201, { account: publicAccount(account), tenant: { slug: row.slug, host: row.host || tenantHost(row.slug, config) } });
        } catch (error) {
          if (error?.code === "duplicate_email") return json(response, 409, { error: "duplicate_email", message: "That email address already has an account." });
          throw error;
        }
      }

      if (segments.length === 4 && segments[3] === "password" && method === "POST") {
        const password = typeof body.password === "string" ? body.password : "";
        if (password.length < MIN_PASSWORD_LENGTH) return json(response, 400, { error: "bad_request", message: `The password has to be at least ${MIN_PASSWORD_LENGTH} characters.` });
        const updated = store.setAccountPassword(segments[2], password);
        if (updated == null) return json(response, 404, { error: "not_found" });
        return noContent(response);
      }

      return json(response, 404, { error: "not_found" });
    }

    // ---- tenants (operator) --------------------------------------------------------------------
    if (segments[1] === "tenants") {
      if (!requireAdmin(request, response)) return undefined;

      if (segments.length === 2 && method === "GET") {
        const rows = [];
        for (const row of store.listTenants()) rows.push(await tenantView(row));
        return json(response, 200, { tenants: rows });
      }

      if (segments.length === 2 && method === "POST") {
        // Taken as typed rather than lowercased, so "Acme" is refused with a sentence that says
        // what a name looks like instead of quietly becoming a different name than the operator
        // wrote. The CLI validates the same way before it ever calls, so the answer is the same
        // either side.
        const slug = String(body.slug ?? "").trim();
        const name = String(body.name ?? "").trim();
        const ownerEmail = body.ownerEmail == null ? null : normalizeEmail(body.ownerEmail);
        const dryRun = body.dryRun === true || config.dryRun;

        const valid = validateSlug(slug);
        if (!valid.ok) return json(response, 400, { error: "bad_slug", message: valid.reason });
        if (store.getTenant(slug) != null) return json(response, 409, { error: "duplicate_slug", message: "That tenant already exists." });

        if (dryRun) {
          // Nothing is created, on Coolify or on the disk, and no tenant row is written either: a
          // dry run that left a half tenant in the ledger would be the opposite of a rehearsal.
          // The plan itself is recorded, which is what makes it reviewable afterwards.
          const result = await provisionTenant({ store, config, slug, name, dryRun: true, fetchImpl });
          if (!result.ok) return json(response, 500, { error: "render_failed", message: result.error, plan: result.plan });
          return json(response, 200, { dryRun: true, slug, host: tenantHost(slug, config), plan: result.plan, composeSha256: result.composeSha256 });
        }

        if (!config.allowNewTenants) return json(response, 409, { error: "new_tenants_off", message: NEW_TENANTS_BLOCKED });

        store.createTenant({ slug, name, host: tenantHost(slug, config), status: "provisioning", ownerEmail });
        const result = await provisionTenant({ store, config, slug, name, fetchImpl });
        if (!result.ok) {
          return json(response, 502, { error: "provisioning_failed", step: result.step, message: result.error, tenant: publicTenant(store.getTenant(slug)) });
        }
        return json(response, 201, {
          tenant: publicTenant(result.tenant),
          relayPassword: result.relayPassword,
          relayPasswordNote: result.relayPasswordNote,
        });
      }

      const slug = segments[2] ?? "";
      const row = slug.length > 0 ? store.getTenant(slug) : null;

      if (segments.length === 3 && method === "GET") {
        if (row == null) return json(response, 404, { error: "not_found" });
        return json(response, 200, { tenant: await tenantView(row) });
      }

      if (segments.length === 3 && method === "DELETE") {
        if (row == null) return json(response, 404, { error: "not_found" });
        // An adopted instance was not built here and is not this service's to delete. On tenant
        // "titanium" the Coolify service behind that row is the live console, and a stop followed
        // by a confirmed delete would take it away. Forgetting the row is the operator's way out
        // and it touches nothing on Coolify.
        if (wasAdopted(slug, row)) {
          return json(response, 409, {
            error: "adopted",
            message: "This instance was already running when it was claimed, so this service did not build it and will not delete it. Remove it in Coolify if that is really what you want.",
          });
        }
        if (row.status !== "stopped") {
          return json(response, 409, { error: "not_stopped", message: "Stop the tenant first. Only a stopped tenant can be removed." });
        }
        if (String(body.confirm ?? "") !== slug) {
          return json(response, 400, { error: "confirm_required", message: `To remove this tenant send {"confirm": "${slug}"} in the body.` });
        }
        if (row.coolifyServiceUuid) {
          try { await client.deleteService(row.coolifyServiceUuid); }
          catch (error) { return json(response, 502, { error: "coolify_error", message: String(error?.message ?? error) }); }
        }
        store.deleteTenant(slug);
        return json(response, 200, {
          deleted: true,
          slug,
          // Said here as well as in the docs, because this is the answer the operator is looking at
          // when they wonder whether they just lost a customer's work.
          dataKept: tenantDirectory(slug, config),
          message: `The Coolify service is gone. Everything in ${tenantDirectory(slug, config)} was left alone, so nothing the customer made was deleted.`,
        });
      }

      if (segments.length === 4 && segments[3] === "adopt" && method === "POST") {
        const uuid = String(body.coolifyServiceUuid ?? "").trim();
        const host = String(body.host ?? "").trim();
        if (uuid.length === 0 || host.length === 0) return json(response, 400, { error: "bad_request", message: "Send the Coolify service uuid and the hostname it answers on." });
        // The character and length rules apply, the reserved list does not. "titanium" is on that
        // list and is exactly the name Jason's own instance takes, which is the whole point of this
        // route: reserved means "no customer may claim it", not "the operator may not use it".
        const value = String(slug);
        if (!/^[a-z0-9-]{3,32}$/.test(value) || value.startsWith("-") || value.endsWith("-")) {
          return json(response, 400, { error: "bad_slug", message: "A tenant name is 3 to 32 lowercase letters, numbers and dashes, and cannot start or end with a dash." });
        }
        const existing = store.getTenant(value);
        const tenant = existing == null
          ? store.createTenant({ slug: value, name: String(body.name ?? value), host, status: "adopted", coolifyServiceUuid: uuid })
          : store.updateTenant(value, { host, status: "adopted", coolifyServiceUuid: uuid, lastError: null });
        store.recordStep({ slug: value, step: "adopt", status: "ok", detail: JSON.stringify({ uuid, host }) });
        return json(response, 200, { tenant: publicTenant(tenant) });
      }

      if (segments.length === 4 && segments[3] === "provision" && method === "POST") {
        if (row == null) return json(response, 404, { error: "not_found" });
        const dryRun = body.dryRun === true || config.dryRun;
        // Provision on an adopted instance is not a retry, it is a second instance.
        //
        // Adopt records one ledger step called "adopt", so none of the seven provisioning steps is
        // marked done and every one of them would run: a duplicate Coolify service, a second
        // container carrying the com.titanbot.role=box label the relay resolves its box by, the
        // ledger repointed at the new service, and the hostname rewritten from
        // console.titanium.bot to titanium.titanium.bot, which does not exist. On tenant
        // "titanium" that is Jason's live console.
        if (!dryRun && wasAdopted(slug, row)) {
          return json(response, 409, {
            error: "adopted",
            message: "This instance was already running when it was claimed, so this service did not build it and will not rebuild it. Building it again would make a second copy beside the one that is live.",
          });
        }
        // Finishing a build that was already allowed is fine; starting a new one is not.
        if (!dryRun && !config.allowNewTenants && !row.coolifyServiceUuid) {
          return json(response, 409, { error: "new_tenants_off", message: NEW_TENANTS_BLOCKED });
        }
        const result = await provisionTenant({ store, config, slug, name: row.name, dryRun, fetchImpl });
        if (!result.ok) {
          const status = dryRun ? 500 : 502;
          return json(response, status, { error: dryRun ? "render_failed" : "provisioning_failed", step: result.step, message: result.error, plan: result.plan });
        }
        if (dryRun) return json(response, 200, { dryRun: true, slug, plan: result.plan, composeSha256: result.composeSha256 });
        return json(response, 200, { tenant: publicTenant(result.tenant), ran: result.ran, relayPassword: result.relayPassword, relayPasswordNote: result.relayPasswordNote });
      }

      if (segments.length === 4 && ["stop", "start", "restart"].includes(segments[3]) && method === "POST") {
        if (row == null) return json(response, 404, { error: "not_found" });
        if (!row.coolifyServiceUuid) return json(response, 409, { error: "no_service", message: "This tenant has no Coolify service yet." });
        const action = segments[3];
        try {
          const answer = action === "stop" ? await client.stopService(row.coolifyServiceUuid)
            : action === "start" ? await client.startService(row.coolifyServiceUuid)
            : await client.restartService(row.coolifyServiceUuid);
          // Coolify queues all three and answers immediately, so the ledger records what was asked
          // for, not what has happened. GET /v1/tenants/{slug} is what says when it took.
          //
          // An adopted row keeps saying "adopted": that is how it got here, not a container state,
          // and it is what the delete and provision guards above read. Writing "stopped" over it
          // would turn a stop into a way around them.
          const next = wasAdopted(slug, row) ? "adopted" : action === "stop" ? "stopped" : "provisioning";
          const updated = store.updateTenant(slug, { status: next, lastError: null });
          return json(response, 200, { tenant: publicTenant(updated), message: String(answer?.message ?? "") });
        } catch (error) {
          store.updateTenant(slug, { lastError: String(error?.message ?? error) });
          return json(response, 502, { error: "coolify_error", message: String(error?.message ?? error) });
        }
      }

      return json(response, 404, { error: "not_found" });
    }

    return json(response, 404, { error: "not_found" });
  }

  async function guarded(request, response) {
    try { await handle(request, response); }
    catch (error) {
      // The message goes to the log, never to the caller: an exception here can carry a file path
      // or a Coolify body, and neither belongs in a stranger's response.
      process.stderr.write(`cp: ${request.method} ${request.url} failed: ${String(error?.stack ?? error)}\n`);
      if (!response.headersSent) json(response, 500, { error: "server_error" });
      else response.end();
    }
  }

  return { config, store, client, handle: guarded };
}

export function createHttpServer(app) {
  return http.createServer((request, response) => { void app.handle(request, response); });
}

async function main() {
  const config = loadConfig();
  const problems = configProblems(config);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`control plane: ${problem}\n`);
    process.exit(1);
  }
  const app = createApp({ config });
  const server = createHttpServer(app);
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`control plane listening on ${config.port}, tenants under ${config.tenantRoot}, release ${config.releaseRoot}\n`);
    if (!config.coolifyUrl || !config.coolifyApiKey) {
      process.stdout.write("Coolify is not configured, so tenants can be recorded and adopted but not created. Set COOLIFY_URL and COOLIFY_API_KEY.\n");
    }
  });
  const shutdown = () => { server.close(() => { app.store.close(); process.exit(0); }); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url || entry === fileURLToPath(import.meta.url)) await main();
