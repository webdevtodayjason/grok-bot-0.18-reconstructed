// Shared fixtures for the tests/cp-*.test.mjs suites: a fake Coolify that answers the way the
// openapi says it does, and a control plane stood up on an ephemeral port against a temporary
// sqlite file and a temporary tenant root.
//
// Every secret in here is generated for the run and thrown away with the directory. Nothing in this
// file reads a real key, a real endpoint or a real token.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { createApp, createHttpServer } from "../cp/server.mjs";
import { loadConfig } from "../cp/provision.mjs";
import { openStore } from "../cp/store.mjs";

// The uuid Coolify hands back for a created service, and the two container rows it reports under
// /services/{uuid}/applications. Their names are the compose service names, which is what the
// openapi says sub_service_name matches.
const CONTAINER_NAMES = ["titanbot-box", "titanbot-relay"];

function normalizePath(pathname) {
  return pathname
    .replace(/^\/api\/v1/, "")
    .replace(/\/services\/[^/]+/, "/services/{uuid}");
}

// An in-process Coolify. It records every call (method, path, query, body, whether the bearer was
// right) and answers the bodies the openapi documents. failOnce queues a single failure for a
// route so a test can watch a provisioning run stop at one step and pick up there on the retry.
export async function startFakeCoolify(options = {}) {
  const apiKey = options.apiKey ?? `fake-coolify-${randomBytes(12).toString("hex")}`;
  const calls = [];
  const services = new Map();
  const failures = new Map();

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://fake-coolify.invalid");
      const route = `${request.method} ${normalizePath(url.pathname)}`;
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      const authorized = String(request.headers.authorization ?? "") === `Bearer ${apiKey}`;
      calls.push({ route, method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorized });

      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };

      if (!authorized) return send(401, { message: "Unauthenticated." });

      const queued = failures.get(route) ?? [];
      if (queued.length > 0) {
        const failure = queued.shift();
        return send(failure.status, { message: failure.message });
      }

      const uuidMatch = url.pathname.match(/\/services\/([^/]+)/);
      const uuid = uuidMatch ? uuidMatch[1] : null;
      const service = uuid ? services.get(uuid) : null;

      if (route === "POST /services") {
        const created = { uuid: `svc-${randomUUID().slice(0, 8)}`, name: body?.name ?? "", docker_compose_raw: body?.docker_compose_raw ?? "", envs: [], urls: [], started: false };
        services.set(created.uuid, created);
        return send(201, { uuid: created.uuid, domains: [] });
      }
      if (service == null) return send(404, { message: "Service not found." });

      if (route === "GET /services/{uuid}") {
        return send(200, { id: 1, uuid: service.uuid, name: service.name, environment_id: 1, server_id: 1, docker_compose_raw: service.docker_compose_raw, service_type: null, config_hash: "hash" });
      }
      if (route === "GET /services/{uuid}/applications") {
        const status = service.started ? "running (healthy)" : "exited (0)";
        return send(200, CONTAINER_NAMES.map((name) => ({ uuid: `${service.uuid}-${name}`, name, status, fqdn: service.urls[0]?.url ?? null })));
      }
      if (route === "POST /services/{uuid}/envs") {
        service.envs.push(body);
        return send(201, { uuid: `env-${service.envs.length}` });
      }
      if (route === "PATCH /services/{uuid}") {
        if (Array.isArray(body?.urls)) service.urls = body.urls;
        if (typeof body?.docker_compose_raw === "string") service.docker_compose_raw = body.docker_compose_raw;
        return send(200, { uuid: service.uuid, domains: service.urls.map((entry) => entry.url) });
      }
      if (route === "POST /services/{uuid}/start") { service.started = true; return send(200, { message: "Service starting request queued." }); }
      if (route === "POST /services/{uuid}/stop") { service.started = false; return send(200, { message: "Service stopping request queued." }); }
      // Coolify's own spelling, kept so a reader of this fake is not surprised by the real one.
      if (route === "POST /services/{uuid}/restart") { service.started = true; return send(200, { message: "Service restaring request queued." }); }
      if (route === "DELETE /services/{uuid}") { services.delete(service.uuid); return send(200, { message: "Service deletion request queued." }); }

      return send(404, { message: "Not found." });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    apiKey,
    url: `http://127.0.0.1:${port}`,
    calls,
    services,
    routes: () => calls.map((call) => call.route),
    callsTo: (route) => calls.filter((call) => call.route === route),
    failOnce(route, status = 500, message = "Coolify said no") {
      const queued = failures.get(route) ?? [];
      queued.push({ status, message });
      failures.set(route, queued);
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

// A control plane on a temporary everything. Returns the base url, the app (so a test can reach the
// store), the config and a dispose that closes the server and removes the directories.
export async function startControlPlane(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cp-test-"));
  const env = {
    CP_PORT: "0",
    CP_DATA_DIR: path.join(root, "data"),
    CP_SESSION_SECRET: options.sessionSecret ?? randomBytes(32).toString("hex"),
    CP_ADMIN_TOKEN: options.adminToken ?? randomBytes(24).toString("hex"),
    CP_BASE_DOMAIN: "titanium.bot",
    CP_TENANT_ROOT: path.join(root, "tenants"),
    CP_RELEASE_ROOT: path.join(root, "release"),
    CP_PUBLIC_URL: "https://api.titanium.bot",
    COOLIFY_URL: options.coolifyUrl ?? "",
    COOLIFY_API_KEY: options.coolifyApiKey ?? "",
    COOLIFY_PROJECT_UUID: options.projectUuid ?? "project-uuid",
    COOLIFY_SERVER_UUID: options.serverUuid ?? "server-uuid",
    COOLIFY_ENVIRONMENT_NAME: "production",
    ...(options.env ?? {}),
  };
  const config = loadConfig(env);
  const store = openStore({ dataDir: config.dataDir });
  const app = createApp({ config, store });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (method, pathname, { body, token, headers = {} } = {}) => {
    const init = { method, headers: { accept: "application/json", ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    const response = await fetch(`${base}${pathname}`, init);
    const text = await response.text();
    let parsed = null;
    if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    return { status: response.status, headers: response.headers, text, body: parsed };
  };

  return {
    base, app, store, config, env, root, request,
    admin: (method, pathname, body) => request(method, pathname, { body, token: config.adminToken }),
    async dispose() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function makeTempRoot(prefix = "cp-unit-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
