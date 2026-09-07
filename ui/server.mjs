// Local frontend host for the sand gateway.
//
// The gateway rejects any request carrying an Origin header (gateway-server.ts:23,
// "browser-origin gateway requests are not allowed"), so a browser cannot call it
// directly. This process is the shim: it serves the UI and relays to the gateway
// without an Origin, adding the Bearer token the browser must never hold.
//
// Reaching this process has always been equivalent to holding the gateway token, so it now has a
// login of its own. ui/auth.json (0600, never in git) holds a scrypt hash and a cookie signing
// secret; `node ui/set-password.mjs` writes it. With that file present every route except the
// login itself needs a session cookie or the gateway bearer. Without it the server behaves exactly
// as it always did on loopback, and refuses to start on any other address.
//
// Env:
//   SAND_HOST_GATEWAY_URL    gateway origin, no trailing slash (paths are concatenated)
//   SAND_HOST_GATEWAY_TOKEN  optional; sent as Bearer when set
//   SAND_UI_PORT             listen port, default 7777
//   SAND_UI_BIND_HOST        listen address, default 127.0.0.1; anything else needs ui/auth.json
//   SAND_UI_TRUSTED_PROXIES  comma list of CIDRs, or "any"; empty (the default) reads no
//                            forwarded header at all. See the block above TRUSTED_PROXIES.
//   SAND_UI_CLOUDFLARE_RANGES  comma list of CIDRs; empty (the default) never reads
//                            CF-Connecting-IP. See the block above CLOUDFLARE_RANGES.
//   TITAN_JOB_TOKEN          the job bus bearer for /v1; unset falls back to the file the
//                            console writes, and neither means /v1 answers 503. docs/JOB-BUS.md
//   SAND_HOST_RUNTIME_DIR    the ship's runtime directory (host-main.cjs plus the version file
//                            stage-host-bundle.mjs writes). Unset means /runtime answers 503 and
//                            the box simply never finds a host bundle to update to. SHIP-2.
//   SAND_UI_STATE_DIR        where the OPERATOR's writable files go: auth.json, endpoints.json,
//                            subscriptions.json, mail.json, mail-inbox.jsonl. Unset means beside
//                            this file, which is what every single-relay install has always done.
//                            Every other tenant's come out of its own state directory, which the
//                            registry names. ui/state-dir.mjs. TENANT-2, TENANT-5.
//   SAND_UI_AUTH_FILE        auth.json, overriding the state directory. Older than the line above.
//                            There is one auth.json for the console: it is the operator's door.
//   SAND_UI_ENDPOINTS_FILE   the OPERATOR's endpoints.json, overriding the state directory.
//   SAND_BOX_CONTAINER       the operator's own box container, for `docker exec`. Under Coolify it
//                            is titanbot-box-<service uuid>. A name that is not running is said in
//                            the log and never guessed at, because guessing on a shared host means
//                            reaching into a customer's box. TENANT-5.
//   CP_URL                   the control plane's public URL, and
//   CP_RELAY_TOKEN           the credential that opens GET /v1/relay/tenants and nothing else.
//                            Both or neither. With them the login page also takes a Titanium Bot
//                            account and this console serves every tenant the control plane knows.
//                            ui/tenant-login.mjs, ui/tenant-registry.mjs. TENANT-5.
//   SAND_UI_TENANTS_FILE     a JSON tenant list read INSTEAD of the control plane, the same kind of
//                            documented override SAND_UI_AUTH_FILE is. It is what makes the whole
//                            registry testable with no network and no control plane.
import { createServer } from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { adoptSubscription, forgetSubscription, resolveSubscription, scanSubscriptions } from "./subscriptions.mjs";
import { rewriteVncAsset } from "./vnc-bridge.mjs";
import {
  BOX_INCOMING_ENTRY, BOX_TARBALL_PATH, LATEST_VERSION_FILE, RUNTIME_ROUTE_PREFIX,
  composeHostBundleScript, formatLatestVersionFile, parseLatestVersionFile, parseRuntimeRequest,
} from "./host-bundle.mjs";
import {
  SESSION_LIFETIME_MS, clientAddress, containerAddressLookup, createBoxPeers, createLoginThrottle,
  createSession, edgeAddress,
  isLoopbackHost, isPrivateAddress, isSecureRequest, parseCookies, parseTrustedProxies, readAuthFile,
  readSession, safeEqual, safeNextPath, serializeCookie, sourceAddress, verifyPassword,
} from "./auth.mjs";
import {
  createRateLimiter, jobBusProfileDir, jobBusTokenFile, jobCreateArgs, jobSubmitterId, jobTokenInDir,
  newJobToken, resolveJobToken, routeJobBus,
} from "./job-bus-edge.mjs";
import {
  MAIL_BODY_LIMIT, MAIL_LEDGER_FILE, MAIL_SETTINGS_FILE, createMailEdge, domainOf, readMailSettings,
  svixHeaders, toAddressList, verifySvixSignature,
} from "./mail-edge.mjs";
import { stateDir, stateFile } from "./state-dir.mjs";
import { createLoginLedger, filterAttempts } from "./login-ledger.mjs";
import { readBoxHealth } from "./box-health.mjs";
import { accountSignIn, relayConfig, ssoVerdict } from "./tenant-login.mjs";
import {
  NOT_AVAILABLE_SENTENCE, OPERATOR_SLUG, createTenantRegistry, dockerNameReader, operatorEntry,
  tenantFile,
} from "./tenant-registry.mjs";
import { NOT_AVAILABLE, createDockerProbe, notAvailable } from "./docker-edge.mjs";
import { chmod, chown, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";

// Which model answers is an OPERATOR decision, not a rebuild. The host resolves it from
// process.env first and /home/box/sand-data/box-secrets.json second, and it re-reads that file
// with readFileSync on every single request -- so writing it takes effect on the next message,
// with no restart and no container recreate. The gateway's own setBoxSecrets refuses
// SAND_-prefixed names, which is why this writes the file directly instead of going through it.
const SECRETS_PATH = "/home/box/sand-data/box-secrets.json";
// This directory, which is where the relay's writable files went before there was more than one
// relay on a machine. SAND_UI_STATE_DIR moves them; see ui/state-dir.mjs and STATE_DIR below.
const HERE = path.dirname(new URL(import.meta.url).pathname);
// The OPERATOR's saved endpoint list. SAND_UI_ENDPOINTS_FILE wins, then the state directory, then
// here. Every other tenant's endpoints.json comes out of its own state directory and is resolved
// per request, because one console now serves all of them: see contextOf below.
const ENDPOINTS_OVERRIDE = process.env.SAND_UI_ENDPOINTS_FILE?.trim() || "";
const PROVIDER_KEYS = ["SAND_OPENAI_COMPATIBLE_BASE_URL", "SAND_OPENAI_COMPATIBLE_MODEL",
  "SAND_OPENAI_COMPATIBLE_API_KEY"];

const dockerOut = (args) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 8 << 20 }, (err, out) => resolve(err != null && !out ? null : out)));

// TENANT-2. A customer's instance is rendered without /var/run/docker.sock, so every `docker exec`
// below reaches nothing. One probe decides, asked once at boot and remembered, and the routes that
// need it say so in plain words instead of answering 200 with a null in every field. See
// ui/docker-edge.mjs for why an honest refusal beats the silent version.
const dockerAvailable = createDockerProbe({ execFile });
// The one refusal shape. 409 rather than 503: nothing is temporarily down, this console simply
// does not carry the feature here, and a retry will not change that. Used for a relay with no
// docker and, under TENANT-5, for the operator-only surfaces a customer's session reaches.
const refuseWithoutDocker = (res, detail) => {
  res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
  return res.end(JSON.stringify(notAvailable(detail)));
};

// TENANT-5 DELETED THE LABEL FALLBACK, and this comment is the reason it is not coming back.
//
// The relay used to answer "which container is the box" with `docker ps --filter
// label=com.titanbot.role=box`, taking the first match, whenever the configured name did not
// resolve. On a machine with one box that was a convenience. On a machine with N customers it
// resolves to an ARBITRARY customer's container, and every `docker exec` this file makes -- the
// model picker writing box-secrets.json, the connector editor writing connectors.json in
// plaintext, the desktop buttons -- would land in somebody else's box. There is no version of that
// which is safe to keep, including a per-tenant label, because a label is a string somebody
// eventually mistypes.
//
// So a box name is now VERIFIED and never guessed: ui/tenant-registry.mjs asks `docker ps` once per
// refresh for the names that exist, and a tenant whose box is not among them answers "That
// workspace is not available right now." rather than reaching into a neighbour. The operator's own
// name comes from SAND_BOX_CONTAINER and a name that is not running is a loud line in the log.

const readSecrets = async (t) => {
  const raw = await dockerOut(["exec", t.box, "cat", SECRETS_PATH]);
  try { return JSON.parse(raw).secrets ?? {}; } catch { return {}; }
};
// Merge, never replace: this file is also where the operator's real secrets live.
async function writeSecrets(t, next) {
  const body = JSON.stringify({ version: 1, secrets: next });
  return new Promise((resolve, reject) => {
    const child = execFile("docker", ["exec", "-i", t.box, "sh", "-c", `cat > ${SECRETS_PATH}`],
      (err) => (err ? reject(err) : resolve()));
    child.stdin.end(body);
  });
}
const CONNECTORS_PATH = "/home/box/sand-data/connectors.json";

// The connector file lives in the box's sand-data, which is a docker VOLUME -- there is no path on
// the host to open it with. Read and write it through the box the same way the secrets file is
// handled, so adding a connector is an edit in the UI rather than a docker exec.
// null means "the box could not be read"; an empty or missing file is an empty map. The two used to
// look the same, and the dashboard's connector sweep once rebuilt connectors.json from a hiccup.
const readConnectors = async (t) => {
  const raw = await dockerOut(["exec", t.box, "cat", CONNECTORS_PATH]);
  if (raw == null) return null;
  if (String(raw).trim().length === 0) return { mcpServers: {} };
  try { return JSON.parse(raw); } catch { return { mcpServers: {} }; }
};
async function writeConnectors(t, next) {
  const body = JSON.stringify(next, null, 2);
  return new Promise((resolve, reject) => {
    // 0600: this file carries connector tokens in plaintext.
    const child = execFile("docker", ["exec", "-i", t.box, "sh", "-c",
      `umask 077 && cat > ${CONNECTORS_PATH} && chmod 600 ${CONNECTORS_PATH}`],
      (err) => (err ? reject(err) : resolve()));
    child.stdin.end(body);
  });
}

const readCatalog = async (t) => {
  try { return JSON.parse(await readFile(t.endpointsFile, "utf8")); } catch { return { endpoints: [] }; }
};

// ---- where a tenant is allowed to point an endpoint -------------------------------------------
//
// On Jason's own instance the console is his and an endpoint may be anything he can reach,
// including the box next door and a model server on his own LAN. On a TENANT the console belongs
// to a customer, and this pair of surfaces -- save a base URL, then have the relay fetch it and
// report the status, the latency and the model list -- is a request generator inside the R750's
// private network with the answers handed back. Measured from a signed-in tenant session before
// this guard: the relay itself answered HTTP 401, the box gateway HTTP 404, the host address
// refused and an off-network address timed out. Those four answers apart are a port scan, and the
// apiKey field let the customer aim any bearer they liked at any host they liked.
//
// So a tenant's endpoint has to be somewhere on the public internet, over https. The sentences are
// the ones a business owner reads on the endpoint row, so they say what to do rather than what
// went wrong inside.
const TENANT_ENDPOINT = {
  shape: "That is not a web address. It should start with https:// and then the host name.",
  scheme: "Endpoints on this instance have to start with https://",
  unknown: "That host name could not be looked up, so nothing can be saved for it.",
  inside: "That address is inside this server's own network, so it cannot be used here.",
};

// null when the base URL is fine, otherwise the sentence to show. Always null off a tenant.
//
// The name is resolved here and the fetch resolves it again, so a name whose answer changes between
// the two calls is not stopped by this. What it does stop is the whole of the surface above:
// saving an address in the private ranges, and probing one. Closing the rest means pinning the
// resolved address into the connection, which node's fetch has no supported way to do.
async function tenantEndpointRefusal(t, baseUrl) {
  // Keyed off whose console this request belongs to, which is the correct reading of the guard and
  // always was: on one shared relay "is this process a tenant" is not a question with an answer.
  if (t.operator) return null;
  let url;
  try { url = new URL(String(baseUrl ?? "")); } catch { return TENANT_ENDPOINT.shape; }
  if (url.protocol !== "https:") return TENANT_ENDPOINT.scheme;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) return TENANT_ENDPOINT.shape;
  if (isPrivateAddress(host)) return TENANT_ENDPOINT.inside;
  let found;
  try { found = await lookup(host, { all: true }); }
  catch { return TENANT_ENDPOINT.unknown; }
  if (!Array.isArray(found) || found.length === 0) return TENANT_ENDPOINT.unknown;
  // Every answer, not the first: a name that resolves to one public address and one private one is
  // the ordinary shape of this attack.
  if (found.some((entry) => isPrivateAddress(entry.address))) return TENANT_ENDPOINT.inside;
  return null;
}

// A saved endpoint is only useful if it is actually up, so say so rather than implying it.
async function probe(t, endpoint) {
  const started = Date.now();
  const refusal = await tenantEndpointRefusal(t, endpoint?.baseUrl);
  if (refusal != null) return { reachable: false, detail: refusal, ms: Date.now() - started };
  try {
    const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/models`,
      { signal: AbortSignal.timeout(6000),
        headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {} });
    if (!res.ok) return { reachable: false, detail: `HTTP ${res.status}`, ms: Date.now() - started };
    const body = await res.json();
    const models = (body?.data ?? []).map((m) => m.id);
    return { reachable: true, ms: Date.now() - started, models,
      serves: endpoint.model ? models.includes(endpoint.model) : null };
  } catch (error) {
    return { reachable: false, ms: Date.now() - started,
      detail: error?.name === "TimeoutError" ? "timed out" : "no answer" };
  }
}

const OPERATOR_GATEWAY = (process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340").replace(/\/+$/, "");
// ponytail: the local-docker connector writes this token in plaintext (0600) next to
// its settings, so read it instead of making the operator export one. Env still wins.
function tokenFromProfile() {
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":").concat([
    path.join(process.cwd(), ".cache/firstmate-profile/sand-data"),
    path.join(process.env.HOME ?? "", "Library/Application Support/First Mate/sand-data"),
  ])) {
    if (dir.length === 0) continue;
    try { return JSON.parse(readFileSync(path.join(dir, "local-docker-vm.json"), "utf8")).token ?? ""; }
    catch {}
  }
  return "";
}
const OPERATOR_TOKEN = process.env.SAND_HOST_GATEWAY_TOKEN?.trim() || tokenFromProfile();
const PORT = Number.parseInt(process.env.SAND_UI_PORT ?? "7777", 10);

// ---- where this relay's own files live --------------------------------------------------------
// Empty on Jason's instance and on every developer Mac, which is the whole compatibility story:
// unset, every path below is the one it has always been. Set, the relay's writable files come out
// of a directory that belongs to this instance rather than out of the release directory every
// tenant on the server shares. ui/state-dir.mjs carries the rule and the ordering.
//
// Made once at boot rather than on the first write, because the first write is a person clicking
// Save in the console and a missing directory there is an unexplained 500 rather than a log line.
// A failure here is not fatal: the mount may already exist and be owned by somebody else, in which
// case mkdir fails and every write still works.
const STATE_DIR = stateDir();
if (STATE_DIR.length > 0) {
  try { mkdirSync(STATE_DIR, { recursive: true }); }
  catch (error) { console.log(`state could not make ${STATE_DIR}: ${error?.message ?? error}`); }
}

// ---- the failed sign-in ledger (ADMIN-1) -------------------------------------------------------
//
// Every refusal and every lockout at either door lands in <state dir>/login-attempts.jsonl, with the
// tried password kept only as a keyed hash so the panel can say "the same password forty times"
// versus "forty different passwords" without holding anybody's secret. ui/login-ledger.mjs carries
// the decision and the salt.
//
// It goes in the OPERATOR's state directory, not a tenant's, and that is not an oversight: a refused
// sign-in has no tenant yet. Somebody typing a wrong email at the login page belongs to nobody, and
// a per-tenant ledger would simply lose them.
const LOGIN_LEDGER = createLoginLedger({
  dir: STATE_DIR.length > 0 ? STATE_DIR : HERE,
  ownLikeParent,
  log: (line) => console.log(line),
});

// ---- one console, every tenant (TENANT-5) -----------------------------------------------------
//
// There is one relay, one console and one login page. Which BOX, which TOKEN, which files a request
// reaches is decided once per request from the session cookie, and everything below takes that
// answer as a parameter called `t` instead of reading a module-level constant.
//
// With no control plane configured the registry holds exactly one entry -- this one, built from the
// environment the relay already had -- every seam resolves to it, and a developer Mac or a
// single-box install behaves precisely as it did before. That is the whole compatibility story, and
// it is also why a control plane that is down cannot take the operator's own console with it.
const RELAY = relayConfig();
// Which addresses on this host belong to a customer's box. Refreshed on the registry's own cycle
// from the box container names it already carries, and consulted before any forwarded header is
// read: see createBoxPeers in ui/auth.mjs for the measurement that made this necessary.
const BOX_PEERS = createBoxPeers({
  lookup: containerAddressLookup({ lookup }),
  log: (line) => console.log(line),
});
const registry = createTenantRegistry({
  operator: operatorEntry({
    gateway: OPERATOR_GATEWAY,
    token: OPERATOR_TOKEN,
    stateDir: STATE_DIR,
    profileDir: jobBusProfileDir() ?? "",
  }),
  cpUrl: RELAY?.cpUrl ?? "",
  relayToken: RELAY?.relayToken ?? "",
  tenantsFile: process.env.SAND_UI_TENANTS_FILE?.trim() || "",
  dockerNames: dockerNameReader(execFile),
  boxPeers: BOX_PEERS,
  log: (line) => console.log(line),
});

// One context per tenant, rebuilt only when the registry entry behind it actually changed. The
// registry hands back the same entry object while nothing about a tenant moves, so this cache is
// keyed on identity and costs one Map lookup per request.
const contexts = new Map();

function buildContext(entry) {
  const file = (name) => tenantFile(entry, name, { here: HERE, stateFile });
  const gateway = entry.gateway.length > 0 ? entry.gateway : OPERATOR_GATEWAY;
  let boxHost = "";
  try { boxHost = new URL(gateway).hostname; } catch { boxHost = ""; }
  const jobTokenFile = entry.operator
    ? jobBusTokenFile()
    : (entry.profileDir.length > 0 ? path.join(entry.profileDir, "job-bus.json") : null);
  return {
    entry,
    slug: entry.slug,
    name: entry.name,
    operator: entry.operator === true,
    box: entry.box,
    gateway,
    boxHost,
    token: entry.token,
    stateDir: entry.stateDir,
    profileDir: entry.profileDir,
    file,
    // The operator's endpoints file keeps every override it ever had; a tenant's comes out of its
    // own state directory and nowhere else.
    endpointsFile: entry.operator && ENDPOINTS_OVERRIDE.length > 0 ? ENDPOINTS_OVERRIDE : file("endpoints.json"),
    mailSettingsFile: entry.operator ? MAIL_SETTINGS_FILE : file("mail.json"),
    mailLedgerFile: entry.operator ? MAIL_LEDGER_FILE : file("mail-inbox.jsonl"),
    jobTokenFile,
    // TITAN_JOB_TOKEN is a fact about this DEPLOYMENT, so it can only ever mean the operator. Read
    // for every tenant it would arm one environment value across every customer's box.
    jobToken: () => (entry.operator ? resolveJobToken() : jobTokenInDir(entry.profileDir)),
    // The single choke point every upstream call already went through, now per tenant.
    headers: (extra = {}) => ({ ...(entry.token.length > 0 ? { authorization: `Bearer ${entry.token}` } : {}), ...extra }),
    // A tenant's state directory is made by the provisioner, so it normally exists before the relay
    // ever hears of the tenant. Making it here as well means a first save is a saved file rather
    // than an unexplained 500 on the one click a customer just made.
    ensureDir: () => {
      const dir = entry.operator ? STATE_DIR : entry.stateDir;
      if (dir.length === 0) return;
      try { mkdirSync(dir, { recursive: true }); } catch { /* already there, or somebody else's */ }
    },
  };
}

// Which key verifies a sign-in for a workspace, and "" for one this console cannot serve. It goes
// through contextOf rather than straight to the registry on purpose: a workspace whose box is not
// running must meet the same plain sentence at the login as it does on every other route, rather
// than being signed in to a session that answers "not available" on its very first page.
const sessionKeyFor = (slug) => (contextOf(slug) == null ? "" : registry.sessionKeyOf(slug));

// The context for a slug, or null when this console cannot serve it: unknown to the registry, or
// known and pointing at a box that is not running.
function contextOf(slug) {
  const entry = registry.get(slug);
  if (entry == null) { registry.miss(slug); return null; }
  if (entry.reachable === false) return null;
  const found = contexts.get(entry.slug);
  if (found != null && found.entry === entry) return found;
  const built = buildContext(entry);
  contexts.set(entry.slug, built);
  return built;
}

function fail(res, status, message, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error: message }));
}

// ---- the login ------------------------------------------------------------------------------
// AUTH is read once at boot rather than per request. A password change is therefore a restart,
// which is what set-password.mjs prints, and it means a request path cannot be slowed down or
// broken by a half-written file.
// The path is overridable so a gate can stand up a relay with a password of its own without
// writing into the operator's tree: verify-job-bus.mjs has to prove the job bearer opens
// nothing but /v1, and on a relay with no password every route answers everyone alike, so
// the leg could only ever have measured the missing lock. Setting this is no weaker than the
// env that already carries the gateway token; the non-loopback refusal below still applies to
// whatever file it resolves to.
// Empty counts as unset, the same way SAND_UI_ENDPOINTS_FILE does. An empty value is what a compose
// file produces when a variable is declared and never given one, and reading that as "the auth file
// is the empty path" means a relay that comes up with no password at all.
const AUTH_FILE = process.env.SAND_UI_AUTH_FILE?.trim() || stateFile("auth.json", HERE);
const AUTH = readAuthFile(AUTH_FILE);
const SESSION_COOKIE = "gb_session";
const throttle = createLoginThrottle();

// Which peers may tell this process who its caller is. Empty by default, which is the loopback and
// tailnet shape: no header is read and the socket address is the client. Inside Coolify the socket
// address is Traefik's on a docker network, one address for the entire internet, so the lockout
// would be a single bucket every visitor shares and a stranger's five typos would lock Jason out.
// Naming the docker ranges here moves the lockout back onto the real caller. It is deliberately
// not the default: a relay reachable from anywhere with this set to "any" would let a guesser mint
// a fresh five attempts per forged header.
const TRUSTED_PROXIES = parseTrustedProxies(process.env.SAND_UI_TRUSTED_PROXIES);

// Which of those forwarded addresses may in turn hand over a CF-Connecting-IP.
//
// Traefik rewrites the X-Forwarded-* family from what it actually saw, so the address it reports
// is not something a caller can choose. CF-Connecting-IP is not in that family and arrives
// untouched, so it is only worth anything when the request really did come through Cloudflare --
// and nothing forces it to. The origin address of a proxied name is public, and a request sent
// straight there carries whatever CF-Connecting-IP its sender felt like writing. Naming
// Cloudflare's published ranges here is what separates the two: header believed on the path
// Cloudflare owns, ignored on the path anyone can reach. Empty, the default, never reads it.
const CLOUDFLARE_RANGES = parseTrustedProxies(process.env.SAND_UI_CLOUDFLARE_RANGES);
// A customer's box shares a network with this relay, so its address is inside the ranges above.
// It is still not a proxy: nothing it writes in X-Forwarded-For or X-Forwarded-Proto is read, and
// the address it is counted as is the socket's. Without this, one customer's agents could mint a
// fresh lockout bucket per password guess, or spend the operator's five and hold him out of his
// own console and the job bus.
const peerIsBox = (req) => BOX_PEERS.has(sourceAddress(req));
const clientOf = (req) => (peerIsBox(req) ? sourceAddress(req) : clientAddress(req, TRUSTED_PROXIES, CLOUDFLARE_RANGES));
const edgeOf = (req) => (peerIsBox(req) ? sourceAddress(req) : edgeAddress(req, TRUSTED_PROXIES));
const secureOf = (req) => (peerIsBox(req) ? req?.socket?.encrypted === true : isSecureRequest(req, TRUSTED_PROXIES));
// One year, and only ever on a response that really did arrive over TLS. A browser that sees this
// refuses plain HTTP to the name for that long, which is the point on a public domain and is also
// why secureOf ignores a forwarded scheme from an untrusted peer: the header would otherwise be a
// way for a stranger to break someone else's access to a host they do not own.
const HSTS = "max-age=31536000; includeSubDomains";

// The bearer stays a way in because holding it is already full access: every /api call this
// process forwards carries it. Requiring a session on top would only break the gates and the
// scripts without taking any capability away from someone who has the token.
function bearerMatches(req) {
  const header = String(req.headers.authorization ?? "");
  // Exactly one token opens this door, and it is the OPERATOR's. A customer's gateway token is a
  // credential for their own box and must never be a way past the console's login.
  const token = registry.operator().token;
  return token.length > 0 && header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), token);
}

// The live session's payload, or null. It is the whole payload rather than a boolean because the
// tenant claim lives in it. TENANT-5.
function sessionPayload(req) {
  if (AUTH == null) return null;
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return raw == null ? null : readSession(raw, AUTH.cookieSecret);
}
const hasSession = (req) => sessionPayload(req) != null;

// Which tenant this request is for, or null when it is not signed in at all.
//
// With no password configured the console is a loopback developer console and every request is the
// operator's, which is the shape it has always had. The gateway bearer is the operator's too. A
// cookie minted before this shipped carries no tenant claim and reads back as the operator, which
// is what keeps a session alive across the deploy.
function tenantOf(req) {
  if (AUTH == null) return OPERATOR_SLUG;
  if (bearerMatches(req)) return OPERATOR_SLUG;
  const payload = sessionPayload(req);
  if (payload == null) return null;
  const claimed = typeof payload.tenant === "string" ? payload.tenant.trim() : "";
  return claimed.length > 0 ? claimed : OPERATOR_SLUG;
}
function isAuthorized(req) {
  return tenantOf(req) != null;
}

// A bearer on a page request also mints a session, so a browser handed the token as a header can
// go on to do the things a browser does: an EventSource carries no custom header, an iframe
// carries none either, and a page opened with the bearer would otherwise paint and then be
// refused on its own subresources. Holding the token is already full access -- every /api call
// this process forwards carries it -- so the cookie adds no capability, it only puts the access
// somewhere the browser will keep sending. /api is excluded because a script calling the API is
// not a session and does not want one.
function mintSessionFromBearer(req, res, url) {
  if (AUTH == null) return;
  if (url.pathname.startsWith("/api/")) return;
  if (!bearerMatches(req) || hasSession(req)) return;
  res.setHeader("set-cookie", serializeCookie(SESSION_COOKIE, createSession(AUTH.cookieSecret, { tenant: OPERATOR_SLUG }),
    { maxAgeSeconds: SESSION_LIFETIME_MS / 1000, secure: secureOf(req) }));
}

// The console bounces to /login on a 401 only when it carries this header. Without a marker the
// page cannot tell OUR refusal from the gateway's, and a gateway 401 (a stale bearer, a box
// recreated under a live relay) would send an operator who typed the right password straight back
// to the login, forever, over a fault no password can fix.
const RELAY_AUTH_HEADER = { "x-relay-auth": "required" };

// A browser asking for a page gets sent to the login; anything else gets JSON it can act on. The
// Accept header is the only honest way to tell those apart, because /api and a stylesheet and a
// document all arrive as plain GETs.
function denyUnauthenticated(req, res, url) {
  const wantsHtml = req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
  if (!wantsHtml) return fail(res, 401, "not signed in", RELAY_AUTH_HEADER);
  res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" });
  return res.end();
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One form, one button, the error inline, and every byte of it in this response. Serving no
// separate asset is not just tidiness: an asset path exempted from the session check would be a
// hole in the thing this page exists to close.
//
// On a tenant instance the form grows an email field above the password, and that is the only
// difference: still one form and still one button. Filling the email in means "this is my Titanium
// Bot account"; leaving it empty means "this is the instance password", which is the door the
// operator has always used and the one that still works when the control plane does not answer.
// Two separate forms would have made the customer choose between two words for the same thing
// before they had any way of knowing which one they hold.
function loginPage({ error = "", next = "/", tenant = false } = {}) {
  return `<!doctype html>
<html lang="en" data-theme="dusk">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in - Machine Room</title>
<link rel="icon" href="data:," />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(1200px 700px at 20% -10%, #23323a 0%, #0f151a 60%) #0f151a;
    color: rgba(255,255,255,0.94);
    font: 400 14px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  form { width: min(360px, calc(100vw - 48px)); padding: 28px; border-radius: 20px;
    background: rgba(17,25,30,0.82); border: 1px solid rgba(255,255,255,0.1);
    box-shadow: 0 30px 90px rgba(4,10,13,0.5), inset 0 1px 0 rgba(255,255,255,0.12); }
  .lights { display: flex; gap: 6px; margin-bottom: 18px; }
  .lights span { width: 10px; height: 10px; border-radius: 999px; background: rgba(255,255,255,0.18); }
  h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600; letter-spacing: 0.01em; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: rgba(233,239,239,0.46); }
  label { display: block; font-size: 12px; color: rgba(233,239,239,0.68); margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.18); background: rgba(31,42,47,0.46);
    color: inherit; font: inherit; }
  input:focus { outline: none; border-color: #8b69ea; box-shadow: 0 0 0 3px rgba(139,105,234,0.28); }
  button { margin-top: 16px; width: 100%; padding: 10px 12px; border-radius: 10px; border: 0;
    background: #8b69ea; color: #fffaf2; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #9a7cf0; }
  .error { margin-top: 14px; padding: 9px 11px; border-radius: 10px; font-size: 13px;
    background: rgba(255,111,114,0.14); border: 1px solid rgba(255,111,114,0.38); color: #ffb3b4; }
  p.also { margin: 8px 0 0; font-size: 12px; color: rgba(233,239,239,0.46); }
  label.second { margin-top: 14px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <div class="lights" aria-hidden="true"><span></span><span></span><span></span></div>
  <h1>Machine Room</h1>
  <p class="sub">${tenant ? "Sign in with your Titanium Bot account" : "This console drives the box. Sign in to reach it."}</p>
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  ${tenant ? `<label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" autofocus />
  <label class="second" for="password">Password</label>` : `<label for="password">Password</label>`}
  <input id="password" name="password" type="password" autocomplete="current-password"${tenant ? "" : " autofocus"} required />
  ${tenant ? `<p class="also">or the instance password</p>` : ""}
  <button type="submit">Sign in</button>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
</form>
</body>
</html>
`;
}

// Every render of the page goes through here, so which form this instance draws is decided in one
// place. A page that offered the email field on one route and not on another would be a bug nobody
// notices until a customer meets the wrong one after a mistyped password.
const renderLoginPage = (options = {}) => loginPage({ tenant: RELAY != null, ...options });

function sendLoginPage(res, status, options) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  return res.end(renderLoginPage(options));
}

// A password and a next path. Anything larger than this is not a login, and /login is the one
// route an unauthenticated caller may POST to on a published relay, so the body is capped rather
// than buffered whole.
const LOGIN_BODY_LIMIT = 8 * 1024;

// Answering without having read the body leaves the client still uploading, so the answer has to
// take the connection down with it. Ending the response first and destroying the request in its
// callback is the difference between the caller seeing a status and seeing a reset socket.

// Files this process writes into bind-mounted directories (the profile, the ui directory) must end
// up owned by the directory's owner, not by root: the relay runs as root inside its container, and a
// root-owned job-bus.json or subscriptions.json was unreadable to the operator's own backup on the
// R750 (2026-09-06). A chown that cannot happen (same user, or not root) is not an error.
async function ownLikeParent(file) {
  try { const parent = await stat(path.dirname(file)); await chown(file, parent.uid, parent.gid); } catch {}
}
function endAndClose(req, res, status, headers, payload) {
  res.writeHead(status, { "cache-control": "no-store", connection: "close", ...headers });
  return res.end(payload, () => req.destroy());
}

// Behind a proxy that is still forwarding the body, destroying the request turns our 413 into the
// proxy's 502: the deploy gate's 64 KB login probe came back 413 and 502 on alternate runs through
// Cloudflare on 2026-09-06. A body the size of a form is drained (never buffered) and the
// connection closed normally; only a body past DRAIN_LIMIT is still cut off, because draining that
// is the attack the cap exists for.
const DRAIN_LIMIT = 256 * 1024;
async function drainThenEnd(req, res, status, headers, payload) {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > DRAIN_LIMIT) return endAndClose(req, res, status, headers, payload);
  let seen = 0;
  const drained = await new Promise((resolve) => {
    req.on("data", (chunk) => { seen += chunk.length; if (seen > DRAIN_LIMIT) { req.pause(); resolve(false); } });
    req.on("end", () => resolve(true));
    req.on("error", () => resolve(false));
    req.resume();
  });
  if (!drained) return endAndClose(req, res, status, headers, payload);
  res.writeHead(status, { "cache-control": "no-store", connection: "close", ...headers });
  return res.end(payload);
}

// One attempt written to <state dir>/login-attempts.jsonl. Never awaited by a route: the ledger is
// a record of the door, not the door, and a slow disk must not hold a sign-in open. Never throws
// either -- createLoginLedger swallows its own write errors and logs them.
//
// The password reaches this and goes no further: what lands on disk is the keyed hash, and a
// successful sign-in gets not even that.
const noteLoginAttempt = (req, fields) => {
  void LOGIN_LEDGER.record({
    ip: clientOf(req),
    userAgent: req.headers["user-agent"] ?? "",
    ...fields,
  });
};

async function handleLogin(req, res, url) {
  const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
  const key = clientOf(req);

  // Before the body, not after: a locked out address must not be able to make this process hold
  // anything in memory on its behalf.
  const waitMs = throttle.retryAfterMs(key);
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    console.log(`login rate limited for ${key}, ${seconds}s left`);
    // A lockout row carries no hash and no email, and that is honest rather than lazy: this branch
    // answers BEFORE the body is read, so there is no password here and no address either. What the
    // panel learns from it is the one thing that matters, which is that this address kept knocking
    // after it had been told to stop.
    noteLoginAttempt(req, { door: "instance", outcome: "locked" });
    const stalled = safeNextPath(url.searchParams.get("next"));
    const headers = { "retry-after": String(seconds) };
    if (!wantsHtml) return endAndClose(req, res, 429, { ...headers, "content-type": "application/json" }, JSON.stringify({ error: `too many attempts; wait ${seconds}s` }));
    return endAndClose(req, res, 429, { ...headers, "content-type": "text/html; charset=utf-8" },
      renderLoginPage({ error: `Too many attempts. Wait ${seconds} seconds and try again.`, next: stalled }));
  }

  let body;
  try { body = await readBody(req, LOGIN_BODY_LIMIT); }
  catch (error) {
    if (error?.code !== "BODY_TOO_LARGE") throw error;
    // It counts as a failure: a flood of oversized bodies is an attack on this port, and the
    // lockout is the only thing that makes any of it slow.
    throttle.recordFailure(key);
    // Recorded as the instance door because that is the door the routing below would have sent it
    // to: no body means no email, and an empty email is the instance door. No hash, because there
    // is no password in a body this size, only a payload.
    noteLoginAttempt(req, { door: "instance", outcome: "refused" });
    if (!wantsHtml) return drainThenEnd(req, res, 413, { "content-type": "application/json" }, JSON.stringify({ error: "that is not a password" }));
    return drainThenEnd(req, res, 413, { "content-type": "text/html; charset=utf-8" },
      renderLoginPage({ error: "That request was too large to be a password." }));
  }
  const isJson = String(req.headers["content-type"] ?? "").includes("application/json");
  let fields = {};
  if (isJson) { try { fields = JSON.parse(body || "{}") ?? {}; } catch { fields = {}; } }
  else { fields = Object.fromEntries(new URLSearchParams(body)); }
  const next = safeNextPath(fields.next ?? url.searchParams.get("next") ?? "/");

  // An address in the email field means this is an account sign-in, so the control plane decides
  // and the instance password is not consulted at all. Empty means the door that was always here.
  const email = String(fields.email ?? "").trim();
  if (RELAY != null && email.length > 0) {
    return await handleAccountLogin(req, res, { email, password: String(fields.password ?? ""), next, key, wantsHtml });
  }

  if (!verifyPassword(String(fields.password ?? ""), AUTH.password)) {
    throttle.recordFailure(key);
    noteLoginAttempt(req, { door: "instance", outcome: "refused", password: String(fields.password ?? "") });
    // The address, never the password, and the address is the client's rather than the proxy's
    // wherever a trusted proxy said so. On a public console this line is the only record that
    // anyone is knocking.
    const edge = edgeOf(req);
    console.log(`login refused from ${key}${edge === key ? "" : ` (via ${edge})`}`);
    // One message for a wrong password and for an empty one: naming which is wrong tells a
    // guesser something, and tells the operator nothing they cannot see on their own screen.
    if (!wantsHtml) return fail(res, 401, "that password did not work");
    return sendLoginPage(res, 401, { error: "That password did not work.", next });
  }

  throttle.recordSuccess(key);
  noteLoginAttempt(req, { door: "instance", outcome: "ok", tenant: OPERATOR_SLUG });
  // The instance password is the operator's door and means the operator's workspace. TENANT-5.
  const cookie = serializeCookie(SESSION_COOKIE, createSession(AUTH.cookieSecret, { tenant: OPERATOR_SLUG }),
    { maxAgeSeconds: SESSION_LIFETIME_MS / 1000, secure: secureOf(req) });
  res.writeHead(302, { location: next, "set-cookie": cookie, "cache-control": "no-store" });
  return res.end();
}

// ---- an account sign-in, once the control plane has answered -----------------------------------
//
// Mints the relay's own ordinary session cookie from a verified control plane token. The cookie is
// the same one the instance password mints, signed with the same cookie secret, and the console
// cannot tell the two apart: that is the point, and it is why nothing else in this file had to
// learn about accounts.
//
// The lifetime is the token's remaining life, capped at the relay's own twelve hours. Whichever
// expires first should end the session, and taking the smaller of the two is how both of those are
// true at once without a second clock to keep.
function mintAccountSession(req, res, payload, location) {
  const now = Date.now();
  const lifetimeMs = Math.min(Math.max(0, Number(payload.exp) - now), SESSION_LIFETIME_MS);
  // The tenant claim comes off the VERIFIED token, never off the form. It is what every seam in
  // this file resolves a box, a token and a state directory from for the rest of this session.
  const cookie = serializeCookie(SESSION_COOKIE,
    createSession(AUTH.cookieSecret, { nowMs: now, lifetimeMs, tenant: String(payload.tenant ?? "") }),
    { maxAgeSeconds: lifetimeMs / 1000, secure: secureOf(req) });
  res.writeHead(302, { location, "set-cookie": cookie, "cache-control": "no-store" });
  return res.end();
}

// The account door. Every answer here is a plain sentence a business owner can act on, because the
// person meeting them owns a company and not this software.
async function handleAccountLogin(req, res, { email, password, next, key, wantsHtml }) {
  const verdict = await accountSignIn({
    config: RELAY, email, password, client: key, keyOf: sessionKeyFor,
  });
  // ADMIN-1. The email as typed, lowercased, because "who is being guessed at" is the question the
  // operator is asking and an address that is not an address is still an answer to it. The tenant is
  // left empty on anything but a success: this relay does not know which workspace an unknown email
  // belongs to, and the control plane fills that in when it merges the two ledgers.
  const note = (outcome, tenant = "") => noteLoginAttempt(req, { door: "account", email, outcome, tenant, password });
  const say = (status, page, json) => {
    if (!wantsHtml) return fail(res, status, json);
    return sendLoginPage(res, status, { error: page, next });
  };

  if (verdict.kind === "session") {
    throttle.recordSuccess(key);
    console.log(`login by account on ${verdict.payload.tenant} from ${key}`);
    note("ok", String(verdict.payload.tenant ?? ""));
    return mintAccountSession(req, res, verdict.payload, next);
  }

  // A right password for a workspace this console cannot serve right now: one that is still
  // provisioning, or one the control plane has created since the last registry read. Their
  // credential was correct, so this is not a refusal, and there is no other host to send them to
  // any more -- console.titanium.bot is everybody's front door. It is the same sentence a session
  // for an unknown workspace gets, because it is the same fact.
  //
  // The lockout counter is left exactly as it was, neither charged nor cleared, and that is the
  // whole point of this comment. Clearing it here would hand every account holder a reset button
  // for the instance password door: four wrong passwords, one sign-in of their own, four more,
  // forever, and the five-try lockout never fires. Charging it would lock a customer out of a
  // console over a workspace that is merely still being built.
  if (verdict.kind === "unknown") {
    console.log(`login for ${verdict.slug} from ${key}, which is not a workspace this console serves`);
    return say(503, NOT_AVAILABLE_SENTENCE, "that workspace is not available right now");
  }

  if (verdict.kind === "refused") {
    throttle.recordFailure(key);
    // The address of the caller, never the address that was typed and never the password.
    const edge = edgeOf(req);
    console.log(`account login refused from ${key}${edge === key ? "" : ` (via ${edge})`}`);
    note("refused");
    return say(401, "That email or password is not right.", "that email or password is not right");
  }

  if (verdict.kind === "busy") {
    // The control plane's own lockout said no. It is a lockout wherever it was decided, and the
    // panel should show it as one rather than as a refusal that never reached a password check.
    note("locked");
    return say(429, "Too many sign-in attempts. Wait a moment and try again.", "too many attempts");
  }

  // Something the control plane wanted said in its own words, which is where "your account is set
  // up but its instance is not registered yet" comes from.
  if (verdict.kind === "message") return say(409, verdict.text, verdict.text);

  // No answer at all. Not a failed attempt, so it does not count toward the lockout: locking the
  // operator out because a different service is down would take away the very door this sentence
  // is pointing at.
  console.log(`account login could not reach ${RELAY.cpUrl} (${verdict.detail ?? "no answer"})`);
  return say(503, "Titanium Bot sign-in is not answering right now. The instance password still works.",
    "titanium bot sign-in is not answering right now; the instance password still works");
}

// A sign-in link from another instance's login page: /login?sso=<token>. The token is verified with
// this relay's own key, and its tenant claim is checked against this relay's own name, before
// anything is minted. Nothing about the link is trusted, including that it came from us.
function handleSso(req, res, token) {
  const verdict = ssoVerdict({ token, keyOf: sessionKeyFor });
  if (verdict.kind === "session") {
    console.log(`login by sign-in link on ${verdict.payload.tenant} from ${clientOf(req)}`);
    return mintAccountSession(req, res, verdict.payload, "/");
  }
  if (verdict.kind === "unknown") {
    console.log(`sign-in link for ${verdict.slug} from ${clientOf(req)}, which is not a workspace this console serves`);
    return sendLoginPage(res, 503, { error: NOT_AVAILABLE_SENTENCE });
  }
  console.log(`sign-in link refused from ${clientOf(req)} (${verdict.detail ?? "not valid"})`);
  return sendLoginPage(res, 401, { error: "That sign-in link is not valid here." });
}

// ---- what the control plane asks this relay for (ADMIN-1) --------------------------------------
//
// Two GETs, both read-only, both behind CP_RELAY_TOKEN, and neither reachable with a console
// session or with a job bus bearer. They exist because the super admin console lives on the control
// plane and two of its facts do not: the failed sign-in ledger is written at THIS door, and box
// health needs the docker socket, which the control plane's container deliberately does not have.
//
// An install with no control plane serves neither. There is nothing to ask and nobody to ask it, and
// answering 404 rather than 401 is the truthful shape: this route does not exist here.
async function handleRelayAdmin(req, res, url) {
  const expected = String(RELAY?.relayToken ?? "");
  if (expected.length === 0) return fail(res, 404, "not found");
  if (req.method !== "GET") return fail(res, 405, "GET");
  const header = String(req.headers.authorization ?? "");
  const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  // Constant time over the value and over the length, the same compare the registry uses on a
  // gateway token. A wrong credential learns nothing from how long the refusal took.
  if (presented.length === 0 || !safeEqual(presented, expected)) return fail(res, 401, "unauthorized");

  if (url.pathname === "/admin/login-attempts") {
    const rows = filterAttempts(await LOGIN_LEDGER.rows(), {
      since: url.searchParams.get("since"),
      outcome: url.searchParams.get("outcome") ?? "",
      limit: Number(url.searchParams.get("limit") ?? 500),
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    // The salt is not in here and never will be. What leaves this process is the keyed hash, which
    // is what lets the panel count distinct passwords and nothing else.
    return res.end(JSON.stringify({ source: "relay", measuredAt: new Date().toISOString(), rows }));
  }

  if (url.pathname === "/admin/boxes") {
    const report = await readBoxHealth(registry.all());
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(report));
  }

  return fail(res, 404, "not found");
}

function handleLogout(req, res) {
  // Max-Age=0 with the same attributes is the only reliable way to delete a cookie; a browser
  // matches on name, path and domain, so a Set-Cookie that differs in Path clears nothing.
  const cookie = serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: secureOf(req) });
  if (String(req.headers.accept ?? "").includes("text/html")) {
    res.writeHead(302, { location: "/login", "set-cookie": cookie, "cache-control": "no-store" });
    return res.end();
  }
  res.writeHead(200, { "content-type": "application/json", "set-cookie": cookie, "cache-control": "no-store" });
  return res.end(JSON.stringify({ loggedOut: true }));
}

// maxBytes defaults to no limit because the authenticated routes carry connector files and prompt
// text and always have. The limit is for the unauthenticated one.
async function readBody(req, maxBytes = Infinity) {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  const tooLarge = () => { req.pause(); return Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }); };
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const chunks = [];
  let size = 0;
  // Events rather than for-await: leaving a for-await early destroys the stream underneath it,
  // which is the socket reset the comment on drainThenEnd describes. A chunked body declares no
  // length, so the count is kept while it arrives; pausing leaves the socket alive to answer on.
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(tooLarge()); return; }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf8");
}

// POST /api/<method> -> that tenant's gateway. The browser never sees the token.
async function relayCommand(t, req, res, method) {
  const body = await readBody(req);
  const upstream = await fetch(`${t.gateway}/api/${method}`, {
    method: "POST",
    headers: t.headers({ "content-type": "application/json" }),
    body: body.length > 0 ? body : "{}",
  });
  const text = await upstream.text();
  // The gateway refusing the relay's own bearer is not the operator being signed out, and passing
  // its 401 through wearing our status code is how a correct password ends in a login loop. It is
  // a broken deployment, so it answers as one, with the thing to go and look at.
  //
  // 401 only. The gateway spends 401 on the bearer (gateway-server.ts: "unauthorized") and 403 on
  // a refusal the command itself made -- resetOnboarding without SAND_TEST_HOOKS=1, a browser
  // Origin, an untrusted Host, a cross-site avatar. Folding those into the stale-token sentence
  // sent whoever read it to re-mint a token that was never the problem, and hid the one sentence
  // that says what to do instead. A command's own refusal is its answer to give.
  if (upstream.status === 401) {
    return fail(res, 502, `the gateway refused this relay's token (HTTP ${upstream.status}): ` +
      `SAND_HOST_GATEWAY_TOKEN is stale or the box was recreated. Signing in again will not help.`);
  }
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  res.end(text);
}

// GET /events -> gateway SSE, piped through unchanged so reconnects behave normally.
async function relayEvents(t, req, res, search) {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const upstream = await fetch(`${t.gateway}/events${search}`, { headers: t.headers(), signal: controller.signal });
  if (!upstream.ok || upstream.body == null) return fail(res, upstream.status, `gateway events unavailable (${upstream.status})`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch { /* client went away, or the gateway did */ }
  res.end();
}

async function relayAvatar(t, req, res, pathname) {
  const upstream = await fetch(`${t.gateway}${pathname}`, { headers: t.headers() });
  if (!upstream.ok) return fail(res, upstream.status, "no avatar");
  const bytes = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "image/png", "cache-control": "no-store", "content-length": bytes.byteLength });
  res.end(bytes);
}

// ---- the job bus edge -----------------------------------------------------------------------
// /v1 is the Chief of Staff's surface and nothing else. It carries its own bearer, it never
// accepts a console session, and it reaches exactly the five jobBus* commands -- so the token CoS
// holds buys no shell, no desktop and no /api. That is the whole point of a separate bearer, and
// it is why this block sits above the console's login rather than inside it. docs/JOB-BUS.md §3.
const JOB_BUS_BODY_LIMIT = 64 * 1024;
const JOB_BUS_REALM = { "www-authenticate": 'Bearer realm="titan-job-bus"' };
const jobBusLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
// One bucket for the whole bus, on top of the per-client one. Without it a caller with a range of
// addresses gets 120 a minute per address and the box wears the sum. One fixed key, so the map
// never grows. docs/JOB-BUS.md 10.6.
const jobBusGlobalLimiter = createRateLimiter({ limit: 600, windowMs: 60_000, capacity: 1 });
const JOB_BUS_GLOBAL = "bus";

async function jobBusCall(t, command, args) {
  const upstream = await fetch(`${t.gateway}/api/${command}`, {
    method: "POST",
    headers: t.headers({ "content-type": "application/json" }),
    body: JSON.stringify(args ?? {}),
  });
  return {
    status: upstream.status,
    text: await upstream.text(),
    type: upstream.headers.get("content-type") ?? "application/json",
  };
}

// The gateway's own status and body go through -- 400, 403, 404, 409 and 503 are its answers to
// give, and CoS acts on their detail. Its 401 is the exception, the same one relayCommand makes:
// that is this relay's bearer being stale, not the caller's, and passing it on would tell CoS to
// re-auth against a fault no token of its own can fix.
function answerUpstream(res, upstream, status = upstream.status, text = upstream.text) {
  if (upstream.status === 401) {
    return fail(res, 502, `the gateway refused this relay's token (HTTP ${upstream.status}): `
      + `SAND_HOST_GATEWAY_TOKEN is stale or the box was recreated.`);
  }
  res.writeHead(status, { "content-type": upstream.type, "cache-control": "no-store" });
  return res.end(text);
}

async function handleJobBus(req, res, url) {
  const client = clientOf(req);

  // The same lockout the login uses, keyed the same way, because a bearer is guessed exactly the
  // way a password is and there is no reason the bus should be the cheaper of the two doors to
  // knock on. Checked before the body and before the token compare: an address already locked out
  // must not be able to make this process do work on its behalf.
  const lockedMs = throttle.retryAfterMs(client);
  if (lockedMs > 0) {
    const seconds = Math.ceil(lockedMs / 1000);
    return fail(res, 429, `too many attempts; wait ${seconds}s`, { "retry-after": String(seconds) });
  }

  const header = String(req.headers.authorization ?? "");
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // TENANT-5. /v1 arrives with a bearer and no session, so the bearer is what says which tenant
  // this is: every tenant's own bus token is compared, with no early break, and the one that
  // matches names the box the jobs go to. A tenant's Chief of Staff therefore reaches that tenant's
  // bus and no other, using the token that tenant's own console generated.
  const matched = registry.matchBy(presented, (entry) =>
    (entry.operator ? resolveJobToken() : jobTokenInDir(entry.profileDir)).token);
  const t = matched == null ? null : contextOf(matched.slug);
  // One answer for unconfigured, missing and wrong. The 503 that used to say "job bus not
  // configured" told an unauthenticated stranger that this host runs a bus and that its token is
  // currently unset, which is the one moment it is worth knowing. The console still says it, to a
  // caller that already signed in. docs/JOB-BUS.md 10.6. A workspace whose box is not running gets
  // the same answer for the same reason: which workspaces exist here is not a stranger's business.
  if (t == null) {
    const lockoutMs = throttle.recordFailure(client);
    // recordFailure only reports a wait on the attempt that trips the lock, and a locked client is
    // turned away above, so this fires once per lockout rather than once per refused request.
    if (lockoutMs > 0) {
      console.log(`job bus bearer locked out for ${client}`);
      // The audit row goes to the OPERATOR's box: there is no tenant to attribute a bearer nobody
      // holds to, and the operator is who reads the fleet's own audit.
      const operator = contextOf(OPERATOR_SLUG);
      if (operator != null) {
        jobBusCall(operator, "jobBusAudit", { event: "auth_locked", client })
          .catch((error) => console.log(`job bus audit failed: ${error?.message ?? error}`));
      }
    }
    return fail(res, 401, "unauthorized", JOB_BUS_REALM);
  }
  // A good bearer deliberately does NOT clear the count. The bucket is shared with the console
  // login, and clearing it here would let anyone holding the bus token reset a password lockout on
  // their address. A lockout expires on its own, which is all this needs to be.

  // Per client, the same address the login lockout counts, so a proxy in front does not collapse
  // every caller into one bucket; then the whole bus, so many addresses cannot outrun it together.
  const wait = jobBusLimiter.retryAfterSeconds(client)
    || jobBusGlobalLimiter.retryAfterSeconds(JOB_BUS_GLOBAL);
  if (wait > 0) return fail(res, 429, `too many requests; wait ${wait}s`, { "retry-after": String(wait) });

  const route = routeJobBus(url.pathname);
  if (route == null) return fail(res, 404, `not found: ${url.pathname}`);
  if (req.method !== route.method) return fail(res, 405, route.method, { allow: route.method });

  if (route.command !== "jobBusCreate") return answerUpstream(res, await jobBusCall(t, route.command, route.args));

  let raw;
  try { raw = await readBody(req, JOB_BUS_BODY_LIMIT); }
  catch (error) {
    if (error?.code !== "BODY_TOO_LARGE") throw error;
    // The caller is still uploading, so the answer has to take the connection with it.
    return drainThenEnd(req, res, 413, { "content-type": "application/json" },
      JSON.stringify({ error: "job body too large" }));
  }
  const shaped = jobCreateArgs(raw, req.headers["idempotency-key"],
    { client, submitterId: jobSubmitterId(presented) });
  if (shaped.error != null) return fail(res, 400, shaped.error);

  const upstream = await jobBusCall(t, "jobBusCreate", shaped.args);
  if (upstream.status !== 200) return answerUpstream(res, upstream);
  // jobBusCreate answers {created, job}. The status is the only place a REST client can see the
  // difference between a job it just made and one its retry found, so it is `created` that picks
  // 201 or 200, never a timestamp comparison.
  let body;
  try { body = JSON.parse(upstream.text); } catch { body = null; }
  if (body?.job == null) return answerUpstream(res, upstream);
  // Four fields, not the whole record. A create answer that echoed the job would hand back the
  // payload and the worker's agent ids to whoever posted it; CoS reads the rest with GET
  // /v1/jobs/{id} when it wants it. docs/JOB-BUS.md 10.6.
  const { id, type, status, created_at } = body.job;
  return answerUpstream(res, upstream, body.created === true ? 201 : 200,
    JSON.stringify({ id, type, status, created_at }));
}

// ---- arming the bus ---------------------------------------------------------------------------
// docs/JOB-BUS.md 10.7 says the bus is off until the operator turns it on, and that setting a
// bearer IS turning it on. That was implemented only in the browser -- the console's own token
// buttons -- so the env-var deploy path in section 8 armed nothing: an operator who set
// TITAN_JOB_TOKEN on Coolify and never opened Settings got `503 job bus is disabled` on every
// create, with a token that worked. So the relay does it too, from both ends: once at start when
// the token comes from the environment, and on the console routes that write one.
//
// It is one jobBusSetSettings {enabled:true} call and it is logged, because "the deploy turned the
// bus on" is exactly the kind of thing an operator must be able to read back out of a container
// log. It runs on every relay start with the env token set, which is the honest reading of that
// variable: the deployment says the bus is on. An operator who wants it off clears the variable.
async function armJobBus(t, why) {
  const answer = await jobBusCall(t, "jobBusSetSettings", { enabled: true }).catch((error) => ({
    status: 0, text: String(error?.message ?? error), type: "",
  }));
  if (answer.status === 200) console.log(`bus  armed the job bus (${why})`);
  else console.log(`bus  could not arm the job bus (${why}): HTTP ${answer.status} ${answer.text.slice(0, 200)}`);
  return answer.status === 200;
}

// ---- the job bus token, from the console --------------------------------------------------
// Written where resolveJobToken reads it, at 0600, because it is a bearer for the whole bus.
// Returns null on success and the reason on failure, because the two ways this fails -- no
// profile directory, and a read-only mount -- are both operator faults with different fixes, and
// a 502 saying "gateway unreachable" would send whoever meets them to the wrong place entirely.
async function writeJobToken(t, token) {
  const file = t.jobTokenFile;
  if (file == null) return "no profile directory to write the token to: SAND_PROFILE_DIRS is unset";
  try {
    await writeFile(file, JSON.stringify({ token }), { mode: 0o600 });
    await ownLikeParent(file);
    // writeFile's mode only applies to a file it creates, and this one is rewritten every time
    // the operator rotates the token.
    await chmod(file, 0o600);
    return null;
  } catch (error) {
    return `could not write ${file}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleJobBusConsole(t, req, res, url) {
  const sendJson = (status, value) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(value));
  };
  const state = () => {
    const current = t.jobToken();
    const host = String(req.headers.host ?? "");
    return {
      configured: current.token.length > 0,
      source: current.source,
      base_url: host.length > 0 ? `${secureOf(req) ? "https" : "http"}://${host}/v1` : null,
    };
  };

  if (url.pathname === "/job-bus/status") {
    if (req.method !== "GET") return fail(res, 405, "GET", { allow: "GET" });
    return sendJson(200, state());
  }
  if (req.method !== "POST") return fail(res, 405, "POST", { allow: "POST" });
  // The env wins wherever it is set, so writing the file would only produce a token that never
  // works. Say so rather than accepting the write.
  const envWins = t.jobToken().source === "env";

  if (url.pathname === "/job-bus/token/generate") {
    if (envWins) return fail(res, 409, "TITAN_JOB_TOKEN is set in the environment; it would win over this file");
    const token = newJobToken();
    const failed = await writeJobToken(t, token);
    if (failed != null) return fail(res, 503, failed);
    // Nobody generates a bearer for a bus they want shut. The browser asks for this as well; doing
    // it here means the bus is armed even when the console is not the caller.
    await armJobBus(t, "a token was generated in the console");
    // Once. It is not readable back through any route on this server.
    return sendJson(200, { token, ...state() });
  }
  if (url.pathname === "/job-bus/token/clear") {
    const file = t.jobTokenFile;
    // force skips a file that is not there, which is a successful clear; a read-only mount still
    // throws, and that is worth saying rather than dressing up as a gateway fault.
    if (file != null) {
      try { await rm(file, { force: true }); }
      catch (error) { return fail(res, 503, `could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return sendJson(200, state());
  }
  if (url.pathname === "/job-bus/token") {
    if (envWins) return fail(res, 409, "TITAN_JOB_TOKEN is set in the environment; it would win over this file");
    let token;
    try { token = JSON.parse(await readBody(req, JOB_BUS_BODY_LIMIT))?.token; } catch { token = null; }
    if (typeof token !== "string" || token.trim().length < 32) return fail(res, 400, "the token must be at least 32 characters");
    const failed = await writeJobToken(t, token.trim());
    if (failed != null) return fail(res, 503, failed);
    await armJobBus(t, "a token was set in the console");
    return sendJson(200, state());
  }
  return fail(res, 404, `not found: ${url.pathname}`);
}

// ---- agent email (MAIL-1, docs/MAIL.md) -------------------------------------------------------
// The receive side lives beside the job bus edge and is wired the same way: one module holds every
// rule, this file holds the mount and hands it the helpers it needs. jobBusCall is the upstream
// helper -- it is the one call that carries this relay's bearer -- so the gateway token stays here
// and mail reaches an agent as an ordinary sendPrompt.
//
// Sixty a minute per address on the public hook. Resend sends one request per message and retries
// slowly, so anything above that rate is not Resend.
//
// TENANT-5 makes it one edge PER TENANT rather than one for the process, which createMailEdge was
// already shaped for: it takes settingsFile, ledgerFile and gatewayCall, so this is a factory and
// not a rewrite. The rate limiter is deliberately NOT per tenant -- /hooks/resend is one public
// door on one host, and sixty a minute is a fact about that door.
const mailLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const mailEdges = new Map();
function mailEdgeFor(t) {
  const found = mailEdges.get(t.slug);
  if (found != null && found.settingsFile === t.mailSettingsFile) return found.edge;
  t.ensureDir();
  const edge = createMailEdge({
    readBody, drainThenEnd, fail, clientOf, secureOf,
    gatewayCall: (command, args) => jobBusCall(t, command, args),
    ownLikeParent,
    settingsFile: t.mailSettingsFile,
    ledgerFile: t.mailLedgerFile,
    limiter: mailLimiter,
    // Which OTHER workspace on this console already holds that domain. One file read per tenant,
    // and only on a save that actually changes the domain.
    domainClaimedElsewhere: async (domain) => {
      const want = String(domain ?? "").toLowerCase();
      if (want.length === 0) return null;
      for (const entry of registry.all()) {
        if (entry.slug === t.slug) continue;
        const other = contextOf(entry.slug);
        if (other == null) continue;
        const settings = await readMailSettings(other.mailSettingsFile).catch(() => null);
        if (String(settings?.domain ?? "").toLowerCase() === want) return other.name || other.slug;
      }
      return null;
    },
    log: (line) => console.log(line),
  });
  mailEdges.set(t.slug, { settingsFile: t.mailSettingsFile, edge });
  return edge;
}

// ---- POST /hooks/resend, for a console with more than one tenant on it ------------------------
//
// The webhook carries no session and no bearer: its credential is the Svix signature, and the
// signing secret is per tenant, so the tenant has to be chosen BEFORE anything is verified. The
// contract offered "one shared domain, unique agent name" and that is not sound: agent names are
// not unique across tenants, and the moment two customers each have a Titan, titan@titanium.bot is
// ambiguous and one customer's mail lands in the other's box.
//
// What is sound and costs one file read per tenant: route by DOMAIN. A tenant's mail domain is
// already a per-state-directory setting (MAIL-3), and the recipient is in the webhook body which is
// already read without a fetch. Choosing a KEY from an unverified claim is the pattern
// ui/session-token.mjs already blesses: the claim picks the secret, the secret then has to check
// out, and a liar picks a secret that does not verify their signature.
//
// THE CLAIM IS NOT THE ANSWER, and the first version of this loop treated it as one. mail.json's
// domain is a free string any signed-in customer types into their own console (ui/mail-edge.mjs
// mergeMailSettings takes it as written), tenants sort before the operator in the registry, and
// this loop returned on the FIRST entry claiming the recipient's domain. So a customer who typed
// the operator's domain into their own settings won the loop, their edge failed the Svix check
// against their own secret, and the answer was a 401 Resend retries for hours while the real
// owner's mail never arrived. "A domain is verified inside exactly one Resend account so a tie is
// impossible" is a fact about Resend and not about a file the claimant writes.
//
// So a claim only nominates a candidate. When more than one tenant claims the domain, the one
// whose signing secret actually verifies THIS body is the one that gets it, which is the same
// "the claim picks the key, the key has to check out" rule the paragraph above states. An
// impostor has no secret that verifies Resend's signature, so an impostor cannot take the mail
// and cannot black-hole it either. One claimant is dispatched unverified exactly as before, so
// the edge keeps answering 503 not_configured and 401 invalid_signature in its own words.
//
// No tenant owns the domain: 200 and a reason. A webhook that answers anything else is a webhook
// Resend retries for hours over a decision we made on purpose.
function recipientDomains(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { return []; }
  const data = event?.data ?? {};
  const addresses = [...toAddressList(data.received_for), ...toAddressList(data.to)];
  return [...new Set(addresses.map((address) => domainOf(address)).filter((domain) => domain.length > 0))];
}

async function handleMailWebhook(req, res) {
  const serving = registry.all().filter((entry) => entry.reachable !== false);
  // One tenant on this console, which is Jason's own machine and every developer Mac: the edge
  // reads the body itself and this route is byte for byte the one it always was.
  if (serving.length <= 1) {
    const only = contextOf(serving[0]?.slug ?? OPERATOR_SLUG);
    if (only == null) return fail(res, 503, "no workspace on this console");
    return await mailEdgeFor(only).handleWebhook(req, res);
  }
  if (req.method !== "POST") return fail(res, 405, "POST", { allow: "POST" });
  // Charged here rather than inside the edge, because the body has to be read before the tenant is
  // known and an address sending floods must not make this process hold anything on its behalf.
  const wait = mailLimiter.retryAfterSeconds(clientOf(req));
  if (wait > 0) return fail(res, 429, `too many requests; wait ${wait}s`, { "retry-after": String(wait) });

  let raw;
  try { raw = await readBody(req, MAIL_BODY_LIMIT); }
  catch (error) {
    if (error?.code !== "BODY_TOO_LARGE") throw error;
    return drainThenEnd(req, res, 413, { "content-type": "application/json" },
      JSON.stringify({ error: "that webhook body is too large" }));
  }

  const domains = recipientDomains(raw);
  const claimants = [];
  for (const entry of serving) {
    const t = contextOf(entry.slug);
    if (t == null) continue;
    const settings = await readMailSettings(t.mailSettingsFile).catch(() => null);
    const domain = String(settings?.domain ?? "").toLowerCase();
    if (domain.length === 0 || !domains.includes(domain)) continue;
    claimants.push({ t, settings });
  }
  if (claimants.length === 1) return await mailEdgeFor(claimants[0].t).handleWebhook(req, res, { raw });
  if (claimants.length > 1) {
    const headers = svixHeaders(req.headers);
    for (const { t, settings } of claimants) {
      const secret = String(settings?.webhookSecret ?? "");
      if (secret.length === 0 || headers == null) continue;
      if (!verifySvixSignature(secret, headers, raw, Date.now()).ok) continue;
      console.log(`mail  ${claimants.length} workspaces claim that domain; ${t.slug} holds the signing secret`);
      return await mailEdgeFor(t).handleWebhook(req, res, { raw });
    }
    // Every claimant is a claimant and none of them can prove it. Nobody is handed the message and
    // nobody is told which of them was lying; 200 so Resend stops rather than retrying a decision
    // that will not change.
    console.log(`mail  ${claimants.length} workspaces claim that domain and none of their signing secrets verified this webhook`);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ignored: "no_verified_tenant" }));
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  return res.end(JSON.stringify({ ignored: "no_tenant" }));
}

// ---- the desktop ----------------------------------------------------------------------------
// The host answers ensureForeverBox with a vnc URL on ITS OWN loopback (127.0.0.1:6081), which is
// the right address for exactly one browser: one running on the same machine as the box. Through
// the R750 the operator's browser resolved that against his Mac and the frame said "Failed to
// connect to downstream server". So the relay proxies the desktop the same way it proxies the
// gateway: /vnc/<display>/... is served from the box's own websockify, assets and all, behind the
// same session the rest of this server requires. Nothing is vendored -- noVNC's files still come
// from the box, so the box image stays the one source of that client.
//
// :1 is the shared seat and the box serves it on 6080 with no token. Every fork display is behind
// the token-websockify on 6081, where the token IS the display number.
// ---- the host-only ship (docs/GAP-ANALYSIS.md SHIP-2) ------------------------------------------
// The runtime directory a ship writes, served back to the box in the layout the host's own
// self-upgrade already knows how to read. ui/host-bundle.mjs carries the layout rules and why.
const RUNTIME_DIR = process.env.SAND_HOST_RUNTIME_DIR?.trim() ?? "";
// One compose at a time. The staging paths inside the box are fixed, so two overlapping requests
// would build into each other's tree; the tarball is ~15 MB and takes seconds, so a queue costs
// nothing and a second name would only move the race.
let bundleCompose = Promise.resolve();
const runExec = (args, input) => new Promise((resolve, reject) => {
  const child = execFile("docker", args, { maxBuffer: 8 << 20 }, (error, out, err) =>
    (error ? reject(new Error(`${args.slice(0, 3).join(" ")}: ${String(err || error.message).trim().slice(0, 400)}`)) : resolve(String(out))));
  if (input != null) child.stdin.end(input);
});

async function readLatestBundleVersion() {
  if (RUNTIME_DIR.length === 0) return null;
  try { return parseLatestVersionFile(await readFile(path.join(RUNTIME_DIR, LATEST_VERSION_FILE), "utf8")); } catch { return null; }
}

// Build the tarball in the box and stream it back with a real content-length. It is written to a
// file first and measured rather than streamed straight out of tar, so a compose that fails still
// fails as an HTTP status the host can report instead of as a truncated body it would try to
// extract.
async function serveHostBundleTarball(t, res, version) {
  await runExec(["cp", path.join(RUNTIME_DIR, "host-main.cjs"), `${t.box}:${BOX_INCOMING_ENTRY}`]);
  await runExec(["exec", t.box, "sh", "-c", composeHostBundleScript({ version })]);
  const size = Number.parseInt(String(await runExec(["exec", t.box, "stat", "-c", "%s", BOX_TARBALL_PATH])).trim(), 10);
  if (!Number.isInteger(size) || size <= 0) throw new Error("the composed bundle measured 0 bytes");
  await new Promise((resolve, reject) => {
    res.writeHead(200, { "content-type": "application/gzip", "content-length": String(size), "cache-control": "no-store" });
    const child = spawn("docker", ["exec", t.box, "cat", BOX_TARBALL_PATH], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.pipe(res);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cat exited ${code}`))));
  });
  await runExec(["exec", t.box, "rm", "-f", BOX_TARBALL_PATH]).catch(() => {});
}

async function handleRuntimeBundle(req, res, url) {
  const asked = parseRuntimeRequest(url.pathname);
  // 404 rather than 401 on a bad token: this route is reached before the console's login, and a
  // refusal that distinguished "wrong token" from "no such file" would confirm the path exists to
  // anyone who found it.
  //
  // TENANT-5: the caller is a box's own host process asking for its next bundle, so the token in
  // the path says which box. Every tenant's gateway token is compared with no early break, so the
  // time this takes says nothing about which one matched or how many exist.
  const matched = asked == null ? null : registry.matchToken(asked.token);
  const t = matched == null ? null : contextOf(matched.slug);
  if (t == null) return fail(res, 404, "not found");
  if (RUNTIME_DIR.length === 0) return fail(res, 503, "no SAND_HOST_RUNTIME_DIR on this relay, so no host bundle is served");
  const latest = await readLatestBundleVersion();
  if (latest == null) return fail(res, 404, "no staged host bundle version");
  if (asked.kind === "version") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end(formatLatestVersionFile(latest));
  }
  // Only the staged version, never an arbitrary one: the box already holds the tree every other
  // version would be composed from, so serving "any sha" would mean serving the same bytes under a
  // name that lies about them.
  if (asked.version !== latest) return fail(res, 404, "not the staged host bundle version");
  // The version file above is read straight off the mounted runtime directory and needs nothing
  // else, so it answers on every instance. The tarball genuinely cannot be built here without
  // docker: the archive's base tree is copied from the box's own /home/box/sand-host so the
  // supervisor's prune does not delete the parts of the bundle that come from the image (see
  // ui/host-bundle.mjs). An honest refusal, so the host retries later instead of unpacking a
  // truncated download. TENANT-2 item 4, and docs/TENANCY.md says the same.
  if (!await dockerAvailable()) return refuseWithoutDocker(res, NOT_AVAILABLE.hostBundle);
  const mine = bundleCompose.then(() => serveHostBundleTarball(t, res, latest));
  bundleCompose = mine.catch(() => {});
  try {
    await mine;
  } catch (error) {
    console.log(`runtime bundle compose failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) return fail(res, 502, "the host bundle could not be composed in the box");
    res.destroy();
  }
  return undefined;
}

const VNC_ROUTE = /^\/vnc\/([1-9][0-9]?)\/(.*)$/;
const vncTarget = (display) => (display === 1 ? { port: 6080, query: "" } : { port: 6081, query: `?token=${display}` });

async function relayVnc(t, req, res, display, rest, search) {
  const { port } = vncTarget(display);
  // Only what the box needs to answer. The browser's cookie and the relay's bearer are ours, not
  // the box's, and forwarding either would hand a credential to a process that never asked.
  const upstream = await fetch(`http://${t.boxHost}:${port}/${rest}${search}`,
    { headers: { accept: String(req.headers.accept ?? "*/*") } });
  if (!upstream.ok) return fail(res, upstream.status, `the box did not serve ${rest} (HTTP ${upstream.status})`);
  // vnc.html, and nothing else, comes back with the clipboard bridge appended to its head; every
  // asset is passed through byte for byte. See ui/vnc-bridge.mjs for what goes in and why.
  const bytes = rewriteVncAsset(rest, Buffer.from(await upstream.arrayBuffer()));
  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
  });
  return res.end(bytes);
}

// The websocket half, in node builtins because this process has no node_modules at all. The
// handshake is rewritten rather than forwarded: the client's key and version go through so the
// browser's own accept check still holds end to end, and everything else (Origin, cookies, the
// extension offer) is dropped, which leaves both ends negotiating a plain binary socket. After the
// request line the two sockets are simply piped, including the upstream's 101 -- nothing here
// parses a frame, so there is no framing bug to have.
const WS_KEY = /^[A-Za-z0-9+/=]{16,32}$/;
function relayVncSocket(t, req, socket, head, display) {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const version = String(req.headers["sec-websocket-version"] ?? "13");
  if (!WS_KEY.test(key) || !/^\d{1,3}$/.test(version)) return socket.destroy();
  const { port, query } = vncTarget(display);
  const target = net.connect(port, t.boxHost, () => {
    const lines = [
      `GET /websockify${query} HTTP/1.1`,
      `Host: ${t.boxHost}:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Version: ${version}`,
      `Sec-WebSocket-Key: ${key}`,
    ];
    const protocol = String(req.headers["sec-websocket-protocol"] ?? "");
    if (/^[A-Za-z0-9\-_.,+ ]{1,120}$/.test(protocol)) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
    target.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
}

// ui/index.html still aims its desktop frame at http://127.0.0.1:6080, which was the right
// address for exactly one arrangement: a browser on the same machine as the box. Served from here
// it is wrong twice over. The loopback is the VIEWER's, not the box's, and on the public domain a
// plain-http frame inside an https page is mixed content, which the browser blocks before it can
// even fail to connect -- so the page would have shipped one http-only asset on the very
// deployment this work exists for. The Machine Room already went through this and answers it with
// the relay's own /vnc route; ui/index.html belongs to a different part of the tree, so the fix
// goes where the responsibility is: this server owns what it publishes, and rewrites the address
// on the way out rather than editing a file that is not its own.
//
// :1 is the shared seat, which is what the operator page has always shown. `path` is set because
// noVNC opens its socket against that value instead of guessing one from the page URL, and
// guessing is what breaks behind a proxy.
const LOOPBACK_DESKTOP = /https?:\/\/127\.0\.0\.1:6080\/([A-Za-z0-9_.-]+)(\?[^"']*)?/g;
const sameOriginDesktop = (html) => String(html).replace(LOOPBACK_DESKTOP, (_, file, query) => {
  const params = new URLSearchParams((query ?? "").slice(1));
  params.set("path", "/vnc/1/websockify");
  return `/vnc/1/${file}?${params}`;
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  // Set before anything answers, so it is on every response including the login page and the
  // refusals. writeHead's own header object is merged over this rather than replacing it.
  if (secureOf(req)) res.setHeader("strict-transport-security", HSTS);
  try {
    // Before the console's login, and never reaching it: /v1 is the job bus, authenticated with
    // its own bearer. A console session must not open it and its bearer must not open anything
    // else, so the two doors never see each other's credential.
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return await handleJobBus(req, res, url);
    // Before the console's login too, and for the same reason the job bus is: the caller is the
    // box's own host process asking for its next bundle, and it can hold neither a session cookie
    // nor an authorization header. Its credential is the token segment in the path. SHIP-2.
    if (url.pathname.startsWith(RUNTIME_ROUTE_PREFIX)) {
      if (req.method !== "GET") return fail(res, 405, "GET");
      return await handleRuntimeBundle(req, res, url);
    }
    // Before the console's login as well: this is Resend calling with mail for an agent, and a
    // webhook carries no cookie and no bearer. Its credential is the Svix signature on the body,
    // which the mail edge verifies before it reads a single field. MAIL-1.
    if (url.pathname === "/hooks/resend") return await handleMailWebhook(req, res);
    // Before the console's login as well, and behind a credential the console session cannot
    // present: this is the CONTROL PLANE asking the relay for the two things only the relay can
    // see. The failed sign-in ledger, because a refusal happens at this door and never reaches the
    // control plane at all; and box health, because this container has the docker socket and the
    // control plane's deliberately does not. ADMIN-1.
    //
    // The credential is CP_RELAY_TOKEN, which is the same value the control plane already checks on
    // its own registry route. One shared secret between these two services, not two.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return await handleRelayAdmin(req, res, url);
    }
    // Whether a password is configured is not a secret: the login page announces it to anyone who
    // asks for it. The console reads this to decide whether to draw a Log out control.
    if (req.method === "GET" && url.pathname === "/auth/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ required: AUTH != null, authenticated: isAuthorized(req) }));
    }
    if (AUTH == null) {
      // No password configured, which only a loopback bind reaches (see the listen call below).
      // Send /login somewhere useful rather than 404 at an operator who bookmarked it.
      if (req.method === "GET" && url.pathname === "/login") { res.writeHead(302, { location: "/" }); return res.end(); }
    } else {
      if (url.pathname === "/login") {
        if (req.method === "GET") {
          // A sign-in link the control plane minted for a workspace. It is verified here with that
          // workspace's own key, out of the registry, and nothing about the link is taken on trust
          // including that it came from us. TENANT-2, reshaped by TENANT-5.
          const sso = url.searchParams.get("sso");
          if (RELAY != null && sso != null) return handleSso(req, res, sso);
          return sendLoginPage(res, 200, { next: safeNextPath(url.searchParams.get("next")) });
        }
        if (req.method === "POST") return await handleLogin(req, res, url);
        return fail(res, 405, "GET or POST");
      }
      if (url.pathname === "/logout") {
        if (req.method === "POST") return handleLogout(req, res);
        return fail(res, 405, "POST");
      }
      // Everything else, without exception. The login page carries its own CSS inline precisely so
      // there is no asset list to exempt here.
      if (!isAuthorized(req)) return denyUnauthenticated(req, res, url);
      mintSessionFromBearer(req, res, url);
    }

    // ---- which workspace this request is for (TENANT-5) ---------------------------------------
    //
    // Once, here, and every route below takes the answer. The session cookie carries the tenant;
    // the instance password and the gateway bearer both mean the operator; a console with no
    // control plane has exactly one workspace and resolves to it.
    //
    // A session naming a workspace this console cannot serve gets a page and a plain sentence, and
    // the cookie is deliberately NOT cleared: a workspace is unknown while it is being built and
    // during a control plane outage, and signing a customer out over a state that mends itself in
    // sixty seconds is worse than the sentence.
    const slug = tenantOf(req);
    if (slug == null) return denyUnauthenticated(req, res, url);
    const t = contextOf(slug);
    if (t == null) return sendLoginPage(res, 503, { error: NOT_AVAILABLE_SENTENCE });
    // Before the static branch below, which claims every path ending in .js or .css and would
    // otherwise swallow the box's own noVNC assets at /vnc/<display>/app/ui.js.
    if (req.method === "GET" && VNC_ROUTE.test(url.pathname)) {
      const [, display, rest] = VNC_ROUTE.exec(url.pathname);
      // The rest is pasted into a URL aimed at the box's web server, so a traversal segment never
      // gets to be its problem.
      if (rest.length === 0 || rest.split("/").includes("..")) return fail(res, 400, "bad vnc path");
      return await relayVnc(t, req, res, Number(display), rest, url.search);
    }
    // The Machine Room is the console at "/"; the operator page lives at /operator/ (2026-09-02).
    if (req.method === "GET" && (url.pathname === "/operator" || url.pathname === "/operator/" || url.pathname === "/operator/index.html")) {
      const html = sameOriginDesktop(await readFile(path.join(HERE, "index.html"), "utf8"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    if (req.method === "GET" && (url.pathname === "/machine-room" || url.pathname === "/machine-room/")) {
      res.writeHead(302, { location: "/" });
      return res.end();
    }
    // Put an app on the box's X display so the VNC view has something to show. What keeps this
    // safe is the fixed command table below: the operator's string picks a key, never reaches a
    // shell, and an unknown key is rejected. That is the whole argument, and it has to be, because
    // SAND_UI_BIND_HOST means this server is not necessarily on loopback any more -- the R750
    // deploy binds it to 0.0.0.0 inside a container. Anyone who gets past the login above already
    // holds the full gateway surface through /api, so the exec table is not the boundary; it is
    // simply not an extra hole in one.
    // Did the window actually appear? The launch is detached and cannot report, so the UI asks
    // afterwards instead of trusting a 200 that only ever meant "the request was accepted".
    if (req.method === "GET" && url.pathname === "/box/surface") {
      const CLASSES = { browser: "box-chrome", terminal: "Xfce4-terminal" };
      const cls = CLASSES[url.searchParams.get("app")];
      if (!cls) return fail(res, 400, "unknown app");
      // Without docker this answered 200 with present:false and windows:0, which an operator reads
      // as "the box has no desktop" rather than "this instance has no desktop view". TENANT-2.
      if (!await dockerAvailable()) return refuseWithoutDocker(res, NOT_AVAILABLE.desktop);
      const surfaceDisplay = /^[1-9][0-9]?$/.test(String(url.searchParams.get("display") ?? ""))
        ? `:${url.searchParams.get("display")}` : ":1";
      const script = `for w in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*# //;s/,//g'); do xprop -id $w WM_CLASS 2>/dev/null | grep -q '"${cls}"' && echo present && break; done`;
      const { execFile } = await import("node:child_process");
      const present = await new Promise((resolve) => {
        execFile("docker", ["exec", "-e", `DISPLAY=${surfaceDisplay}`, t.box, "sh", "-c", script], (error, stdout) =>
          resolve(!error && String(stdout).includes("present")));
      });
      // Also report whether the display has ANY desktop session. Fork displays on this box image
      // come up with an X server but no window manager (xfwm4 dies on "Xfconf could not be
      // initialized"), so an empty screen is a broken session rather than an idle one -- and the
      // difference is the whole message the operator needs.
      // Count only the hex window ids after the "#". _NET_CLIENT_LIST is set by the window
      // manager, so "not found" means no WM on that display at all -- which is the fork-display
      // failure on this box image, and it must not be counted as three windows.
      const anyScript = `xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*# //' | tr ',' '\n' | grep -c '0x' || true`;
      const windows = await new Promise((resolve) => {
        execFile("docker", ["exec", "-e", `DISPLAY=${surfaceDisplay}`, t.box, "sh", "-c", anyScript],
          (error, stdout) => resolve(error ? 0 : Number(String(stdout).trim()) || 0));
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ app: url.searchParams.get("app"), present, windows, hasSession: windows > 0 }));
    }

    if (req.method === "POST" && url.pathname === "/box/launch") {
      // Find-or-launch, then raise. --disable-dev-shm-usage is load-bearing: /dev/shm in this box
      // is 64MB, and without it Chrome dies during startup with nothing in its output but GCM
      // noise -- the pane just shows whatever else is on the display. Two fixed entries; the class and command are server constants
      // and no part of the request is ever interpolated into the shell. Without the find step every
      // switch spawned another window -- the box collected four terminals before this was noticed.
      // Chrome needs its own profile dir or it just attaches to whatever instance already exists
      // and opens no window on this display at all.
      const APPS = {
        // box-chrome, never the raw binary. The box's own launcher derives the display, uses the
        // profile the agent's computer-use tooling expects (/home/box/chrome-profile-N) and opens
        // the CDP port at 9222+N that the agent drives it through. A raw google-chrome came up on
        // the right screen with a different profile and no debug port, so the operator watched one
        // browser while the agent tried to drive another -- which is why a computerUse subagent
        // reported "done" having navigated nothing.
        browser: { cls: "box-chrome", cmd: "box-chrome about:blank" },
        terminal: { cls: "Xfce4-terminal", cmd: "xfce4-terminal --maximize" },
      };
      let app;
      try { app = JSON.parse(await readBody(req))?.app; } catch { app = null; }
      const spec = APPS[app];
      if (!spec) return fail(res, 400, `unknown app: ${app}`);
      // The launch is detached and cannot report, so with no docker this answered 200 {launched}
      // for a window that was never going to appear. The console reads this refusal and puts the
      // sentence in the pane instead of an empty grey frame. TENANT-2.
      if (!await dockerAvailable()) return refuseWithoutDocker(res, NOT_AVAILABLE.desktop);
      // The display is interpolated into a shell command, so it is validated as a small integer
      // and nothing else. :1 is the shared seat; the host allocates forks from :2 upward.
      const display = /^[1-9][0-9]?$/.test(String(url.searchParams.get("display") ?? ""))
        ? `:${url.searchParams.get("display")}` : ":1";
      const cmd = spec.cmd;
      const script = [
        `win=$(for w in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*# //;s/,//g'); do`,
        `  xprop -id $w WM_CLASS 2>/dev/null | grep -q '"${spec.cls}"' && echo $w && break;`,
        `done)`,
        `if [ -n "$win" ]; then xdotool windowactivate $win;`,
        `else setsid ${cmd} >/dev/null 2>&1 & sleep 12;`,
        `  for w in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*# //;s/,//g'); do`,
        `    xprop -id $w WM_CLASS 2>/dev/null | grep -q '"${spec.cls}"' && xdotool windowactivate $w && break;`,
        `  done; fi`,
      // Joined with newlines: a space put `done)` and `if` on one line, which sh rejects.
      ].join("\n");
      const { spawn, execFile } = await import("node:child_process");

      // Two different jobs wearing one route. Raising a window that already exists takes about a
      // fifth of a second, so it is done synchronously and the caller knows it landed -- doing it
      // detached let a switch answer before the raise, and the next surface check caught the
      // previous window still on top. Only a cold start needs the detached path, because a
      // non-detached docker exec tears down its own process tree when the shell exits, which
      // killed Chrome three seconds into a ten-second startup.
      const findScript = `for w in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*# //;s/,//g'); do xprop -id $w WM_CLASS 2>/dev/null | grep -q '"${spec.cls}"' && echo $w && break; done`;
      const existing = await new Promise((resolve) => {
        execFile("docker", ["exec", "-e", `DISPLAY=${display}`, t.box, "sh", "-c", findScript],
          (error, stdout) => resolve(error ? "" : String(stdout).trim()));
      });

      if (existing) {
        await new Promise((resolve) => {
          execFile("docker", ["exec", "-e", `DISPLAY=${display}`, t.box, "xdotool", "windowactivate", existing],
            () => resolve());
        });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ launched: app, raised: true }));
      }

      const child = spawn("docker", ["exec", "-d", "-e", `DISPLAY=${display}`, t.box, "sh", "-c", script], { stdio: "ignore" });
      child.on("error", () => {});
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ launched: app, raised: false }));
    }

    // The Machine Room frontend is a vendored handoff: many files, and the rule from its README
    // is that the DOM and event layer stay untouched. So it gets served as a directory rather
    // than inlined, and the only file this repo authors inside it is the gateway adapter.
    // Static console: "/" and the handoff's assets (by extension, so the JSON API routes below stay
    // reachable), plus the old /machine-room/ paths for bookmarks.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/machine-room/")
      || (/\.(css|js|mjs|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|map|webmanifest|txt|md)$/.test(url.pathname) && !url.pathname.startsWith("/api/")))) {
      // Every asset in the handoff is referenced relatively, so at "/machine-room" (no trailing
      // slash) the browser resolves them against "/" and the page renders as unstyled HTML.
      // Redirect to the directory form the way a static server would.
      const rel = url.pathname === "/" || url.pathname === "/index.html"
        ? "index.html"
        : url.pathname.startsWith("/machine-room/") ? url.pathname.slice("/machine-room/".length) : url.pathname.slice(1);
      const file = path.resolve(HERE, "machine-room", rel);
      // Resolve first, then check: a path that escapes the directory never reaches readFile.
      if (!file.startsWith(path.join(HERE, "machine-room") + path.sep)) return fail(res, 403, "outside the frontend directory");
      const types = { ".webp": "image/webp", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/plain; charset=utf-8" };
      try {
        const bytes = await readFile(file);
        res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        return res.end(bytes);
      } catch { return fail(res, 404, `not found: ${url.pathname}`); }
    }
    if (url.pathname === "/connectors") {
      // connectors.json lives in the box's sand-data volume, which there is no host path for: the
      // only way in is `docker exec`. Without docker the GET used to answer 503 "the box could not
      // be read" on every console load, which reads as an outage. TENANT-2. The POST is refused
      // below instead of here, after its body is read, so the caller is not left uploading.
      if (req.method === "GET" && !await dockerAvailable()) return refuseWithoutDocker(res, NOT_AVAILABLE.connectors);
      const sendJson = (value) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET") { const current = await readConnectors(t); return current == null ? fail(res, 503, "the box could not be read") : sendJson(current); }
      if (req.method === "POST") {
        let parsed;
        try { parsed = JSON.parse(await readBody(req)); } catch { return fail(res, 400, "body must be JSON"); }
        if (!await dockerAvailable()) return refuseWithoutDocker(res, NOT_AVAILABLE.connectors);
        const servers = parsed?.mcpServers;
        if (servers == null || typeof servers !== "object" || Array.isArray(servers)) {
          return fail(res, 400, "expected { mcpServers: { ... } }");
        }
        // Reject a config the host would silently drop, rather than accepting it and leaving the
        // operator wondering why their connector never appears.
        for (const [name, config] of Object.entries(servers)) {
          if (config == null || typeof config !== "object") return fail(res, 400, `${name}: not an object`);
          if (typeof config.command !== "string" || config.command.length === 0) {
            return fail(res, 400, `${name}: stdio connectors need a "command"`);
          }
          // SECRET-2. "shell" is the reserved destination a secret card names to mean the agent's
          // own box shell, so routeSecret returns on it before any connector is consulted: a
          // connector under that name could never be given a key from a card. Refused here rather
          // than written and silently bypassed. A POST that simply omits it still passes, so an
          // entry already in the file can always be removed.
          if (name.trim().toLowerCase() === "shell") {
            return fail(res, 400, `${name}: "shell" is reserved for the agent's own box shell environment, so a connector cannot use it. Rename it (for example shell-mcp) and save again.`);
          }
        }
        await writeConnectors(t, { mcpServers: servers });
        return sendJson({ saved: Object.keys(servers), restartRequired: true });
      }
    }
    if (req.method === "GET" && url.pathname === "/clients") {
      // The box is shared: the desktop app talks to this same gateway. Anyone driving
      // it sees your writes. Count the sockets so the page can say so out loud.
      const port = new URL(t.gateway).port || "80";
      // lsof truncates COMMAND to 9 chars ("Grok B"), so take the pids and ask ps.
      const pids = await new Promise((resolve) => {
        execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED"], (err, out) => {
          if (!out) return resolve([]);
          const found = new Set();
          for (const line of out.split("\n").slice(1)) {
            const [cmd, pid] = line.split(/\s+/);
            if (!pid || cmd?.startsWith("com.docke")) continue;
            if (Number(pid) !== process.pid) found.add(pid);
          }
          resolve([...found]);
        });
      });
      const peers = await Promise.all(pids.map((pid) => new Promise((resolve) => {
        execFile("ps", ["-p", pid, "-o", "comm="], (err, out) => {
          const path = (out ?? "").trim();
          resolve(path ? (path.split("/").find((seg) => seg.endsWith(".app"))?.replace(/\.app$/, "") ?? path.split("/").pop()) : null);
        });
      })));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ peers: [...new Set(peers.filter(Boolean))] }));
    }
    // Subscriptions already authenticated ON THIS MACHINE (docs/SUBSCRIPTIONS-CONTRACT.md): the
    // Codex and Claude logins in the operator's own home directory. There is exactly one machine
    // under this console and it is Jason's, so these three are operator-only under TENANT-5. A
    // customer gets an empty list and the ordinary not-available refusal on the two writes, which
    // is both safer and a smaller change than threading a store file through ui/subscriptions.mjs
    // to reach credentials that were never theirs. The scan never returns a secret; adoption
    // writes subscriptions.json and a keyless endpoint row.
    if (req.method === "GET" && url.pathname === "/subscriptions") {
      const subscriptions = t.operator ? await scanSubscriptions(process.env, await readCatalog(t)) : [];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ subscriptions }));
    }
    if (req.method === "POST" && url.pathname === "/subscriptions/adopt") {
      const { id, apiKey, model } = JSON.parse(await readBody(req) || "{}");
      if (!t.operator) return refuseWithoutDocker(res, NOT_AVAILABLE.subscriptions);
      let entry;
      try { entry = await adoptSubscription(id, { apiKey, model }); } catch (error) { return fail(res, 400, error.message); }
      const catalog = await readCatalog(t);
      const endpoints = (catalog.endpoints ?? []).filter((e) => e.id !== entry.id).concat([entry]);
      t.ensureDir();
      await writeFile(t.endpointsFile, JSON.stringify({ endpoints }, null, 2));
      await ownLikeParent(t.endpointsFile);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ adopted: id, endpoint: entry }));
    }
    if (req.method === "POST" && url.pathname === "/subscriptions/forget") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      if (!t.operator) return refuseWithoutDocker(res, NOT_AVAILABLE.subscriptions);
      await forgetSubscription(id);
      const catalog = await readCatalog(t);
      t.ensureDir();
      await writeFile(t.endpointsFile, JSON.stringify({ endpoints: (catalog.endpoints ?? []).filter((e) => e.subscription !== id) }, null, 2));
      await ownLikeParent(t.endpointsFile);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ forgot: id }));
    }
    if (req.method === "GET" && url.pathname === "/endpoints") {
      // The catalog is a file on this side of the wall and answers everywhere. Which endpoint is
      // LIVE is only readable through the box, so on an instance with no docker the two docker
      // legs are skipped and the answer carries a sentence saying the live row is unknown, rather
      // than a null that reads as "no model is configured". TENANT-2.
      const hasDocker = await dockerAvailable();
      const [catalog, secrets, envOut] = await Promise.all([
        readCatalog(t),
        hasDocker ? readSecrets(t) : {},
        hasDocker ? dockerOut(["inspect", t.box, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]) : null,
      ]);
      const envOf = (key) => (envOut ?? "").split("\n")
        .find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
      // env beats the secrets file in the host's own resolver, so an env value pins the
      // endpoint and nothing chosen here can take effect until the box is recreated without it.
      const pinned = PROVIDER_KEYS.some((k) => envOf(k) != null);
      const live = { baseUrl: envOf(PROVIDER_KEYS[0]) ?? secrets[PROVIDER_KEYS[0]] ?? null,
        model: envOf(PROVIDER_KEYS[1]) ?? secrets[PROVIDER_KEYS[1]] ?? null };
      const endpoints = await Promise.all((catalog.endpoints ?? []).map(async (e) => {
        if (!e.subscription) return { ...e, apiKey: e.apiKey ? "set" : "", health: await probe(t, e) };
        // A subscription row carries no key; probe with the live token where the vendor serves
        // /models, otherwise say so rather than show it down.
        let resolved = null;
        try { resolved = await resolveSubscription(e.subscription); } catch (error) { return { ...e, apiKey: "", health: { reachable: false, detail: error.message } }; }
        const health = e.transport === "responses"
          ? { reachable: true, serves: null, ms: null, detail: "subscription; verified on use" }
          : await probe(t, { ...e, apiKey: resolved.apiKey });
        return { ...e, apiKey: "subscription", health };
      }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ endpoints, live, pinned,
        pinnedBy: pinned ? "container env; recreate the box without SAND_OPENAI_COMPATIBLE_* to unpin" : null,
        // Present only when it is true, so nothing has to read it on Jason's instance.
        ...(hasDocker ? {} : { liveNote: NOT_AVAILABLE.liveModel, switchable: false }) }));
    }
    // Save the catalog the operator edits in the browser.
    if (req.method === "POST" && url.pathname === "/endpoints") {
      const next = JSON.parse(await readBody(req) || "{}");
      if (!Array.isArray(next.endpoints)) return fail(res, 400, "endpoints must be an array");
      // On a tenant, before anything is written: an address inside this server's own network is
      // not a provider, it is a port scan with a saved bearer aimed at it. See tenantEndpointRefusal.
      for (const e of next.endpoints) {
        const refusal = await tenantEndpointRefusal(t, e?.baseUrl);
        if (refusal != null) return fail(res, 400, refusal);
      }
      const current = await readCatalog(t);
      // A key the browser never received back comes in as "set"; keep the stored one.
      const merged = next.endpoints.map((e) => ({ ...e,
        apiKey: e.apiKey === "set"
          ? (current.endpoints ?? []).find((c) => c.id === e.id)?.apiKey ?? "" : (e.apiKey ?? "") }));
      t.ensureDir();
      await writeFile(t.endpointsFile, JSON.stringify({ endpoints: merged }, null, 2));
      await ownLikeParent(t.endpointsFile);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ saved: merged.length }));
    }
    // Point the host at one of them. Takes effect on the next message.
    if (req.method === "POST" && url.pathname === "/endpoints/use") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      // Pointing the host at an endpoint means writing box-secrets.json inside the box, and the
      // only door to that file is `docker exec`. Refused before anything is chosen or resolved, so
      // nothing is half done, but after the body is read so the caller is not left uploading into
      // a closed answer. TENANT-2.
      if (!await dockerAvailable()) return refuseWithoutDocker(res, NOT_AVAILABLE.endpointsUse);
      const catalog = await readCatalog(t);
      const chosen = (catalog.endpoints ?? []).find((e) => e.id === id);
      if (chosen == null) return fail(res, 404, `no endpoint named ${id}`);
      const secrets = await readSecrets(t);
      const next = { ...secrets, SAND_OPENAI_COMPATIBLE_BASE_URL: chosen.baseUrl, SAND_OPENAI_COMPATIBLE_MODEL: chosen.model, SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: chosen.name };
      for (const key of ["SAND_OPENAI_COMPATIBLE_API_KEY", "SAND_OPENAI_COMPATIBLE_TRANSPORT", "SAND_OPENAI_COMPATIBLE_ACCOUNT_ID", "SAND_OPENAI_COMPATIBLE_ORIGINATOR"]) delete next[key];
      if (chosen.subscription) {
        // A subscription row names a credential in the OPERATOR's own home directory, so only the
        // operator's console can resolve one. A tenant never has such a row: the scan that writes
        // them answers empty for a tenant.
        if (!t.operator) return refuseWithoutDocker(res, NOT_AVAILABLE.subscriptions);
        // The live token, refreshed through the vendor's own endpoint if it is about to expire;
        // the refreshed token goes to our store, never back to the vendor's file.
        let resolved;
        try { resolved = await resolveSubscription(chosen.subscription); } catch (error) { return fail(res, 502, error.message); }
        next.SAND_OPENAI_COMPATIBLE_API_KEY = resolved.apiKey;
        next.SAND_OPENAI_COMPATIBLE_TRANSPORT = resolved.transport;
        next.SAND_OPENAI_COMPATIBLE_ORIGINATOR = resolved.originator;
        if (resolved.accountId) next.SAND_OPENAI_COMPATIBLE_ACCOUNT_ID = resolved.accountId;
      } else if (chosen.apiKey) {
        next.SAND_OPENAI_COMPATIBLE_API_KEY = chosen.apiKey;
      }
      if (chosen.contextWindow) next.SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW = String(chosen.contextWindow);
      await writeSecrets(t, next);
      // A subscription row has no key of its own and the Codex backend serves no /models; report
      // it the way the listing does instead of probing it into a false "down".
      const health = chosen.subscription
        ? (chosen.transport === "responses"
          ? { reachable: true, serves: null, ms: null, detail: "subscription; verified on use" }
          : await probe(t, { ...chosen, apiKey: next.SAND_OPENAI_COMPATIBLE_API_KEY }))
        : await probe(t, chosen);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ using: chosen.name, health }));
    }
    if (req.method === "GET" && url.pathname === "/model") {
      // The gateway reports which provider is routed but never which model answers, and
      // "openai-compatible" is not something you can hold a conversation with.
      //
      // The host resolves process.env first and box-secrets.json second, and this has to resolve
      // the same way or it reports on a different machine than the one answering. Since the box
      // was recreated to unpin the endpoint, the env vars are gone and every answer lives in the
      // file -- so reading env alone returned nulls, and every worker was labelled "default".
      // Both sources are inside the box, so with no docker there is no honest answer here at all.
      // 200 with nulls and a sentence, not a 409: the console asks for this on every load and a
      // refusal in that position would be an error badge on a page that is working fine. TENANT-2.
      if (!await dockerAvailable()) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ model: null, endpoint: null, source: "unknown", note: NOT_AVAILABLE.liveModel }));
      }
      const fromEnv = await new Promise((resolve) => {
        execFile("docker", ["inspect", t.box, "--format",
          "{{range .Config.Env}}{{println .}}{{end}}"], (err, out) => {
          if (err != null && !out) return resolve({});
          const pick = (name) => {
            const line = out.split("\n").find((l) => l.startsWith(`${name}=`));
            return line ? line.slice(name.length + 1) : null;
          };
          resolve({
            model: pick("SAND_OPENAI_COMPATIBLE_MODEL"),
            endpoint: pick("SAND_OPENAI_COMPATIBLE_BASE_URL"),
          });
        });
      });
      const fromFile = await new Promise((resolve) => {
        execFile("docker", ["exec", t.box, "cat", SECRETS_PATH], (err, out) => {
          if (err != null) return resolve({});
          try {
            const secrets = JSON.parse(out)?.secrets ?? {};
            resolve({
              model: secrets.SAND_OPENAI_COMPATIBLE_MODEL ?? null,
              endpoint: secrets.SAND_OPENAI_COMPATIBLE_BASE_URL ?? null,
            });
          } catch { resolve({}); }
        });
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({
        model: fromEnv.model || fromFile.model || null,
        endpoint: fromEnv.endpoint || fromFile.endpoint || null,
        // Which source won, because "why does it say that" is the next question every time.
        source: fromEnv.model ? "container env" : fromFile.model ? "box-secrets.json" : "unset",
      }));
    }
    // The console's half of the job bus: read the state, generate, set or clear the token. Behind
    // the session like every other console route, and it never reads a token back out.
    if (url.pathname === "/job-bus/status" || url.pathname.startsWith("/job-bus/token")) {
      return await handleJobBusConsole(t, req, res, url);
    }
    // The console's half of agent email: the domain, the addresses, the webhook URL and the two
    // write-only secrets. Behind the session like every other console route, and it never reads a
    // secret back out. MAIL-1.
    if (url.pathname === "/mail/settings") return await mailEdgeFor(t).handleSettings(req, res);
    if (req.method === "GET" && url.pathname === "/health") {
      const upstream = await fetch(`${t.gateway}/health`, { headers: t.headers() });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json" });
      return res.end(text);
    }
    if (req.method === "GET" && url.pathname === "/events") return await relayEvents(t, req, res, url.search);
    if (req.method === "GET" && url.pathname.startsWith("/avatars/")) return await relayAvatar(t, req, res, url.pathname + url.search);
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const method = url.pathname.slice("/api/".length);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) return fail(res, 400, "bad method name");
      return await relayCommand(t, req, res, method);
    }
    return fail(res, 404, `not found: ${req.method} ${url.pathname}`);
  } catch (error) {
    return fail(res, 502, `gateway unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// The desktop's websocket. An upgrade never reaches the request handler above, so the login has to
// be checked again here, on the same cookie the browser sends with it -- otherwise the one route
// that carries the box's screen and keyboard would be the one route with no password on it.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const match = VNC_ROUTE.exec(url.pathname);
  if (match == null || match[2] !== "websockify") return socket.destroy();
  // A refusal a browser can read, rather than a reset socket: noVNC reports "failed to connect"
  // either way, but the operator opening devtools sees which of the two it was.
  const slug = tenantOf(req);
  if (slug == null) return socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
  // And which box's screen this is, decided here rather than inherited: an upgrade never reaches
  // the request handler, so the one route carrying a keyboard would otherwise be the one route
  // that never asked whose box it was aiming at.
  const t = contextOf(slug);
  if (t == null) return socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n");
  return relayVncSocket(t, req, socket, head, Number(match[1]));
});

// Loopback by default: this process holds the gateway token, so it must not be reachable off-box
// unless the operator says so. SAND_UI_BIND_HOST is that say-so, and it exists because the R750
// deploy runs the relay in a container, where 127.0.0.1 is the container's own loopback and
// nothing outside it -- not even the published port -- could ever reach the server.
const BIND = process.env.SAND_UI_BIND_HOST?.trim() || "127.0.0.1";
// Refusing to start is the point. A relay on a reachable address with no password is the same
// thing as publishing the gateway token, and there is no configuration that makes that safe, so
// this is not a warning that scrolls past in a container log.
if (AUTH == null && !isLoopbackHost(BIND)) {
  console.error(`refusing to bind ${BIND}:${PORT} with no password.`);
  console.error(`Reaching this server means holding the gateway token: /api forwards the bearer,`);
  console.error(`which includes createAgent, deleteAgent, shell in the box, and secret writes.`);
  console.error(`Set one and start again:   node ${path.join(HERE, "set-password.mjs")}`);
  console.error(`It writes ${AUTH_FILE} at mode 0600. Loopback needs no password and is unchanged.`);
  process.exit(1);
}
// The first read of the tenant list, before the first request rather than after it, and the sixty
// second schedule behind it. It is awaited because a console that answered "not available" to the
// first customer through the door while it caught up would be worse than a second of boot; a
// control plane that is not answering yet costs the ten second timeout and then serves the
// operator alone, which is exactly what it did before any of this existed.
await registry.refresh().catch((error) => console.log(`reg  first read failed: ${error?.message ?? error}`));
registry.start();
if (!await dockerAvailable()) {
  console.log("box  no docker on this relay, so the model picker, the connectors editor and the desktop view say so rather than failing");
}
// The env deploy path (docs/JOB-BUS.md 8): TITAN_JOB_TOKEN set on the deployment means the bus is
// meant to be answering, so the relay arms it on its own start. It arms the OPERATOR's box and no
// other: the variable is a fact about this deployment, and read for every tenant it would turn on
// a bus in every customer's box that none of them asked for. Not awaited into the listen: a
// gateway that is not up yet must not stop the console from coming up, and the call logs either way.
if (String(process.env.TITAN_JOB_TOKEN ?? "").trim().length > 0) {
  const operator = contextOf(OPERATOR_SLUG);
  if (operator != null) void armJobBus(operator, "TITAN_JOB_TOKEN is set in the environment");
}
server.listen(PORT, BIND, () => {
  console.log(`ui   http://${BIND}:${PORT}`);
  console.log(`gw   ${OPERATOR_GATEWAY}${OPERATOR_TOKEN.length > 0 ? " (bearer)" : " (no auth)"} `
    + `via ${registry.operator().box}`);
  console.log(`auth ${AUTH == null ? "none (loopback, no ui/auth.json)" : "password login, 12 h sessions"}`);
  // Which files this instance owns, said out loud. On a shared server the answer decides whether
  // two tenants are writing over each other, and it is not visible from anywhere else.
  console.log(`state ${STATE_DIR.length > 0 ? STATE_DIR : `${HERE} (beside the code, SAND_UI_STATE_DIR is unset)`}`);
  // Two doors or one, and how many workspaces this console serves. Worth two lines because the
  // first difference is a field on the login page, which an operator looking at a page with no
  // email field needs somewhere to read why about, and the second is the only place the fleet this
  // process is serving is visible at all.
  const serving = registry.all().map((entry) => `${entry.slug}${entry.reachable === false ? " (box not running)" : ""}`);
  console.log(`tnnt ${RELAY == null
    ? "one workspace, the instance password is the only sign-in (set CP_URL and CP_RELAY_TOKEN for accounts)"
    : `accounts sign in through ${RELAY.cpUrl}`}`);
  console.log(`work ${serving.length}: ${serving.join(", ")}`);
  console.log(`prox ${TRUSTED_PROXIES.any ? "any peer may forward a client address" : (TRUSTED_PROXIES.ranges.length === 0
    ? "none, so the socket address is the client and no forwarded header is read"
    : `${TRUSTED_PROXIES.ranges.length} trusted range(s) from SAND_UI_TRUSTED_PROXIES`)}`);
  if (TRUSTED_PROXIES.ignored?.length > 0) {
    console.log(`prox IGNORED, not an address or prefix: ${TRUSTED_PROXIES.ignored.join(" ")}`);
  }
  console.log(`cfip ${CLOUDFLARE_RANGES.any ? "ANY forwarded address may send CF-Connecting-IP, which is a header anyone can write"
    : (CLOUDFLARE_RANGES.ranges.length === 0
      ? "none, so CF-Connecting-IP is never read and the forwarded address is the client"
      : `${CLOUDFLARE_RANGES.ranges.length} Cloudflare range(s) from SAND_UI_CLOUDFLARE_RANGES`)}`);
  if (CLOUDFLARE_RANGES.ignored?.length > 0) {
    console.log(`cfip IGNORED, not an address or prefix: ${CLOUDFLARE_RANGES.ignored.join(" ")}`);
  }
  console.log(`peer ${BOX_PEERS.size()} box address(es) held untrusted as forwarders`
    + " (refreshed with the tenant registry; a box is never read as a proxy)");
});
