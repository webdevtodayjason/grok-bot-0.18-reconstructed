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
import { createServer } from "node:http";
import net from "node:net";
import { adoptSubscription, forgetSubscription, resolveSubscription, scanSubscriptions } from "./subscriptions.mjs";
import { rewriteVncAsset } from "./vnc-bridge.mjs";
import {
  SESSION_LIFETIME_MS, clientAddress, createLoginThrottle, createSession, edgeAddress,
  isLoopbackHost, isSecureRequest, parseCookies, parseTrustedProxies, readAuthFile, readSession,
  safeEqual, safeNextPath, serializeCookie, verifyPassword,
} from "./auth.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

// Which model answers is an OPERATOR decision, not a rebuild. The host resolves it from
// process.env first and /home/box/sand-data/box-secrets.json second, and it re-reads that file
// with readFileSync on every single request -- so writing it takes effect on the next message,
// with no restart and no container recreate. The gateway's own setBoxSecrets refuses
// SAND_-prefixed names, which is why this writes the file directly instead of going through it.
let BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SECRETS_PATH = "/home/box/sand-data/box-secrets.json";
const ENDPOINTS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), "endpoints.json");
const PROVIDER_KEYS = ["SAND_OPENAI_COMPATIBLE_BASE_URL", "SAND_OPENAI_COMPATIBLE_MODEL",
  "SAND_OPENAI_COMPATIBLE_API_KEY"];

const dockerOut = (args) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 8 << 20 }, (err, out) => resolve(err != null && !out ? null : out)));

// Under a compose orchestrator the container is not necessarily called what the compose file calls
// it: Coolify names a service's container after its own resource id. Every `docker exec` below
// would then find nothing, and the failure is invisible -- the console loads and the model picker
// and the connector editor just return nothing. So if the configured name is not a container here,
// fall back to whatever is running with our own role label. The gateway URL never needs this: a
// compose network answers the SERVICE name whatever the container is called.
async function resolveBoxContainer() {
  // docker inspect prints "[]" on stdout for a missing container and exits 1, so a non-null
  // answer is not proof the name exists: on the R750 that read the Mac's container name as
  // found and every docker-backed route aimed at nothing (the desktop verdict, the endpoint
  // label, the connectors file). Only a real name, which docker prints with a leading slash, counts.
  const inspected = String(await dockerOut(["inspect", BOX, "--format", "{{.Name}}"]) ?? "").trim();
  if (inspected.startsWith("/")) return;
  const found = String(await dockerOut(["ps", "--filter", "label=com.titanbot.role=box", "--format", "{{.Names}}"]) ?? "")
    .split("\n").map((name) => name.trim()).find((name) => name.length > 0);
  if (found == null) return;
  console.log(`box  no container named ${BOX}; using ${found}, which carries com.titanbot.role=box`);
  BOX = found;
}

const readSecrets = async () => {
  const raw = await dockerOut(["exec", BOX, "cat", SECRETS_PATH]);
  try { return JSON.parse(raw).secrets ?? {}; } catch { return {}; }
};
// Merge, never replace: this file is also where the operator's real secrets live.
async function writeSecrets(next) {
  const body = JSON.stringify({ version: 1, secrets: next });
  return new Promise((resolve, reject) => {
    const child = execFile("docker", ["exec", "-i", BOX, "sh", "-c", `cat > ${SECRETS_PATH}`],
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
const readConnectors = async () => {
  const raw = await dockerOut(["exec", BOX, "cat", CONNECTORS_PATH]);
  if (raw == null) return null;
  if (String(raw).trim().length === 0) return { mcpServers: {} };
  try { return JSON.parse(raw); } catch { return { mcpServers: {} }; }
};
async function writeConnectors(next) {
  const body = JSON.stringify(next, null, 2);
  return new Promise((resolve, reject) => {
    // 0600: this file carries connector tokens in plaintext.
    const child = execFile("docker", ["exec", "-i", BOX, "sh", "-c",
      `umask 077 && cat > ${CONNECTORS_PATH} && chmod 600 ${CONNECTORS_PATH}`],
      (err) => (err ? reject(err) : resolve()));
    child.stdin.end(body);
  });
}

const readCatalog = async () => {
  try { return JSON.parse(await readFile(ENDPOINTS_FILE, "utf8")); } catch { return { endpoints: [] }; }
};

// A saved endpoint is only useful if it is actually up, so say so rather than implying it.
async function probe(endpoint) {
  const started = Date.now();
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

const GATEWAY = (process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340").replace(/\/+$/, "");
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
const TOKEN = process.env.SAND_HOST_GATEWAY_TOKEN?.trim() || tokenFromProfile();
const PORT = Number.parseInt(process.env.SAND_UI_PORT ?? "7777", 10);
const HERE = path.dirname(new URL(import.meta.url).pathname);

const upstreamHeaders = (extra = {}) => ({ ...(TOKEN.length > 0 ? { authorization: `Bearer ${TOKEN}` } : {}), ...extra });

function fail(res, status, message, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error: message }));
}

// ---- the login ------------------------------------------------------------------------------
// AUTH is read once at boot rather than per request. A password change is therefore a restart,
// which is what set-password.mjs prints, and it means a request path cannot be slowed down or
// broken by a half-written file.
const AUTH_FILE = path.join(HERE, "auth.json");
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
const clientOf = (req) => clientAddress(req, TRUSTED_PROXIES, CLOUDFLARE_RANGES);
const edgeOf = (req) => edgeAddress(req, TRUSTED_PROXIES);
const secureOf = (req) => isSecureRequest(req, TRUSTED_PROXIES);
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
  return TOKEN.length > 0 && header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), TOKEN);
}
function hasSession(req) {
  if (AUTH == null) return false;
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return raw != null && readSession(raw, AUTH.cookieSecret) != null;
}
function isAuthorized(req) {
  if (AUTH == null) return true;
  return bearerMatches(req) || hasSession(req);
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
  res.setHeader("set-cookie", serializeCookie(SESSION_COOKIE, createSession(AUTH.cookieSecret),
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

// One field, one button, the error inline, and every byte of it in this response. Serving no
// separate asset is not just tidiness: an asset path exempted from the session check would be a
// hole in the thing this page exists to close.
function loginPage({ error = "", next = "/" } = {}) {
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
</style>
</head>
<body>
<form method="post" action="/login">
  <div class="lights" aria-hidden="true"><span></span><span></span><span></span></div>
  <h1>Machine Room</h1>
  <p class="sub">This console drives the box. Sign in to reach it.</p>
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
  <button type="submit">Sign in</button>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
</form>
</body>
</html>
`;
}

function sendLoginPage(res, status, options) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  return res.end(loginPage(options));
}

// A password and a next path. Anything larger than this is not a login, and /login is the one
// route an unauthenticated caller may POST to on a published relay, so the body is capped rather
// than buffered whole.
const LOGIN_BODY_LIMIT = 8 * 1024;

// Answering without having read the body leaves the client still uploading, so the answer has to
// take the connection down with it. Ending the response first and destroying the request in its
// callback is the difference between the caller seeing a status and seeing a reset socket.
function endAndClose(req, res, status, headers, payload) {
  res.writeHead(status, { "cache-control": "no-store", connection: "close", ...headers });
  return res.end(payload, () => req.destroy());
}

async function handleLogin(req, res, url) {
  const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
  const key = clientOf(req);

  // Before the body, not after: a locked out address must not be able to make this process hold
  // anything in memory on its behalf.
  const waitMs = throttle.retryAfterMs(key);
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    console.log(`login rate limited for ${key}, ${seconds}s left`);
    const stalled = safeNextPath(url.searchParams.get("next"));
    const headers = { "retry-after": String(seconds) };
    if (!wantsHtml) return endAndClose(req, res, 429, { ...headers, "content-type": "application/json" }, JSON.stringify({ error: `too many attempts; wait ${seconds}s` }));
    return endAndClose(req, res, 429, { ...headers, "content-type": "text/html; charset=utf-8" },
      loginPage({ error: `Too many attempts. Wait ${seconds} seconds and try again.`, next: stalled }));
  }

  let body;
  try { body = await readBody(req, LOGIN_BODY_LIMIT); }
  catch (error) {
    if (error?.code !== "BODY_TOO_LARGE") throw error;
    // It counts as a failure: a flood of oversized bodies is an attack on this port, and the
    // lockout is the only thing that makes any of it slow.
    throttle.recordFailure(key);
    if (!wantsHtml) return endAndClose(req, res, 413, { "content-type": "application/json" }, JSON.stringify({ error: "that is not a password" }));
    return endAndClose(req, res, 413, { "content-type": "text/html; charset=utf-8" },
      loginPage({ error: "That request was too large to be a password." }));
  }
  const isJson = String(req.headers["content-type"] ?? "").includes("application/json");
  let fields = {};
  if (isJson) { try { fields = JSON.parse(body || "{}") ?? {}; } catch { fields = {}; } }
  else { fields = Object.fromEntries(new URLSearchParams(body)); }
  const next = safeNextPath(fields.next ?? url.searchParams.get("next") ?? "/");

  if (!verifyPassword(String(fields.password ?? ""), AUTH.password)) {
    throttle.recordFailure(key);
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
  const cookie = serializeCookie(SESSION_COOKIE, createSession(AUTH.cookieSecret),
    { maxAgeSeconds: SESSION_LIFETIME_MS / 1000, secure: secureOf(req) });
  res.writeHead(302, { location: next, "set-cookie": cookie, "cache-control": "no-store" });
  return res.end();
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
  for await (const chunk of req) {
    size += chunk.length;
    // A chunked body declares no length, so the count has to be kept while it arrives. Pausing
    // rather than destroying leaves the socket alive long enough for the caller to answer on it.
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// POST /api/<method> -> gateway. The browser never sees the token.
async function relayCommand(req, res, method) {
  const body = await readBody(req);
  const upstream = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: upstreamHeaders({ "content-type": "application/json" }),
    body: body.length > 0 ? body : "{}",
  });
  const text = await upstream.text();
  // The gateway refusing the relay's own bearer is not the operator being signed out, and passing
  // its 401 through wearing our status code is how a correct password ends in a login loop. It is
  // a broken deployment, so it answers as one, with the thing to go and look at.
  if (upstream.status === 401 || upstream.status === 403) {
    return fail(res, 502, `the gateway refused this relay's token (HTTP ${upstream.status}): ` +
      `SAND_HOST_GATEWAY_TOKEN is stale or the box was recreated. Signing in again will not help.`);
  }
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  res.end(text);
}

// GET /events -> gateway SSE, piped through unchanged so reconnects behave normally.
async function relayEvents(req, res, search) {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const upstream = await fetch(`${GATEWAY}/events${search}`, { headers: upstreamHeaders(), signal: controller.signal });
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

async function relayAvatar(req, res, pathname) {
  const upstream = await fetch(`${GATEWAY}${pathname}`, { headers: upstreamHeaders() });
  if (!upstream.ok) return fail(res, upstream.status, "no avatar");
  const bytes = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "image/png", "cache-control": "no-store", "content-length": bytes.byteLength });
  res.end(bytes);
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
const BOX_HOST = new URL(GATEWAY).hostname;
const VNC_ROUTE = /^\/vnc\/([1-9][0-9]?)\/(.*)$/;
const vncTarget = (display) => (display === 1 ? { port: 6080, query: "" } : { port: 6081, query: `?token=${display}` });

async function relayVnc(req, res, display, rest, search) {
  const { port } = vncTarget(display);
  // Only what the box needs to answer. The browser's cookie and the relay's bearer are ours, not
  // the box's, and forwarding either would hand a credential to a process that never asked.
  const upstream = await fetch(`http://${BOX_HOST}:${port}/${rest}${search}`,
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
function relayVncSocket(req, socket, head, display) {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const version = String(req.headers["sec-websocket-version"] ?? "13");
  if (!WS_KEY.test(key) || !/^\d{1,3}$/.test(version)) return socket.destroy();
  const { port, query } = vncTarget(display);
  const target = net.connect(port, BOX_HOST, () => {
    const lines = [
      `GET /websockify${query} HTTP/1.1`,
      `Host: ${BOX_HOST}:${port}`,
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
        if (req.method === "GET") return sendLoginPage(res, 200, { next: safeNextPath(url.searchParams.get("next")) });
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
    // Before the static branch below, which claims every path ending in .js or .css and would
    // otherwise swallow the box's own noVNC assets at /vnc/<display>/app/ui.js.
    if (req.method === "GET" && VNC_ROUTE.test(url.pathname)) {
      const [, display, rest] = VNC_ROUTE.exec(url.pathname);
      // The rest is pasted into a URL aimed at the box's web server, so a traversal segment never
      // gets to be its problem.
      if (rest.length === 0 || rest.split("/").includes("..")) return fail(res, 400, "bad vnc path");
      return await relayVnc(req, res, Number(display), rest, url.search);
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
      const surfaceDisplay = /^[1-9][0-9]?$/.test(String(url.searchParams.get("display") ?? ""))
        ? `:${url.searchParams.get("display")}` : ":1";
      const script = `for w in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*# //;s/,//g'); do xprop -id $w WM_CLASS 2>/dev/null | grep -q '"${cls}"' && echo present && break; done`;
      const { execFile } = await import("node:child_process");
      const present = await new Promise((resolve) => {
        execFile("docker", ["exec", "-e", `DISPLAY=${surfaceDisplay}`, BOX, "sh", "-c", script], (error, stdout) =>
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
        execFile("docker", ["exec", "-e", `DISPLAY=${surfaceDisplay}`, BOX, "sh", "-c", anyScript],
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
        execFile("docker", ["exec", "-e", `DISPLAY=${display}`, BOX, "sh", "-c", findScript],
          (error, stdout) => resolve(error ? "" : String(stdout).trim()));
      });

      if (existing) {
        await new Promise((resolve) => {
          execFile("docker", ["exec", "-e", `DISPLAY=${display}`, BOX, "xdotool", "windowactivate", existing],
            () => resolve());
        });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ launched: app, raised: true }));
      }

      const child = spawn("docker", ["exec", "-d", "-e", `DISPLAY=${display}`, BOX, "sh", "-c", script], { stdio: "ignore" });
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
      const sendJson = (value) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET") { const current = await readConnectors(); return current == null ? fail(res, 503, "the box could not be read") : sendJson(current); }
      if (req.method === "POST") {
        let parsed;
        try { parsed = JSON.parse(await readBody(req)); } catch { return fail(res, 400, "body must be JSON"); }
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
        }
        await writeConnectors({ mcpServers: servers });
        return sendJson({ saved: Object.keys(servers), restartRequired: true });
      }
    }
    if (req.method === "GET" && url.pathname === "/clients") {
      // The box is shared: the desktop app talks to this same gateway. Anyone driving
      // it sees your writes. Count the sockets so the page can say so out loud.
      const port = new URL(GATEWAY).port || "80";
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
    // The operator's endpoint list, what is live right now, and whether each one answers.
    // Subscriptions already authenticated on this Mac (docs/SUBSCRIPTIONS-CONTRACT.md). The scan
    // never returns a secret; adoption writes ui/subscriptions.json and a keyless endpoint row.
    if (req.method === "GET" && url.pathname === "/subscriptions") {
      const subscriptions = await scanSubscriptions(process.env, await readCatalog());
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ subscriptions }));
    }
    if (req.method === "POST" && url.pathname === "/subscriptions/adopt") {
      const { id, apiKey, model } = JSON.parse(await readBody(req) || "{}");
      let entry;
      try { entry = await adoptSubscription(id, { apiKey, model }); } catch (error) { return fail(res, 400, error.message); }
      const catalog = await readCatalog();
      const endpoints = (catalog.endpoints ?? []).filter((e) => e.id !== entry.id).concat([entry]);
      await writeFile(ENDPOINTS_FILE, JSON.stringify({ endpoints }, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ adopted: id, endpoint: entry }));
    }
    if (req.method === "POST" && url.pathname === "/subscriptions/forget") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      await forgetSubscription(id);
      const catalog = await readCatalog();
      await writeFile(ENDPOINTS_FILE, JSON.stringify({ endpoints: (catalog.endpoints ?? []).filter((e) => e.subscription !== id) }, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ forgot: id }));
    }
    if (req.method === "GET" && url.pathname === "/endpoints") {
      const [catalog, secrets, envOut] = await Promise.all([
        readCatalog(), readSecrets(),
        dockerOut(["inspect", BOX, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]),
      ]);
      const envOf = (key) => (envOut ?? "").split("\n")
        .find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
      // env beats the secrets file in the host's own resolver, so an env value pins the
      // endpoint and nothing chosen here can take effect until the box is recreated without it.
      const pinned = PROVIDER_KEYS.some((k) => envOf(k) != null);
      const live = { baseUrl: envOf(PROVIDER_KEYS[0]) ?? secrets[PROVIDER_KEYS[0]] ?? null,
        model: envOf(PROVIDER_KEYS[1]) ?? secrets[PROVIDER_KEYS[1]] ?? null };
      const endpoints = await Promise.all((catalog.endpoints ?? []).map(async (e) => {
        if (!e.subscription) return { ...e, apiKey: e.apiKey ? "set" : "", health: await probe(e) };
        // A subscription row carries no key; probe with the live token where the vendor serves
        // /models, otherwise say so rather than show it down.
        let resolved = null;
        try { resolved = await resolveSubscription(e.subscription); } catch (error) { return { ...e, apiKey: "", health: { reachable: false, detail: error.message } }; }
        const health = e.transport === "responses"
          ? { reachable: true, serves: null, ms: null, detail: "subscription; verified on use" }
          : await probe({ ...e, apiKey: resolved.apiKey });
        return { ...e, apiKey: "subscription", health };
      }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ endpoints, live, pinned,
        pinnedBy: pinned ? "container env; recreate the box without SAND_OPENAI_COMPATIBLE_* to unpin" : null }));
    }
    // Save the catalog the operator edits in the browser.
    if (req.method === "POST" && url.pathname === "/endpoints") {
      const next = JSON.parse(await readBody(req) || "{}");
      if (!Array.isArray(next.endpoints)) return fail(res, 400, "endpoints must be an array");
      const current = await readCatalog();
      // A key the browser never received back comes in as "set"; keep the stored one.
      const merged = next.endpoints.map((e) => ({ ...e,
        apiKey: e.apiKey === "set"
          ? (current.endpoints ?? []).find((c) => c.id === e.id)?.apiKey ?? "" : (e.apiKey ?? "") }));
      await writeFile(ENDPOINTS_FILE, JSON.stringify({ endpoints: merged }, null, 2));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ saved: merged.length }));
    }
    // Point the host at one of them. Takes effect on the next message.
    if (req.method === "POST" && url.pathname === "/endpoints/use") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      const catalog = await readCatalog();
      const chosen = (catalog.endpoints ?? []).find((e) => e.id === id);
      if (chosen == null) return fail(res, 404, `no endpoint named ${id}`);
      const secrets = await readSecrets();
      const next = { ...secrets, SAND_OPENAI_COMPATIBLE_BASE_URL: chosen.baseUrl, SAND_OPENAI_COMPATIBLE_MODEL: chosen.model, SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: chosen.name };
      for (const key of ["SAND_OPENAI_COMPATIBLE_API_KEY", "SAND_OPENAI_COMPATIBLE_TRANSPORT", "SAND_OPENAI_COMPATIBLE_ACCOUNT_ID", "SAND_OPENAI_COMPATIBLE_ORIGINATOR"]) delete next[key];
      if (chosen.subscription) {
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
      await writeSecrets(next);
      // A subscription row has no key of its own and the Codex backend serves no /models; report
      // it the way the listing does instead of probing it into a false "down".
      const health = chosen.subscription
        ? (chosen.transport === "responses"
          ? { reachable: true, serves: null, ms: null, detail: "subscription; verified on use" }
          : await probe({ ...chosen, apiKey: next.SAND_OPENAI_COMPATIBLE_API_KEY }))
        : await probe(chosen);
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
      const fromEnv = await new Promise((resolve) => {
        execFile("docker", ["inspect", BOX, "--format",
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
        execFile("docker", ["exec", BOX, "cat", SECRETS_PATH], (err, out) => {
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
    if (req.method === "GET" && url.pathname === "/health") {
      const upstream = await fetch(`${GATEWAY}/health`, { headers: upstreamHeaders() });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json" });
      return res.end(text);
    }
    if (req.method === "GET" && url.pathname === "/events") return await relayEvents(req, res, url.search);
    if (req.method === "GET" && url.pathname.startsWith("/avatars/")) return await relayAvatar(req, res, url.pathname + url.search);
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const method = url.pathname.slice("/api/".length);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) return fail(res, 400, "bad method name");
      return await relayCommand(req, res, method);
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
  if (!isAuthorized(req)) return socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
  return relayVncSocket(req, socket, head, Number(match[1]));
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
await resolveBoxContainer();
server.listen(PORT, BIND, () => {
  console.log(`ui   http://${BIND}:${PORT}`);
  console.log(`gw   ${GATEWAY}${TOKEN.length > 0 ? " (bearer)" : " (no auth)"}`);
  console.log(`auth ${AUTH == null ? "none (loopback, no ui/auth.json)" : "password login, 12 h sessions"}`);
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
});
