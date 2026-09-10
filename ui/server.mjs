// Local frontend host for the sand gateway.
//
// The gateway 403s any request carrying an Origin header (gateway-server.ts:25,
// rejectUntrustedBrowserRequest, "browser-origin gateway requests are not allowed"), so a browser
// cannot call it directly. This process is the shim: it serves the UI and relays to the gateway
// without an Origin, adding the Bearer token the browser must never hold.
//
// STORE-1 leaves that refusal exactly as it is, behind this relay, and answers CORS HERE instead. A
// phone or desktop shell that bundles its own assets is cross-origin, so it gets a device bearer
// (ui/auth-device.mjs) and an exact-string origin allow-list on this process; the gateway keeps
// never talking to a browser, which is the property this file exists for. docs/APPS.md.
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
  MAIL_BODY_LIMIT, MAIL_LEDGER_FILE, MAIL_SENT_LEDGER_FILE, MAIL_SETTINGS_FILE, appendMailLedger,
  createMailEdge, createMailSendRoute, createProductMailRoute, domainOf, mailLedgerRow,
  productFrom, readMailSettings, svixHeaders, toAddressList, verifySvixSignature,
} from "./mail-edge.mjs";
// ONBOARD-2. The relay's only destructive hand. It is its own module rather than lines in this file
// for the reason every other edge here is: the rules worth testing have to be reachable without a
// relay, and the docker socket and the tenant root cannot leave this one.
import { allDockerNames, createTenantPurgeRoute, removeTreeFs, statTreeFs } from "./purge-edge.mjs";
// VOICE-1. The relay's half of talking to Titan out loud: the settings door and the browser's
// audio socket. Everything else that would have had to live in this file -- the per-tenant edge
// cache, the gateway caller, the caps, the ledger, the RFC 6455 codec -- is in there, because three
// waves share this file and every line here is a surgical stage after a rebase.
import { VOICE_SOCKET_PATH, originAllowed, voiceEdgeFor } from "./voice-edge.mjs";
import {
  CODE_DEFAULTS, CODE_SWEEP_MS, appendTaskRow as appendCodeTask, createCodeEdge,
  readTaskRows as readCodeTasks,
} from "./code-edge.mjs";
import {
  DEVICE_TOKEN_TTL_MS, MINT_BODY_LIMIT, corsHeaders, createDeviceStore, deviceBearerOf,
  looksLikeDeviceBearer, mintRequest, newDeviceId, parseAppOrigins, publicDevice, readDeviceToken,
  signDeviceToken,
} from "./auth-device.mjs";
import { loadRelayHooks } from "./relay-hooks.mjs";
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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// One writer for every file this console puts inside a box. 0600 on all of them, and the mode is
// set two ways because neither alone is enough: `umask 077` decides the mode of a file this write
// CREATES, and `chmod` fixes one that already exists at the wrong mode -- which is every box on the
// R750, measured 2026-09-08 at 0644 box:box while the host's own writer for the same file uses
// 0o600. SECRET-3. The redirection is what truncates, so a shorter document never leaves a tail of
// the old one behind.
async function writeBoxFile(t, filePath, body) {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", ["exec", "-i", t.box, "sh", "-c",
      `umask 077 && cat > ${filePath} && chmod 600 ${filePath}`],
      (err) => (err ? reject(err) : resolve()));
    child.stdin.end(body);
  });
}
// Merge, never replace: this file is also where the operator's real secrets live.
async function writeSecrets(t, next) {
  return await writeBoxFile(t, SECRETS_PATH, JSON.stringify({ version: 1, secrets: next }));
}
// The other half of the box's credential plane (CONNECT-5): connector env values, keyed by the
// connector they belong to. Read and written here only so the migration can take the operator's
// copied TinyFish key back out of a customer's box.
const CONNECTOR_SECRETS_PATH = "/home/box/sand-data/connector-env-secrets.json";
const readConnectorSecrets = async (t) => {
  const raw = await dockerOut(["exec", t.box, "cat", CONNECTOR_SECRETS_PATH]);
  if (raw == null || String(raw).trim().length === 0) return null;
  try { const parsed = JSON.parse(raw); return typeof parsed === "object" && parsed != null && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
};
const CONNECTORS_PATH = "/home/box/sand-data/connectors.json";

// ---- the box store, the fourth place a credential lives ----------------------------------------
//
// MEASURED ON THE R750 2026-09-08, and it is why the first removal did not remove anything. The
// migration deleted the operator's provider key from box-secrets.json in all three boxes and the
// proof read those three files back and reported it absent. It was not absent: box-store-sync had
// already copied box-secrets.json into the box's own content-addressed store, so a byte-identical
// 539-byte copy of the same 113-character key sat at
//   /var/lib/sand-box-store/<store id>/blobs/<sha256 of the file>
// mode 0644 root:root, in every one of the three boxes, and the agent host runs as root inside the
// box, so any shell tool call a customer's agent makes could read it. An absence proof scoped to
// three files is not an absence proof.
//
// Two halves fix it, and both are needed. The host no longer puts these files in the store at all
// (source/host/durable-file-policy.ts, BOX_STORE_SECRET_FILE_NAMES), which stops the next copy;
// and the sweep below takes out the copies already there, which the exclusion cannot do.
const BOX_STORE_DIR = "/var/lib/sand-box-store";
// The two file names whose stored copies this route is allowed to DELETE outright. Anything else in
// the store that carries the value is reported and left alone: a blob can be a pack holding
// unrelated files, an agent's conversation database or a Chrome profile, and deleting one of those
// to chase a credential is the customer's data gone (BOX-6). Reporting it is the honest answer, and
// rotating the credential at the vendor is the only thing that ends it.
const STORE_SECRET_MARKERS = ['"secrets"', '"servers"'];

// What a grep inside the box printed, as paths. Anchored on being ABSOLUTE rather than on the store
// prefix: the grep was pointed at the store directory, so everything it names is under it, and the
// test harness reaches a directory on this Mac instead of a container so the prefix there is its
// own. Anchoring on the prefix silently found nothing under the harness, which is the shape of bug
// this whole sweep exists because of.
const storeLines = (text) => String(text ?? "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/"));

// Every path under the store whose bytes contain one of `values`. One pass, patterns on stdin so no
// secret ever reaches a command line, where `ps` inside the box would show it.
async function storePathsCarrying(t, values) {
  if (values.length === 0) return [];
  const out = await new Promise((resolve) => {
    const child = execFile("docker", ["exec", "-i", t.box, "sh", "-c",
      `grep -rlsaF -f - -- ${BOX_STORE_DIR} 2>/dev/null || true`],
      { maxBuffer: 8 << 20, timeout: 120_000 }, (err, stdout) => resolve(err != null && !stdout ? "" : String(stdout ?? "")));
    child.stdin.end(values.join("\n") + "\n");
  });
  return storeLines(out);
}

// The stored copies of the two secret files, as {path, parsed}. Found by SHAPE rather than by name,
// because a blob is named after the sha256 of its contents and carries no name at all: the marker
// grep narrows the store to a handful of candidates, and each one is parsed here.
async function storedSecretDocuments(t) {
  const found = await new Promise((resolve) => {
    execFile("docker", ["exec", t.box, "sh", "-c",
      `grep -rlsa ${STORE_SECRET_MARKERS.map((one) => `-e '${one}'`).join(" ")} -- ${BOX_STORE_DIR} 2>/dev/null || true`],
      { maxBuffer: 8 << 20, timeout: 120_000 }, (err, stdout) => resolve(err != null && !stdout ? "" : String(stdout ?? "")));
  });
  const paths = storeLines(found);
  const documents = [];
  for (const filePath of paths.slice(0, 200)) {
    const raw = await dockerOut(["exec", t.box, "sh", "-c", `head -c 262144 -- '${filePath}'`]);
    if (raw == null) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) continue;
    // box-secrets.json is {version, secrets:{...}}; connector-env-secrets.json is {servers:{...},
    // shell:{...}}. A pack, a database or a profile matches neither and is never a delete.
    const isSecrets = typeof parsed.secrets === "object" && parsed.secrets != null && !Array.isArray(parsed.secrets);
    const isConnectors = typeof parsed.servers === "object" && parsed.servers != null && !Array.isArray(parsed.servers);
    if (isSecrets || isConnectors) documents.push({ path: filePath, parsed });
  }
  return documents;
}

// Every string value inside one of those documents, one level deep on the sections that hold them.
function valuesOfStoredDocument(parsed) {
  const values = [];
  const push = (value) => { if (typeof value === "string" && value.length > 0) values.push(value); };
  for (const value of Object.values(parsed?.secrets ?? {})) push(value);
  for (const section of ["servers", "shell"]) {
    const holder = parsed?.[section];
    if (typeof holder !== "object" || holder == null || Array.isArray(holder)) continue;
    for (const value of Object.values(holder)) {
      if (typeof value === "string") push(value);
      else if (typeof value === "object" && value != null && !Array.isArray(value)) for (const inner of Object.values(value)) push(inner);
    }
  }
  return values;
}

async function removeStorePaths(t, paths) {
  if (paths.length === 0) return;
  await new Promise((resolve) => {
    const child = execFile("docker", ["exec", "-i", t.box, "sh", "-c", "xargs -0 rm -f --"],
      { timeout: 60_000 }, () => resolve());
    child.stdin.end(paths.map((one) => `${one}\0`).join(""));
  });
}

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

// MARKET-6: the diff behind POST /connectors. What arrives is still a whole map, because every
// caller sends one; what leaves is one host command per key that actually moved. An entry is
// "the same" only if it serialises identically, so a changed argument is a change and a resend of
// the same file is nothing at all.
//
// `handled: false` means this box's host has no such command -- an older bundle -- and the caller
// falls back to the whole-file write. Anything else the host says is its own answer to give: a
// refusal comes back as the sentence it wrote, not as a 500.
const sameConnectorEntry = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// An entry as it sits in the file, said in the shape the host's one writer takes. A command is a
// program; an address is a remote server, and which way the box opens one is the host's decision,
// not something a whole-map POST gets to state.
//
// Credential values are never carried. A file's env map already holds names against empty values --
// that emptiness is how this box marks a credential the operator still owes -- so the names cross
// as an array and the values stay where they are. A header value crosses exactly as written, which
// for a credential header is the `${NAME}` placeholder the host substitutes out of the 0600 store
// at push time; the host refuses a literal in an auth header, so a caller cannot smuggle one
// through this route either.
function connectorSpecFromEntry(name, config) {
  const env = config?.env ?? {};
  const envNames = Object.keys(env);
  const values = envNames.filter((field) => String(env[field] ?? "").length > 0);
  const url = String(config?.url ?? "").trim();
  if (url) {
    return {
      name,
      url,
      type: String(config?.type ?? config?.transport ?? "http") === "sse" ? "sse" : "http",
      ...(config?.headers == null ? {} : { headers: config.headers }),
      // A configuration variable the operator already answered keeps its value; a credential field
      // is empty and crosses as a name. Sending the whole map when any value is set is what lets an
      // entry like MCP_REMOTE_CONFIG_DIR survive a resave.
      env: values.length === 0 ? envNames : env,
    };
  }
  return {
    name,
    command: String(config?.command ?? ""),
    args: Array.isArray(config?.args) ? config.args.map((one) => String(one)) : [],
    env: values.length === 0 ? envNames : env,
  };
}
async function delegateConnectorChanges(t, held, submitted) {
  const changed = [];
  for (const [name, config] of Object.entries(submitted)) {
    if (!sameConnectorEntry(held[name], config)) changed.push({ op: "add", name, config });
  }
  for (const name of Object.keys(held)) {
    if (!Object.hasOwn(submitted, name)) changed.push({ op: "remove", name });
  }
  if (changed.length === 0) return { handled: true, changed: [] };
  const done = [];
  for (const change of changed) {
    const command = change.op === "add" ? "addLocalConnector" : "removeLocalConnector";
    const args = change.op === "add"
      ? { ...connectorSpecFromEntry(change.name, change.config), replace: true }
      // MARKET-23. An entry deleted here loses its stored value too, the same as the card's Remove
      // and the Marketplace's Uninstall. The host does the two in the order that works, since it
      // resolves a connector's store through connectors.json and cannot reach it once the row has
      // left the file. Without this the editor's delete left an orphaned key with no surface but
      // the Plugins panel's strip.
      : { server: change.name, name: change.name, clearSecrets: true };
    let answer;
    try { answer = await jobBusCall(t, command, args); } catch { return { handled: false }; }
    let body;
    try { body = JSON.parse(answer.text); } catch { body = null; }
    // The one string that separates "this bundle is older than the command" from "the host
    // refused". Nothing else answers it, and treating a refusal as an absent command would write
    // the whole file behind the host's back, which is what this shim exists to stop.
    if (/unknown gateway method/i.test(String(body?.error ?? ""))) return { handled: false };
    if (answer.status >= 400 || body?.error) return { handled: true, error: String(body?.error ?? `the host answered ${answer.status} for ${change.name}`), changed: done };
    done.push(`${change.op} ${change.name}`);
  }
  return { handled: true, changed: done };
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

// ---- what a plan already includes (PROXY-1) ---------------------------------------------------
//
// These rows CANNOT live in a tenant's endpoints.json, and that is the whole design rather than an
// inconvenience. The proxy answers on http://titanbot-proxy:4000/v1 -- plain http, a name on this
// server's own bridge -- which tenantEndpointRefusal above refuses twice over, and rightly: that
// guard is the thing stopping a customer aiming this relay at the machine every other customer is
// on. Relaxing it to let one address through would relax it for every address that resolves the
// same way.
//
// So the rows are COMPUTED from the registry on each request, returned in an array of their own,
// and the virtual key is rendered as the literal word "included" everywhere it would otherwise be
// printed. A tenant with no included set gets an empty array and every path below behaves exactly
// as it did before this existed.
const PLAN_PREFIX = "plan-";
const isPlanId = (id) => String(id ?? "").startsWith(PLAN_PREFIX);
function includedRows(t) {
  const included = t?.entry?.included ?? null;
  if (included == null) return [];
  return included.models.map((row) => ({
    id: row.id, name: row.name, model: row.model, baseUrl: included.baseUrl,
    contextWindow: row.contextWindow, servedBy: row.servedBy, modelLabel: row.modelLabel,
    // Set HERE, out of the registry, and stripped from anything a request body carries before a
    // catalog is written. It is the flag probe() reads to skip the tenant guard, so where it can
    // come from is the whole of that bypass's safety.
    included: true, enforced: included.enforced,
  }));
}

// One probe for the whole included set. Three rows are one question -- same proxy, same base URL,
// same key -- so probing per row would be three requests to say one thing. Cached briefly because
// the console asks for this list twice on a single page load (hydrate, then the settings refresh).
const PROXY_PROBE_CACHE_MS = 10_000;
const proxyProbes = new Map();
async function probeIncluded(t) {
  const included = t?.entry?.included ?? null;
  if (included == null) return null;
  // Keyed on a HASH of the credential, not on keyId: a re-mint is exactly the moment a cached
  // "reachable" becomes a lie, and nothing says the control plane changes the id when it changes
  // the key. Nothing key-shaped goes into a map this way either.
  const key = `${t.slug}\n${included.baseUrl}\n${sha256Hex(included.key)}`;
  const hit = proxyProbes.get(key);
  if (hit != null && Date.now() - hit.at < PROXY_PROBE_CACHE_MS) return hit.health;
  const health = await probe(t, { baseUrl: included.baseUrl, apiKey: included.key, model: null, included: true });
  proxyProbes.set(key, { at: Date.now(), health });
  return health;
}

// Whether this box's endpoint is pinned by its container environment, and by which names.
//
// The host resolves process.env first and box-secrets.json second, so a SAND_OPENAI_COMPATIBLE_*
// variable baked into the container wins over anything written into the file -- and every writer
// on this relay writes the file. GET /endpoints has computed this since TENANT-2 and shows it; the
// SUPER ADMIN's door did not, so `proxy migrate` could report a successful write, list the six
// names it wrote, and leave the box answering through something else entirely. A door that reports
// a write it knows cannot take effect is a door that lies quietly, which is worse than one that
// refuses. Read once here so both callers say the same thing.
//
// A box with no docker under it answers {pinned: false, pinnedBy: null}: not knowing is not the
// same as knowing it is unpinned, and the two callers already refuse without docker anyway.
async function endpointPin(t) {
  const envOut = await dockerOut(["inspect", t.box, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]);
  const names = PROVIDER_KEYS.filter((key) => (envOut ?? "").split("\n").some((line) => line.startsWith(`${key}=`)));
  return {
    pinned: names.length > 0,
    pinnedBy: names.length > 0
      ? `container env (${names.join(", ")}); recreate the box without SAND_OPENAI_COMPATIBLE_* to unpin`
      : null,
  };
}

// A saved endpoint is only useful if it is actually up, so say so rather than implying it.
async function probe(t, endpoint) {
  const started = Date.now();
  // PROXY-1. The one bypass of the tenant guard, and it is not reachable from a request body: the
  // flag is set by includedRows out of the registry, POST /endpoints drops every plan- row and
  // strips this field from the rest before a catalog is written, so there is no path by which a
  // customer types it into a saved endpoint and gets the relay to fetch an address of their
  // choosing. The guard itself and isPrivateAddress are not touched.
  const refusal = endpoint?.included === true ? null : await tenantEndpointRefusal(t, endpoint?.baseUrl);
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
    // MAIL-3. What this workspace's own bots sent, beside what arrived for them and on the same
    // volume, so a customer's Mail card reads both out of their own state directory and nobody
    // else's.
    mailSentLedgerFile: entry.operator ? MAIL_SENT_LEDGER_FILE : file("mail-sent.jsonl"),
    // VOICE-1. The realtime key is a PER-WORKSPACE secret and it lives here, in the tenant's own
    // state directory, beside the mail pair and for the same reason: it is written through the
    // ordinary console session, it is never read back out of any route, and it belongs to one
    // customer rather than to the deployment. The super-admin Providers panel could not hold it --
    // that panel is global, its keys live at LiteLLM and read back masked, and there is no
    // per-workspace provider row on it at all.
    voiceSettingsFile: entry.operator ? stateFile("voice.json", HERE) : file("voice.json"),
    // And what the minutes were spent on, on the same volume, so a workspace's caps are read from
    // its own ledger and nobody else's.
    voiceLedgerFile: entry.operator ? stateFile("voice-minutes.jsonl", HERE) : file("voice-minutes.jsonl"),
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

// ---- STORE-1, the device bearer ----------------------------------------------------------------
//
// A store app bundles its own assets, so its page origin is not this one and a browser never sends a
// SameSite=Strict cookie from there. The credential it can send is a header, and this is where one is
// read. ui/auth-device.mjs holds the token format, the row store and the CORS rules, and the comment
// at the top of it is the argument for each.
//
// ONE STORE PER TENANT, keyed on the context, because the rows live in that tenant's own state
// directory beside mail.json -- the same t.file() split endpoints.json and the mail ledgers use. The
// Map is keyed on the context object rather than the slug so a registry entry that MOVES (a box
// recreated, a state directory repointed) gets a fresh store rather than one aimed at the old path.
const deviceStores = new Map();
function deviceStoreFor(t) {
  if (t == null) return null;
  const found = deviceStores.get(t);
  if (found != null) return found;
  const store = createDeviceStore(t.file("devices.json"), { own: (file) => { void ownLikeParent(file); } });
  deviceStores.set(t, store);
  // One entry per live context. contextOf rebuilds a context only when its registry row actually
  // changed, so this is bounded by the tenant count and not by the request count; the sweep keeps a
  // long-lived relay from holding a store for every box that was ever recreated under it.
  if (deviceStores.size > 256) {
    for (const key of deviceStores.keys()) { if (deviceStores.size <= 128) break; if (key !== t) deviceStores.delete(key); }
  }
  return store;
}

// A bad bearer is rate limited and does NOT charge the password lockout, which is the one decision in
// this whole item that is about a customer's day rather than about an attacker. The shared `throttle`
// object is also the job bus's and the console login's, so an app looping on a token that expired
// while the phone was in a drawer would lock its owner out of his own laptop's console. 60 a minute
// per address is the same fixed-window shape the job bus uses, and it is plenty: an app is told to
// stop on a 401, re-mint once, then ask the person.
const deviceUseLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

// The verified device payload for a request, or null. Two gates, in this order: the signature and the
// clock (no I/O at all), then the row on disk through the mtime-gated cache. The row is what makes
// Revoke mean something, and the cache window is what bounds how long a revoked device keeps working.
//
// The tenant comes off the VERIFIED payload and the row is read out of THAT tenant's directory, so a
// token minted for one workspace cannot be presented against another: the slug it names is the slug
// whose devices.json is consulted, and a row under a different tenant is simply not there.
// Once per REQUEST, not once per caller. tenantOf asks, subOf asks, the gate asks and then the tenant
// resolution asks again, so a single /api call from a phone would otherwise verify the same HMAC four
// times and stat the same file four times. The answer is stamped on the request object, which lives
// exactly as long as the answer is true for.
const DEVICE_SESSION = Symbol("deviceSession");

function deviceSessionOf(req) {
  if (req != null && Object.prototype.hasOwnProperty.call(req, DEVICE_SESSION)) return req[DEVICE_SESSION];
  const answer = readDeviceSession(req);
  if (req != null) Object.defineProperty(req, DEVICE_SESSION, { value: answer, enumerable: false, configurable: true });
  return answer;
}

function readDeviceSession(req) {
  if (AUTH == null) return null;
  const token = deviceBearerOf(req.headers.authorization);
  if (token.length === 0) return null;
  const payload = readDeviceToken(token, AUTH.cookieSecret);
  if (payload == null) return null;
  const t = contextOf(String(payload.tenant ?? ""));
  if (t == null) return null;
  const store = deviceStoreFor(t);
  const row = store?.live(payload.did, payload.iat);
  if (row == null) return null;
  // At most one write per device per ten minutes, so the device list on a console page is honest to
  // the minute without the hot path touching the disk per request.
  try { store.touch(payload.did); } catch { /* a read-only volume is not a reason to refuse a request */ }
  return { payload, row, tenant: String(payload.tenant), sub: String(payload.sub ?? ""), context: t };
}

// Which tenant this request is for, or null when it is not signed in at all.
//
// With no password configured the console is a loopback developer console and every request is the
// operator's, which is the shape it has always had. The gateway bearer is the operator's too. A
// cookie minted before this shipped carries no tenant claim and reads back as the operator, which
// is what keeps a session alive across the deploy.
//
// The device arm is the THIRD and last way in, and it is deliberately the narrowest: it answers a
// tenant and nothing more, so every route below the gate treats a phone exactly as it treats a
// browser, and a device bearer can never do more than the cookie can. It cannot mint a cookie
// (mintSessionFromBearer returns early for it), it cannot open /v1 (handleJobBus refuses it by
// shape), and it cannot open the websocket upgrade at all, because a browser WebSocket carries no
// headers. A phone therefore gets no live screen by construction as well as by design.
function tenantOf(req) {
  if (AUTH == null) return OPERATOR_SLUG;
  if (bearerMatches(req)) return OPERATOR_SLUG;
  if (looksLikeDeviceBearer(req.headers.authorization)) return deviceSessionOf(req)?.tenant ?? null;
  const payload = sessionPayload(req);
  if (payload == null) return null;
  const claimed = typeof payload.tenant === "string" ? payload.tenant.trim() : "";
  return claimed.length > 0 ? claimed : OPERATOR_SLUG;
}
function isAuthorized(req) {
  return tenantOf(req) != null;
}

// WHICH PERSON this request is, or "" for the workspace itself.
//
// "" means the operator, or a session minted by the INSTANCE password, which is the machine's door and
// names nobody. Everything per-person -- the device list, a push registration, quiet hours -- keys on
// this, and "" reads as the workspace's own, which is the same precedent the tenant claim already set:
// the comment on tenantOf records that an absent claim means the operator, and that is a test rather
// than an assumption (tests/relay-device-bearer.test.mjs, "a sub-less cookie reads as the operator").
//
// It exists because accounts.tenant carries no UNIQUE constraint (cp/store.mjs:116-124), so two people
// can share one workspace and nothing else in this process could tell them apart.
function subOf(req) {
  if (AUTH == null) return "";
  if (bearerMatches(req)) return "";
  if (looksLikeDeviceBearer(req.headers.authorization)) return deviceSessionOf(req)?.sub ?? "";
  const payload = sessionPayload(req);
  const claimed = typeof payload?.sub === "string" ? payload.sub.trim() : "";
  return claimed;
}

// A bearer on a page request also mints a session, so a browser handed the token as a header can
// go on to do the things a browser does: an EventSource carries no custom header, an iframe
// carries none either, and a page opened with the bearer would otherwise paint and then be
// refused on its own subresources. Holding the token is already full access -- every /api call
// this process forwards carries it -- so the cookie adds no capability, it only puts the access
// somewhere the browser will keep sending. /api is excluded because a script calling the API is
// not a session and does not want one.
//
// A DEVICE BEARER NEVER MINTS ANYTHING. That early return pays twice. Once because a cookie is strictly
// more than a device token is meant to be -- the cookie opens the websocket upgrade, which is the box's
// screen and keyboard, and a phone is deliberately not given that. And once because a Set-Cookie on an
// asset response is a Cloudflare cache bypass: every stamped asset a shell read would come back with
// one and the edge would stop caching the console's own code for everybody.
function mintSessionFromBearer(req, res, url) {
  if (AUTH == null) return;
  if (url.pathname.startsWith("/api/")) return;
  if (looksLikeDeviceBearer(req.headers.authorization)) return;
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
//
// STORE-1. A REQUEST CARRYING AN AUTHORIZATION HEADER IS NEVER REDIRECTED. Measured on
// grok-bot-local-vm 2026-09-09: `Accept: text/html` is what a web view sends on a document fetch and
// what fetch() sends when an app copies the browser's own headers, so a cross-origin read whose bearer
// had expired followed a 302 into the login page and the shell got 200 OK with a sign-in form in it.
// An app cannot branch on that. With a header present the answer is always the JSON 401 with
// x-relay-auth: required, which docs/APPS.md tells a shell to read: stop, re-mint once, then ask the
// person, never loop.
//
// The other half of that refusal is documented rather than coded, because it is the shell's job: the
// 401 body is application/json, which Chrome's Opaque Response Blocking turns into
// net::ERR_BLOCKED_BY_ORB for a bare <script> or <img> rather than an error the page can see. So the
// contract is fetch plus blob URLs for images, never a bare subresource on a cross-origin read.
function denyUnauthenticated(req, res, url) {
  const presentedHeader = String(req.headers.authorization ?? "").length > 0;
  const wantsHtml = !presentedHeader && req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
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
// The Ti mark, inline, and inline is the whole point: the comment above loginPage says an asset path
// exempted from the session check would be a hole in the thing this page exists to close. It is the
// rounded-square signature off the product's own brand board -- the outlined tile, the T, the i stem,
// and the i's dot in Signal Cyan -- taken from the first four shapes of
// ui/machine-room/assets/titanium-bot-logo.svg with the wordmark and the gradients dropped, because
// 6 KB of gradient definitions on a login page buys nothing a flat silver does not.
const TI_MARK = `<svg class="mark" viewBox="0 0 1024 1024" width="34" height="34" aria-hidden="true" focusable="false">`
  + `<path fill="#E6EBF2" fill-rule="evenodd" d="M300 60H724Q964 60 964 300V724Q964 964 724 964H300Q60 964 60 724V300Q60 60 300 60Z`
  + ` M300 155Q155 155 155 300V724Q155 869 300 869H724Q869 869 869 724V300Q869 155 724 155Z"/>`
  + `<path fill="#E6EBF2" d="M250 280H596V412H494V793H448Q354 793 354 699V412H328Q250 412 250 334Z"/>`
  + `<path fill="#E6EBF2" d="M648 467H794V682Q794 793 683 793H648Z"/>`
  + `<rect x="648" y="280" width="146" height="146" rx="42" fill="#00C8F0"/></svg>`;

// DOOR-1. This page is the first screen a customer ever sees, and before this ship it was titled
// "Machine Room", painted in a purple nothing else in the product uses, and laid out 10 px wider than
// a 390 px phone. Four things were measured on grok-bot-local-vm at 390x844 on 2026-09-09 and each
// one is fixed here rather than worked around.
//
// THE 10 PX. The form was content-box at `width: min(360px, calc(100vw - 48px))` with 28 px of padding
// and a 1 px border on each side, so at 390 it laid out 342 + 56 + 2 = 400 and the document panned
// sideways. `box-sizing: border-box` is the fix. Correcting the subtrahend instead would have left the
// same arithmetic one padding change away from being wrong again.
//
// THE ZOOM. iOS Safari zooms the page whenever a focused control's text is under 16 px, and body set
// 14 px with both the inputs and the button at `font: inherit`. So BOTH move, explicitly, and the
// autofocus attribute is REMOVED OUTRIGHT rather than media-queried, because HTML has no media query
// and an attribute that only matters on a phone has no business being on the desktop page either.
//
// WHAT CHROME CANNOT PROVE. visualViewport.scale stayed 1 through focus at both phone widths in real
// headless Chrome, so no gate in this repo can claim a measured no-zoom on iOS. The evidence
// scripts/verify-door.mjs prints instead is the computed font-size on every control plus the absent
// attribute, which are the two things the behaviour is defined in terms of.
//
// THE PALETTE is the product's own board and not the parent company's: Midnight #090D14, Graphite
// #172232, Titanium #E6EBF2, Signal Cyan #00C8F0. The two doors behave exactly as they did -- the
// email field only when there is a control plane, filled means the account, empty means the instance
// password, one form, one button, the error inline.
function loginPage({ error = "", next = "/", tenant = false } = {}) {
  return `<!doctype html>
<html lang="en" data-theme="dusk">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Sign in - Titanium Bot</title>
<link rel="icon" href="data:," />
<style>
  :root { color-scheme: dark;
    --midnight: #090D14; --graphite: #172232; --titanium: #E6EBF2; --cyan: #00C8F0; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    /* env() on the body so the card clears a notch in landscape as well as the home indicator. */
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
             max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    box-sizing: border-box;
    background: radial-gradient(1100px 640px at 18% -12%, #13243A 0%, var(--midnight) 62%) var(--midnight);
    color: var(--titanium);
    font: 400 14px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  /* border-box, so the padding and the border are INSIDE the 360, which is what the 400 px document
     on a 390 px screen was. */
  form { box-sizing: border-box; width: min(360px, 100%); padding: 28px; border-radius: 20px;
    background: rgba(23,34,50,0.86); border: 1px solid rgba(230,235,242,0.10);
    box-shadow: 0 30px 90px rgba(3,6,11,0.58), inset 0 1px 0 rgba(230,235,242,0.10); }
  /* The brand lockup IS the h1: the mark and the product's name, once, rather than a wordmark above a
     heading that repeats it. */
  h1 { display: flex; align-items: center; gap: 10px; margin: 0 0 6px;
    font-size: 17px; font-weight: 600; letter-spacing: 0.01em; }
  .mark { display: block; flex: none; }
  h1 b { font-weight: 600; color: var(--cyan); }
  p.sub { margin: 0 0 20px; font-size: 13px; color: rgba(230,235,242,0.52); }
  label { display: block; font-size: 13px; color: rgba(230,235,242,0.72); margin-bottom: 6px; }
  /* 16px on both controls, explicitly: body is 14px and font: inherit would carry that down, which
     is the size iOS zooms for. 44px minimum height is the touch target. */
  input { width: 100%; box-sizing: border-box; min-height: 44px; padding: 11px 12px; border-radius: 10px;
    border: 1px solid rgba(230,235,242,0.18); background: rgba(9,13,20,0.55);
    color: var(--titanium); font: inherit; font-size: 16px; }
  input:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(0,200,240,0.26); }
  button { margin-top: 18px; width: 100%; min-height: 44px; padding: 11px 12px; border-radius: 10px;
    border: 0; background: var(--cyan); color: var(--midnight); font: inherit; font-size: 16px;
    font-weight: 600; cursor: pointer; }
  button:hover { background: #2BD6F5; }
  button:focus-visible { outline: 2px solid var(--titanium); outline-offset: 2px; }
  .error { margin-top: 14px; padding: 9px 11px; border-radius: 10px; font-size: 13px;
    background: rgba(255,111,114,0.14); border: 1px solid rgba(255,111,114,0.38); color: #FFB3B4; }
  p.also { margin: 8px 0 0; font-size: 13px; color: rgba(230,235,242,0.52); }
  label.second { margin-top: 14px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>${TI_MARK}<span>Titanium <b>Bot</b></span></h1>
  <p class="sub">${tenant ? "Sign in with your Titanium Bot account" : "This console drives the box. Sign in to reach it."}</p>
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  ${tenant ? `<label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" inputmode="email" />
  <label class="second" for="password">Password</label>` : `<label for="password">Password</label>`}
  <input id="password" name="password" type="password" autocomplete="current-password" required />
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
  //
  // STORE-1 adds `sub`, the account id, off the same verified token. It was already here and thrown
  // away, and it is what every per-person thing keys on: two people can share a workspace
  // (accounts.tenant has no UNIQUE constraint), so "my devices" and "my pushes" cannot be the
  // workspace's.
  const cookie = serializeCookie(SESSION_COOKIE,
    createSession(AUTH.cookieSecret, {
      nowMs: now, lifetimeMs,
      tenant: String(payload.tenant ?? ""),
      sub: String(payload.sub ?? ""),
    }),
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

// ---- POST /auth/token, the token door (STORE-1, docs/APPS.md) -----------------------------------
//
// An app signs in once and holds a named, revocable, thirty-day device bearer. ui/auth-device.mjs
// holds the format, the rows and the CORS rules, and the five rules at the top of it are the argument
// for every choice here.
//
// WHY THIS ROUTE SITS IN THE PRE-LOGIN BAND, beside GET /auth/state, rather than below the gate: a
// caller minting a token has no cookie and no bearer by definition, and anything below the gate is
// refused before it is reached. Measured on grok-bot-local-vm 2026-09-09: OPTIONS /api/getHealth with
// an Origin answered 401 with x-relay-auth: required, because no OPTIONS handler existed anywhere in
// this file. So the preflight is answered above the gate too (handleCors, called from the entry).
//
// THREE WAYS IN, and the third is the one that makes an app pleasant to own:
//
//   {email, password, device}  the account door, verified by the control plane exactly as the login
//                              page's is -- same call, same verdict, same ledger row.
//   {password, device}         the instance password, the operator's door, which still works when the
//                              control plane does not answer.
//   {device}                   a silent re-mint, allowed ONLY when the request already carries a live
//                              device bearer. So an app in regular use never meets a password prompt
//                              again and a phone left in a drawer for a month is dead.
//
// A FAILED MINT CHARGES THE PASSWORD LOCKOUT, through clientOf and never through a raw header: a
// bearer is guessed exactly the way a password is, and the shared throttle object is the one that
// carries the TENANT-5 box-peer special case for a reason. The USE of a bad bearer does not, which is
// deviceUseLimiter's whole job.
const DEVICE_MINT_REFUSAL = "that sign-in did not work";

async function handleDeviceTokenMint(req, res) {
  if (req.method !== "POST") return fail(res, 405, "POST");
  if (AUTH == null) return fail(res, 404, "not found");
  const key = clientOf(req);
  const wait = throttle.retryAfterMs(key);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    // The DOOR is the credential, not the client: ui/login-ledger.mjs keeps `account` and `instance`,
    // and a mint from an app is one of those two. What says it came from an app is the user agent,
    // which every row already carries, so the panel can tell a phone from a browser without this file
    // inventing a third door in a ledger it does not own.
    noteLoginAttempt(req, { door: "instance", outcome: "locked" });
    return endAndClose(req, res, 429, { "content-type": "application/json", "retry-after": String(seconds) },
      JSON.stringify({ error: `too many attempts; wait ${seconds}s` }));
  }

  let raw;
  try { raw = await readBody(req, MINT_BODY_LIMIT); }
  catch (error) {
    if (error?.code !== "BODY_TOO_LARGE") throw error;
    throttle.recordFailure(key);
    noteLoginAttempt(req, { door: "instance", outcome: "refused" });
    return drainThenEnd(req, res, 413, { "content-type": "application/json" },
      JSON.stringify({ error: "that is not a sign-in" }));
  }
  const shaped = mintRequest(raw);
  if (shaped.error != null) return fail(res, 400, shaped.error);

  // The silent re-mint. Checked FIRST and before the throttle is ever charged, because a live bearer
  // is already a proved credential and re-proving it must not be able to lock anybody out.
  const live = deviceSessionOf(req);
  if (live != null && shaped.password.length === 0 && shaped.email.length === 0) {
    return answerDeviceToken(req, res, {
      t: live.context, sub: live.sub, device: { ...shaped.device, id: shaped.device.id || live.row.id }, renewed: true,
    });
  }

  // The account door. The same call the login page makes, so a password that works on one works on
  // the other and there is one place that decides.
  if (RELAY != null && shaped.email.length > 0) {
    const verdict = await accountSignIn({
      config: RELAY, email: shaped.email, password: shaped.password, client: key, keyOf: sessionKeyFor,
    });
    const note = (outcome, tenant = "") =>
      noteLoginAttempt(req, { door: "account", email: shaped.email, outcome, tenant, password: shaped.password });
    if (verdict.kind === "session") {
      throttle.recordSuccess(key);
      note("ok", String(verdict.payload.tenant ?? ""));
      const t = contextOf(String(verdict.payload.tenant ?? ""));
      if (t == null) return fail(res, 503, NOT_AVAILABLE_SENTENCE);
      console.log(`device token minted for ${t.slug} by account from ${key}`);
      return answerDeviceToken(req, res, { t, sub: String(verdict.payload.sub ?? ""), device: shaped.device, renewed: false });
    }
    if (verdict.kind === "unknown") { note("refused"); return fail(res, 503, NOT_AVAILABLE_SENTENCE); }
    if (verdict.kind === "busy") return fail(res, 429, "too many attempts; wait a minute", { "retry-after": "60" });
    if (verdict.kind === "unreachable") return fail(res, 503, "the sign-in service is not answering");
    if (verdict.kind === "message") { note("refused"); return fail(res, 401, verdict.text); }
    throttle.recordFailure(key);
    note("refused");
    return fail(res, 401, DEVICE_MINT_REFUSAL, RELAY_AUTH_HEADER);
  }

  // The instance door. The operator's, which means the operator's workspace and names no person.
  if (!verifyPassword(shaped.password, AUTH.password)) {
    throttle.recordFailure(key);
    noteLoginAttempt(req, { door: "instance", outcome: "refused", password: shaped.password });
    console.log(`device token refused from ${key}`);
    return fail(res, 401, DEVICE_MINT_REFUSAL, RELAY_AUTH_HEADER);
  }
  throttle.recordSuccess(key);
  noteLoginAttempt(req, { door: "instance", outcome: "ok", tenant: OPERATOR_SLUG });
  const t = contextOf(OPERATOR_SLUG);
  if (t == null) return fail(res, 503, NOT_AVAILABLE_SENTENCE);
  console.log(`device token minted for ${OPERATOR_SLUG} by the instance password from ${key}`);
  return answerDeviceToken(req, res, { t, sub: "", device: shaped.device, renewed: false });
}

/**
 * The row, then the token over it. In that order, and it matters: the row's id is what the token
 * names, and the row's tokenIat is what makes the PREVIOUS token for the same device stop working --
 * so a person who re-mints because a phone was stolen does not leave the stolen phone live for a
 * month.
 *
 * The token is in the body and nowhere else: not a cookie, not a URL, not a log line. It is answered
 * once, at the mint, and the device list never shows it again.
 */
function answerDeviceToken(req, res, { t, sub, device, renewed }) {
  const store = deviceStoreFor(t);
  if (store == null) return fail(res, 503, NOT_AVAILABLE_SENTENCE);
  t.ensureDir();
  const nowMs = Date.now();
  let row;
  try { row = store.upsert({ ...device, id: device.id || newDeviceId(), sub, tokenIat: nowMs }); }
  catch (error) { return fail(res, 500, `the device list could not be written: ${error?.message ?? error}`); }
  const { token } = signDeviceToken({ tenant: t.slug, sub, did: row.id, nowMs }, AUTH.cookieSecret);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  return res.end(JSON.stringify({
    token,
    expiresAt: nowMs + DEVICE_TOKEN_TTL_MS,
    renewed: renewed === true,
    tenant: t.slug,
    device: publicDevice(row),
  }));
}

// ---- GET /auth/devices and DELETE /auth/devices/<id>, below the gate ---------------------------
//
// What a person sees and what they can take away. It is scoped by PERSON and not by workspace
// (subOf), because two accounts can share one workspace and one customer's phone list is not the
// other's. The operator, and any session minted by the instance password, sees the workspace's own
// rows -- the ones with no person on them -- which is the same precedent as the tenant claim.
//
// A revoked device's next /api call is a 401 within one cache window, which is at most two seconds
// (DEVICE_CACHE_MS). That bound is a gate leg rather than a claim.
const DEVICE_ROUTE = /^\/auth\/devices(?:\/([^/]+))?$/;

function handleDeviceList(req, res, t, sub) {
  const store = deviceStoreFor(t);
  const rows = (store?.forSub(sub) ?? []).map(publicDevice)
    .sort((a, b) => Number(b.lastSeenAt ?? 0) - Number(a.lastSeenAt ?? 0));
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  return res.end(JSON.stringify({ tenant: t.slug, devices: rows }));
}

function handleDeviceRevoke(req, res, t, sub, id) {
  const store = deviceStoreFor(t);
  if (store == null) return fail(res, 503, NOT_AVAILABLE_SENTENCE);
  let gone;
  // The sub is part of the match, so one person cannot revoke another's phone by guessing an id.
  try { gone = store.revoke(id, { sub }); }
  catch (error) { return fail(res, 500, `the device list could not be written: ${error?.message ?? error}`); }
  if (!gone) return fail(res, 404, "no such device");
  // And its push row with it, in the same action. Not awaited and never able to fail this revoke:
  // the bearer is dead the moment the line above returns, and a person revoking a phone they lost
  // must not be told the revoke failed because a notification row would not delete. It IS logged.
  // The same sub the bearer store just matched on, so this cannot remove a push row belonging to
  // another account that happens to have chosen the same device id.
  void HOOKS.pushForgetDevice(t.slug, id, sub).then((answer) => {
    if (answer?.ok === true && answer?.removed === true) console.log(`device ${id} will not be notified on ${t.slug} either`);
  }).catch(() => {});
  console.log(`device ${id} revoked on ${t.slug}`);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  return res.end(JSON.stringify({ revoked: id, tenant: t.slug }));
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

// One box-health sweep, shared.
//
// The sweep runs `docker inspect`, `docker stats` and `du -sk` once per customer, which is real
// work on the host. One refresh of the admin console asks for it twice, because the Box health
// panel and the System health panel both want it, and two asks used to be two full fleet sweeps
// running at the same time. `inFlight` makes concurrent asks share one sweep; the short window
// makes back-to-back asks share one too. Anything older than the window is measured again, because
// a health panel that shows a cached minute is a panel that quietly shows the past.
const BOX_HEALTH_CACHE_MS = 5_000;
let boxHealthShared = { at: 0, report: null, inFlight: null };
function sharedBoxHealth() {
  if (boxHealthShared.report != null && Date.now() - boxHealthShared.at < BOX_HEALTH_CACHE_MS) {
    return Promise.resolve(boxHealthShared.report);
  }
  if (boxHealthShared.inFlight != null) return boxHealthShared.inFlight;
  const pending = readBoxHealth(registry.all()).then(
    (report) => { boxHealthShared = { at: Date.now(), report, inFlight: null }; return report; },
    (error) => { boxHealthShared = { at: 0, report: null, inFlight: null }; throw error; },
  );
  boxHealthShared = { ...boxHealthShared, inFlight: pending };
  return pending;
}

// PROXY-1. The migration's two doors, and they are on this relay for the same reason the other two
// are: writing inside a box needs the docker socket, and the control plane's container deliberately
// has none. The control plane drives the migration, this relay is the only thing that can touch a
// box's files, and CP_RELAY_TOKEN is the one credential between them.
//
// Neither answers with a value. What leaves this process is a NAME, a LENGTH and the first twelve
// hex characters of a sha256, which is enough to prove a specific key is gone from a specific box
// and not enough to be one.
const TENANT_ADMIN_ROUTE = /^\/admin\/tenants\/([^/]+)\/(use-included|forget-provider-keys|rollback-included)$/;
// PROVIDERS-1. WHAT A BOX IS ACTUALLY RUNNING, read rather than assumed. GET only, and it answers
// with three plain strings and no credential at all.
//
// The super admin's Providers panel used to report `labelBehind: null` for every plan model,
// because the label a customer's Titan says lives in that box's own box-secrets.json and nothing
// reported it back. The control plane cannot read that file itself: MEASURED ON THE R750
// 2026-09-08 from inside titanbot-cp, /data/titanbot/<slug>/volumes/data/box-secrets.json answers
// EACCES for demo and richard-avery (0600, owned by the box user) and ENOENT for the adopted
// titanium, whose directories are somewhere else entirely. This relay can: it has the docker socket
// and reads the file through the box the same way the model picker does. So it says so, once per
// tenant, and the panel counts the boxes that are behind.
const TENANT_RUNNING_ROUTE = /^\/admin\/tenants\/([^/]+)\/running$/;
// AGENTS-CAP-2. HOW MANY BOTS A WORKSPACE MAY HOLD, read off the box on a GET and written into the
// box on a POST. The super admin's Clients panel is the only caller and CP_RELAY_TOKEN is the only
// credential, the same pair as the two routes above.
//
// It is one route with two methods rather than two routes because the answer shape is identical:
// the write ends by reading the number back through the box's own getAgentCapacity, so "what it is
// now" is the same computation either way. Reporting the number that was SENT would report a
// success on a box whose container environment pins something else.
const TENANT_CEILING_ROUTE = /^\/admin\/tenants\/([^/]+)\/ceiling$/;
// CLOUD-BROWSER-1. WHAT A TENANT SPENT ON CLOUD BROWSERS, read out of that tenant's own box.
//
// The host writes one JSONL row per cloud session to /home/box/sand-data/cloud-browser-ledger.jsonl
// (0600, no secrets, the session id but never the endpoint that carries its credential). That path
// and that row shape are a written contract with the marketplace panel, which reads this route.
//
// It is on the relay rather than the control plane for the same reason box health is: reading a
// file inside a box needs the docker socket, and the control plane's container deliberately has
// none. The row's own `tenant` field is whatever the box calls itself, which is not authoritative
// -- nothing pushes a control-plane slug into a box -- so the answer carries the slug this relay
// resolved the container by, which is.
const TENANT_CLOUD_BROWSER_ROUTE = /^\/admin\/tenants\/([^/]+)\/cloud-browser$/;
// STORE-1. ONE TENANT'S DEVICE ROWS, AND KILLING ONE, from the control plane's own credential.
//
// GET lists; DELETE with ?id=<device> revokes. It is on the relay for the same reason box health is:
// the rows live in the tenant's own state directory beside mail.json, and the control plane's
// container does not read inside a box or a tenant volume. CP_RELAY_TOKEN is the credential, the same
// one every other route in this band takes.
//
// Why it exists at all: a customer whose phone is lost and who cannot sign in to revoke it himself
// needs somebody able to do it, and "ssh to the R750 and edit a JSON file" is exactly the hand
// operation that has to become a command. cp/cli.mjs device list / device revoke is that command.
const TENANT_DEVICES_ROUTE = /^\/admin\/tenants\/([^/]+)\/devices$/;
const CLOUD_BROWSER_LEDGER_PATH = "/home/box/sand-data/cloud-browser-ledger.jsonl";
const sha256Hex = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
const evidenceOf = (name, value) => ({ name, length: String(value ?? "").length, sha256: sha256Hex(value).slice(0, 12) });

async function handleRelayAdmin(req, res, url) {
  const expected = String(RELAY?.relayToken ?? "");
  if (expected.length === 0) return fail(res, 404, "not found");
  const action = TENANT_ADMIN_ROUTE.exec(url.pathname);
  const running = TENANT_RUNNING_ROUTE.exec(url.pathname);
  const ceiling = TENANT_CEILING_ROUTE.exec(url.pathname);
  const cloudBrowser = TENANT_CLOUD_BROWSER_ROUTE.exec(url.pathname);
  const devices = TENANT_DEVICES_ROUTE.exec(url.pathname);
  // The method refusal still comes before the credential, so a wrong method charges nobody's
  // lockout and learns nothing. The three reads are GET-only; the two migration doors are POST-only,
  // because each of them changes a file inside somebody's box. The ceiling is the one route that
  // reads and writes, so it takes either -- and the two existing branches are untouched: the
  // expression below still answers exactly "GET" or "POST" for every path they match. The device
  // route lists and revokes, so it takes GET or DELETE.
  const allowed = devices != null ? ["GET", "DELETE"]
    : ceiling != null ? ["GET", "POST"] : (action == null ? "GET" : "POST");
  if (Array.isArray(allowed) ? !allowed.includes(req.method) : req.method !== allowed) {
    return fail(res, 405, Array.isArray(allowed) ? allowed.join(" or ") : allowed);
  }
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
    const report = await sharedBoxHealth();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(report));
  }

  if (running != null) return await reportRunning(res, decodeURIComponent(running[1]));

  if (ceiling != null) return await handleTenantCeiling(req, res, decodeURIComponent(ceiling[1]));
  if (cloudBrowser != null) return await reportCloudBrowser(res, decodeURIComponent(cloudBrowser[1]));
  if (devices != null) return handleAdminDevices(req, res, url, decodeURIComponent(devices[1]));

  if (action != null) return await handleTenantMigration(req, res, decodeURIComponent(action[1]), action[2]);

  return fail(res, 404, "not found");
}

/**
 * One tenant's device rows for the control plane, and killing one.
 *
 * EVERY ROW, not one person's: the caller is the operator holding CP_RELAY_TOKEN and the question they
 * are answering is "which devices can reach this workspace at all". That is also why the revoke here
 * takes no sub -- an operator revoking a lost phone for a customer who cannot sign in does not know
 * which of two people on a shared workspace it belongs to, and making them guess would be the hand
 * operation this route exists to replace.
 *
 * No token is ever in the answer. A token is answered once, at the mint, and nothing reads one back.
 */
function handleAdminDevices(req, res, url, slug) {
  const t = contextOf(slug);
  if (t == null) return fail(res, 404, NOT_AVAILABLE_SENTENCE);
  const store = deviceStoreFor(t);
  if (store == null) return fail(res, 503, NOT_AVAILABLE_SENTENCE);
  if (req.method === "DELETE") {
    const id = String(url.searchParams.get("id") ?? "").trim();
    if (id.length === 0) return fail(res, 400, "name a device with ?id=");
    let gone;
    try { gone = store.revoke(id); }
    catch (error) { return fail(res, 500, `the device list could not be written: ${error?.message ?? error}`); }
    if (!gone) return fail(res, 404, "no such device");
    console.log(`device ${id} revoked on ${slug} by the control plane`);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ slug, revoked: id }));
  }
  const rows = store.all().map((row) => ({ ...publicDevice(row), sub: String(row.sub ?? "") }))
    .sort((a, b) => Number(b.lastSeenAt ?? 0) - Number(a.lastSeenAt ?? 0));
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  return res.end(JSON.stringify({ slug, measuredAt: new Date().toISOString(), devices: rows }));
}

/**
 * One tenant's cloud browser ledger, folded, with the money on it.
 *
 * Two lines go into that file per session -- one before the connect so an orphan can be found, one
 * when it stops -- and this folds them by session id, last write winning. A session with no closing
 * line comes back with `endedAt: null`, which is exactly what an operator needs to see: it is the
 * shape of a browser that may still be running on somebody's bill.
 *
 * `proxyBytes` stays null where the vendor publishes no figure. Browserbase's session object
 * carries it; Browser Use documents no per-browser traffic number at all. A zero there would read
 * as "this session used no proxy", and on a residential exit at $5 a gigabyte that is the most
 * expensive wrong number this file could print, so the field is null and the panel says
 * "not reported by this vendor".
 */
async function reportCloudBrowser(res, slug) {
  const t = contextOf(slug);
  if (t == null) return fail(res, 404, NOT_AVAILABLE_SENTENCE);
  const answer = (payload) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ slug, measuredAt: new Date().toISOString(), ...payload }));
  };
  if (!await dockerAvailable()) {
    return answer({ read: false, why: "this relay has no docker under it, so it cannot read inside a box", rows: [], totals: null });
  }
  const raw = await dockerOut(["exec", t.box, "cat", CLOUD_BROWSER_LEDGER_PATH]);
  // No file is not a failure: it is a box that has never opened a cloud browser, which is most of
  // them. "We could not look" and "there is nothing to see" are different answers and only one of
  // them sends an operator anywhere.
  if (raw == null) return answer({ read: true, why: "", rows: [], totals: emptyCloudTotals() });

  const bySession = new Map();
  for (const line of String(raw).split("\n")) {
    const text = line.trim();
    if (text.length === 0) continue;
    let row;
    try { row = JSON.parse(text); } catch { continue; }
    if (row == null || typeof row.sessionId !== "string" || row.sessionId.length === 0) continue;
    const { event: _event, ...rest } = row;
    // The slug this relay resolved the container by wins over whatever the box calls itself.
    bySession.set(row.sessionId, { ...rest, tenant: slug });
  }
  const rows = [...bySession.values()].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  return answer({ read: true, why: "", rows, totals: cloudTotals(rows) });
}

const emptyCloudTotals = () => ({ sessions: 0, minutes: 0, proxyBytes: null, proxyReportedBy: [], open: 0 });

function cloudTotals(rows) {
  let minutes = 0;
  let bytes = 0;
  let anyBytes = false;
  const reporters = new Set();
  for (const row of rows) {
    if (Number.isFinite(Number(row.minutes))) minutes += Number(row.minutes);
    if (Number.isFinite(Number(row.proxyBytes))) {
      bytes += Number(row.proxyBytes);
      anyBytes = true;
      reporters.add(String(row.vendor ?? ""));
    }
  }
  return {
    sessions: rows.length,
    minutes: Math.round(minutes * 100) / 100,
    proxyBytes: anyBytes ? bytes : null,
    proxyReportedBy: [...reporters].filter((name) => name.length > 0).sort(),
    open: rows.filter((row) => row.endedAt == null).length,
  };
}

/**
 * The three names that decide what a customer's Titan says it runs, read out of that box.
 *
 * NO CREDENTIAL LEAVES THIS ROUTE. box-secrets.json also holds SAND_OPENAI_COMPATIBLE_API_KEY and
 * whatever else the operator put there; only these three are read out of it, by name, and the
 * answer is built field by field rather than by filtering a spread -- a filter is one edit away
 * from becoming a passthrough.
 *
 * A box that cannot be read answers `read: false` with the reason. That is deliberately not the
 * same as an empty label: "we could not look" and "it says nothing" send an operator to different
 * places, and reporting the first as the second is how a panel comes to show a green count over a
 * box nobody checked.
 */
async function reportRunning(res, slug) {
  const t = contextOf(slug);
  if (t == null) return fail(res, 404, NOT_AVAILABLE_SENTENCE);
  const answer = (payload) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ slug, measuredAt: new Date().toISOString(), ...payload }));
  };
  if (!await dockerAvailable()) {
    return answer({ read: false, why: "this relay has no docker under it, so it cannot read inside a box", model: "", modelLabel: "", endpointName: "" });
  }
  let secrets;
  try { secrets = await readSecrets(t); }
  catch (error) { return answer({ read: false, why: `that box's own settings file could not be read (${String(error?.message ?? error).split("\n")[0].slice(0, 120)})`, model: "", modelLabel: "", endpointName: "" }); }
  const pin = await endpointPin(t);
  return answer({
    read: true,
    why: "",
    model: String(secrets.SAND_OPENAI_COMPATIBLE_MODEL ?? ""),
    modelLabel: String(secrets.SAND_OPENAI_COMPATIBLE_MODEL_LABEL ?? ""),
    endpointName: String(secrets.SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME ?? ""),
    // A box whose container environment pins the endpoint answers through THAT, whatever the file
    // says, so a panel reading the file alone would report a label the customer never hears.
    ...pin,
  });
}

// ---- one problem report, forwarded to the control plane (FEEDBACK-1) ---------------------------
//
// The POST shape is ui/tenant-login.mjs's, down to the deadline and the verdict union that never
// throws, and for the same reason: a control plane that is down is one service on one machine, and
// a console that threw over it would take the report AND the page with it. What the person gets
// instead is one plain sentence.
const FEEDBACK_TIMEOUT_MS = 15_000;
async function forwardFeedback(req, res, t) {
  const say = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(payload));
  };
  if (RELAY == null) {
    return say(503, { sent: false, message: "This console is not connected to the developers, so the report was not sent. Keep it and pass it on to whoever runs this instance." });
  }
  let body;
  // 96 KB, which is cp/feedback.mjs INTAKE_BYTES and not this file's own opinion: a report carries
  // its evidence twice, as the text the person edited and as the structured copy, so a reader
  // smaller than the control plane's would refuse reports the control plane would have taken.
  try { body = JSON.parse(await readBody(req, 96 * 1024) || "{}"); } catch { return fail(res, 400, "that was not JSON"); }

  let upstream;
  try {
    upstream = await fetch(`${RELAY.cpUrl}/v1/feedback`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${RELAY.relayToken}`,
        "content-type": "application/json",
        accept: "application/json",
        // The workspace, out of the registry this process already resolved, and the only place it
        // is ever set. Whatever the body said about a workspace is not read here or there.
        "x-titanbot-tenant": t.slug,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });
  } catch (error) {
    return say(502, {
      sent: false,
      message: error?.name === "TimeoutError"
        ? "The developers' service did not answer in time, so the report was not sent. Try again in a minute."
        : "The developers' service did not answer, so the report was not sent. Try again in a minute.",
    });
  }
  let answer = null;
  try { answer = await upstream.json(); } catch { answer = null; }
  if (upstream.status === 201) {
    return say(201, { sent: true, id: Number(answer?.id ?? 0), tier: String(answer?.tier ?? ""), message: "Sent. It is with the developers now." });
  }
  const said = String(answer?.message ?? "").split("\n")[0].slice(0, 200);
  return say(upstream.status >= 400 && upstream.status < 500 ? 400 : 502, {
    sent: false,
    message: said.length > 0 ? said : `The developers' service answered ${upstream.status}, so the report was not sent.`,
  });
}

// ---- how many bots a workspace may hold (AGENTS-CAP-2) -----------------------------------------
//
// The file, its path, and the two facts about it that decide the shape of everything below.
//
// FIRST: the host's settings reader takes a value ONLY when typeof value === "string", so a number
// written here is silently ignored and the workspace runs on the product default with nothing
// anywhere saying why. Every write below goes through String().
//
// SECOND: writeBoxFile TRUNCATES, and all three live R750 boxes carry SAND_TOOL_TRACE and
// SAND_SELF_TALK_CAP in this same file. So a write is a read, a merge and a write, never a write of
// one key. Measured read-only on the R750 2026-09-09: all three boxes hold "SAND_MAX_AGENTS": "100"
// as a string with an empty container environment.
const HOST_SETTINGS_PATH = "/home/box/sand-data/sand-host-settings.json";
// Some hosts nest the values under a "settings" key and some do not. Both are read and the shape
// that was there is the shape that is written back, because rewriting a nested file as a flat one
// would drop every other switch in it.
function settingsContainerOf(parsed) {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return { document: {}, container: {}, nested: false };
  const inner = parsed.settings;
  if (inner != null && typeof inner === "object" && !Array.isArray(inner)) return { document: parsed, container: inner, nested: true };
  return { document: parsed, container: parsed, nested: false };
}
// A box that has no settings file yet gets a FLAT one, which is what every box on the fleet holds.
// `nested` carries the shape rather than an identity test on two objects: the missing-file case
// handed back two different empty objects, so the test read false and wrote a nested document into
// a box that had never had one. grok-bot-local-vm holds no SAND_MAX_AGENTS at all, which is exactly
// the box this wave measures the default on.
async function readHostSettings(t) {
  const raw = await dockerOut(["exec", t.box, "cat", HOST_SETTINGS_PATH]);
  if (raw == null || String(raw).trim().length === 0) return { document: {}, container: {}, nested: false };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return { document: {}, container: {}, nested: false, unreadable: true }; }
  return settingsContainerOf(parsed);
}

/**
 * What the box itself says its ceiling is, asked of the host rather than read off the file.
 *
 * The file is what a box was TOLD; getAgentCapacity is what it resolved, container environment and
 * all. A panel that read the file would report a number the box does not honour whenever the
 * environment pins one, which is the pinned-model bug one wave earlier, moved sideways.
 */
async function readAgentCapacity(t) {
  try {
    const upstream = await fetch(`${t.gateway}/api/getAgentCapacity`, {
      method: "POST",
      headers: t.headers({ "content-type": "application/json" }),
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return { ok: false, why: `that box's host answered ${upstream.status} to getAgentCapacity` };
    const body = await upstream.json();
    const maxAgents = Number(body?.maxAgents);
    const bots = Number(body?.bots);
    if (!Number.isFinite(maxAgents)) return { ok: false, why: "that box's host does not report a ceiling yet" };
    return { ok: true, maxAgents, bots: Number.isFinite(bots) ? bots : null };
  } catch (error) {
    return { ok: false, why: error?.name === "TimeoutError" ? "that box did not answer in time" : "that box did not answer" };
  }
}

/** Whether the CONTAINER pins the ceiling, in which case nothing written into the file matters. */
async function ceilingPin(t) {
  const envOut = await dockerOut(["inspect", t.box, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]);
  const pinned = (envOut ?? "").split("\n").some((line) => line.startsWith("SAND_MAX_AGENTS="));
  return {
    pinned,
    pinnedBy: pinned ? "container env (SAND_MAX_AGENTS); recreate the box without it to unpin" : null,
  };
}

async function handleTenantCeiling(req, res, slug) {
  const t = contextOf(slug);
  if (t == null) return fail(res, 404, NOT_AVAILABLE_SENTENCE);
  const answer = (payload) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ slug, measuredAt: new Date().toISOString(), ...payload }));
  };
  if (!await dockerAvailable()) {
    // read:false with the reason, never a zero and never the default. The two are different facts
    // and an operator acts on them differently.
    return answer({ read: false, maxAgents: null, bots: null, pinned: false, pinnedBy: null,
      why: "this relay has no docker under it, so it cannot read or write inside a box" });
  }

  const report = async () => {
    const live = await readAgentCapacity(t);
    const pin = await ceilingPin(t);
    if (!live.ok) return answer({ read: false, maxAgents: null, bots: null, ...pin, why: live.why });
    return answer({ read: true, maxAgents: live.maxAgents, bots: live.bots, ...pin, why: "" });
  };

  if (req.method === "GET") return await report();

  let body;
  try { body = JSON.parse(await readBody(req, 64 * 1024) || "{}"); } catch { return fail(res, 400, "that was not JSON"); }
  const wanted = Number(body?.maxAgents);
  // The control plane checks the range too, and this is not a duplicate: whichever of the two is
  // called directly is the one that has to refuse, and a box written with a value its host ignores
  // is a customer silently dropped to the default.
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 1000) {
    return fail(res, 400, "a ceiling is a whole number from 1 to 1000, and nothing was written");
  }

  const before = await readHostSettings(t);
  if (before.unreadable) return fail(res, 409, "that box's settings file is there and is not JSON, so nothing was written over it");
  // MERGED, and the value is a STRING. Both halves are load-bearing; see the header above.
  const container = { ...before.container, SAND_MAX_AGENTS: String(wanted) };
  const document = before.nested ? { ...before.document, settings: container } : container;
  try { await writeBoxFile(t, HOST_SETTINGS_PATH, JSON.stringify(document)); }
  catch (error) { return fail(res, 502, `that box's settings file could not be written (${String(error?.message ?? error).split("\n")[0].slice(0, 120)})`); }

  return await report();
}

// Both migration doors, sharing one resolution of the workspace and one shape of answer.
async function handleTenantMigration(req, res, slug, step) {
  const t = contextOf(slug);
  if (t == null) return fail(res, 404, NOT_AVAILABLE_SENTENCE);
  if (!await dockerAvailable()) return refuseWithoutDocker(res, NOT_AVAILABLE.endpointsUse);
  let body;
  try { body = JSON.parse(await readBody(req, 64 * 1024) || "{}"); } catch { return fail(res, 400, "that was not JSON"); }
  const answer = (payload) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ slug, measuredAt: new Date().toISOString(), ...payload }));
  };
  if (step === "use-included") return await useIncluded(res, t, body, answer);
  if (step === "rollback-included") return await rollbackIncluded(res, t, answer);
  return await forgetProviderKeys(res, t, body, answer);
}

// Point this box at one of its included models, keeping the way back. The snapshot is taken FIRST
// and to a 0600 file in the tenant's own profile directory, because from the moment the copied
// operator key leaves this box the proxy is the only thing answering for it: a rollback that
// depends on remembering what was there is not a rollback.
const ROLLBACK_NAME = "model-proxy-rollback.json";
// The snapshot on disk, or null when there is none and null when what is there is not readable.
// Both callers treat those the same on purpose: a file that cannot be parsed is not a way back,
// and the one thing neither of them may do is overwrite it on the strength of that.
async function readRollback(rollbackFile) {
  let saved;
  try { saved = JSON.parse(await readFile(rollbackFile, "utf8")); } catch { return null; }
  const secrets = saved?.secrets;
  return (typeof secrets === "object" && secrets != null && !Array.isArray(secrets)) ? secrets : null;
}
async function useIncluded(res, t, body, answer) {
  const included = t.entry?.included ?? null;
  if (included == null) return fail(res, 409, `no included set for ${t.slug}`);
  const wanted = String(body?.model ?? "").trim();
  const plan = wanted.length > 0
    ? includedRows(t).find((row) => row.id === wanted)
    : includedRows(t)[0];
  if (plan == null) return fail(res, 404, `no included model named ${wanted}`);
  if (String(t.profileDir ?? "").length === 0) return fail(res, 409, `${t.slug} has no profile directory to keep a rollback in`);

  const before = await readSecrets(t);
  const rollbackFile = path.join(t.profileDir, ROLLBACK_NAME);
  // THE SNAPSHOT IS WRITTEN ONCE AND NEVER OVERWRITTEN, and this is the second-run bug it fixes.
  //
  // MEASURED ON THE R750 2026-09-08: demo was migrated twice inside a minute while the re-mint
  // hazard was being fixed. The first run saved the true pre-migration state; the second run saved
  // what the first run had left, which is a REVOKED virtual key pointed at the proxy. `proxy
  // rollback demo` would have written that key back into the box and taken the tenant off the air,
  // and the command would have reported success. A way back that a second attempt destroys is not
  // a way back.
  //
  // Two guards, because either alone leaves a hole. A snapshot that exists is kept whatever it
  // holds; and a box that is ALREADY on a plan endpoint has no pre-migration state left to save,
  // so nothing is written rather than a plan state being recorded as the way home.
  const already = await readRollback(rollbackFile);
  const onPlan = String(before?.SAND_OPENAI_COMPATIBLE_BASE_URL ?? "") === String(plan.baseUrl ?? "");
  // "kept" the snapshot was already there, "written" this call took it, "none" there was nothing
  // pre-migration left to take. The answer carries it so `proxy migrate` can print the truth
  // instead of "the way back is kept at ..." over a file it did not write.
  let rollback = "kept";
  if (already == null) {
    if (onPlan) rollback = "none";
    else {
      await writeFile(rollbackFile, JSON.stringify({ version: 1, secrets: before }), { mode: 0o600 });
      // writeFile's mode applies only when it CREATES the file, so the mode is set again rather
      // than assumed.
      await chmod(rollbackFile, 0o600).catch(() => {});
      rollback = "written";
    }
  }

  const next = { ...before, SAND_OPENAI_COMPATIBLE_BASE_URL: plan.baseUrl, SAND_OPENAI_COMPATIBLE_MODEL: plan.model, SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: plan.name, SAND_OPENAI_COMPATIBLE_API_KEY: included.key };
  for (const key of ["SAND_OPENAI_COMPATIBLE_TRANSPORT", "SAND_OPENAI_COMPATIBLE_ACCOUNT_ID", "SAND_OPENAI_COMPATIBLE_ORIGINATOR"]) delete next[key];
  if (plan.servedBy) next.SAND_OPENAI_COMPATIBLE_SERVED_BY = plan.servedBy;
  else delete next.SAND_OPENAI_COMPATIBLE_SERVED_BY;
  // What this box tells the customer it is running. Without it the persona note reads the routing
  // alias `plan-zai` back to them, which is a name only the operator's proxy uses.
  if (plan.modelLabel) next.SAND_OPENAI_COMPATIBLE_MODEL_LABEL = plan.modelLabel;
  else delete next.SAND_OPENAI_COMPATIBLE_MODEL_LABEL;
  if (plan.contextWindow) next.SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW = String(plan.contextWindow);
  await writeSecrets(t, next);
  // PROVIDERS-1. Read AFTER the write, so nothing is refused over it: the file is the right place
  // for these values whether or not the container also carries them, and a rollback still needs
  // them there. What changes is what the answer CLAIMS. `pinned: true` means the super admin just
  // wrote seven names into a box that will keep answering through its container environment until
  // it is recreated, so the caller has the fact and can say that instead of reporting a success.
  // Today the only caller is `cp/cli.mjs proxy migrate`, which prints the endpoint name and not
  // this; printing it belongs to that file and to the item of this wave that owns it.
  const pin = await endpointPin(t);
  return answer({
    using: plan.id, endpointName: plan.name, rollbackFile, rollback,
    // What the customer's own Titan will say it is running. Empty when the control plane sent no
    // label for this model, in which case the box says the model and the operator knows to set one.
    modelLabel: plan.modelLabel || "",
    ...pin,
    // Names, lengths and hash prefixes. The key itself has already gone into the box and does not
    // come back out through this answer.
    wrote: Object.keys(next).filter((name) => name.startsWith("SAND_OPENAI_COMPATIBLE_")).sort()
      .map((name) => evidenceOf(name, next[name])),
  });
}

// Take a specific credential back out of this box, by hash and by hash alone.
//
// A prefix rather than a value on purpose: the caller proves it knows WHICH key without this route
// ever accepting one, and a typo deletes nothing rather than something. Three files, because the
// operator's copies landed in three places -- the endpoint pin, the tenant's own saved endpoint
// rows, and the connector env store TinyFish reads. Both box files are left present and valid; a
// file this box never had is not created by a removal.
async function forgetProviderKeys(res, t, body, answer) {
  const prefix = String(body?.prefix ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{6,64}$/.test(prefix)) return fail(res, 400, "prefix must be at least six hex characters of a sha256");
  const matches = (value) => String(value ?? "").length > 0 && sha256Hex(value).startsWith(prefix);
  const removed = [];
  // Every distinct value this call has proved is the one being forgotten. It is what the store
  // sweep greps for, and it never leaves this function.
  const hit = new Set();
  const noteHit = (value) => { hit.add(String(value)); return true; };

  const secrets = await readSecrets(t);
  const keptSecrets = {};
  for (const [name, value] of Object.entries(secrets)) {
    if (matches(value) && noteHit(value)) removed.push({ file: "box-secrets.json", ...evidenceOf(name, value) });
    else keptSecrets[name] = value;
  }
  if (removed.length > 0) await writeSecrets(t, keptSecrets);

  // The tenant's saved catalog. The ROW stays -- it is the customer's own endpoint definition and
  // deleting it would be deleting their configuration, not a credential -- and its key is cleared,
  // which is the thing the proof reads for.
  const catalog = await readCatalog(t);
  let catalogChanged = false;
  const endpoints = (catalog.endpoints ?? []).map((row) => {
    if (!matches(row?.apiKey)) return row;
    noteHit(row.apiKey);
    catalogChanged = true;
    removed.push({ file: "endpoints.json", ...evidenceOf(`${row.id}.apiKey`, row.apiKey) });
    return { ...row, apiKey: "" };
  });
  if (catalogChanged) {
    t.ensureDir();
    await writeFile(t.endpointsFile, JSON.stringify({ endpoints }, null, 2));
    await ownLikeParent(t.endpointsFile);
  }

  const connectorSecrets = await readConnectorSecrets(t);
  const servers = connectorSecrets?.servers;
  let connectorsChanged = false;
  if (typeof servers === "object" && servers != null && !Array.isArray(servers)) {
    for (const [server, fields] of Object.entries(servers)) {
      if (typeof fields !== "object" || fields == null || Array.isArray(fields)) continue;
      for (const [field, value] of Object.entries(fields)) {
        if (!matches(value)) continue;
        noteHit(value);
        delete fields[field];
        connectorsChanged = true;
        removed.push({ file: "connector-env-secrets.json", ...evidenceOf(`servers.${server}.${field}`, value) });
      }
    }
  }
  if (connectorsChanged) await writeBoxFile(t, CONNECTOR_SECRETS_PATH, JSON.stringify(connectorSecrets));

  // ---- the box store ---------------------------------------------------------------------------
  //
  // The stored copies come FIRST, because they also teach this route the value when the live files
  // no longer hold it. Run `forget` a second time after a migration and the three files are already
  // clean; without this pass there would be nothing to grep the store with and the sweep would
  // report a clean box over a store that still had the key in it.
  const storeRemoved = [];
  for (const document of await storedSecretDocuments(t)) {
    const carried = valuesOfStoredDocument(document.parsed).filter((value) => matches(value));
    if (carried.length === 0) continue;
    for (const value of carried) noteHit(value);
    storeRemoved.push({ path: document.path, values: carried.length });
  }
  await removeStorePaths(t, storeRemoved.map((one) => one.path));
  for (const one of storeRemoved) {
    removed.push({ file: "box-store", name: one.path, length: one.values, sha256: prefix });
  }
  // And then everything else in the store that still carries it. NOT deleted: a blob can be a pack
  // of unrelated files, an agent's conversation database, an audit log or a Chrome profile, and
  // deleting one of those to chase a credential loses the customer's data. Named instead, with its
  // path, so the operator reads the truth and rotates the credential rather than believing a count.
  const storeRemaining = (await storePathsCarrying(t, [...hit]))
    .map((filePath) => ({ where: "box-store", name: filePath, length: 0, sha256: prefix }));

  // What is STILL in this box afterwards, by name, length and hash prefix. This is the absence
  // proof the migration is judged on: the operator reads it and sees that the hash they asked to
  // remove is not in the list, rather than taking a removal count on trust. Names only, never a
  // value, which is what makes the output safe to paste into a ticket.
  const remaining = [
    ...Object.entries(keptSecrets).map(([name, value]) => ({ where: "box-secrets.json", ...evidenceOf(name, value) })),
    ...endpoints.filter((row) => String(row?.apiKey ?? "").length > 0)
      .map((row) => ({ where: "endpoints.json", ...evidenceOf(`${row.id}.apiKey`, row.apiKey) })),
    ...Object.entries(connectorSecrets?.servers ?? {}).flatMap(([server, fields]) =>
      (typeof fields === "object" && fields != null && !Array.isArray(fields))
        ? Object.entries(fields).map(([field, value]) => ({ where: "connector-env-secrets.json", ...evidenceOf(`servers.${server}.${field}`, value) }))
        : []),
    ...storeRemaining,
  ];

  // `storeSwept` is the difference between "the sweep found nothing" and "the sweep did not run",
  // which is the distinction the first proof lost. False means this box's store could not be read.
  return answer({ prefix, removed, removedCount: removed.length, remaining, storeSwept: true, storeCarrying: storeRemaining.length });
}

// Putting one box back the way it was, from the snapshot use-included took before it moved.
//
// This is the third door rather than a flag on use-included on purpose. If rollback were a flag and
// somebody wired it wrong, the box would be pointed AT the proxy instead of away from it, which is
// a wrong action that answers 200. A route of its own either exists or answers 404, and a 404 is
// something an operator can act on at three in the morning.
async function rollbackIncluded(res, t, answer) {
  if (String(t.profileDir ?? "").length === 0) return fail(res, 409, `${t.slug} has no profile directory to read a rollback from`);
  const rollbackFile = path.join(t.profileDir, ROLLBACK_NAME);
  const secrets = await readRollback(rollbackFile);
  if (secrets == null) {
    return fail(res, 409, `there is no rollback to replay for ${t.slug}; this box was never moved onto a plan, ` +
      `or the snapshot is unreadable. Point this workspace at an endpoint of its own in Settings instead.`);
  }
  // Through the same writer as every other change to this file, so it lands 0600 like its
  // neighbours and takes effect on that workspace's next message with no restart and no recreate.
  await writeSecrets(t, secrets);
  return answer({
    restoredFrom: rollbackFile,
    wrote: Object.keys(secrets).sort().map((name) => evidenceOf(name, secrets[name])),
  });
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
  // COST-1's seam (ui/relay-hooks.mjs). One gateway answer on its way to a browser, with the chance
  // to send less of it: the outline paged rather than whole, a digest header so a repeat read can be
  // answered with "unchanged" in the body instead of a megabyte of it. With no ui/api-diet.mjs this is
  // the body unchanged and no extra headers, which is byte for byte what this function did before the
  // seam existed.
  //
  // The status stays 200: every gateway command is a POST, and a 304 on a POST is not a thing a
  // browser's cache understands. A projection says "you already have this" in the body it returns,
  // which is the shape the console's own reader can act on.
  //
  // Only on a 200: a refusal's body is the gateway's sentence and must reach the console whole.
  if (upstream.status === 200) {
    const shaped = HOOKS.shapeApiAnswer(method, body, req.headers, text);
    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...shaped.headers,
    });
    return res.end(shaped.bytes);
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
  // COST-1. An avatar is a picture of a bot and it changes when somebody changes it, which is almost
  // never -- and it was measured fetched NINE times in one first paint at 390x844 on grok-bot-local-vm
  // 2026-09-09, every one of them `no-store`. So it goes through the asset policy hook, which answers
  // a validator the browser can revalidate against. With no ui/asset-cache.mjs it stays `no-store`,
  // which is what it does today.
  //
  // PRIVATE, never public, and that is the whole reason this goes through a hook rather than a literal
  // header: the avatar route is behind the login, and a publicly cacheable answer would let an edge
  // hand one workspace's bot picture, or a 401, to everybody.
  const policy = HOOKS.assetPolicy(pathname, new URL(pathname, "http://relay.invalid"), req);
  if (policy.status === 304) {
    res.writeHead(304, policy.headers);
    return res.end();
  }
  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") ?? "image/png",
    "content-length": bytes.byteLength,
    ...policy.headers,
  });
  res.end(bytes);
}

// ---- one file out of a box (CONSOLE-4) -------------------------------------------------------
//
// GET /files?agent=<id>&path=<absolute path>[&download=1] answers the bytes of one file that
// passed through an agent's conversation, so a file row in the console can be opened and saved.
//
// WHAT AUTHORIZES THIS IS THE GATEWAY'S OWN PATH CHECK, NOT THE CHECK BELOW. readAttachmentChunk
// derives the owning agent from the path it is given (attachments-service.ts
// resolveAttachmentOwnerDir) and refuses anything outside that agent's attachments/ or assets/
// directory; the `agent` parameter here is only the fallback the host uses for a path it cannot
// place, which our own shape rules out. So `agent` is decorative and must never be described as
// an access control. The regex below is a second, tighter fence in front of that one: it keeps a
// malformed request from ever reaching the box, and it means this route can never be pointed at
// settings.json, box-secrets.json or anything else inside an agent's directory that is not a file
// the conversation actually carried.
//
// The bytes come through the gateway. There is deliberately no `docker exec` here: the relay
// serves three boxes including a paying customer's, and a route that shells into a container to
// read a path a browser chose is a different and much worse thing than a route that asks the box's
// own API for a file it has already agreed to serve.
//
// Nesting below attachments/ and assets/ is allowed on purpose. An ingested attachment is written
// flat (a content hash plus the extension), but a GENERATED image is written to a path the model
// chose, under an mkdir -p (generate-image-resource-accessor.ts). A flat-only pattern here would
// have refused those, and the symptom would have been the very thing this wave is fixing: a file
// in the list that will not open. What is never allowed is a "." or ".." segment, checked
// separately below so that a file legitimately named "notes..md" still opens.
const BOX_FILE_PATH = /^(?:\/[^/]+)*\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:attachments|assets)(?:\/[^/]+)+$/i;
// The host's own per-call ceiling (attachments-service.ts ATTACHMENT_CHUNK_MAX_BYTES). Asking for
// more than this gets silently clamped, so the paging loop would spin forever on a wrong number.
const BOX_FILE_CHUNK_BYTES = 8 * 1024 * 1024;
// And the ceiling on the whole answer. A console tab holding a quarter of a gigabyte because
// somebody clicked a row is not a download, it is an outage.
const BOX_FILE_TOTAL_BYTES = 25 * 1024 * 1024;
// The host reports a mime only for pictures, video and audio (imageMimeFromPath and friends), so
// for the markdown, text and PDF this route mostly carries, the extension is all there is.
const BOX_FILE_MIME = {
  md: "text/markdown", markdown: "text/markdown", mdx: "text/markdown",
  txt: "text/plain", text: "text/plain", log: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", yaml: "text/yaml", yml: "text/yaml", toml: "text/plain", xml: "application/xml",
  html: "text/html", htm: "text/html", svg: "image/svg+xml", css: "text/css", js: "text/javascript",
  pdf: "application/pdf", zip: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
};
// What may be rendered by the browser in place rather than saved. PDF is the reason this route has
// an inline mode at all, and pictures come free with it. Everything else is sent as a download,
// which is what keeps an agent-written .html or .svg from executing on this console's own origin
// with this console's own session -- the console and the file share a host name, so an inline
// text/html here would be same-origin script, not a preview.
const BOX_FILE_INLINE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "text/plain"]);
const boxFileMime = (filePath, reported) => reported
  || BOX_FILE_MIME[(/\.([^./]+)$/.exec(filePath)?.[1] ?? "").toLowerCase()]
  || "application/octet-stream";

async function relayFile(t, req, res, url) {
  const filePath = url.searchParams.get("path") ?? "";
  const agentId = url.searchParams.get("agent") || null;
  const download = url.searchParams.get("download") === "1";
  // ".." is rejected as a path SEGMENT rather than as a substring: a file legitimately named
  // "notes..md" is not a traversal, and refusing it would be a bug reported as a missing file.
  const segments = filePath.split("/");
  if (segments.includes("..") || segments.includes(".") || !BOX_FILE_PATH.test(filePath)) {
    return fail(res, 400, "that is not a file from a conversation on this box");
  }

  const parts = [];
  let read = 0;
  let totalSize = 0;
  let reportedMime = null;
  for (;;) {
    const upstream = await fetch(`${t.gateway}/api/readAttachmentChunk`, {
      method: "POST",
      headers: t.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ path: filePath, agentId, offset: read, length: BOX_FILE_CHUNK_BYTES }),
    });
    const text = await upstream.text();
    // The box's refusal is the box's answer to give, with the one exception relayCommand already
    // makes: its 401 is this relay's bearer being stale, which is a broken deployment and not
    // something the person clicking a file row can do anything about.
    if (upstream.status === 401) {
      return fail(res, 502, "the gateway refused this relay's token: SAND_HOST_GATEWAY_TOKEN is stale or the box was recreated.");
    }
    if (!upstream.ok) {
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      return res.end(text);
    }
    let answer;
    try { answer = JSON.parse(text); } catch { answer = null; }
    // null is what the host answers for a path it will not serve, and for a file that is gone.
    // Both are a 404 to the person: the row is stale either way.
    if (answer == null || typeof answer.bytesBase64 !== "string") {
      return fail(res, 404, "the box would not serve that file");
    }
    totalSize = Number(answer.totalSize) || totalSize;
    reportedMime = reportedMime ?? (typeof answer.mime === "string" ? answer.mime : null);
    if (totalSize > BOX_FILE_TOTAL_BYTES) {
      return fail(res, 413, `that file is ${Math.round(totalSize / (1024 * 1024))} MB; this console serves files up to ${BOX_FILE_TOTAL_BYTES / (1024 * 1024)} MB`);
    }
    const chunk = Buffer.from(answer.bytesBase64, "base64");
    parts.push(chunk);
    read += chunk.byteLength;
    // A zero-length answer ends the loop whatever the reported size says. Without it a totalSize
    // the host revised upward mid-read would spin here forever.
    if (chunk.byteLength === 0 || read >= totalSize) break;
  }

  const bytes = Buffer.concat(parts);
  const mime = boxFileMime(filePath, reportedMime);
  const name = filePath.split("/").pop() ?? "file";
  // The filename is quoted and stripped of the two characters that could end the quoting early.
  // Everything else in it is already constrained: it is one path segment out of the regex above.
  const filename = name.replace(/["\\]/g, "");
  const inline = !download && BOX_FILE_INLINE.has(mime);
  res.writeHead(200, {
    "content-type": mime,
    "content-length": bytes.byteLength,
    // nosniff, always. It is what makes the inline list above the whole list: without it a browser
    // is free to decide an application/octet-stream is really HTML and run it.
    "x-content-type-options": "nosniff",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
    "cache-control": "no-store",
  });
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

  // STORE-1. A DEVICE BEARER IS REFUSED HERE, BY SHAPE, AND CHARGES NOTHING.
  //
  // The job bus keeps its own token and the two doors never see each other's credential, which is
  // what the comment on the /v1 route line says out loud. A device token could never MATCH a bus
  // token -- a bus token is 48 hex and this one starts tbd1. -- so the only thing reaching the
  // compare below would achieve is spending an app's owner five attempts on the shared lockout over
  // an app that aimed at the wrong path. Refusing by shape is not a bypass for the same reason: a
  // guesser prefixing tbd1. is guessing in a space no bus token is in.
  if (looksLikeDeviceBearer(req.headers.authorization)) return fail(res, 401, "unauthorized", RELAY_AUTH_HEADER);

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

// ---- voice (VOICE-1, docs/VOICE.md) -----------------------------------------------------------
// What every voice edge on this relay shares. The caps come from the control plane behind the
// credential this relay already holds: per-workspace overrides are deliberately NOT writable from a
// console, because a customer raising their own cap is the bypass. With no control plane, which is
// every developer box, the relay's own constants answer instead. Everything else voice needs is in
// ui/voice-edge.mjs, so this file gains one import, two context fields, one route and one branch.
const voiceDeps = {
  ownLikeParent,
  log: (line) => console.log(line),
  relayBase: RELAY?.cpUrl ?? "",
  relayToken: RELAY?.relayToken ?? "",
  // The ONE override, and it is an ADDRESS, never a key: GROK_BOT_MAIL_API_BASE is the same shape for
  // mail (ui/mail-edge.mjs:588), and scripts/verify-voice.mjs points a spawned relay at its own stub
  // vendor with it. A realtime KEY is never an environment variable on either side of this -- it lives
  // in the workspace's own voice.json and reaches the vendor as a header.
  providerUrl: String(process.env.GROK_BOT_VOICE_WS_BASE ?? "").trim(),
};

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
    sentLedgerFile: t.mailSentLedgerFile,
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
    // MAIL-2. The directory, and the door into another workspace's box. All four are read through
    // a function rather than captured, so a sweep that lands after this edge was built is a sweep
    // this edge sees.
    directoryDomain: () => mailDirectoryDomain(),
    directoryRoute: (localpart) => mailDirectoryRoute(localpart),
    directoryAddress: ({ agentId }) => Promise.resolve(mailAddressOf(t.slug, agentId)),
    deliverTo: (args) => mailDeliverTo(args, t.slug),
    // The directory is global and a signing secret is not: every workspace sets its own on its own
    // Mail card, so an edge that could resolve a code would be a workspace that could sign a body
    // naming any other customer's bot. Only the workspace whose Resend account actually holds the
    // directory domain resolves codes; for everyone else routeDirectoryFirst answers "elsewhere"
    // and their own domain routes exactly as it always did.
    ownsDirectory: () => t.slug === mailDirectoryOwnerSlug(),
    ownSlug: t.slug,
    log: (line) => console.log(line),
  });
  mailEdges.set(t.slug, { settingsFile: t.mailSettingsFile, edge });
  return edge;
}

// ---- the per-bot address directory (MAIL-2, docs/MAIL.md) ------------------------------------
//
// Every bot has an address of its own: agent<code>@<domain>, six digits the CONTROL PLANE mints
// once per (workspace, bot) and never reuses. This relay does three things with that and owns none
// of it: it sweeps each workspace's roster and asks the control plane to mint what is missing, it
// caches the answer so a code still routes while the control plane is down, and it delivers a
// message that resolved to another workspace into that workspace's box.
//
// WHY THE CACHE IS ON DISK. The registry already survives a control plane outage by serving its
// last read from memory; this goes one step further and writes the answer down, because a relay
// restarted during an outage has no memory to serve from and mail would stop routing entirely for
// the length of it. No secret is in this file: it is codes, addresses, bot names and slugs, all of
// which are printed on the agent cards in the console anyway.
const MAIL_DIRECTORY_FILE = process.env.SAND_UI_MAIL_DIRECTORY_FILE?.trim() || stateFile("mail-directory.json", HERE);
// Five minutes, so a bot created at 08:00 has a working address by 08:05 with nobody touching the
// box it lives in. Plus one sweep at start, plus one refresh on a miss.
const MAIL_SWEEP_MS = 5 * 60_000;
// A miss is somebody guessing an address far more often than it is a code we have not read yet, so
// the refresh a miss triggers is rate limited hard. Thirty seconds is one control plane read per
// half minute in the worst case, and it is short enough that a bot minted a moment ago answers.
const MAIL_MISS_COOLDOWN_MS = 30_000;
// WHICH WORKSPACE HOLDS THE DIRECTORY DOMAIN. myagents.email is one Resend account and it is the
// operator's; every other workspace on this console has its own domain or none. This is the one
// workspace whose edge may resolve a per-bot code, and it is a setting rather than a constant only
// so an operator who runs the directory out of a workspace that is not slug "operator" can say so.
const MAIL_OWNER_FILE = process.env.SAND_UI_MAIL_OWNER_FILE?.trim() || stateFile("mail-owner.txt", HERE);
function mailDirectoryOwnerSlug() {
  const named = process.env.CP_MAIL_OWNER_SLUG?.trim();
  if (named != null && named.length > 0) return named;
  // The same escape hatch the read-only list has, and for the same reason: a console's containers
  // are made once and this is a fact an operator may have to correct on a running one.
  try {
    for (const line of readFileSync(MAIL_OWNER_FILE, "utf8").split("\n")) {
      const slug = line.split("#")[0].trim();
      if (slug.length > 0) return slug;
    }
  } catch { /* no file, which is every install where the operator holds the domain */ }
  return OPERATOR_SLUG;
}

// WORKSPACES THIS RELAY MUST NOT WRITE INSIDE. Codes are still minted for them and mail still
// routes to them -- routing is decided here, not in a box -- but the setAgentMail push, the only
// part of this that writes a file inside somebody's box, is skipped. That is an operator's
// decision about one afternoon and one customer, so it is set on the relay and the product ships
// with it EMPTY: a customer's slug written into source is a fact about a Wednesday that every
// future deployment of this product would carry.
//
// Two ways to set it, because the relay's container environment is fixed when the container is
// created and a live console is not recreated to hold a customer read-only for an afternoon:
// SAND_UI_MAIL_NO_PUSH_SLUGS (comma separated) and a file of one slug per line beside the rest of
// the relay's state. Both are read each sweep, so a slug added or removed takes effect within five
// minutes with nothing restarted.
const MAIL_NO_PUSH_FILE = process.env.SAND_UI_MAIL_NO_PUSH_FILE?.trim() || stateFile("mail-no-push.txt", HERE);
function mailNoPushSlugs() {
  const slugs = String(process.env.SAND_UI_MAIL_NO_PUSH_SLUGS ?? "").split(",").map((one) => one.trim()).filter(Boolean);
  try {
    for (const line of readFileSync(MAIL_NO_PUSH_FILE, "utf8").split("\n")) {
      const slug = line.split("#")[0].trim();
      if (slug.length > 0) slugs.push(slug);
    }
  } catch { /* no file, which is every install that never held a workspace read-only */ }
  return new Set(slugs);
}

// WORKSPACES THIS RELAY MUST NOT SEND MAIL FOR (MAIL-3). The same shape and the same two ways of
// setting it as the list above, and the product ships with it EMPTY for the same reason.
//
// It is a SEPARATE list from mail-no-push.txt on purpose. That one says "do not write inside this
// box", which is about a box being on an old bundle; this one says "refuse this workspace's sends
// at the route", which is about custody. A workspace that is not pushed never learns canSend and
// so never offers its bots the tool -- but its box still holds a valid gateway token and could
// call the route anyway, and an absent push is not a rule. This is the rule.
//
// Read per request rather than per sweep, because a send is a thing an operator may want stopped
// in the next second and not within five minutes.
const MAIL_NO_SEND_FILE = process.env.SAND_UI_MAIL_NO_SEND_FILE?.trim() || stateFile("mail-no-send.txt", HERE);
function mailNoSendSlugs() {
  const slugs = String(process.env.SAND_UI_MAIL_NO_SEND_SLUGS ?? "").split(",").map((one) => one.trim()).filter(Boolean);
  try {
    for (const line of readFileSync(MAIL_NO_SEND_FILE, "utf8").split("\n")) {
      const slug = line.split("#")[0].trim();
      if (slug.length > 0) slugs.push(slug);
    }
  } catch { /* no file, which is every install that has not switched a workspace's sending off */ }
  return new Set(slugs);
}

/**
 * Whether this workspace's bots may send, which is what the address push tells each box.
 *
 * Two conditions and both are facts this process holds: the workspace is not on the list above, and
 * there is a directory domain at all -- a console with no control plane has no address to force a
 * From to, so there is nothing its bots could send AS.
 */
function sendingIsOn(slug, noSend = mailNoSendSlugs()) {
  return mailDirectoryDomain().length > 0 && !noSend.has(String(slug ?? ""));
}

let mailDirectoryState = { domain: "", tenants: {}, measuredAt: "", readAt: 0, source: "never read" };
let mailDirectoryLoadedFromDisk = false;
let mailLastMissRefresh = 0;
let mailSweepRunning = false;

/** The last answer, from disk, once, so a relay restarted during an outage still routes codes. */
function mailDirectoryFromDisk() {
  if (mailDirectoryLoadedFromDisk) return;
  mailDirectoryLoadedFromDisk = true;
  try {
    const parsed = JSON.parse(readFileSync(MAIL_DIRECTORY_FILE, "utf8"));
    if (parsed?.tenants == null || typeof parsed.tenants !== "object") return;
    mailDirectoryState = {
      domain: String(parsed.domain ?? ""),
      tenants: parsed.tenants,
      measuredAt: String(parsed.measuredAt ?? ""),
      readAt: 0,
      source: `${MAIL_DIRECTORY_FILE}, measured ${String(parsed.measuredAt ?? "at an unknown time")}`,
    };
    console.log(`mail  the address directory was read back off the disk (${mailAddressCount()} address(es))`);
  } catch { /* no file yet, which is every first start */ }
}

const mailAddressCount = () => Object.values(mailDirectoryState.tenants ?? {})
  .reduce((total, entry) => total + (Array.isArray(entry?.addresses) ? entry.addresses.length : 0), 0);

/** What the router reads. Never throws, and never empty once anything has ever been read. */
function mailDirectory() {
  mailDirectoryFromDisk();
  return mailDirectoryState;
}

/** The product domain codes live at, or "" when there is no control plane to have one. */
function mailDirectoryDomain() { return mailDirectory().domain; }

function mailDirectoryWrite() {
  try {
    writeFileSync(MAIL_DIRECTORY_FILE, JSON.stringify({
      domain: mailDirectoryState.domain,
      tenants: mailDirectoryState.tenants,
      measuredAt: mailDirectoryState.measuredAt,
    }, null, 2), { mode: 0o600 });
    void ownLikeParent(MAIL_DIRECTORY_FILE);
  } catch (error) { console.log(`mail  could not write ${MAIL_DIRECTORY_FILE}: ${error?.message ?? error}`); }
}

/** One GET at the control plane, behind CP_RELAY_TOKEN, which is the credential this relay already
 * holds for the registry. A failure keeps the last good answer rather than emptying it. */
async function mailDirectoryRefresh() {
  if (RELAY == null) return { ok: false, why: "this relay has no control plane" };
  let response;
  try {
    response = await fetch(`${RELAY.cpUrl}/v1/relay/mail/directory`, {
      headers: { authorization: `Bearer ${RELAY.relayToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) { return { ok: false, why: error?.name === "TimeoutError" ? "timed out" : "no answer" }; }
  if (response.status !== 200) return { ok: false, why: `HTTP ${response.status}` };
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (body?.tenants == null || typeof body.tenants !== "object") return { ok: false, why: "the answer carried no directory" };
  mailDirectoryFromDisk();
  mailDirectoryState = {
    domain: String(body.domain ?? ""),
    tenants: body.tenants,
    measuredAt: String(body.measuredAt ?? new Date().toISOString()),
    readAt: Date.now(),
    source: "the control plane",
  };
  mailDirectoryWrite();
  return { ok: true, addresses: mailAddressCount() };
}

/** A localpart against the cache. Sync, so the hot path costs one object walk and no await. */
function mailDirectoryLookup(localpart) {
  const want = String(localpart ?? "").toLowerCase();
  const state = mailDirectory();
  for (const [slug, entry] of Object.entries(state.tenants ?? {})) {
    for (const row of Array.isArray(entry?.addresses) ? entry.addresses : []) {
      if (String(row?.address ?? "").split("@")[0].toLowerCase() !== want) continue;
      return {
        slug,
        agentId: String(row.agentId ?? ""),
        agentName: String(row.agentName ?? ""),
        address: String(row.address ?? ""),
        state: String(row.state ?? "active"),
        approvedSendersOnly: entry?.approvedSendersOnly === true,
        senders: Array.isArray(entry?.senders) ? entry.senders : [],
      };
    }
  }
  return null;
}

/** The router's own reader: the cache, then ONE refresh on a miss behind the cooldown. */
async function mailDirectoryRoute(localpart) {
  const found = mailDirectoryLookup(localpart);
  if (found != null) return found;
  const since = Date.now() - mailLastMissRefresh;
  if (since < MAIL_MISS_COOLDOWN_MS) return null;
  mailLastMissRefresh = Date.now();
  const answer = await mailDirectoryRefresh();
  if (!answer.ok) console.log(`mail  the address directory could not be refreshed: ${answer.why}`);
  return mailDirectoryLookup(localpart);
}

/**
 * ONE workspace's own bot's directory row, and null for everything else.
 *
 * The scoping is the point. The send route looks a bot up by the slug its BEARER proved, so this
 * one call refuses three different things with one answer: a bot that has no address, a bot whose
 * address is retired, and a bot in somebody else's workspace. They cannot drift apart, and the
 * route answers all three the same sentence, so a caller learns nothing about a workspace that is
 * not theirs -- which is the MAIL-2c class of failure closed in one line.
 */
function mailDirectoryRowOf(slug, agentId) {
  const entry = mailDirectory().tenants?.[String(slug ?? "")];
  const row = (Array.isArray(entry?.addresses) ? entry.addresses : [])
    .find((one) => String(one?.agentId ?? "") === String(agentId ?? "") && String(one?.state ?? "active") !== "retired");
  if (row == null) return null;
  return {
    agentId: String(row.agentId ?? ""),
    code: String(row.code ?? ""),
    address: String(row.address ?? ""),
    agentName: String(row.agentName ?? ""),
    state: String(row.state ?? "active"),
  };
}

/** One workspace's own bot's code address, for the retiring notice on a name address. */
function mailAddressOf(slug, agentId) {
  return mailDirectoryRowOf(slug, agentId)?.address ?? "";
}

/**
 * A message that resolved to a bot in ANOTHER workspace, delivered into that workspace's box.
 *
 * This is the one thing ui/mail-edge.mjs cannot do and deliberately does not try to: the gateway
 * bearers are per tenant and they live in this process. The row is mirrored into the receiving
 * workspace's own ledger as well, so the customer's mail card shows what arrived for their bots
 * rather than only the door it came through showing it.
 */
async function mailDeliverTo({ slug, agentId, prompt, nonce, ledger = {} }, fromSlug = "") {
  const t = contextOf(slug);
  if (t == null) return { status: 503, text: `${slug} is not a workspace this console can reach`, type: "application/json" };
  const answer = await jobBusCall(t, "sendPrompt", { agentId, prompt, clientNonce: nonce })
    .catch((error) => ({ status: 0, text: String(error?.message ?? error), type: "" }));
  if (String(slug) !== String(fromSlug)) {
    t.ensureDir();
    await appendMailLedger(mailLedgerRow({
      ...ledger, agentId,
      outcome: answer.status === 200 ? "delivered" : "send_failed",
    }), { file: t.mailLedgerFile, ownLikeParent })
      .catch((error) => console.log(`mail  could not write ${slug}'s inbox ledger: ${error?.message ?? error}`));
  }
  return answer;
}

/**
 * The sweep: every workspace this console serves, its roster read, its missing codes minted, and
 * its addresses pushed into its box.
 *
 * setAgentMail is a host command that may not exist yet -- a box on an older bundle answers
 * "unknown gateway method" -- and that is FINE and is why the push is swallowed rather than
 * retried. Delivery never depends on that file; only the sentence Titan says about his own address
 * does. It is what lets the rollout be control plane, then host swaps, then relay, with mail
 * working at every step.
 */
async function mailMintSweep(reason = "the timer", { only = "" } = {}) {
  if (RELAY == null) return { ok: false, why: "this relay has no control plane" };
  if (mailSweepRunning) return { ok: false, why: "a sweep is already running" };
  mailSweepRunning = true;
  // ONBOARD-2. ONE WORKSPACE, when the caller names one, and the whole fleet when it does not.
  //
  // This matters more than it looks. The loop below makes a listAgents and a setAgentMail call into
  // EVERY workspace this console serves, so onboarding one customer reaches inside every other
  // customer's box, and the cost of giving a new client their addresses grows with the number of
  // clients. With a slug the work is one box. With no body at all this is exactly today's fleet
  // sweep, so the five minute timer and `cp mail sweep` are unchanged.
  const only_ = String(only ?? "").trim();
  const swept = [];
  // Read once per sweep rather than at import, so an operator adds or removes a workspace with a
  // file and a five minute wait instead of a restart.
  const noPush = mailNoPushSlugs();
  // Read once per sweep rather than once per workspace, so every box in one pass is told the same
  // thing about a file that could be edited between two of them.
  const noSend = mailNoSendSlugs();
  try {
    // The control plane FIRST, and nothing else happens if it does not answer.
    //
    // This is an order and not a tidy-up. A roster read is a call into every customer's box, and
    // there is nothing to do with the answer when the mint that follows it cannot be posted: a
    // control plane outage would otherwise cost one gateway call per customer every five minutes
    // for the length of it, for no result. Measured through tests/relay-one-console, which counts
    // the calls a box receives: with the control plane dead this now makes none at all.
    // A WORKSPACE MINTED A MINUTE AGO IS NOT IN THIS REGISTRY YET. The schedule reads the control
    // plane once a minute, and the caller naming a slug is the control plane saying "this one exists
    // now", so the read happens before the lookup rather than a minute after it. Only on the named
    // path: the fleet sweep already refreshes through mailDirectoryRefresh below and a second full
    // read every five minutes buys nothing.
    if (only_.length > 0) await registry.refresh().catch(() => {});
    const warmed = await mailDirectoryRefresh();
    if (!warmed.ok) {
      console.log(`mail  the control plane did not answer (${warmed.why}), so no roster was read `
        + `and no address was minted this pass; ${mailAddressCount()} address(es) still route from the last read`);
      return { ok: false, why: warmed.why, swept, ...(only_.length > 0 ? { asked: only_ } : {}) };
    }
    // A NAMED WORKSPACE THIS CONSOLE CANNOT REACH IS A REFUSAL AND NOT AN EMPTY SUCCESS. A sweep
    // that answered 200 over a workspace it never looked at is the exact shape of a green light
    // somebody believes, which is why the control plane's own green is a directory read rather than
    // this answer -- but this answer still has to be honest.
    let workspaces = registry.all();
    if (only_.length > 0) {
      const entry = registry.get(only_);
      if (entry == null) return { ok: false, why: `${only_} is not a workspace this console knows yet`, asked: only_, swept };
      if (entry.reachable === false) return { ok: false, why: `${only_} is not a workspace this console can reach yet`, asked: only_, swept };
      workspaces = [entry];
    }
    for (const entry of workspaces) {
      if (entry.reachable === false) continue;
      const t = contextOf(entry.slug);
      if (t == null) continue;
      let agents = [];
      try {
        const answer = await jobBusCall(t, "listAgents", {});
        if (answer.status !== 200) throw new Error(`listAgents answered HTTP ${answer.status}`);
        const body = JSON.parse(answer.text);
        agents = Array.isArray(body) ? body : Array.isArray(body?.agents) ? body.agents : [];
      } catch (error) {
        console.log(`mail  ${entry.slug}'s roster could not be read, so no address was minted for it: ${error?.message ?? error}`);
        continue;
      }
      let minted;
      try {
        const response = await fetch(`${RELAY.cpUrl}/v1/relay/mail/mint`, {
          method: "POST",
          headers: { authorization: `Bearer ${RELAY.relayToken}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ slug: entry.slug, agents: agents.map((agent) => ({ id: agent?.id, name: agent?.name, isGroup: agent?.isGroup === true })) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        minted = await response.json();
      } catch (error) {
        console.log(`mail  the control plane did not mint addresses for ${entry.slug}: ${error?.message ?? error}`);
        continue;
      }
      const addresses = Array.isArray(minted?.addresses) ? minted.addresses : [];
      swept.push({ slug: entry.slug, addresses: addresses.length, minted: Number(minted?.minted ?? 0), retired: Number(minted?.retired ?? 0) });

      if (noPush.has(entry.slug)) {
        console.log(`mail  ${entry.slug} holds ${addresses.length} address(es) and they route; nothing was written inside that box, which this relay is set to leave read-only`);
        continue;
      }
      // The box's own copy, so the prompt can say what this bot's address is without a network
      // call. An older bundle has no such command and says so; that is not a failure worth a line
      // every five minutes, so it is counted and said once per sweep.
      const push = await jobBusCall(t, "setAgentMail", {
        domain: String(minted?.domain ?? ""),
        // MAIL-3. This one boolean decides two things at once inside the box: whether the bot is
        // offered the send tool at all, and whether its own facts say it can send. Both flip
        // together on the sweep after the relay carries the route, which is why the ship order is
        // boxes first and the relay last -- a relay that answered /mail/send while the boxes were
        // still on the old bundle would be a fleet of bots claiming a capability they do not hold.
        canSend: sendingIsOn(entry.slug, noSend),
        addresses: addresses.filter((row) => row.state !== "retired")
          .map((row) => ({ agentId: row.agentId, code: row.code, address: row.address })),
      }).catch((error) => ({ status: 0, text: String(error?.message ?? error), type: "" }));
      if (push.status !== 200) {
        console.log(`mail  ${entry.slug}'s box did not take the address list (HTTP ${push.status} ${String(push.text).slice(0, 120)}); `
          + "delivery is unaffected, only what its bots can say about their own address");
      }
    }
    // Re-read only when something was actually minted: the warm read at the top of this function
    // is already this pass's directory otherwise.
    const minted = swept.reduce((total, row) => total + row.minted, 0);
    const retired = swept.reduce((total, row) => total + row.retired, 0);
    const refreshed = minted + retired > 0 ? await mailDirectoryRefresh() : warmed;
    console.log(`mail  swept ${swept.length} workspace(s) for addresses (${reason}); ${minted} minted, ${retired} retired, `
      + (refreshed.ok ? `${refreshed.addresses} in the directory` : `the directory could not be re-read: ${refreshed.why}`));
    return { ok: true, swept, directory: refreshed, ...(only_.length > 0 ? { asked: only_ } : {}) };
  } finally { mailSweepRunning = false; }
}

/** One sweep at start and one every five minutes. Never awaited into the listen. */
function mailSweepStart() {
  if (RELAY == null) return;
  void mailMintSweep("this relay started");
  setInterval(() => { void mailMintSweep("the timer"); }, MAIL_SWEEP_MS).unref();
}

// ---- POST /mail/send, a bot sending from its own address (MAIL-3, docs/MAIL.md) ----------------
//
// This relay is the only process holding all three things a send needs: every tenant's gateway
// bearer, the cached address directory, and the directory owner's Resend key. So it is the only
// place the key can stay while a bot in a box still gets to send. The rules and the order of the
// refusals are in ui/mail-edge.mjs; what is here is the three things that cannot leave this file.
//
// The credential is the box's OWN gateway token, which the registry already maps to a slug with no
// early break -- the same value and the same comparison handleRuntimeBundle uses for the host
// bundle. No new secret is minted anywhere in this wave.

/** The claim, on the control plane, before anything is sent. */
async function mailSendOpen(row) {
  if (RELAY == null) return { ok: false, error: "unreachable", message: "this relay has no control plane" };
  let response;
  try {
    response = await fetch(`${RELAY.cpUrl}/v1/relay/mail/send/open`, {
      method: "POST",
      body: JSON.stringify(row),
      headers: { authorization: `Bearer ${RELAY.relayToken}`, "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, error: "unreachable", message: error?.name === "TimeoutError" ? "timed out" : "no answer" };
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 200 && body?.ok === true && Number(body.id) > 0) return { ok: true, id: Number(body.id) };
  // A cap refusal is passed on WORD FOR WORD: the control plane counted the rows, so it is the one
  // that knows the number and when the next one can go.
  if (response.status === 429) return { ...body, ok: false, error: "rate_limited" };
  return { ok: false, error: String(body?.error ?? `HTTP ${response.status}`), message: String(body?.message ?? "the claim was refused") };
}

/** And what happened to it. Never awaited into a refusal: a settle that fails is logged, not raised. */
async function mailSendClose(id, outcome, resendId, detail) {
  if (RELAY == null) return;
  const response = await fetch(`${RELAY.cpUrl}/v1/relay/mail/send/close`, {
    method: "POST",
    body: JSON.stringify({ id, outcome, resendId, detail }),
    headers: { authorization: `Bearer ${RELAY.relayToken}`, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
}

// MAIL-3 follow-up. The cheap door in front of the caps. The real policy is the control plane's --
// thirty an hour per bot, two hundred a day per workspace, counted over rows nobody in a box can
// reach -- and this is not that. This is the transport refusal that keeps a looping caller, or one
// with no credential at all, from costing this process a control plane round trip per attempt. The
// key is a HASH of the bearer and never the bearer, so no token is held in a limiter's Map; a
// caller that presents none is keyed by address instead. Sixty a minute is far above what a bot
// sending tens of mails a day ever asks for.
const mailSendLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
function mailSendLimiterKey(req) {
  const header = String(req.headers.authorization ?? "");
  const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  return presented.length === 0 ? `client:${clientOf(req)}` : `box:${sha256Hex(presented).slice(0, 32)}`;
}
/** Answered in the send route's own shape, because the sentence is what a bot reads back. */
function mailSendTooMany(req, res, wait) {
  return drainThenEnd(req, res, 429,
    { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(wait) },
    JSON.stringify({
      message: "That is more mail than this box may ask for right now, so nothing was sent. Try again in a minute.",
      sent: false,
      error: "rate_limited",
    }));
}

let mailSendRouteBuilt = null;
function mailSendRoute() {
  if (mailSendRouteBuilt != null) return mailSendRouteBuilt;
  mailSendRouteBuilt = createMailSendRoute({
    readBody,
    drainThenEnd,
    // The bearer proves the WORKSPACE. Every entry is compared with no early break, so the time
    // this takes says nothing about which one matched or how many there are.
    workspaceOf: (bearer) => {
      const entry = registry.matchToken(bearer);
      return entry == null ? null : { slug: entry.slug, name: entry.name };
    },
    // Scoped to the caller's own slug, which is what makes one lookup refuse three things.
    directoryRowFor: (slug, agentId) => mailDirectoryRowOf(slug, agentId),
    // THE DIRECTORY OWNER'S settings and never the caller's. mailEdgeFor is per tenant and a
    // customer's own mail.json has an empty apiKey, so a route written the obvious way would find
    // no key on every customer and the bug would read as "Resend refused".
    ownerSettings: () => {
      const owner = contextOf(mailDirectoryOwnerSlug());
      return owner == null ? Promise.resolve(null) : readMailSettings(owner.mailSettingsFile);
    },
    directoryDomain: () => mailDirectoryDomain(),
    noSend: (slug) => mailNoSendSlugs().has(String(slug ?? "")),
    openSend: mailSendOpen,
    closeSend: mailSendClose,
    // The workspace's own readable row, on the workspace's own volume, beside its inbox ledger.
    appendSent: async (slug, row) => {
      const t = contextOf(slug);
      if (t == null) return;
      t.ensureDir();
      await appendMailLedger(row, { file: t.mailSentLedgerFile, ownLikeParent });
    },
    log: (line) => console.log(line),
  });
  return mailSendRouteBuilt;
}

/**
 * POST /mail/sweep, for `cp mail sweep`. Behind CP_RELAY_TOKEN, which is the one credential these
 * two services already share, and mounted beside the webhook rather than behind the console login
 * because the caller is the control plane and not a person.
 */
async function handleMailSweepRoute(req, res) {
  const expected = String(RELAY?.relayToken ?? "");
  if (expected.length === 0) return fail(res, 404, "not found");
  if (req.method !== "POST") return fail(res, 405, "POST", { allow: "POST" });
  const header = String(req.headers.authorization ?? "");
  const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  if (presented.length === 0 || !safeEqual(presented, expected)) return fail(res, 401, "unauthorized");
  // ONBOARD-2. An OPTIONAL {slug}. No body is exactly what this route did before -- the whole fleet,
  // which is what `cp mail sweep` sends and what the timer runs -- and a slug sweeps that one
  // workspace so giving a new customer their addresses does not reach into every other customer's
  // box. A body that will not parse is treated as no body rather than refused, because the caller
  // that sends none is the one this route was written for.
  let only = "";
  try {
    const raw = await readBody(req, 4096);
    if (String(raw ?? "").trim().length > 0) {
      const body = JSON.parse(raw);
      if (body != null && typeof body === "object" && !Array.isArray(body)) only = String(body.slug ?? "").trim();
    }
  } catch { only = ""; }
  const answer = await mailMintSweep(only.length > 0 ? `the control plane asked for ${only}` : "the operator asked for it", { only });
  res.writeHead(answer.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
  return res.end(JSON.stringify(answer));
}

// ---- POST /mail/product and POST /tenant/purge (ONBOARD-2) -------------------------------------
//
// Both behind CP_RELAY_TOKEN, both called only by the control plane, and both built once and cached
// the way mailSendRoute is. What cannot leave this file is in here and nothing else: the stored key's
// owner, the docker socket, the tenant root and the registry.
//
// THEY ARE MOUNTED AT THE TOP LEVEL AND NOT UNDER /admin/, which is not a style choice.
// handleRelayAdmin computes its method allow-list from which of five regexes matched the path, so a
// POST to a path none of them match is answered 405 BEFORE the credential is even read -- and a 405
// there reads, from the control plane's side, as the relay refusing it. Beside /mail/sweep is where a
// control-plane door belongs on this server.

let productMailRouteBuilt = null;
function productMailRoute() {
  if (productMailRouteBuilt != null) return productMailRouteBuilt;
  productMailRouteBuilt = createProductMailRoute({
    readBody,
    drainThenEnd,
    relayToken: RELAY?.relayToken ?? "",
    // THE DIRECTORY OWNER'S settings and never a tenant's, the same resolution the bot's send door
    // uses: a customer's own mail.json has an empty apiKey, so a route written the obvious way would
    // find no key and the bug would read as "Resend refused".
    ownerSettings: () => {
      const owner = contextOf(mailDirectoryOwnerSlug());
      return owner == null ? Promise.resolve(null) : readMailSettings(owner.mailSettingsFile);
    },
    productFrom,
    log: (line) => console.log(line),
  });
  return productMailRouteBuilt;
}

// Where this host keeps workspaces. The relay's compose mounts /data/titanbot at the identical path
// the host uses, which is why that is the default; the two environment names are an escape hatch for
// an install that put it somewhere else, read in the order an operator would expect.
const TENANT_DATA_ROOT = process.env.SAND_UI_TENANT_ROOT?.trim()
  || process.env.CP_TENANT_ROOT?.trim()
  || "/data/titanbot";

let tenantPurgeRouteBuilt = null;
function tenantPurgeRoute() {
  if (tenantPurgeRouteBuilt != null) return tenantPurgeRouteBuilt;
  tenantPurgeRouteBuilt = createTenantPurgeRoute({
    readBody,
    drainThenEnd,
    relayToken: RELAY?.relayToken ?? "",
    tenantRootOf: () => TENANT_DATA_ROOT,
    // A registry that still routes to a workspace is a workspace that is still there, whatever
    // docker says about one container name.
    registryKnows: (slug) => {
      const entry = registry.get(String(slug ?? ""));
      return entry != null && entry.reachable !== false;
    },
    containerFor: (slug) => registry.get(String(slug ?? ""))?.box ?? "",
    // `docker ps -a`, not `docker ps`: a stopped container still exists, still holds the customer's
    // mounts and still comes back on a reboot, so "not running" is not "gone".
    dockerNames: allDockerNames(execFile),
    removeTree: removeTreeFs,
    statTree: statTreeFs,
    operatorSlug: OPERATOR_SLUG,
    log: (line) => console.log(line),
  });
  return tenantPurgeRouteBuilt;
}

// ---- coding tasks, in a throwaway computer (CODE-1, docs/CODE.md) -----------------------------
//
// This relay is the only process on the machine holding /var/run/docker.sock, it mounts
// /data/titanbot at the identical path the host uses, and it already drives docker through the CLI in
// its own image. So a coding task's container is made HERE, one per task, on its own internal network
// that reaches the proxy and nothing else, and removed when the task ends.
//
// The credential is the box's OWN gateway token, exactly as POST /mail/send takes it: no new secret is
// minted anywhere for this, and a box with no relay in front of it resolves nothing and is handed a
// plain refusal rather than a control that cannot work.
//
// Every rule worth testing is in ui/code-edge.mjs. What is here is the four things that cannot leave
// this file: the per-tenant paths, the control plane claim, the limiter and the route mounting.

/** Where a task's files go. This is the HOST side of the directory the box already mounts as
 *  /workspace, so the sandbox writes straight where the bot can read it with the tools it already has
 *  and there is no copy-back at all. cp/provision.mjs: <root>/volumes/workspace is the box's
 *  /workspace, and entry.stateDir is <root>/state.
 *
 *  CODE_TASK_ROOT is the override this Mac's gate uses, because a local relay is a host process with
 *  no tenant tree under it. */
function codeTaskRootFor(slug, taskId) {
  const override = String(process.env.CODE_TASK_ROOT ?? "").trim();
  if (override.length > 0) return path.join(override, String(slug), "code", String(taskId));
  const t = contextOf(slug);
  if (t == null || String(t.stateDir ?? "").length === 0) return "";
  return path.join(path.dirname(t.stateDir), "volumes", "workspace", "code", String(taskId));
}

/** The fallback credential directory, used only when a daemon will not take a tar on stdin. It is
 *  OUTSIDE volumes/, so it is outside every mount the box has: a key the box could read would defeat
 *  the whole custody argument. Deleted by the end path and by the sweep. */
function codeCredRootFor(slug) {
  const override = String(process.env.CODE_TASK_ROOT ?? "").trim();
  if (override.length > 0) return path.join(override, String(slug), "code-cred");
  const t = contextOf(slug);
  if (t == null || String(t.stateDir ?? "").length === 0) return "";
  return path.join(path.dirname(t.stateDir), "code-cred");
}

/** The workspace's own task file, beside its two mail ledgers and on the same volume. THIS is where
 *  the customer's own words live: the title and the instructions. The control plane's row carries
 *  neither, the same rule mail_send_log holds about subjects. */
const codeTasksFile = (slug) => {
  const t = contextOf(slug);
  return t == null ? "" : t.file("code-tasks.jsonl");
};

/** The claim, BEFORE the container exists. An unstarted task is recoverable; an unbilled container
 *  hour is not. The response carries the per-task key, which this process holds for the length of one
 *  create and never writes down. */
async function codeTaskOpen(row) {
  if (RELAY == null) return { ok: false, error: "unreachable", message: "this relay has no control plane" };
  let response;
  try {
    response = await fetch(`${RELAY.cpUrl}/v1/relay/code/task/open`, {
      method: "POST",
      body: JSON.stringify(row),
      headers: { authorization: `Bearer ${RELAY.relayToken}`, "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, error: "unreachable", message: error?.name === "TimeoutError" ? "timed out" : "no answer" };
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 200 && body?.ok === true && Number(body.id) > 0) return { ...body, ok: true, id: Number(body.id) };
  if (response.status === 429) return { ...body, ok: false, error: "rate_limited" };
  return { ok: false, error: String(body?.error ?? `HTTP ${response.status}`), message: String(body?.message ?? "the claim was refused") };
}

/** And what happened to it. Never awaited into a refusal: a close that fails is logged, not raised.
 *
 *  THE DEADLINE IS 45 SECONDS AND NOT 10, AND IT RETRIES ONCE. The control plane reads the task's
 *  model spend off the per-task key before it answers, and the proxy books a key's spend with the
 *  same batch writer /spend/logs is filled from: measured at about fifteen seconds, so that read
 *  waits up to twenty. A 10 s deadline here therefore timed out on a close that was working --
 *  measured on the R750 2026-09-10, "could not close task row 2: The operation was aborted due to
 *  timeout" on a task that really had ended, which leaves a container's minutes unbilled. The retry
 *  is safe by the other side's own design: the row's ended_at is written BEFORE that wait, so a
 *  second close answers {ok:true, already:true} at once and the first one finishes on its own. */
async function codeTaskClose({ id, outcome, minutes, detail }) {
  if (RELAY == null || !(Number(id) > 0)) return;
  let last = null;
  for (const deadline of [45_000, 45_000]) {
    let response;
    try {
      response = await fetch(`${RELAY.cpUrl}/v1/relay/code/task/close`, {
        method: "POST",
        body: JSON.stringify({ id: Number(id), outcome, minutes, detail }),
        headers: { authorization: `Bearer ${RELAY.relayToken}`, "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(deadline),
      });
    } catch (error) {
      // A timeout is the one failure worth asking again about; anything else is this relay's own.
      last = error;
      if (error?.name === "TimeoutError") continue;
      throw error;
    }
    if (response.status === 200) return;
    last = new Error(`HTTP ${response.status}`);
    // A 404 means the control plane has no such row, and asking twice will not invent one.
    if (response.status === 404) throw last;
  }
  throw last ?? new Error("the close never answered");
}

/** The E2B key, asked for again rather than held between calls. It is a write-only control plane
 *  setting an operator pastes, and it is never read from any file on this machine. CODE-3. */
async function codeE2bKey(slug) {
  if (RELAY == null) return "";
  try {
    const response = await fetch(`${RELAY.cpUrl}/v1/relay/code/e2b-key`, {
      method: "POST",
      body: JSON.stringify({ slug }),
      headers: { authorization: `Bearer ${RELAY.relayToken}`, "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return "";
    return String((await response.json())?.key ?? "");
  } catch { return ""; }
}

// The cheap door in front of the caps. The real policy is the control plane's -- two concurrent and
// twenty a day per workspace, counted over rows nobody in a box can reach -- and this is not that.
// This is the transport refusal that keeps a looping caller from costing this process a control plane
// round trip and a `docker network ls` per attempt. The key is a HASH of the bearer and never the
// bearer, so no token is held in a limiter's Map. Thirty a minute is far above what a bot starting
// two tasks at a time ever asks for, and it covers status polling too.
const codeLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const codeLimiterKey = (req) => mailSendLimiterKey(req);
const codeTooMany = (req, res, wait) => drainThenEnd(req, res, 429,
  { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(wait) },
  JSON.stringify({
    message: "That is more coding than this box may ask for right now, so nothing started. Try again in a minute.",
    started: false,
    error: "rate_limited",
  }));

let codeEdgeBuilt = null;
function codeEdge() {
  if (codeEdgeBuilt != null) return codeEdgeBuilt;
  codeEdgeBuilt = createCodeEdge({
    execFile,
    readBody,
    drainThenEnd,
    // The bearer proves the WORKSPACE. Every entry is compared with no early break, so the time this
    // takes says nothing about which one matched or how many there are.
    workspaceOf: (bearer) => {
      const entry = registry.matchToken(bearer);
      return entry == null ? null : { slug: entry.slug, name: entry.name };
    },
    taskRootFor: codeTaskRootFor,
    credRootFor: codeCredRootFor,
    boxOf: (slug) => String(contextOf(slug)?.box ?? ""),
    ownLikeParent,
    readTasks: async (slug) => {
      const file = codeTasksFile(slug);
      return file.length === 0 ? [] : await readCodeTasks(file);
    },
    writeTask: async (slug, row) => {
      const t = contextOf(slug);
      if (t == null) return;
      t.ensureDir();
      await appendCodeTask(t.file("code-tasks.jsonl"), row, { ownLikeParent });
    },
    openTask: codeTaskOpen,
    closeTask: codeTaskClose,
    e2bKeyFor: codeE2bKey,
    dockerAvailable,
    // The per-workspace settings the control plane owns. Read through the registry entry, so a change
    // there takes effect on the next call with nothing restarted; CODE_DEFAULTS is the shape and the
    // fallback, and CODE-9 is the row about these wanting a control in the admin console.
    settingsFor: (slug) => ({ ...CODE_DEFAULTS, ...(registry.get(slug)?.code ?? {}) }),
    log: (line) => console.log(line),
  });
  return codeEdgeBuilt;
}

/** One sweep at start and one every 60 s: the wall clock, the orphans a restart left behind, and the
 *  networks with nothing in them. Mounted exactly where mailSweepStart is and never awaited, for the
 *  same reason: a docker daemon that is slow must not stop this console coming up.
 *
 *  It is the ONLY thing enforcing the wall clock. A timer in this process's memory does not survive
 *  the restart that ends every ship, and the deadline lives on the container's own label so that a
 *  relay which has never heard of a task can still end it. */
function codeSweepStart() {
  void (async () => {
    // What this process believes is running, rebuilt from every workspace's rows BEFORE the first
    // sweep, so a restart does not read its own live tasks as orphans and kill them.
    for (const entry of registry.all()) {
      const file = codeTasksFile(entry.slug);
      if (file.length === 0) continue;
      codeEdge().adopt(entry.slug, await readCodeTasks(file).catch(() => []));
    }
    await codeEdge().sweep("this relay started").catch((error) => console.log(`code  first sweep failed: ${error?.message ?? error}`));
  })();
  setInterval(() => {
    void codeEdge().sweep("the timer").catch((error) => console.log(`code  sweep failed: ${error?.message ?? error}`));
  }, CODE_SWEEP_MS).unref();
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
  // The directory's domain is decided here and never by a claim on a tenant's own Mail card. Any
  // workspace can write "myagents.email" into its own settings and set its own signing secret; if
  // that made it a claimant, its secret would be the one that verified its own body and the edge it
  // reached could resolve any customer's code. So: a recipient at the directory's domain is the
  // directory owner's mail, whatever anybody else's mail.json says, and their secret is the only
  // one that can prove it.
  const directoryDomain = mailDirectoryDomain();
  if (directoryDomain.length > 0 && domains.includes(directoryDomain)) {
    const ownerSlug = mailDirectoryOwnerSlug();
    const owner = contextOf(ownerSlug);
    if (owner != null) return await mailEdgeFor(owner).handleWebhook(req, res, { raw });
    console.log(`mail  a webhook named ${directoryDomain} and ${ownerSlug}, which holds it, is not a workspace on this console`);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ignored: "no_directory_owner" }));
  }
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

// ---- CORS, for exactly the app origins and nothing else (STORE-1) -------------------------------
//
// The rules and the argument for each are at the bottom of ui/auth-device.mjs. In one line: an
// exact-string set, no allow-credentials ever, and an allowed Origin is never a REQUIREMENT for a
// bearer request -- it decides only which access-control headers come back, because a native HTTP
// client sends no Origin at all.
//
// SAND_UI_APP_ORIGINS names the set; empty, the default, is capacitor://localhost plus
// https://localhost. A third origin for the desktop shell is therefore a config line and not a
// deploy of new code.
const APP_ORIGINS = parseAppOrigins(process.env.SAND_UI_APP_ORIGINS);

// WHICH PATHS CORS IS FOR, named rather than "everything". Until the review pass these headers went
// on at the top of the entry and therefore on every route on this relay: measured on the R750
// 2026-09-10, OPTIONS /v1/jobs, /admin/login-ledger, /mail/send and /code/start each answered 204
// with access-control-allow-origin: capacitor://localhost. Nothing was exploitable -- no cookie is
// ever sent cross-site and each of those doors wants a credential a page does not hold -- but
// https://localhost is on the default allow-list and is the commonest dev origin on a customer's own
// machine, so the blast radius of any future credential a page could hold was the whole relay rather
// than the console API. These are the paths docs/APPS.md section 3 describes and the only paths the
// gate's own shell touches; everything else falls through with no access-control headers at all,
// exactly as it did before this wave.
const CORS_ASSET = /\.(css|js|mjs|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|map|webmanifest|txt|md)$/;
function corsPath(pathname) {
  if (pathname.startsWith("/api/")) return true;
  if (pathname === "/events") return true;
  if (pathname === "/auth/token") return true;
  if (DEVICE_ROUTE.test(pathname)) return true;
  if (pathname === "/push" || pathname.startsWith("/push/")) return true;
  if (pathname.startsWith("/avatars/")) return true;
  // The static console, by the same test the asset branch itself uses further down.
  if (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/machine-room/")) return true;
  return CORS_ASSET.test(pathname);
}

/**
 * Called from the entry, above every door, and answers true when it already answered the request.
 *
 * It is above the login gate because a browser sends NO cookie and NO Authorization on a preflight,
 * so a preflight below the gate is a 401 and every cross-origin call a shell makes dies on it.
 * Measured on grok-bot-local-vm 2026-09-09: OPTIONS /api/getHealth with an Origin answered 401 with
 * x-relay-auth: required, because this file had no OPTIONS handler at all.
 *
 * An OPTIONS from an origin nobody named gets 403 and no access-control headers: the browser would
 * refuse the real request anyway, and a 401 there would be read as "sign in", which is not the fault.
 */
function handleCors(req, res, url) {
  const origin = String(req.headers.origin ?? "");
  if (origin.length === 0) return false;
  if (!corsPath(String(url?.pathname ?? ""))) return false;
  const headers = corsHeaders(origin, APP_ORIGINS);
  for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
  if (req.method !== "OPTIONS") return false;
  // A preflight is never a request for data, so it is answered here whatever path it names.
  if (headers?.["access-control-allow-origin"] == null) {
    res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "that origin is not allowed here" }));
    return true;
  }
  res.writeHead(204, { "cache-control": "no-store", "content-length": "0" });
  res.end();
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  // Set before anything answers, so it is on every response including the login page and the
  // refusals. writeHead's own header object is merged over this rather than replacing it.
  if (secureOf(req)) res.setHeader("strict-transport-security", HSTS);
  try {
    // After the HSTS line and above every door, for the reason on handleCors: a preflight carries no
    // credential of any kind, so one answered below the login gate is a 401 and a bundled shell is
    // dead on its first call. A request with no Origin, or one nobody named, falls straight through
    // and behaves exactly as it does today.
    if (handleCors(req, res, url)) return;
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
    // MAIL-2. The control plane asking this relay to mint the addresses a new bot is missing, out
    // of band from the five minute timer. Its credential is CP_RELAY_TOKEN, the same one the two
    // routes below take, so it sits here rather than behind the console login.
    if (url.pathname === "/mail/sweep") return await handleMailSweepRoute(req, res);
    // ONBOARD-2, and here for the same reason /mail/sweep is: the caller is the control plane and not
    // a person, its credential is CP_RELAY_TOKEN, and a console session must not open either of them.
    // The first sends the product's own mail, which is the only mail on this server whose sender is
    // the product rather than a bot. The second is the only destructive route on this relay, and the
    // only place in the product that can delete a customer's data at all: the control plane runs as
    // uid 1001 and a box's volumes are 0700 owned by uid 1000, measured on the R750 2026-09-10.
    if (url.pathname === "/mail/product") return await productMailRoute().handleProductMail(req, res);
    if (url.pathname === "/tenant/purge") return await tenantPurgeRoute().handlePurge(req, res);
    // MAIL-3, and before the console's login for the same reason the runtime bundle is: the caller
    // is a bot inside a box, which holds no session cookie. Its credential is the box's own gateway
    // token, presented as a bearer and matched against the registry -- the one credential a box
    // already has, so no new secret is minted for this.
    if (url.pathname === "/mail/send") {
      const wait = mailSendLimiter.retryAfterSeconds(mailSendLimiterKey(req));
      if (wait > 0) return await mailSendTooMany(req, res, wait);
      return await mailSendRoute().handleSend(req, res);
    }
    // CODE-1, and before the console's login for the same reason /mail/send is: the caller is a bot
    // inside a box, which holds no session cookie. Its credential is the box's own gateway token,
    // presented as a bearer and matched against the registry. Five routes, one limiter, and every
    // refusal is a plain sentence the bot reads back to the person. docs/CODE.md section 3.
    if (url.pathname.startsWith("/code/") && req.method === "POST") {
      const verb = url.pathname.slice("/code/".length);
      if (["start", "status", "stop", "result", "list"].includes(verb)) {
        const wait = codeLimiter.retryAfterSeconds(codeLimiterKey(req));
        if (wait > 0) return await codeTooMany(req, res, wait);
        const edge = codeEdge();
        if (verb === "start") return await edge.handleStart(req, res);
        if (verb === "status") return await edge.handleStatus(req, res);
        if (verb === "stop") return await edge.handleStop(req, res);
        if (verb === "result") return await edge.handleResult(req, res);
        return await edge.handleList(req, res);
      }
    }
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
    // STORE-1. The token door, beside /auth/state and above the login gate for the same reason the
    // preflight is: the caller minting a token has no credential this console would recognise yet.
    if (url.pathname === "/auth/token") return await handleDeviceTokenMint(req, res);
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
      if (!isAuthorized(req)) {
        // STORE-1. A BAD DEVICE BEARER IS RATE LIMITED AND CHARGES NOTHING ELSE. An app whose token
        // expired while the phone was in a drawer must not be able to lock its owner out of his own
        // laptop's console and the job bus, which is what the shared `throttle` object would do: it
        // is one bucket per address and all three doors read it. So this gets its own fixed window,
        // 60 a minute per address, the same shape the job bus limiter has.
        if (looksLikeDeviceBearer(req.headers.authorization)) {
          const seconds = deviceUseLimiter.retryAfterSeconds(clientOf(req));
          if (seconds > 0) {
            return fail(res, 429, `too many requests; wait ${seconds}s`,
              { "retry-after": String(seconds), ...RELAY_AUTH_HEADER });
          }
        }
        return denyUnauthenticated(req, res, url);
      }
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
    // STORE-1. The person's own devices: what they are signed in on, and taking one away. Scoped by
    // subOf, because two accounts can share one workspace and one customer's phone list is not the
    // other's.
    if (DEVICE_ROUTE.test(url.pathname)) {
      const [, id] = DEVICE_ROUTE.exec(url.pathname);
      const sub = subOf(req);
      if (req.method === "GET" && id === undefined) return handleDeviceList(req, res, t, sub);
      if (req.method === "DELETE" && id !== undefined) return handleDeviceRevoke(req, res, t, sub, decodeURIComponent(id));
      return fail(res, 405, id === undefined ? "GET" : "DELETE");
    }
    // PUSH-1, through the hook seam, so this file carries the dispatch and ui/push-edge.mjs carries
    // every rule. With no push-edge.mjs this falls through to the 404 at the bottom, which is what a
    // shell needs to read on a relay that has no push: a refusal rather than a hang.
    if (url.pathname === "/push" || url.pathname.startsWith("/push/")) {
      const push = HOOKS.pushRoutes();
      if (push != null && await push.handle({ t, req, res, url, sub: subOf(req) }) === true) return;
      return fail(res, 404, `not found: ${req.method} ${url.pathname}`);
    }
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
    // FEEDBACK-1. A problem report on its way to the developers.
    //
    // Here rather than inside the box, and that is the whole design. The agent's tool writes a
    // PENDING report into its own box and returns a sentence; the console draws it, the person can
    // edit it or drop it, and this route is what carries the one they chose to send. So the report
    // never leaves the box without the operator, by topology rather than by a check somebody could
    // forget, and no control plane credential is ever inside a customer's container -- CP_RELAY_TOKEN
    // reads every tenant's gateway token, and every exec daemon in a box runs as uid 0.
    //
    // THE WORKSPACE IS STAMPED HERE, from `t`, which came from the session's own tenant claim. A
    // slug in the body is ignored, not refused: the field is simply not read anywhere on this path.
    if (url.pathname === "/feedback") {
      if (req.method !== "POST") return fail(res, 405, "POST");
      return await forwardFeedback(req, res, t);
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
        const type = types[path.extname(file)] ?? "application/octet-stream";
        // COST-1's other seam. Measured on grok-bot-local-vm at 390x844 2026-09-09: every asset of the
        // 1,547 KiB of JS came back `cache-control: no-store`, and live every one is cf-cache-status
        // DYNAMIC -- so a second boot pays for the whole bundle again. The policy is the hook's, and
        // with no ui/asset-cache.mjs it is `no-store`, exactly as today.
        //
        // THE POLICY IS PRIVATE, NEVER PUBLIC. denyUnauthenticated runs above this branch and the relay
        // writes no `vary`, so a publicly cacheable response would let the edge serve a signed-in 200,
        // or a 401, to everybody. Cloudflare will keep answering BYPASS on a private answer, which is
        // the intended outcome and is printed by the gate in plain words rather than read as a fault.
        const policy = HOOKS.assetPolicy(file, url, req);
        if (policy.status === 304) {
          res.writeHead(304, policy.headers);
          return res.end();
        }
        // index.html is stamped on the way out, the way sameOriginDesktop already rewrites that same
        // HTML, so the file on disk is never edited for a cache policy and the content-hashed-names
        // question never turns into a build step.
        if (type.startsWith("text/html")) {
          const html = HOOKS.stampHtml(bytes.toString("utf8"), url);
          res.writeHead(200, { "content-type": type, ...policy.headers });
          return res.end(html);
        }
        res.writeHead(200, { "content-type": type, ...policy.headers });
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
        // MARKET-6. This used to be the mechanism: read a customer's connectors.json out of the
        // box with `docker exec cat`, replace it whole, write it back. Two writers of one file
        // that never agreed on the rules, and a read that hiccuped could take every connector on
        // the box with it. It is now a SHIM: it works out which keys actually changed and calls
        // the host's own addLocalConnector / removeLocalConnector for each one, so validation
        // lives where the parser is and a customer's file is never rewritten wholesale by us.
        //
        // Every existing caller keeps its shape -- the same body in, the same {saved} out. A box
        // whose bundle predates those commands answers "unknown gateway method", and the old
        // whole-file write is what happens then, guards and all.
        // A read that failed and an empty file look the same in a map, and a diff computed from
        // the first would add every submitted entry a second time. So a failed read stops here
        // rather than being taken for a box with no connectors.
        const current = await readConnectors(t);
        if (current == null) return fail(res, 503, "the box could not be read, so nothing was changed");
        const delegated = await delegateConnectorChanges(t, current.mcpServers ?? {}, servers);
        if (delegated.handled) {
          if (delegated.error) return fail(res, 400, delegated.error);
          return sendJson({ saved: Object.keys(servers), restartRequired: true, delegated: delegated.changed });
        }
        // Reject a config the host would silently drop, rather than accepting it and leaving the
        // operator wondering why their connector never appears.
        //
        // MARKET-6. Two shapes are real now, not one. A `url` entry used to be dropped by the host's
        // own parser, so refusing it here was telling the truth; the host connects to one itself
        // now, and keeping the refusal would make the console the only door that cannot save what
        // the box can run. The host's single writer holds the whole rule table (https, no loopback,
        // no credential in the address, no literal in an auth header) and re-checks every entry on
        // load, so on any box carrying this bundle the shim above has already handled the write and
        // nothing below runs. What is left here is the old whole-file path, reached only by a box
        // whose bundle predates the two commands, kept honest enough to refuse a shape that box
        // would drop on the floor.
        for (const [name, config] of Object.entries(servers)) {
          if (config == null || typeof config !== "object") return fail(res, 400, `${name}: not an object`);
          const hasCommand = typeof config.command === "string" && config.command.length > 0;
          const hasUrl = typeof config.url === "string" && config.url.length > 0;
          if (!hasCommand && !hasUrl) {
            return fail(res, 400, `${name}: a connector is either a link (a "url" the box connects to) or a program (a "command" the box runs). Give one of the two.`);
          }
          if (hasCommand && hasUrl) {
            return fail(res, 400, `${name}: give either a "url" or a "command", not both.`);
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
      // The same fact the super admin's use-included door now reports, from the same inspect.
      const pinnedNames = PROVIDER_KEYS.filter((k) => envOf(k) != null);
      const pinned = pinnedNames.length > 0;
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
      // PROXY-1. The plan's own rows, in an array of their own so nothing that reads `endpoints`
      // has to learn to skip them, and with the virtual key rendered as the literal word
      // "included" -- the value is never sent to a browser, the same rule the catalog's own
      // apiKey: "set" follows. One probe for the set, attached to every row in it.
      const includedHealth = await probeIncluded(t);
      const included = includedRows(t).map((row) => ({ ...row, apiKey: "included", health: includedHealth }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ endpoints, included, live, pinned,
        pinnedBy: pinned ? `container env (${pinnedNames.join(", ")}); recreate the box without SAND_OPENAI_COMPATIBLE_* to unpin` : null,
        // Present only when it is true, so nothing has to read it on Jason's instance.
        ...(hasDocker ? {} : { liveNote: NOT_AVAILABLE.liveModel, switchable: false }) }));
    }
    // Save the catalog the operator edits in the browser.
    if (req.method === "POST" && url.pathname === "/endpoints") {
      const next = JSON.parse(await readBody(req) || "{}");
      if (!Array.isArray(next.endpoints)) return fail(res, 400, "endpoints must be an array");
      // PROXY-1, BEFORE the guard loop and not after it. The included rows are on screen with the
      // customer's own, so a save sends them back, and the guard runs over EVERY row in the body:
      // without this drop a customer editing a key they DO own is refused because of a row they
      // cannot edit and did not touch. They are also never written -- a plan row lives in the
      // registry, and one in a catalog file would be a stale copy of a key that gets re-minted.
      const offered = next.endpoints.filter((e) => !isPlanId(e?.id));
      // On a tenant, before anything is written: an address inside this server's own network is
      // not a provider, it is a port scan with a saved bearer aimed at it. See tenantEndpointRefusal.
      for (const e of offered) {
        const refusal = await tenantEndpointRefusal(t, e?.baseUrl);
        if (refusal != null) return fail(res, 400, refusal);
      }
      const current = await readCatalog(t);
      // A key the browser never received back comes in as "set"; keep the stored one.
      //
      // `included` and `enforced` are dropped from every surviving row, which is what makes the
      // probe bypass above safe to state as a fact: the flag exists only on rows this process
      // computed from the registry, so a body carrying {included: true} and an address on this
      // server's network is saved without it and probed under the guard like anything else.
      const merged = offered.map(({ included: _plan, enforced: _enforced, ...e }) => ({ ...e,
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
      // PROXY-1. A third branch, resolved from the registry rather than from any file: this is the
      // one place on the relay side that reads the virtual key, and the only place it is written.
      const plan = includedRows(t).find((row) => row.id === id) ?? null;
      const chosen = plan ?? (catalog.endpoints ?? []).find((e) => e.id === id);
      if (chosen == null) return fail(res, 404, `no endpoint named ${id}`);
      const secrets = await readSecrets(t);
      const next = { ...secrets, SAND_OPENAI_COMPATIBLE_BASE_URL: chosen.baseUrl, SAND_OPENAI_COMPATIBLE_MODEL: chosen.model, SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: chosen.name };
      // SERVED_BY joins the four that are deleted on every switch. It has to: it is what makes
      // Titan say a plan's name instead of the base URL's host AND what turns on the plan-worded
      // refusals, so a box moving BACK to a customer's own key must not keep either.
      // MODEL_LABEL travels with SERVED_BY for the same reason: it is a plan-only name, and a box
      // moving back to a customer's own key must say that key's model, not the plan's.
      for (const key of ["SAND_OPENAI_COMPATIBLE_API_KEY", "SAND_OPENAI_COMPATIBLE_TRANSPORT", "SAND_OPENAI_COMPATIBLE_ACCOUNT_ID", "SAND_OPENAI_COMPATIBLE_ORIGINATOR", "SAND_OPENAI_COMPATIBLE_SERVED_BY", "SAND_OPENAI_COMPATIBLE_MODEL_LABEL"]) delete next[key];
      if (plan != null) {
        next.SAND_OPENAI_COMPATIBLE_API_KEY = t.entry.included.key;
        if (plan.servedBy) next.SAND_OPENAI_COMPATIBLE_SERVED_BY = plan.servedBy;
        if (plan.modelLabel) next.SAND_OPENAI_COMPATIBLE_MODEL_LABEL = plan.modelLabel;
      } else if (chosen.subscription) {
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
      const health = plan != null
        // The plan row carries the registry-set flag, so this probe reaches the proxy on the
        // bridge rather than meeting the guard that would refuse its own address.
        ? await probe(t, { ...plan, apiKey: t.entry.included.key })
        : chosen.subscription
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
    // VOICE-1. The Voice card's own door: the vendor, which bot the voice talks to, the caps it is
    // under, what it has spent today, and the key as a write-only field. Behind the session like
    // every other console route, and it reports the key as a boolean and never as a value.
    if (url.pathname === "/voice/settings") return await voiceEdgeFor(t, voiceDeps).handleSettings(req, res);
    // The console's half of coding tasks: what is running, a Stop, and the limits in plain words.
    // Behind the session like every other console route, scoped to the session's own tenant, and it
    // reads the SAME rows the box route reads so the strip in the Computer card and the bot can never
    // disagree about what is running. No new gateway command, so none of the void-RPC class. CODE-1.
    if (req.method === "GET" && url.pathname === "/code/tasks") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(await codeEdge().handleConsoleTasks(t.slug)));
    }
    if (req.method === "POST" && url.pathname === "/code/tasks/stop") {
      let asked;
      try { asked = JSON.parse(await readBody(req, 64 * 1024) || "{}"); } catch { return fail(res, 400, "that was not JSON"); }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(await codeEdge().handleConsoleStop(t.slug, String(asked?.taskId ?? ""))));
    }
    if (req.method === "GET" && url.pathname === "/code/settings") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(codeEdge().handleConsoleSettings(t.slug)));
    }
    if (req.method === "GET" && url.pathname === "/health") {
      const upstream = await fetch(`${t.gateway}/health`, { headers: t.headers() });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json" });
      return res.end(text);
    }
    if (req.method === "GET" && url.pathname === "/events") return await relayEvents(t, req, res, url.search);
    if (req.method === "GET" && url.pathname.startsWith("/avatars/")) return await relayAvatar(t, req, res, url.pathname + url.search);
    // One file out of this tenant's box, for the console's file rows to open and save. Inside the
    // same session and the same tenant resolution as everything else here; see relayFile.
    if (req.method === "GET" && url.pathname === "/files") return await relayFile(t, req, res, url);
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
  // VOICE-1, before the destroy below, because an upgrade that reaches that line answers ZERO
  // BYTES -- measured: real Chrome then reports only onerror at 16 ms with no close code, which is
  // indistinguishable from this relay being down, and that void answer is a failure this console
  // has already been burned by. So voice gets its own branch, and every refusal inside it is an
  // ACCEPTED socket carrying one plain sentence.
  if (url.pathname === VOICE_SOCKET_PATH) {
    const voiceSlug = tenantOf(req);
    if (voiceSlug == null) return socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    const voiceContext = contextOf(voiceSlug);
    if (voiceContext == null) return socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n");
    // An upgrade carries cookies and is exempt from CORS, and the request handler above checks no
    // Origin at all, so this is the one place it can be checked for the route that opens a mic.
    return void voiceEdgeFor(voiceContext, voiceDeps)
      .handleUpgrade(req, socket, head, { origin: originAllowed(req) })
      .catch((error) => { console.log(`voice upgrade failed: ${error?.message ?? error}`); try { socket.destroy(); } catch { /* gone */ } });
  }
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
// The hook seam (ui/relay-hooks.mjs), loaded ONCE here and awaited into boot, before the first
// request. A hook that was sometimes present and sometimes not would be the worst of both halves, and
// loading it lazily on the first /api call would put an import on a request path.
//
// It is why the apps wave's three items have genuinely disjoint file lists: this file carries every
// call site and route line, and ui/api-diet.mjs, ui/asset-cache.mjs and ui/push-edge.mjs are each
// reached only through it. Any of the three being absent is a gate leg (tests/relay-hooks-absent),
// not a comment.
const HOOKS = await loadRelayHooks({
  log: (line) => console.log(line),
  deps: {
    // What an optional module cannot reach for itself: a tenant's context, its own state file, and the
    // one upstream call shape. Nothing here is new capability; it is the same three seams the mail
    // sweep already uses, handed over rather than re-derived.
    contextOf,
    tenants: () => registry.all().map((entry) => contextOf(entry.slug)).filter((one) => one != null),
    file: (t, name) => t.file(name),
    gatewayCall: (t, method, args) => jobBusCall(t, method, args),
    ownLikeParent,
    operatorSlug: OPERATOR_SLUG,
    // What a module with its own ROUTES needs and the three above do not give it: the body reader and
    // the refusal this file already uses everywhere, so /push answers in the same words and the same
    // shapes as /auth and /mail rather than inventing a second vocabulary for the same 400.
    readBody,
    fail,
    subOf,
    // WHETHER A LONG-LIVED CONNECTION'S CREDENTIAL IS STILL GOOD, asked again rather than once at
    // connect. `readDeviceSession` and NOT `deviceSessionOf`: the latter memoises its answer on the
    // request object, which is right for an ordinary request and wrong for an SSE request that lives
    // as long as a tray is open -- it would answer with the row as it was at connect for ever.
    //
    // A request with no device bearer on it is not this function's business and answers true: a cookie
    // session has its own expiry and the instance door has no row to revoke. With a bearer the row is
    // re-read and the tenant and person it names have to be the ones the connection was opened as, so a
    // revoked laptop's stream ends within one heartbeat instead of running until the socket drops.
    stillLive: (req, want) => {
      if (!looksLikeDeviceBearer(req?.headers?.authorization)) return true;
      const live = readDeviceSession(req);
      if (live == null) return false;
      if (want == null) return true;
      // The context's own slug rather than the raw claim, because that is the key the push edge files a
      // connection under and the registry is what normalises one into the other.
      const slug = String(live.context?.slug ?? live.tenant);
      return slug === String(want.tenant ?? "") && live.sub === String(want.sub ?? "");
    },
    // The control plane's address and credential, as two STRINGS rather than a reader. push-edge.mjs
    // builds its own reader out of them, because importing that reader into this file would make the
    // module mandatory and undo the one property the seam exists for.
    cpUrl: RELAY?.cpUrl ?? "",
    relayToken: RELAY?.relayToken ?? "",
    // The https half of a deep link a person taps on a lock screen. One env var because the relay has
    // never needed to know its own public name before: every other answer it gives is relative.
    publicHost: String(process.env.SAND_UI_PUBLIC_HOST ?? "").trim() || "console.titanium.bot",
  },
});
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
// MAIL-2. One sweep now and one every five minutes: each workspace's roster read, its missing
// addresses minted at the control plane, and the list pushed into its box. Not awaited, for the
// same reason the job bus arm above is not: a control plane or a gateway that is not up yet must
// not stop this console coming up, and the sweep logs either way.
mailSweepStart();
// CODE-1. One sweep now and one every minute: the wall clock off each container's own deadline label,
// the orphans a restart left behind, and the task networks with nothing in them. Not awaited, for the
// same reason the mail sweep is not. On a machine that has never run a coding task its first line says
// it removed nothing, which is how an operator tells "the sweep is running" from "the sweep is absent".
codeSweepStart();
// PUSH-1's sweep, beside the mail one and for the same reason: a pending card turning into a push is
// a timer over reads the gateway already answers, not a request path. A no-op with no push-edge.mjs.
HOOKS.pushSweepStart();
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
