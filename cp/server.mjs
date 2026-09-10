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
//   the relay  one route, GET /v1/relay/tenants, behind CP_RELAY_TOKEN. See below.
//
// Node's http, node:sqlite and node:crypto. No npm dependency, because this thing sits in front of
// every customer's console and the smallest supply chain is the one with nothing in it.
//
// What this service will never do: return a password hash, return CP_SESSION_SECRET, return
// CP_ADMIN_TOKEN, or print any of the three. There is a test that walks every route and asserts it.
//
// TENANT-5 AMENDS THAT RULE, deliberately and in exactly one place, and it is written here rather
// than buried in the route because a reader has to be able to find it.
//
// There is now one relay and one console for every customer, so that relay has to be able to reach
// every customer's box and verify every customer's session. GET /v1/relay/tenants hands it, per
// tenant: that tenant's gateway token, and that tenant's DERIVED session key. Both are per tenant
// and neither is the master. CP_SESSION_SECRET itself still never leaves this process, and holding
// one tenant's derived key does not walk back to the master or sideways to another tenant's key
// (ui/session-token.mjs says why: it is an HMAC). The route answers only to CP_RELAY_TOKEN. The
// admin token does not open it and the relay token opens nothing else, which is the same two-door
// rule /v1/sessions and /v1/accounts already live by.
//
// The route-walking test names this: it asserts 401 with no bearer, 401 with CP_ADMIN_TOKEN, 200
// with CP_RELAY_TOKEN, and that the master's bytes appear nowhere in the body. Amending a rule with
// a test that names it is the difference between a decision and a fleet-wide key leak.

import http from "node:http";
// PUSH-1. Only the Apple proof speaks http2, and it is handed to cp/admin.mjs rather than imported
// there, so a test reaches every branch of its verdict table with no network.
import http2Impl from "node:http2";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { clientAddress, containerAddressLookup, createBoxPeers, isTrustedProxy, parseTrustedProxies, sourceAddress } from "../ui/auth.mjs";
import { mintSessionToken, tenantOfUnverifiedToken, tenantSessionSecret, verifySessionToken, SESSION_TTL_MS } from "./session.mjs";
import { openStore, burnPasswordTime, normalizeEmail } from "./store.mjs";
import { createAdminApi } from "./admin.mjs";
import { createMailDirectory, createMailSends, mailDomain } from "./mail.mjs";
import { createVoiceLog } from "./voice.mjs";
import { createCodeTasks } from "./code.mjs";
// KEYS-1. The three keys the product itself uses, their allowlist, their proofs and the two shapes
// this file answers with. The routes are at the bottom of the dispatcher and the reasoning is there.
import { beginKeyAction, keyDefinition, keyEvidence, keysDoor, parseKeyValue, proveKey, relaySecrets } from "./secrets.mjs";
import { INTAKE_BYTES as FEEDBACK_BODY_BYTES, normalizeReport } from "./feedback.mjs";
import { createProxyClient, includedModelRows } from "./proxy.mjs";
import {
  VERIFY_INTERVAL_MS,
  docNoiseRules,
  loadCatalogPlugins,
  readRecords,
  readRollup,
  rowAge,
  rowsWithDocs,
  startVerificationTimer,
  verifyCatalog,
} from "./verification.mjs";
import {
  NEW_TENANTS_BLOCKED,
  adoptionDirs,
  boxContainerName,
  configProblems,
  consoleHost,
  createCoolifyClient,
  deriveSlug,
  loadConfig,
  provisionTenant,
  proxyKeyFileIn,
  readCoolifyState,
  readGatewayToken,
  readProxyKey,
  tenantDirectory,
  tenantPaths,
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
async function readJsonBody(request, cap = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > cap) {
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
  // ADMIN-1. Two facts about a door, and neither is a secret: who may open the super admin console,
  // and whose sign-in is shut off right now. Both are read from the store on every request that
  // cares, never from a token.
  superAdmin: account.superAdmin === true,
  disabled: account.disabled === true,
  createdAt: new Date(account.createdAt).toISOString(),
});

const publicTenant = (tenant) => (tenant == null ? null : {
  slug: tenant.slug,
  name: tenant.name,
  host: tenant.host,
  status: tenant.status,
  coolifyServiceUuid: tenant.coolifyServiceUuid,
  ownerEmail: tenant.ownerEmail,
  // The container the one relay talks to for this customer, and whether it has answered. Not a
  // secret: it is a name on a docker network nobody outside this server can reach.
  boxContainer: tenant.boxContainer,
  boxReady: tenant.boxReady,
  createdAt: new Date(tenant.createdAt).toISOString(),
  lastError: tenant.lastError,
});

export function createApp(options = {}) {
  const config = options.config ?? loadConfig();
  const store = options.store ?? openStore({ dataDir: config.dataDir });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // What talks to a customer's BOX, as opposed to what talks to Coolify. The same fetch in
  // production; separate here so a test can drive the Coolify half honestly without a docker
  // network to resolve a box name on. See waitForBox in cp/provision.mjs.
  const probeImpl = options.probeImpl ?? fetchImpl;
  const now = options.now ?? (() => Date.now());
  const client = createCoolifyClient({ config, fetchImpl });
  // PROXY-1. The proxy, for the one thing this service does to it on a route: revoke a key when the
  // workspace it belongs to is removed. Minting happens in provisioning and in the CLI. A client
  // built with no CP_PROXY_URL is not an error and never throws; every call on it answers with the
  // sentence saying the feature is off.
  const proxy = options.proxy ?? createProxyClient({ config, fetchImpl });

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
  // A customer's BOX is on the shared network with this service and is therefore inside those
  // ranges, and it is not a proxy. Nothing it writes in a forwarded header is read: the address it
  // is counted as is the socket's. See createBoxPeers in ui/auth.mjs. With no lookup the set is
  // empty and this is exactly the old behaviour, which is what every test and every install
  // without a shared network gets.
  const boxPeers = options.boxPeers ?? createBoxPeers({});
  const peerIsBox = (request) => boxPeers.has(sourceAddress(request));
  const clientOf = (request) => (peerIsBox(request)
    ? sourceAddress(request)
    : clientAddress(request, trustedProxies, cloudflareRanges));
  // The container names in the ledger, resolved on a schedule by whoever owns the timer.
  const refreshBoxPeers = () => boxPeers.refresh(store.listTenants().map((row) => row.boxContainer ?? ""));

  // Which callers are a RELAY forwarding a customer, rather than a customer.
  //
  // Every account sign-in on every instance is posted here BY that instance's relay, so what this
  // service sees is one machine's egress address whoever typed the password. Counting an address
  // lockout against it locked POST /v1/sessions for the whole fleet on ten wrong passwords typed at
  // any one login page, and nothing could clear it. CP_RELAY_PEERS names those addresses and their
  // sign-ins are counted by email only. The address half still applies to everyone else, which is
  // any request that did not come from one of Jason's own relays.
  const relayPeers = parseTrustedProxies(config.relayPeers);

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

  // The console relay's own door, and the only thing behind it is the registry.
  //
  // A twin of requireAdmin on purpose, down to the same constant-time compare, and separate from it
  // on purpose too: the admin token adds accounts and deletes services, and the relay token reads
  // every customer's gateway token. Neither should ever be able to do the other's job, so neither
  // one opens the other's routes. An unset CP_RELAY_TOKEN matches nothing (secretsMatch refuses an
  // empty expected value), so an install with no relay to feed answers 401 to everybody.
  const requireRelay = (request, response) => {
    if (secretsMatch(bearer(request), config.relayToken)) return true;
    json(response, 401, { error: "unauthorized" });
    return false;
  };

  // What the one relay needs to serve one customer's request, per tenant.
  //
  // A row is left OUT rather than half answered, and every omission is named in `skipped`, because
  // a relay that gets a tenant with no token would answer that customer 401 forever with nothing in
  // any log to say why. What is skipped: a tenant Coolify has not built yet (no service uuid), one
  // whose token file is not on the disk, and one that is `failed`.
  //
  // The operator's own instance is not served from here, with two named exceptions. The relay seeds
  // that entry from its own environment at boot, which is what keeps Jason's console working when
  // this service is down or absent, and an adoption row holds neither a token nor directories to
  // seed it from anyway. What an adopted row DOES carry is the two fields the relay cannot build for
  // itself: the included set (PROXY-1) and that slug's own derived session key (SIGNIN-2). An
  // adopted row is a full row like any other when the adoption was given the box container name and
  // the directories to read, which is what `tenant adopt --box` writes.
  async function relayRegistry() {
    const tenants = [];
    const skipped = [];
    for (const row of store.listTenants()) {
      const adoption = adoptionDetail(row.slug);
      const paths = tenantPaths(row.slug, config);
      const stateDir = adoption.stateDir || paths.state;
      const profileDir = adoption.profileDir || paths.profile;
      const box = row.boxContainer || (row.coolifyServiceUuid ? boxContainerName(row.coolifyServiceUuid) : "");
      if (row.status === "failed") { skipped.push({ slug: row.slug, what: "tenant", why: "this workspace did not finish being built" }); continue; }
      if (!box) { skipped.push({ slug: row.slug, what: "tenant", why: "this workspace has no container yet" }); continue; }
      const token = adoption.profileDir
        ? readTokenFromDirectory(adoption.profileDir)
        : readGatewayToken(row.slug, config);
      if (!token) {
        skipped.push({ slug: row.slug, what: "tenant", why: "this workspace has no gateway token on this server" });
        // PROXY-1, MEASURED ON THE R750 2026-09-08. The operator's own workspace is adopted and
        // this service holds no gateway token for it, by design: the relay seeds that entry from
        // its own environment so Jason's console keeps working when this service is down. But the
        // whole row was dropped here, and the virtual key rides ON that row, so `proxy migrate
        // titanium` minted his key and then failed forever with "no included set for titanium"
        // while demo and richard-avery went through. His box would have been the one box left
        // holding the copied operator key: the exact thing this wave exists to end, surviving in
        // the one place nobody would look.
        //
        // So an ADOPTED tenant still gets a row, carrying its slug, its derived session key and its
        // included set when it has one, AND NOTHING ELSE. The relay drops every other field of the
        // operator's row already (box, token and both directories come from its own environment and
        // from nowhere else) and merges only these two, so a row shaped like this is exactly what it
        // is built to read. Narrow to adopted on purpose: a normal customer whose token file is
        // missing stays skipped, because a row with no token would have the relay calling that
        // customer's gateway with an empty bearer instead of saying the workspace is not available.
        //
        // SIGNIN-2, MEASURED ON THE R750 2026-09-10. The session key is the second field, and it is
        // the one that made an account on Jason's own workspace unable to sign in at all. This row
        // carried `slug` and `included` and nothing else, so the relay's key for titanium was the
        // empty string, the shared verdict path in ui/tenant-login.mjs answered `unknown`, and the
        // console answered 503 "That workspace is not available right now." to a CORRECT password
        // while the byte-identical account on demo was signed in at once. Nothing in the relay's own
        // environment can derive this key -- the master that derives it is here and only here -- so
        // it is the one other field that has to travel, and it travels the same way a customer's
        // does: the tenant's own derived key, never the master, which signs for that one slug and
        // does not walk back.
        if (wasAdopted(row.slug, row)) {
          const adoptedIncluded = await includedFor(row.slug, profileDir);
          tenants.push({
            slug: row.slug,
            sessionKey: tenantSessionSecret(config.sessionSecret, row.slug),
            ...(adoptedIncluded.row ? { included: adoptedIncluded.row } : {}),
          });
        }
        continue;
      }
      // PROXY-1. What this customer's plan includes, if anything.
      //
      // Two rules, and both of them are about not lying to the relay. The whole object is OMITTED
      // rather than sent half filled, because the relay renders it as a read-only card in Settings
      // and a card with no key behind it is a customer clicking Use this one and getting a 401. And
      // when CP_PROXY_URL is unset nothing is said at all, not even a skipped row: this feature
      // being off is the normal state of every install that has not had it turned on, and a
      // registry answer that grew a per tenant complaint on every read would be noise the day
      // somebody needs to read it.
      const included = await includedFor(row.slug, profileDir);
      if (included.why) skipped.push({ slug: row.slug, what: "included", why: included.why });
      tenants.push({
        ...(included.row ? { included: included.row } : {}),
        slug: row.slug,
        name: row.name,
        status: row.status,
        box,
        gateway: `http://${box}:1340`,
        token,
        // This tenant's own derived key, never the master. Holding it signs for this tenant and for
        // nobody else, and it does not walk back to the master.
        sessionKey: tenantSessionSecret(config.sessionSecret, row.slug),
        stateDir,
        profileDir,
        boxReady: row.boxReady,
      });
    }
    return { tenants, skipped };
  }

  /**
   * PROXY-1. The `included` object for one tenant, pinned field for field.
   *
   *   included = {baseUrl, key, keyId, models: [{id, model, name, contextWindow, servedBy}], enforced}
   *
   * These names are read by the relay and asserted in tests/cp-relay-pair, which exists precisely
   * so the two halves cannot quietly disagree about a spelling. `id` EQUALS `model`, so there is
   * one string rather than two that can drift.
   *
   * The base url is the proxy on the shared bridge, http://titanbot-proxy:4000/v1, which is plain
   * http to a private name. That is exactly what the relay's tenantEndpointRefusal guard exists to
   * refuse, and the guard is NOT relaxed: these rows never live in a tenant's endpoints.json at
   * all, the relay computes them from this answer and never lets a request body claim one.
   *
   * An adopted tenant reads from the profile directory the adoption named, the same way its
   * gateway token does, so the operator's own workspace works through the identical path.
   */
  async function includedFor(slug, profileDir) {
    if (String(config.proxyUrl ?? "").length === 0) return { row: null, why: "" };
    const file = proxyKeyFileIn(profileDir);
    const record = readProxyKey(slug, config, { file });
    if (record == null) {
      return { row: null, why: `this workspace has no plan key yet, so nothing is included with its plan (mint one with cp/cli.mjs proxy mint ${slug})` };
    }
    // PROVIDERS-1. The rows are computed from what the proxy serves RIGHT NOW, not from the
    // snapshot the mint wrote.
    //
    // MEASURED ON THE R750 2026-09-08: all three tenants carried a two-row array written at mint
    // with modelLabel undefined, and nothing re-writes it -- cp/provision.mjs returns an existing
    // record untouched, by design, because re-minting is what wrote a REVOKED key back into a box.
    // So a name changed in the Providers panel would have reached nobody, and the whole panel would
    // have been a page that edits a database no customer reads.
    //
    // Reading them here instead means a label or a vendor-model change reaches the fleet inside one
    // registry cycle with no re-mint, no box write and none of that hazard. The stored array stays
    // as LAST KNOWN GOOD: a proxy that is down leaves every customer's plan card as it was rather
    // than emptying it, which is the difference between a slow minute and a fleet-wide "your plan
    // includes nothing".
    const live = await planModelRows();
    const models = live.rows ?? (Array.isArray(record.models) ? record.models : []);
    return {
      why: live.why,
      row: {
        baseUrl: `${config.proxyUrl}/v1`,
        key: record.key,
        keyId: record.keyId,
        models,
        enforced: record.enforced,
      },
    };
  }

  /**
   * What the proxy serves, as customer-facing rows, cached for a few seconds and joined in flight.
   *
   * The same shape as the admin console's box sweep and for the same reason: every relay on this
   * server polls the registry, and without the join that is one proxy read per relay per poll for
   * an answer that changes when an operator clicks something. With it, a burst of polls is one
   * read. The window is short because the whole point of this wave is that a change takes effect
   * without a restart.
   *
   * A FAILED READ IS NOT CACHED. It answers {rows: null} with the reason, the caller falls back to
   * the stored array, and the next poll asks again rather than sitting on a hole for the window.
   */
  const PLAN_ROWS_CACHE_MS = 5_000;
  let planRowsCache = { at: 0, answer: null, inFlight: null };
  function planModelRows() {
    if (proxy == null || proxy.configured !== true) {
      return Promise.resolve({ rows: null, why: "" });
    }
    if (planRowsCache.answer != null && Date.now() - planRowsCache.at < PLAN_ROWS_CACHE_MS) {
      return Promise.resolve(planRowsCache.answer);
    }
    if (planRowsCache.inFlight != null) return planRowsCache.inFlight;
    const pending = proxy.listModels().then(
      (answer) => {
        const result = answer.ok
          ? { rows: includedModelRows({ deployments: answer.rows }), why: "" }
          : { rows: null, why: `the proxy could not be asked what it serves (${answer.why}), so this workspace's plan card is the last one that was measured` };
        planRowsCache = answer.ok ? { at: Date.now(), answer: result, inFlight: null } : { at: 0, answer: null, inFlight: null };
        return result;
      },
      (error) => {
        planRowsCache = { at: 0, answer: null, inFlight: null };
        return { rows: null, why: `the proxy could not be asked what it serves (${String(error?.message ?? error).split("\n")[0]})` };
      },
    );
    planRowsCache = { ...planRowsCache, inFlight: pending };
    return pending;
  }

  /**
   * PROVIDERS-1. Put the vision fallback map back if it went missing, once at boot.
   *
   * WHY THIS EXISTS AND WHY IT IS AT BOOT. Until this wave the map that sends a screenshot-carrying
   * turn from plan-zai to plan-zai-vision lived in router_settings.fallbacks in the proxy's config
   * file. This wave moves it into the proxy's database, and the second of the wave's two restarts
   * takes it OUT of the file. Between those two facts there is exactly one window where a fallback
   * can be missing: the file no longer carries it and the database's copy is not there either.
   * PROXY-10 is what that costs -- a fleet-wide screenshot outage that read as the model being
   * broken -- so it is worth one read at boot rather than a line in a runbook.
   *
   * IT RECONCILES, IT DOES NOT REWRITE. The wanted target is each deployment's own
   * tb_vision_fallback, which the Providers panel wrote in the same action that wrote the fallback
   * row, so this is putting back what the operator already said rather than a second opinion about
   * it. An alias that already lists its target is left alone, and where one has to be written the
   * entries already there are KEPT behind it, because POST /fallback overwrites the whole list and
   * an operator who added a second route should not lose it to a restart.
   *
   * IT NEVER WRITES A TARGET THE PROXY DOES NOT SERVE. POST /fallback validates that the target
   * exists and answers 400 with the available list, so a target that is not being served is
   * reported and skipped rather than becoming a failed write on every boot.
   *
   * Nothing here throws and nothing here blocks the listen: a proxy that is down leaves the map as
   * it is and says so on stdout, which is the same answer as before this function existed.
   */
  async function reconcileFallbacks() {
    if (proxy == null || proxy.configured !== true) {
      return { ok: false, why: "this control plane has no proxy configured", restored: [], kept: [], skipped: [] };
    }
    const listed = await proxy.listModels();
    if (!listed.ok) {
      return { ok: false, why: `the proxy could not be asked what it serves (${listed.why})`, restored: [], kept: [], skipped: [] };
    }
    const rows = Array.isArray(listed.rows) ? listed.rows : [];
    const served = new Set(rows.map((row) => String(row?.alias ?? "")).filter((alias) => alias.length > 0));
    // One alias can be a pool of deployments. They carry the same customer-facing facts, so the
    // first one that names a target answers for the alias and the rest are the same row again.
    const wanted = new Map();
    for (const row of rows) {
      const alias = String(row?.alias ?? "");
      const target = String(row?.visionFallback ?? "");
      if (alias.length === 0 || target.length === 0 || wanted.has(alias)) continue;
      wanted.set(alias, target);
    }
    const restored = [];
    const kept = [];
    const skipped = [];
    for (const [alias, target] of wanted) {
      if (!served.has(target)) {
        skipped.push({ alias, target, why: `the proxy does not serve ${target}, so writing this would be refused` });
        continue;
      }
      const current = await proxy.getFallback(alias);
      if (!current.ok) { skipped.push({ alias, target, why: current.why }); continue; }
      if (current.fallbacks.includes(target)) { kept.push({ alias, target }); continue; }
      const written = await proxy.setFallback({ alias, fallbacks: [target, ...current.fallbacks] });
      if (!written.ok) { skipped.push({ alias, target, why: written.why }); continue; }
      restored.push({ alias, target, alongside: current.fallbacks });
    }
    return { ok: true, why: "", restored, kept, skipped };
  }

  // The extra facts an adoption was given, read back out of the ledger step it wrote. An adopted
  // instance was not built here, so its directories are wherever the operator already had them and
  // there is nothing in the tenant row that would know.
  // One parse of that step, in cp/provision.mjs, shared with the CLI. It was inline here until
  // PROXY-1 needed the same answer on the operator's side: `proxy mint titanium` has to write into
  // the directory this reader names, and a second implementation of "where does this workspace keep
  // its files" is how one of the two ends up writing a file nothing reads.
  const adoptionDetail = (slug) => adoptionDirs(store.listSteps(slug));

  // The same 0600 file cp/provision.mjs writes, read from a directory an adoption named rather than
  // from this service's own tenant root. Nothing else reads a path a request supplied: the path
  // here came from the operator through the admin door, not from a customer.
  function readTokenFromDirectory(directory) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, "local-docker-vm.json"), "utf8"));
      const token = String(parsed?.token ?? "");
      return token.length > 0 ? token : null;
    } catch { return null; }
  }

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

  // ---- the two things that can be DONE to a workspace, in one place each (ADMIN-1) --------------
  //
  // Lifted out of the /v1/tenants routes rather than copied, because the super admin console offers
  // the same four buttons and two implementations of "stop a customer's workspace" is how one of
  // them ends up without the adopted guard. Both route trees call these.

  async function tenantPower(response, slug, action) {
    const row = store.getTenant(slug);
    if (row == null) return json(response, 404, { error: "not_found" });
    if (!row.coolifyServiceUuid) return json(response, 409, { error: "no_service", message: "This tenant has no Coolify service yet." });
    try {
      const answer = action === "stop" ? await client.stopService(row.coolifyServiceUuid)
        : action === "start" ? await client.startService(row.coolifyServiceUuid)
        : await client.restartService(row.coolifyServiceUuid);
      // Coolify queues all three and answers immediately, so the ledger records what was asked
      // for, not what has happened. GET /v1/tenants/{slug} is what says when it took.
      //
      // An adopted row keeps saying "adopted": that is how it got here, not a container state,
      // and it is what the delete and provision guards read. Writing "stopped" over it would turn
      // a stop into a way around them.
      const next = wasAdopted(slug, row) ? "adopted" : action === "stop" ? "stopped" : "provisioning";
      const updated = store.updateTenant(slug, { status: next, lastError: null });
      return json(response, 200, { tenant: publicTenant(updated), message: String(answer?.message ?? "") });
    } catch (error) {
      store.updateTenant(slug, { lastError: String(error?.message ?? error) });
      return json(response, 502, { error: "coolify_error", message: String(error?.message ?? error) });
    }
  }

  async function tenantProvision(response, slug, body) {
    const row = store.getTenant(slug);
    if (row == null) return json(response, 404, { error: "not_found" });
    const dryRun = body?.dryRun === true || config.dryRun;
    // Provision on an adopted instance is not a retry, it is a second instance. On tenant
    // "titanium" that would be a second copy of Jason's live console.
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
    const result = await provisionTenant({ store, config, slug, name: row.name, dryRun, fetchImpl, probeImpl });
    if (!result.ok) {
      const status = dryRun ? 500 : 502;
      return json(response, status, { error: dryRun ? "render_failed" : "provisioning_failed", step: result.step, message: result.error, plan: result.plan });
    }
    if (dryRun) return json(response, 200, { dryRun: true, slug, plan: result.plan, composeSha256: result.composeSha256 });
    return json(response, 200, { tenant: publicTenant(result.tenant), ran: result.ran, boxReady: result.boxReady, message: result.boxNote });
  }

  // ---- the super admin console (ADMIN-1) --------------------------------------------------------
  //
  // MAIL-2. The per-bot address directory, over the same store. It mints a six digit code per
  // (workspace, agent), answers a lookup, and holds the approved-senders switch. No Resend key
  // reaches this service and no webhook lands on it: the relay keeps both, and this answers the
  // two routes below. cp/mail.mjs carries the reasoning.
  const mail = createMailDirectory({ store, domain: mailDomain(), now });
  // MAIL-3. The send log and its two caps, beside the directory and over the same store. It still
  // holds no Resend key: the relay does the sending and this says whether it may and writes down
  // that it did.
  const mailSends = createMailSends({ store, now });
  // VOICE-1. The minutes ledger and the caps behind spoken work, beside the mail pair and over the
  // same store. It holds no realtime key and opens no socket to a provider: the relay holds both,
  // reads the workspace's own key off its own disk, and counts the seconds on its own clock. This
  // answers the policy the relay starts that clock against and writes down what the session came to.
  // cp/voice.mjs carries the reasoning.
  const voice = createVoiceLog({ store, config, now });

  // CODE-1. The coding task ledger, the per-task credential and the coding deployment, beside the
  // mail send log and over the same store for the same reason: the relay runs the container and this
  // service owns everything that can be revoked or billed. It is handed the proxy client this process
  // already built, so there is one client and one master key in here rather than two.
  const codeTasks = createCodeTasks({ store, proxy, now });

  // Its own file, handed the pieces this one already owns, so there is one store, one Coolify
  // client and one session verifier in this process rather than two. It mounts below, before the
  // operator-token routes, and every route inside it refuses anything that is not a super admin.
  const admin = createAdminApi({
    config, store, client, now, fetchImpl, proxy,
    // ONBOARD-2. The box probe, which is the same fetch as fetchImpl in production and is not in a
    // test: the console's invite asks a new box for its own /health before it will mail a customer,
    // and a test process has no docker network for that name to resolve on. One word, so the
    // sequence is drivable; production behaviour is identical either way.
    probeImpl,
    json, noContent, publicAccount, publicTenant, tenantView, tenantPower, tenantProvision,
    currentSession, version: CP_VERSION,
    // MARKET-26. The marketplace panel's read, built ONCE in this file and handed over, so the
    // console and the operator's own route cannot drift into two different answers about which of
    // our rows may be stale.
    marketplaceVerificationState,
    // PROVIDERS-1. The address a change came from, so an admin_actions row can say WHERE as well as
    // who and when. This function is the only thing in the process that knows which peers are
    // trusted proxies, which are Cloudflare and which are boxes, and the admin API had no way to
    // ask before this wave.
    clientOf,
    // PROXY-1. One tenant's plan key, read off the disk through the same adoption-aware path the
    // registry uses, so the operator's own workspace is read the same way a customer's is.
    //
    // The KEY VALUE is in this record, and it is in it for exactly one reason: /key/info is asked
    // for a key's spend by the key, and that is the number LiteLLM itself compares a budget
    // against. cp/admin.mjs puts the alias and the key id in an answer and never the key, and
    // tests/cp-server asserts it by sweeping every route for a real minted key's bytes.
    proxyKeyOf: (slug) => {
      const adoption = adoptionDetail(slug);
      const profileDir = adoption.profileDir || tenantPaths(slug, config).profile;
      return readProxyKey(slug, config, { file: proxyKeyFileIn(profileDir) });
    },
    // PUSH-1. node:http2, for the one thing on this service that speaks it: the Apple proof, which
    // sends to a deliberately malformed device token and requires 400 BadDeviceToken rather than a
    // 403 about the provider token. Handed in rather than imported inside admin.mjs so a test can
    // drive every branch of that verdict table with no Apple account and no network.
    http2Impl,
  });

  /**
   * MARKET-26. What the catalog says, what the last run found, and how old each is.
   *
   * The two dates are kept apart on purpose. `catalog` is the row as it will reach a CUSTOMER --
   * the dates compiled into the host bundle, and the age their console draws "under review" from,
   * because nothing pushes control-plane state into a running box. `records` is what the last run
   * in THIS container found, which the operator sees now. When they disagree, the fix is a release
   * carrying `marketplace verify --write`, and the screen says so rather than hiding it.
   */
  function marketplaceVerificationState() {
    const at = now();
    let rows = [];
    let catalogProblem = null;
    try {
      rows = rowsWithDocs(loadCatalogPlugins()).map((row) => {
        const age = rowAge(row, at);
        return {
          id: String(row.id),
          name: String(row.name ?? row.id),
          category: String(row.category ?? ""),
          recheckDays: age.recheckDays,
          oldestCheckedOn: age.oldest,
          ageDays: age.days,
          // The word the customer's own plugin page uses for the same row, so an operator reading
          // this screen knows what the customer is being told right now. It has to be decided the
          // SAME WAY the page decides it, or this column becomes its own lie: the page reads the
          // row's own verdict first and its age second, because a `--write` moves the read date
          // forward on a fact it could not confirm, and a column that only knew about age said
          // "checked today" beside a row this very screen was calling NEEDS RE-VERIFICATION.
          customerSees: (row.docs ?? []).some((doc) => String(doc.state) === "changed")
            ? "under review (a fact on it changed)"
            : age.stale ? "under review (nobody has re-read it)" : `checked ${age.oldest}`,
          docs: (row.docs ?? []).map((doc) => ({
            id: String(doc.id), what: String(doc.what), url: String(doc.url),
            anchor: String(doc.anchor), checkedOn: String(doc.checkedOn), state: String(doc.state),
          })),
          knownContradiction: row.knownContradiction ?? null,
        };
      });
    } catch (error) {
      catalogProblem = String(error?.message ?? error);
    }
    return {
      measuredAt: new Date(at).toISOString(),
      rollup: readRollup(store),
      records: readRecords(store),
      catalog: rows,
      catalogProblem,
      // Named on the answer rather than only in the source, because a differ that silently ignores
      // part of a page is a differ nobody can audit.
      ignores: docNoiseRules(),
      everyWeek: VERIFY_INTERVAL_MS,
      meteredRuns: 0,
    };
  }

  async function handleSessionCreate(request, response, body) {
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    if (email.length === 0 || password.length === 0) return json(response, 400, { error: "bad_request", message: "Send an email address and a password." });

    const ip = clientOf(request);
    // A relay's address is not a person's, so the address bucket cannot mean anything for it.
    const viaRelay = isTrustedProxy(ip, relayPeers);
    // And the sign-in RECORD needs the same fact, for the same reason. Every tenant console on this
    // server forwards its sign-ins from one machine's egress address, so a row written here with
    // that address is not a row about where anybody was. The relay wrote its own row for the same
    // attempt with the visitor's real address on it; this one is marked so the merge can drop it
    // and so the by-address table can leave the phantom address out. ADMIN-1.
    const via = viaRelay ? "relay" : "";
    const at = now();
    store.pruneLoginFailures(at);
    const lock = store.loginLock({ email, ip, at, countIp: !viaRelay });
    if (lock.locked) {
      // ADMIN-1. Written down before the answer goes out. No hash: this branch never reached the
      // password check, so there is nothing that was tried, only somebody who kept knocking.
      admin.recordAttempt({ email, ip, outcome: "locked", at, via });
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
      // The keyed hash of what was tried, never the password. cp/admin.mjs carries the decision.
      admin.recordAttempt({ email, ip, outcome: "refused", password, at, via });
      return json(response, 401, { error: "invalid_login" });
    }

    // A door that was shut without the account being removed. The password was right, so this is
    // not a refusal in the lockout's sense and it is not counted as one; it is a sentence saying
    // their sign-in is off. ADMIN-1.
    if (attempt.account.disabled === true) {
      admin.recordAttempt({ email, ip, outcome: "refused", password, tenant: attempt.account.tenant, at, via });
      return json(response, 403, {
        error: "disabled",
        message: "This sign-in has been turned off. Contact your Titanium Bot support contact.",
      });
    }

    const tenant = store.getTenant(attempt.account.tenant);
    if (tenant == null) {
      return json(response, 409, {
        error: "tenant_missing",
        message: "Your account is set up but its instance is not registered yet. Please contact support.",
      });
    }

    store.clearLoginFailures({ email, ip });
    // Successes are recorded too, and with no hash: there is no reason to hold anything derived
    // from a password that worked, and a file of keyed hashes where one is known-good is a worse
    // file than one where none is. This is also what fills the "last sign-in" column.
    admin.recordAttempt({ email, ip, outcome: "ok", tenant: attempt.account.tenant, at, via });
    store.pruneRevocations(at);
    const host = tenant.host || consoleHost(config);
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
      // superAdmin is answered HERE, in the body, and not put in the token. The token's claim set is
      // fixed (ui/session-token.mjs, REQUIRED_CLAIMS) and, more to the point, a claim is a fact from
      // whenever it was minted: the admin routes look the flag up in the store on every request so a
      // demotion takes effect now rather than in up to twelve hours. This field is what tells the
      // console page which door to draw, nothing more. ADMIN-1.
      account: {
        id: attempt.account.id,
        email: attempt.account.email,
        name: attempt.account.name,
        superAdmin: attempt.account.superAdmin === true,
      },
      tenant: { slug: tenant.slug, host, status: tenant.status },
    });
  }

  // TENANT-5, item 5. One request turns a company into a customer: an account, a workspace name
  // derived from the company name, and the box being built.
  //
  // Two doors, and it is the same shape as everything else here. The operator bearer always opens
  // it, which is how Jason adds somebody from the CLI. Without the operator bearer it is open only
  // when CP_ALLOW_SIGNUP=1, and then the lockout applies: every attempt from an address that is not
  // one of our own relays is counted, so a stranger cannot sit there making workspaces. Ten in ten
  // minutes and that address waits, which is the same counter a wrong password fills.
  //
  // The order matters. The account is created first and the workspace is built after, so a build
  // that fails leaves somebody who can sign in and be told their workspace is still coming, rather
  // than a workspace nobody owns. Provisioning is idempotent, so finishing it is one retry.
  // ---- one problem report, stored (FEEDBACK-1) --------------------------------------------------
  //
  // THE WORKSPACE COMES FROM THE RELAY'S FORWARDED HEADER AND FROM NOWHERE ELSE. A body that
  // carries a slug, a tenant or a workspace is not refused, it is IGNORED: refusing would tell a
  // caller that the field is read, and the honest shape is that this route has no way to be told
  // which customer it is serving except by the service that already knows.
  //
  // The relay is what knows: it resolves the tenant from its own registry before it forwards, so
  // the name here was never in a request body anywhere on the path.
  const FEEDBACK_TENANT_HEADER = "x-titanbot-tenant";
  function handleFeedbackIntake(request, response, body) {
    const slug = String(request.headers[FEEDBACK_TENANT_HEADER] ?? "").trim().toLowerCase();
    if (slug.length === 0) {
      return json(response, 400, { error: "bad_request", message: "the console did not say which workspace this report came from, so nothing was stored" });
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
      return json(response, 400, { error: "bad_request", message: "that is not a workspace name, so nothing was stored" });
    }
    const normalized = normalizeReport(body);
    if (!normalized.ok) return json(response, 400, { error: "bad_request", message: normalized.why });
    const report = normalized.report;
    // The workspace is written over whatever arrived, rather than merged with it.
    report.evidence.workspace = slug;

    // A CREDENTIAL IN A REPORT IS THE ONE THING THIS ROUTE REFUSES OUTRIGHT.
    //
    // The evidence is built from a conversation, and a conversation can contain anything an agent
    // ever printed. This service's own three credentials are the ones whose appearance here would
    // be catastrophic and are also the only ones it can recognise, so those are what it looks for.
    // It is not a claim that a report can hold no secret at all; docs/FEEDBACK.md says as much in
    // the words the card shows the person before they press Send.
    const text = JSON.stringify(report);
    const ours = [config.sessionSecret, config.adminToken, config.relayToken]
      .map((one) => String(one ?? "")).filter((one) => one.length >= 16);
    if (ours.some((secret) => text.includes(secret))) {
      return json(response, 400, { error: "credential", message: "that report carried a credential, so nothing was stored" });
    }

    let row;
    try {
      row = store.recordFeedback({
        at: report.at,
        tenant: slug,
        agent: report.evidence.agent,
        agentName: report.evidence.agentName,
        tier: report.tier,
        category: report.category,
        title: report.title,
        body: report.description,
        payload: text,
        state: "new",
      });
    } catch (error) {
      const code = error?.code === "too_large" ? 413 : 400;
      return json(response, code, { error: error?.code ?? "bad_request", message: String(error?.message ?? "that report could not be stored") });
    }
    return json(response, 201, { id: row.id, tier: row.tier, state: row.state });
  }

  async function handleSignup(request, response, body) {
    const isOperator = secretsMatch(bearer(request), config.adminToken);
    if (!isOperator && !config.allowSignup) {
      return json(response, 403, {
        error: "signup_closed",
        message: "Sign up is not open on this server. Ask your Titanium Bot contact to add you.",
      });
    }

    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const company = String(body.company ?? "").trim();
    if (!email.includes("@") || email.length < 3) return json(response, 400, { error: "bad_request", message: "Send a real email address." });
    if (password.length < MIN_PASSWORD_LENGTH) return json(response, 400, { error: "bad_request", message: `The password has to be at least ${MIN_PASSWORD_LENGTH} characters.` });
    if (company.length === 0) return json(response, 400, { error: "bad_request", message: "Send the name of your company." });

    const ip = clientOf(request);
    const at = now();
    if (!isOperator) {
      const viaRelay = isTrustedProxy(ip, relayPeers);
      store.pruneLoginFailures(at);
      const lock = store.loginLock({ email, ip, at, countIp: !viaRelay });
      if (lock.locked) {
        return json(response, 429, { error: "locked", retryAfter: lock.retryAfter }, { "retry-after": String(lock.retryAfter) });
      }
      // Counted whether or not this one works. The counter exists to cap how many workspaces one
      // address can start, and a successful one costs this server far more than a failed one.
      store.recordLoginFailure({ email, ip, at });
    }

    if (store.getAccountByEmail(email) != null) {
      return json(response, 409, { error: "duplicate_email", message: "That email address already has an account. Sign in instead." });
    }

    // Taken means taken NOW or still spoken for. A workspace that was removed while sign-ins still
    // pointed at it keeps its name out of circulation (cp/store.mjs retired_slugs): handing that
    // name to a different company would make the previous customer's sign-ins resolve to the new
    // company's box, with full access to it.
    const slug = deriveSlug(company, (candidate) => store.getTenant(candidate) != null || store.isSlugRetired(candidate));
    if (slug == null) {
      return json(response, 400, { error: "bad_company", message: "That company name has no letters or numbers in it, so there is nothing to name the workspace after. Send a different one." });
    }

    if (!config.allowNewTenants) return json(response, 409, { error: "new_tenants_off", message: NEW_TENANTS_BLOCKED });

    const host = consoleHost(config);
    store.createTenant({ slug, name: company, host, status: "provisioning", ownerEmail: email });
    let account;
    try {
      account = store.createAccount({ email, password, name: String(body.name ?? ""), tenant: slug });
    } catch (error) {
      // The workspace row was written a line ago and nobody owns it, so it comes back out rather
      // than sitting in the ledger as a name a later customer cannot have.
      store.deleteTenant(slug);
      if (error?.code === "duplicate_email") return json(response, 409, { error: "duplicate_email", message: "That email address already has an account. Sign in instead." });
      throw error;
    }

    const result = await provisionTenant({ store, config, slug, name: company, fetchImpl, probeImpl });
    if (!result.ok) {
      // The account stays. They can sign in, and the operator finishes the build with one retry.
      return json(response, 502, {
        error: "provisioning_failed",
        step: result.step,
        // No promise this service cannot keep: it sends no mail. What it can honestly say is that
        // the account works and the workspace is not finished, and that signing in again later is
        // the way to find out.
        message: "Your account is set up and your workspace is not finished yet. You can sign in, and your workspace will be there once it comes up.",
        detail: result.error,
        account: publicAccount(account),
        tenant: publicTenant(store.getTenant(slug)),
      });
    }

    return json(response, 201, {
      account: publicAccount(account),
      tenant: publicTenant(result.tenant),
      signIn: `https://${host}`,
      boxReady: result.boxReady,
      message: result.boxNote,
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
      // One route reads more than the rest, and it is the report intake. A report carries its
      // evidence twice -- the block of text the person read and edited, and the structured copy --
      // so the ordinary maximum is larger than any form on this service. cp/feedback.mjs owns the
      // number and its limits are sized to fit inside it.
      const cap = segments[0] === "v1" && segments[1] === "feedback" && segments.length === 2
        ? FEEDBACK_BODY_BYTES
        : MAX_BODY_BYTES;
      try { body = await readJsonBody(request, cap); }
      catch (error) { return json(response, 400, { error: error.code === "too_large" ? "too_large" : "bad_json", message: String(error.message) }); }
    }

    // ---- the super admin console (ADMIN-1) -----------------------------------------------------
    //
    // Before the /v1 check, because the page itself is served at /admin and not under /v1, and
    // before the operator-token routes, because its own guard is a different one: CP_ADMIN_TOKEN for
    // the CLI, or a session whose account carries super_admin, looked up in the store on every
    // request. It answers false for anything that is not its own, and the routing below carries on.
    if (await admin.handle(request, response, { segments, method, body, url })) return undefined;

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

    // ---- sign up -----------------------------------------------------------------------------
    if (segments[1] === "signups" && segments.length === 2 && method === "POST") {
      return handleSignup(request, response, body);
    }

    // ---- the console relay's registry ----------------------------------------------------------
    // Before the operator block below, so requireAdmin never sees it and the admin token never
    // opens it. See the amendment at the top of this file: this is the one route that answers with
    // per-tenant gateway tokens and per-tenant derived session keys, and it answers to one
    // credential that opens nothing else.
    if (segments[1] === "relay" && segments[2] === "tenants" && segments.length === 3) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      return json(response, 200, await relayRegistry());
    }

    // ---- the per-bot mail directory (MAIL-2, docs/MAIL.md) --------------------------------------
    // Beside the registry route and behind the same one credential, because they are the same kind
    // of thing: what the one relay needs from this service to serve a customer. No new secret, and
    // no public route -- Resend still calls the relay, which already verifies Svix by hand, so
    // readJsonBody above is untouched and the raw-body trap never applies here.
    if (segments[1] === "relay" && segments[2] === "mail" && segments[3] === "directory" && segments.length === 4) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      const slug = String(url.searchParams.get("slug") ?? "").trim();
      return json(response, 200, mail.directory(slug.length > 0 ? slug : null));
    }

    if (segments[1] === "relay" && segments[2] === "mail" && segments[3] === "mint" && segments.length === 4) {
      if (method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      const answer = mail.mint(body.slug, body.agents);
      return json(response, answer.error ? 400 : 200, answer);
    }

    // ---- the send log (MAIL-3, docs/MAIL.md) ----------------------------------------------------
    // Beside the directory and the mint above, behind the same one credential and for the same
    // reason: what the one relay needs from this service to serve a customer. No Resend key crosses
    // this line in either direction.
    //
    // TWO ROUTES AND NOT ONE, because the claim happens BEFORE the mail goes and the outcome is
    // only known after. An unsent mail is recoverable and an unlogged send is not, so a crash
    // between them leaves a row reading "sending", which counts toward the cap and reads as "we do
    // not know". A single route taking a finished send would have no way to say that.
    if (segments[1] === "relay" && segments[2] === "mail" && segments[3] === "send" && segments.length === 5) {
      if (method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      if (segments[4] === "open") {
        const answer = mailSends.openSend({
          slug: body.slug, agentId: body.agentId, code: body.code, to: body.to, idem: body.idem,
        });
        // 429 on a cap and 400 on a malformed claim, so the relay can pass the sentence on word for
        // word rather than inventing one of its own.
        return json(response, answer.ok ? 200 : (answer.error === "rate_limited" ? 429 : 400), answer);
      }
      if (segments[4] === "close") {
        const answer = mailSends.closeSend(body.id, body.outcome, body.resendId, body.detail);
        return json(response, answer.ok ? 200 : 400, answer);
      }
    }

    // ---- a coding task's credential and its ledger (CODE-1, docs/CODE.md) ----------------------
    //
    // Beside the mail send routes above, behind the same one credential, in the same order and with
    // the same refusals: the method first so a wrong method charges nobody, then CP_RELAY_TOKEN and
    // deliberately not the admin token. The relay is the only thing that reaches this, because it is
    // the only thing holding that credential -- a box holds neither, which is what keeps a control
    // plane credential out of a container a customer's agents run as root in.
    //
    // TWO ROUTES AND NOT ONE, the mail shape, and here the reason is money rather than mail: the
    // claim is taken BEFORE the container exists, because an unstarted task is recoverable and an
    // unbilled container-hour is not. `open` answers with the task's OWN credential, which is the
    // only thing on this service that hands a key out, and it hands out one that is capped, scoped to
    // one model and revoked by `close`.
    if (segments[1] === "relay" && segments[2] === "code" && segments[3] === "task" && segments.length === 5) {
      if (method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      if (segments[4] === "open") {
        const answer = await codeTasks.openTask({
          slug: body.slug, agentId: body.agentId, taskId: body.taskId, provider: body.provider,
        });
        // 429 on a cap and 400 on a malformed claim, so the relay can pass the sentence on word for
        // word rather than inventing one of its own. Anything else that stopped the task from
        // starting is a 502: it is this side's failure and not the caller's.
        if (answer.ok) return json(response, 200, answer);
        if (answer.error === "rate_limited") return json(response, 429, answer);
        if (answer.error === "bad_request") return json(response, 400, answer);
        return json(response, 502, answer);
      }
      if (segments[4] === "close") {
        const answer = await codeTasks.closeTask({
          id: body.id, outcome: body.outcome, minutes: body.minutes, detail: body.detail,
        });
        return json(response, answer.ok ? 200 : (answer.error === "not_found" ? 404 : 400), answer);
      }
    }

    // The operator's read, and the two settings writes. They are HERE, at /v1/code, and NOT under
    // /v1/admin, for the same structural reason /v1/mail/sends is: cp/admin.mjs claims every
    // /v1/admin/* path and answers 404 to anything it does not match itself, so a route added under
    // that prefix has to be added inside that file -- and that file belongs to another wave.
    //
    // The guard is the admin API's OWN requireSuperAdmin rather than this file's requireAdmin, and
    // that is deliberate: requireAdmin takes the operator bearer only, and the super admin console is
    // a BROWSER holding a session. A route the panel cannot read is a panel that draws nothing. This
    // guard takes either, it looks the super_admin flag up in the store on every request, and the
    // relay's own credential does not open it.
    if (segments[1] === "code" && segments[2] === "tasks" && segments.length === 3) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!admin.requireSuperAdmin(request, response).ok) return undefined;
      const slug = String(url.searchParams.get("slug") ?? "").trim();
      const asked = Number.parseInt(String(url.searchParams.get("limit") ?? ""), 10);
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : 50;
      return json(response, 200, {
        measuredAt: new Date(now()).toISOString(),
        slug,
        // The per-workspace rollup the Spend panel draws its one quiet line from, and the rows
        // themselves when a workspace is named. Both carry nulls through as nulls.
        tenants: codeTasks.rollup(slug),
        rows: slug.length > 0 ? codeTasks.listTasks(slug, limit) : [],
        settings: slug.length > 0 ? codeTasks.settings(slug) : codeTasks.settings(""),
      });
    }

    if (segments[1] === "code" && segments[2] === "settings" && segments.length === 3) {
      if (method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      const guard = admin.requireSuperAdmin(request, response);
      if (!guard.ok) return undefined;
      const answer = codeTasks.setSettings({ ...body, actor: guard.account?.email ?? "the operator token" });
      return json(response, answer.ok ? 200 : 400, answer);
    }

    // ---- the two push credentials, for the relay (PUSH-1, docs/APPS.md) -------------------------
    //
    // The fifth route of this kind, beside the registry and the three mail ones, behind the same one
    // credential and for the same reason: what the one relay needs from this service to serve a
    // customer. It is the ONLY route on this service that answers with either value, and the only
    // caller is the relay, which holds them in memory, never writes them to disk, and never pushes
    // them into a box -- every exec daemon in a customer's container runs as uid 0, so an Apple key
    // inside one is readable by that customer's own agents.
    //
    // The method refusal is first, so a wrong method charges nobody and learns nothing, exactly as
    // the mail routes above do it. The super admin's own read is GET /v1/admin/push, which answers
    // presence, the evidence and the non-secret ids and never a value.
    if (segments[1] === "relay" && segments[2] === "push" && segments[3] === "credentials" && segments.length === 4) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      const apnsKey = store.getSetting("push.apns.key", "");
      const fcmAccount = store.getSetting("push.fcm.serviceAccount", "");
      let serviceAccount = null;
      try { serviceAccount = fcmAccount.length > 0 ? JSON.parse(fcmAccount) : null; } catch { serviceAccount = null; }
      return json(response, 200, {
        apns: apnsKey.length > 0
          ? {
            key: apnsKey,
            keyId: store.getSetting("push.apns.keyId", ""),
            teamId: store.getSetting("push.apns.teamId", ""),
            bundleId: store.getSetting("push.apns.bundleId", ""),
          }
          : null,
        fcm: serviceAccount != null
          ? { serviceAccount, projectId: store.getSetting("push.fcm.projectId", "") }
          : null,
      });
    }

    // The operator's own read of that log. It is HERE, at /v1/mail/sends, and NOT under /v1/admin,
    // for one structural reason: cp/admin.mjs claims every /v1/admin/* path and answers 404 to
    // anything it does not match itself, so a mail route added under that prefix has to be added
    // inside that file -- and that file belongs to another wave this week. Folding this read into
    // the super admin panel is filed as MAIL-3b. It is still a super admin route: requireAdmin, the
    // same as everything under that prefix, and the relay's own credential does not open it.
    if (segments[1] === "mail" && segments[2] === "sends" && segments.length === 3) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!requireAdmin(request, response)) return undefined;
      const slug = String(url.searchParams.get("slug") ?? "").trim();
      if (slug.length === 0) return json(response, 400, { error: "bad_request", message: "Name the workspace." });
      const asked = Number.parseInt(String(url.searchParams.get("limit") ?? ""), 10);
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : 50;
      return json(response, 200, { slug, caps: mailSends.sendCaps(slug), rows: mailSends.listSends(slug, limit) });
    }

    // ---- spoken sessions (VOICE-1, docs/VOICE.md) ------------------------------------------------
    //
    // Three relay routes and two operator routes, and the split is the whole design: the relay is
    // told NUMBERS and reports ROWS, and the operator is the only one who can change a number.
    //
    // WHAT DOES NOT CROSS THIS LINE IN EITHER DIRECTION: the realtime key. NONE of the five routes
    // in this section takes one, answers one or could be made to log one, and that is still true and
    // still tested.
    //
    // KEYS-1 AMENDED WHAT THAT SENTENCE MEANS, the way TENANT-5 amended the rule at the top of this
    // file rather than deleting it. It used to be true of the whole SERVICE: the key was a
    // per-workspace secret a customer typed into their own console and it never reached here at all.
    // It is the operator's now, it is held in admin_settings write-only, and there is exactly one
    // route on this service that answers with it -- GET /v1/relay/keys, behind CP_RELAY_TOKEN, at the
    // bottom of this dispatcher with its own reasoning on it. Not this one, and not any voice route:
    // the split below is unchanged, the relay is still told NUMBERS and still reports ROWS, and the
    // caps are still the only thing an operator changes here.
    //
    // The key is still NOT on the super-admin Providers panel: those keys are global, they live at
    // LiteLLM as credentials, they read back masked, and a realtime address is a websocket a proxy
    // has no deployment shape for. PROVIDERS-10; the two cosmetic realtime rows that used to sit
    // there are deleted, and "Keys the product uses" is where an operator pastes this one.
    //
    // The method refusal comes first on every one of them, the way the mail send pair does: a wrong
    // method charges nobody and learns nothing.
    if (segments[1] === "relay" && segments[2] === "voice" && segments[3] === "policy" && segments.length === 4) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      const slug = String(url.searchParams.get("slug") ?? "").trim();
      if (slug.length === 0) return json(response, 400, { error: "bad_request", message: "Name the workspace." });
      return json(response, 200, voice.policy(slug));
    }

    // The claim and the settle, shaped exactly like the mail send pair above and for the same reason:
    // the claim happens BEFORE the provider socket opens and the outcome is only known after. A row
    // written on close does not exist for a relay that crashed or a tab closed mid-sentence, and the
    // day cap is read out of these same rows.
    if (segments[1] === "relay" && segments[2] === "voice" && segments[3] === "usage" && segments.length === 5) {
      if (method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      if (segments[4] === "open") {
        const answer = voice.openSession({
          slug: body.slug, sessionId: body.sessionId, agentId: body.agentId, vendor: body.vendor, model: body.model,
        });
        // 429 on a cap and 400 on a malformed claim, so the relay passes the sentence on word for
        // word rather than inventing one of its own. A vendor this workspace may not use is 403 and
        // says the same plain thing a person can act on, which is nothing about a vendor.
        if (answer.ok) return json(response, 200, answer);
        if (answer.error === "day_cap") return json(response, 429, answer);
        if (answer.error === "voice_off" || answer.error === "vendor_not_allowed") return json(response, 403, answer);
        return json(response, 400, answer);
      }
      if (segments[4] === "close") {
        const answer = voice.closeSession(body ?? {});
        return json(response, answer.ok ? 200 : (answer.error === "not_found" ? 404 : 400), answer);
      }
    }

    // The operator's read, and it is HERE rather than under /v1/admin for the structural reason
    // written over the mail send log above: cp/admin.mjs claims every /v1/admin/* path and answers
    // 404 to anything it does not match itself, so a route added under that prefix has to be added
    // inside that file, and that file belongs to another wave this week.
    //
    // THE GUARD IS admin.requireSuperAdmin AND NOT THIS FILE'S requireAdmin (ADMIN-4). The Spend
    // panel calls this route, and a browser does not hold the operator bearer: it holds a session
    // token from POST /v1/sessions. requireAdmin compares the bearer to CP_ADMIN_TOKEN only, so this
    // route answered the panel 401 -- and cp/admin/admin.js's api() signs the person out on ANY 401,
    // which threw every super admin back to the door about two seconds after they signed in.
    // requireSuperAdmin takes EITHER credential, so the operator's CLI keeps working unchanged.
    //
    // NO SLUG MEANS EVERY WORKSPACE, which is the one place this differs from /v1/mail/sends: the
    // Spend panel draws one line per tenant, so a read that demanded a slug would need one fetch per
    // customer to fill one table.
    if (segments[1] === "voice" && segments[2] === "usage" && segments.length === 3) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!admin.requireSuperAdmin(request, response).ok) return undefined;
      const slug = String(url.searchParams.get("slug") ?? "").trim();
      const day = String(url.searchParams.get("day") ?? "").trim();
      if (day.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return json(response, 400, { error: "bad_request", message: "A day is YYYY-MM-DD, in UTC." });
      }
      return json(response, 200, voice.usage({ slug, day }));
    }

    // And the operator's WRITE, which is the thing that has no customer-reachable twin anywhere in
    // this product. A customer raising their own day cap is unbounded spend on somebody else's
    // invoice, so the minutes live in admin_settings behind a super admin door and the customer's own
    // Voice card writes the KEY and nothing else.
    //
    // Same guard as its read above, and for the same reason (ADMIN-4): the read and the write of one
    // operator number are one pair, and a pair split across two doors is how the next panel control
    // added here gets the outage back. No customer-reachable credential opens either one.
    if (segments[1] === "voice" && segments[2] === "caps" && segments.length === 3) {
      if (method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      const guard = admin.requireSuperAdmin(request, response);
      if (!guard.ok) return undefined;
      // The actor on the settings row: the signed-in super admin's own address when a person did it,
      // and the token plus the surface that presented it when the operator's CLI did. Writing down a
      // name nobody proved would be worse than writing down the truth, which is why the bearer case
      // stays a description of the bearer rather than a person.
      const actor = guard.account?.email ?? `operator via ${String(request.headers["x-titanbot-via"] ?? "api")}`;
      const answer = voice.setCaps(body.slug, {
        dayMinutes: body.dayMinutes ?? null,
        sessionMinutes: body.sessionMinutes ?? null,
        vendors: body.vendors ?? null,
      }, actor);
      return json(response, answer.ok ? 200 : 400, answer);
    }

    // ---- a problem report, forwarded by a console (FEEDBACK-1) ---------------------------------
    // Beside the registry route above and shaped exactly like it: the method refusal first so a
    // wrong method charges nobody and learns nothing, then CP_RELAY_TOKEN and deliberately not the
    // admin token. The relay is the only thing that reaches this, because it is the only thing
    // holding that credential -- a customer's box holds neither, which is what keeps a
    // control-plane credential out of a container the customer's own agents run as root in.
    if (segments[1] === "feedback" && segments.length === 2) {
      if (method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      return handleFeedbackIntake(request, response, body);
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

    // ---- MARKET-26: the marketplace rows' vendor documentation ---------------------------------
    //
    // Two routes and nothing else. The state, and a run. Both behind the operator bearer, because
    // what they carry is which of our own catalog rows may be telling a customer something that is
    // no longer true -- an operator's fact, not a customer's.
    //
    // The run is deliberately synchronous and deliberately small: it fetches a handful of vendor
    // documentation pages over plain HTTPS and writes a record. It starts no browser and spends
    // nothing; `meteredRuns` comes back on every answer saying so, because a job that quietly cost
    // money every week would be found out by the invoice rather than by the screen.
    if (segments[1] === "marketplace" && segments[2] === "verification") {
      if (!requireAdmin(request, response)) return undefined;

      if (segments.length === 3 && method === "GET") {
        return json(response, 200, marketplaceVerificationState());
      }

      if (segments.length === 4 && segments[3] === "run" && method === "POST") {
        const only = String(body?.row ?? "").trim();
        try {
          const answer = await verifyCatalog({ store, now, source: "api", only, actor: "the operator token" });
          return json(response, 200, {
            ...answer.rollup,
            records: answer.records,
            measuredAt: new Date(now()).toISOString(),
          });
        } catch (error) {
          // A vendor's documentation site being unreachable is not a 500 on this service. The run
          // says what it could not do and the previous record stays exactly where it was.
          return json(response, 502, { error: "verification_failed", message: String(error?.message ?? error) });
        }
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
          return json(response, 201, { account: publicAccount(account), tenant: { slug: row.slug, host: row.host || consoleHost(config) } });
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

      // Removing somebody's sign-in. There was no way to do this at all, and the hole showed itself
      // the first time a tenant was deleted: deleting a workspace leaves its accounts, so those
      // people could still sign in, be given a session for a workspace that is gone, and meet "That
      // workspace is not available right now." for ever, with nothing the operator could do about it
      // short of editing the database by hand.
      //
      // Deleting the accounts along with the tenant would have been the other answer and it is the
      // wrong one. Re-provisioning a workspace under the same slug is a supported thing to do (it is
      // how the demo tenant was moved onto the one-console shape), and it restores those people's
      // access exactly as it was. Cascading would have locked them out of their own workspace to
      // tidy up a row.
      if (segments.length === 3 && method === "DELETE") {
        // Decoded, because an email in a path is percent-encoded by anything that builds URLs
        // properly and the @ becomes %40. The CLI does exactly that, and the first live run of this
        // route answered 404 for an account that was sitting right there in the list. A malformed
        // escape is not a reason to throw: it is simply not an id anybody holds.
        let named = segments[2];
        try { named = decodeURIComponent(segments[2]); } catch { named = segments[2]; }
        const account = store.getAccountById(named) ?? store.getAccountByEmail(named);
        if (account == null) return json(response, 404, { error: "not_found" });
        if (String(body.confirm ?? "") !== account.email) {
          return json(response, 400, {
            error: "confirm_required",
            message: `To remove this account send {"confirm": "${account.email}"} in the body.`,
          });
        }
        store.deleteAccount(account.id);
        return json(response, 200, {
          deleted: true,
          email: account.email,
          tenant: account.tenant,
          // Said out loud because it is the question the operator is actually asking.
          message: `${account.email} can no longer sign in. Nothing in that workspace was touched, and a session they already hold keeps working until it expires, which is at most 12 hours.`,
        });
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
          return json(response, 200, { dryRun: true, slug, host: consoleHost(config), plan: result.plan, composeSha256: result.composeSha256 });
        }

        if (!config.allowNewTenants) return json(response, 409, { error: "new_tenants_off", message: NEW_TENANTS_BLOCKED });

        store.createTenant({ slug, name, host: consoleHost(config), status: "provisioning", ownerEmail });
        const result = await provisionTenant({ store, config, slug, name, fetchImpl, probeImpl });
        if (!result.ok) {
          return json(response, 502, { error: "provisioning_failed", step: result.step, message: result.error, tenant: publicTenant(store.getTenant(slug)) });
        }
        return json(response, 201, {
          tenant: publicTenant(result.tenant),
          boxReady: result.boxReady,
          message: result.boxNote,
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
        // PROXY-1. The plan key goes BEFORE the container does.
        //
        // Order matters and it is asserted by call order in the tests. A key deleted after the
        // service is gone is a key that is still spending for however long the delete takes, and a
        // key deleted after a FAILED service delete is worse: the box is still running with a
        // credential the operator believes they revoked. Revoking first means the worst case is a
        // workspace that is up and cannot reach a model, which is visible, rather than one that is
        // gone and can, which is not.
        //
        // A failed revoke does NOT stop the delete. The operator asked to remove a customer and a
        // proxy that is down must not strand that; it comes back as a sentence naming the CLI that
        // finishes the job. The alias is derivable from the slug, so it can be revoked later with
        // nothing but the name.
        let revokeNote = "";
        if (proxy.configured) {
          const revoked = await proxy.deleteKeyByAlias(slug);
          if (!revoked.ok) revokeNote = ` The key this workspace used with the models included in its plan could NOT be revoked: ${revoked.why}. Revoke it with cp/cli.mjs proxy revoke ${slug}.`;
        }
        if (row.coolifyServiceUuid) {
          try { await client.deleteService(row.coolifyServiceUuid); }
          catch (error) { return json(response, 502, { error: "coolify_error", message: String(error?.message ?? error) }); }
        }
        // Whose sign-ins are about to point at nothing. Read BEFORE the row goes, and reported
        // rather than deleted: re-provisioning under the same slug gives these people their
        // workspace back, and cascading would have locked them out to tidy a row. What was missing
        // was any way to know, so an operator who really is finished with a customer had no idea
        // there were doors left standing.
        const orphaned = store.listAccountsForTenant(slug).map((account) => account.email);
        store.deleteTenant(slug);
        return json(response, 200, {
          deleted: true,
          slug,
          // Said here as well as in the docs, because this is the answer the operator is looking at
          // when they wonder whether they just lost a customer's work.
          dataKept: tenantDirectory(slug, config),
          accountsLeft: orphaned,
          message: `The Coolify service is gone. Everything in ${tenantDirectory(slug, config)} was left alone, so nothing the customer made was deleted.`
            + revokeNote
            + (orphaned.length === 0
              ? ""
              : ` ${orphaned.length} sign-in${orphaned.length === 1 ? "" : "s"} still point${orphaned.length === 1 ? "s" : ""} at this workspace (${orphaned.join(", ")}). Build it again under the same name and they work; remove them with DELETE /v1/accounts/<email>. Until one or the other, those people are told the workspace is not available, and the name ${slug} is held back so no new customer can be given it.`),
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
        // TENANT-5. What an adoption is FOR now, beyond recording that the instance exists: it is
        // how tenant "titanium", Jason's own instance, gets into the relay's registry without
        // anything being typed twice.
        //
        // The box container name defaults to the one Coolify gives it, which is the compose service
        // name and the resource uuid. That is right for an instance built from this repo's own
        // compose and can be overridden for one that is not. The two directories default to the
        // release root, which is where an operator's own state and profile already are; the token
        // is read out of profileDir/local-docker-vm.json when the registry is asked for, never
        // copied into the ledger.
        //
        // The relay does not depend on any of this to serve Jason: it seeds its own entry from its
        // own environment at boot, so a control plane that is down cannot take his console with it.
        // This is what makes the row consistent with the rest of the fleet, and what would serve a
        // second adopted instance.
        const boxContainer = String(body.boxContainer ?? "").trim() || boxContainerName(uuid);
        const stateDir = String(body.stateDir ?? "").trim() || path.join(config.releaseRoot, "state");
        const profileDir = String(body.profileDir ?? "").trim() || path.join(config.releaseRoot, "profile");
        const existing = store.getTenant(value);
        const tenant = existing == null
          ? store.createTenant({ slug: value, name: String(body.name ?? value), host, status: "adopted", coolifyServiceUuid: uuid, boxContainer })
          : store.updateTenant(value, { host, status: "adopted", coolifyServiceUuid: uuid, boxContainer, lastError: null });
        store.recordStep({ slug: value, step: "adopt", status: "ok", detail: JSON.stringify({ uuid, host, boxContainer, stateDir, profileDir }) });
        return json(response, 200, { tenant: publicTenant(tenant), boxContainer, stateDir, profileDir });
      }

      // Both of these are tenantProvision and tenantPower above. Adopt records one ledger step
      // called "adopt", so none of the seven provisioning steps is marked done and every one of
      // them would run on a re-provision: a duplicate Coolify service, a second container carrying
      // the com.titanbot.role=box label the relay resolves its box by, and the hostname rewritten
      // to one that does not exist. That guard lives in tenantProvision, where the admin console
      // gets it too.
      if (segments.length === 4 && segments[3] === "provision" && method === "POST") {
        if (row == null) return json(response, 404, { error: "not_found" });
        return await tenantProvision(response, slug, body);
      }

      if (segments.length === 4 && ["stop", "start", "restart"].includes(segments[3]) && method === "POST") {
        if (row == null) return json(response, 404, { error: "not_found" });
        return await tenantPower(response, slug, segments[3]);
      }

      return json(response, 404, { error: "not_found" });
    }

    // ---- KEYS-1: the keys the product uses (cp/secrets.mjs, docs/ADMIN.md) ----------------------
    //
    // Three branches, deliberately at the very bottom of this dispatcher and deliberately NOT under
    // /v1/admin: cp/admin.mjs claims that whole prefix and answers 404 to anything it does not match
    // itself, which is the same structural reason /v1/code/settings and /v1/mail/sends live out
    // here. They are also a long way from the voice guard region above, which another wave owns this
    // week.
    //
    // WHAT THIS CHANGES ABOUT THE RULE WRITTEN OVER THE VOICE ROUTES. That comment says the
    // workspace's realtime key never crosses this service, and until today that was true: the key
    // was a per-workspace secret a CUSTOMER typed into their own console. It is not a customer's any
    // more. Jason, looking at the settings panel on 2026-09-10: "A user is never going to put a
    // resend key in. That's on the backend." So the two vendor keys the product itself uses are the
    // operator's, they are held here write-only, and the relay reads them behind its own credential.
    //
    // The isolation that mattered is NOT the key. It is the metering and the caps, and both of those
    // are already per workspace on this service: voice minutes are claimed per tenant before the
    // provider hears a byte, the day and session caps are per tenant, and the mail send ledger is
    // per tenant. What is shared by this change is the vendor's bill, which the operator was always
    // paying anyway; what is not shared is any workspace's ability to spend beyond its own cap.
    // docs/VOICE.md section 2 is rewritten to say exactly that.
    if (segments[1] === "keys") {
      // The super admin's own read: presence, evidence, when and who, and never a value.
      if (segments.length === 2 && method === "GET") {
        if (!admin.requireSuperAdmin(request, response).ok) return undefined;
        return json(response, 200, keysDoor(store));
      }

      // The paste. requireSuperAdmin and NOT requireAdmin, because the thing holding this door open
      // is a BROWSER holding a session from POST /v1/sessions, not the operator's bearer -- which is
      // the whole of ADMIN-4 and is written out at /v1/voice/usage above. requireSuperAdmin takes
      // either, so the operator's CLI keeps working.
      if (segments.length === 3 && method === "POST") {
        const guard = admin.requireSuperAdmin(request, response);
        if (!guard.ok) return undefined;
        const name = String(segments[2] ?? "");
        if (keyDefinition(name) == null) {
          return json(response, 400, { error: "bad_request", message: "That is not a key this product uses. Nothing was stored." });
        }
        const parsed = parseKeyValue(body ?? {});
        if (!parsed.ok) return json(response, 400, { error: "bad_request", message: `${parsed.why} Nothing was stored.` });
        // PROVED BEFORE STORED. A key the vendor will not take is a feature that fails weeks later
        // on somebody else's morning, which is the reason the GitHub token and both push
        // credentials do this too. A refusal is 409 and the store is not touched.
        const proof = await proveKey({ name, value: parsed.value, fetchImpl, env: process.env });
        if (!proof.ok) return json(response, 409, { error: "key_refused", message: `${proof.why} Nothing was stored.` });
        const actor = guard.account?.email ?? `operator via ${String(request.headers["x-titanbot-via"] ?? "api")}`;
        const ledger = beginKeyAction(store, {
          actor, via: String(request.headers["x-titanbot-via"] ?? "console"), ip: clientOf(request),
          name, value: parsed.value, now: now(),
        });
        store.setSetting(name, parsed.value, actor);
        ledger.done(`checked against ${proof.how}`);
        return json(response, 200, {
          name,
          checkedWith: proof.how,
          // NOT the key. Nothing on this service ever answers with it again.
          evidence: keyEvidence(parsed.value),
          message: "That key was accepted and is stored. Nothing here can show it again.",
        });
      }

      return json(response, 404, { error: "not_found" });
    }

    // And what the RELAY reads, behind CP_RELAY_TOKEN like the registry, the mail routes and the two
    // push credentials. THE METHOD REFUSAL IS FIRST, so a wrong method charges nobody and learns
    // nothing; the relay keeps what comes back in memory, never writes it beside a state file, and
    // never pushes it into a box (every exec daemon in a customer's container runs as uid 0, so a
    // key inside one is readable by that customer's own agents).
    //
    // A name with nothing behind it is left out rather than answered empty, because the relay's
    // fallback to a workspace's own file is decided by absence.
    if (segments[1] === "relay" && segments[2] === "keys" && segments.length === 3) {
      if (method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!requireRelay(request, response)) return undefined;
      return json(response, 200, relaySecrets(store));
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

  // ONBOARD-2. `onboarding` is handed out so a SHUTDOWN can wait for an invite that is still going.
  // It is the first piece of work on this control plane that outlives the response that started it:
  // closing the store under it writes into a finalized statement, which reaches an operator as
  // "statement has been finalized" on stderr with nothing to act on, and costs the job its last
  // ledger row, which is the row that says where it got to.
  return { config, store, client, handle: guarded, refreshBoxPeers, boxPeers, reconcileFallbacks, marketplaceVerificationState, voice, onboarding: admin.onboarding };
}

export function createHttpServer(app) {
  return http.createServer((request, response) => { void app.handle(request, response); });
}

/**
 * The boot-time fallback reconcile, and what it says on the way past.
 *
 * Kept out of main() so the reconcile itself stays a plain function a test can call, and so a proxy
 * that is down produces one sentence on stdout rather than an unhandled rejection during startup.
 */
async function reconcileFallbacksAtBoot(app) {
  let answer;
  try { answer = await app.reconcileFallbacks(); }
  catch (error) {
    answer = { ok: false, why: String(error?.message ?? error).split("\n")[0], restored: [], kept: [], skipped: [] };
  }
  if (!answer.ok) {
    process.stdout.write(`vision fallbacks: not checked, ${answer.why}\n`);
    return;
  }
  for (const row of answer.restored) {
    process.stdout.write(`vision fallbacks: ${row.alias} had no route to ${row.target} and now has one\n`);
  }
  for (const row of answer.skipped) {
    process.stdout.write(`vision fallbacks: ${row.alias} still has no route to ${row.target}, ${row.why}\n`);
  }
  if (answer.restored.length === 0 && answer.skipped.length === 0) {
    process.stdout.write(`vision fallbacks: ${answer.kept.length} already in place, nothing written\n`);
  }
}

async function main() {
  const config = loadConfig();
  const problems = configProblems(config);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`control plane: ${problem}\n`);
    process.exit(1);
  }
  const app = createApp({
    config,
    boxPeers: createBoxPeers({
      lookup: containerAddressLookup(await import("node:dns/promises")),
      log: (line) => process.stdout.write(`${line}\n`),
    }),
  });
  // Every minute, and once at boot. A box that appears between two runs is trusted as a forwarder
  // for at most that long, and the set keeps its last value when the resolver cannot be asked.
  void app.refreshBoxPeers().catch(() => {});
  const peerTimer = setInterval(() => { void app.refreshBoxPeers().catch(() => {}); }, 60_000);
  peerTimer.unref?.();
  // PROVIDERS-1. Once at boot, and never on a timer: the vision fallback map is the one thing the
  // wave's second restart takes out of the config file, and a missing one is a fleet-wide
  // screenshot outage rather than a slow page. It reads first and writes only what is missing, so
  // on an ordinary boot it writes nothing and prints one line saying so.
  void reconcileFallbacksAtBoot(app);
  // VOICE-1, once at boot and never on a timer. A relay that was restarted mid-call leaves a claimed
  // row nobody will ever close, and an open row counts toward that workspace's day: unsettled, one
  // such row refuses that customer's voice for the rest of the day and inflates the Spend line for
  // ever. Rows younger than the session cap are left alone, because they may really be running.
  try {
    const settled = app.voice.reconcileOpen();
    if (settled.closed.length === 0) process.stdout.write(`voice: ${settled.why}\n`);
    else {
      process.stdout.write(`voice: settled ${settled.closed.length} session row(s) left open by a relay that went away (${settled.closed.map((one) => `${one.slug} ${one.wallSeconds}s`).join(", ")})\n`);
    }
  } catch (error) {
    process.stdout.write(`voice: the open-session sweep could not run (${String(error?.message ?? error).split("\n")[0]})\n`);
  }
  // MARKET-26. Weekly, and once at boot, on the peer timer's own pattern above: unref'd so it never
  // holds a shutdown open, and swallowing its own failures so a vendor's documentation site being
  // down is never this service being down. Off entirely when the operator says so, because the one
  // thing worse than a stale row is a control plane that makes outbound requests nobody asked for.
  if (String(process.env.CP_MARKETPLACE_VERIFY ?? "1") !== "0") {
    startVerificationTimer({
      store: app.store,
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } else {
    process.stdout.write("marketplace verification is off (CP_MARKETPLACE_VERIFY=0); rows will age into \"under review\" on their own\n");
  }
  const server = createHttpServer(app);
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`control plane listening on ${config.port}, tenants under ${config.tenantRoot}, release ${config.releaseRoot}\n`);
    if (!config.coolifyUrl || !config.coolifyApiKey) {
      process.stdout.write("Coolify is not configured, so tenants can be recorded and adopted but not created. Set COOLIFY_URL and COOLIFY_API_KEY.\n");
    }
  });
  // The store closes only after an invite still in flight has stopped writing to it. Bounded, because
  // a shutdown that waits on a ten minute box wait is a shutdown that never happens.
  const shutdown = () => {
    server.close(async () => {
      await Promise.race([
        Promise.resolve(app.onboarding?.settle?.()).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
      app.store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url || entry === fileURLToPath(import.meta.url)) await main();
