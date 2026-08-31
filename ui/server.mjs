// Local frontend host for the sand gateway.
//
// The gateway rejects any request carrying an Origin header (gateway-server.ts:23,
// "browser-origin gateway requests are not allowed"), so a browser cannot call it
// directly. This process is the shim: it serves the UI and relays to the gateway
// without an Origin, adding the Bearer token the browser must never hold.
//
// Env:
//   SAND_HOST_GATEWAY_URL    gateway origin, no trailing slash (paths are concatenated)
//   SAND_HOST_GATEWAY_TOKEN  optional; sent as Bearer when set
//   SAND_UI_PORT             listen port, default 7777
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

// Which model answers is an OPERATOR decision, not a rebuild. The host resolves it from
// process.env first and /home/box/sand-data/box-secrets.json second, and it re-reads that file
// with readFileSync on every single request -- so writing it takes effect on the next message,
// with no restart and no container recreate. The gateway's own setBoxSecrets refuses
// SAND_-prefixed names, which is why this writes the file directly instead of going through it.
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SECRETS_PATH = "/home/box/sand-data/box-secrets.json";
const ENDPOINTS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), "endpoints.json");
const PROVIDER_KEYS = ["SAND_OPENAI_COMPATIBLE_BASE_URL", "SAND_OPENAI_COMPATIBLE_MODEL",
  "SAND_OPENAI_COMPATIBLE_API_KEY"];

const dockerOut = (args) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 8 << 20 }, (err, out) => resolve(err != null && !out ? null : out)));

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

function fail(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(HERE, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    // Put an app on the box's X display so the VNC view has something to show. Strictly two
    // fixed commands, no operator string ever reaches a shell, and the relay only listens on
    // loopback -- the box is already the agent's sandbox, but that is no reason to hand a
    // browser tab arbitrary exec on it.
    if (req.method === "POST" && url.pathname === "/box/launch") {
      const LAUNCH = {
        browser: ["google-chrome", "--no-sandbox", "--start-maximized", "--no-first-run", "--disable-session-crashed-bubble"],
        terminal: ["xfce4-terminal", "--maximize"],
      };
      let app;
      try { app = JSON.parse(await readBody(req))?.app; } catch { app = null; }
      const argv = LAUNCH[app];
      if (!argv) return fail(res, 400, `unknown app: ${app}`);
      const { spawn } = await import("node:child_process");
      // setsid so the app outlives this exec; DISPLAY=:0 is the display noVNC serves on 6080.
      const child = spawn("docker", [
        "exec", "-d", "-e", "DISPLAY=:1", BOX, "setsid", ...argv,
      ], { stdio: "ignore" });
      child.on("error", () => {});
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ launched: app }));
    }

    // The Machine Room frontend is a vendored handoff: many files, and the rule from its README
    // is that the DOM and event layer stay untouched. So it gets served as a directory rather
    // than inlined, and the only file this repo authors inside it is the gateway adapter.
    if (req.method === "GET" && url.pathname.startsWith("/machine-room")) {
      const rel = url.pathname === "/machine-room" || url.pathname === "/machine-room/"
        ? "index.html"
        : url.pathname.slice("/machine-room/".length);
      const file = path.resolve(HERE, "machine-room", rel);
      // Resolve first, then check: a path that escapes the directory never reaches readFile.
      if (!file.startsWith(path.join(HERE, "machine-room") + path.sep)) return fail(res, 403, "outside the frontend directory");
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/plain; charset=utf-8" };
      try {
        const bytes = await readFile(file);
        res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        return res.end(bytes);
      } catch { return fail(res, 404, `not found: ${url.pathname}`); }
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
      const endpoints = await Promise.all((catalog.endpoints ?? []).map(async (e) =>
        ({ ...e, apiKey: e.apiKey ? "set" : "", health: await probe(e) })));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ endpoints, live, pinned,
        pinnedBy: pinned ? "container env — recreate the box without SAND_OPENAI_COMPATIBLE_* to unpin" : null }));
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
      await writeSecrets({ ...secrets,
        SAND_OPENAI_COMPATIBLE_BASE_URL: chosen.baseUrl,
        SAND_OPENAI_COMPATIBLE_MODEL: chosen.model,
        ...(chosen.apiKey ? { SAND_OPENAI_COMPATIBLE_API_KEY: chosen.apiKey } : {}) });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ using: chosen.name, health: await probe(chosen) }));
    }
    if (req.method === "GET" && url.pathname === "/model") {
      // The gateway reports which provider is routed but never which model answers, and
      // "openai-compatible" is not something you can hold a conversation with. The box
      // carries the answer in its environment.
      const model = await new Promise((resolve) => {
        execFile("docker", ["inspect", "grok-bot-local-vm", "--format",
          "{{range .Config.Env}}{{println .}}{{end}}"], (err, out) => {
          if (err != null && !out) return resolve(null);
          const line = out.split("\n").find((l) => l.startsWith("SAND_OPENAI_COMPATIBLE_MODEL="));
          const host = out.split("\n").find((l) => l.startsWith("SAND_OPENAI_COMPATIBLE_BASE_URL="));
          resolve({
            model: line ? line.split("=")[1] : null,
            endpoint: host ? host.slice("SAND_OPENAI_COMPATIBLE_BASE_URL=".length) : null,
          });
        });
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(model ?? {}));
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

// Loopback only. This process holds the gateway token, so it must not be reachable off-box.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`ui   http://127.0.0.1:${PORT}`);
  console.log(`gw   ${GATEWAY}${TOKEN.length > 0 ? " (bearer)" : " (no auth)"}`);
});
