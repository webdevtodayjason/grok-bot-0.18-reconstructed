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

// The container rows Coolify reports under /services/{uuid}/applications when it cannot work them
// out from a compose. Their names are the compose service names, which is what the openapi says
// sub_service_name matches. A service made from a real compose reports the services THAT compose
// declares instead, read below, because a tenant is one container now and a fake that always
// answered two would hide it.
const CONTAINER_NAMES = ["titanbot-box", "titanbot-relay"];

// The service names in a compose, read the way a reader would: the keys one indent inside
// `services:`, stopping at the next top-level key.
function composeServiceNames(text) {
  const decoded = /^[A-Za-z0-9+/=\s]+$/.test(String(text ?? "")) && !String(text).includes(":")
    ? Buffer.from(String(text), "base64").toString("utf8")
    : String(text ?? "");
  const after = decoded.split(/^services:$/m)[1];
  if (after === undefined) return [];
  const block = after.split(/^\S/m)[0];
  return [...block.matchAll(/^ {2}(\S+):$/gm)].map((match) => match[1]);
}

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
  // Services this Coolify already had before the control plane ever spoke to it. That is what an
  // adopted tenant is: a stack that was running long before this service existed, so a test about
  // adopt needs one here to stop, start or (never) delete.
  for (const uuid of options.existing ?? []) {
    services.set(String(uuid), { uuid: String(uuid), name: `existing-${uuid}`, docker_compose_raw: "", envs: [], urls: [], started: true });
  }

  // Every ${VAR} in a compose, once each, which is the set of fields Coolify creates with it.
  const composeVariables = (text) => {
    const decoded = /^[A-Za-z0-9+/=\s]+$/.test(String(text ?? "")) && !String(text).includes(":")
      ? Buffer.from(String(text), "base64").toString("utf8")
      : String(text ?? "");
    return [...new Set([...decoded.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];
  };

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
        // Coolify reads the compose when it creates a service and makes an empty environment field
        // for every ${VAR} in it, so the fields the control plane is about to POST already exist.
        // Copied here because the real one does it, and because not doing it is what let this fake
        // pass a provisioning run that failed on the R750 on 2026-09-07 with a 409 on the first env.
        for (const name of composeVariables(created.docker_compose_raw)) {
          created.envs.push({ key: name, value: "" });
        }
        services.set(created.uuid, created);
        return send(201, { uuid: created.uuid, domains: [] });
      }
      if (service == null) return send(404, { message: "Service not found." });

      if (route === "GET /services/{uuid}") {
        return send(200, { id: 1, uuid: service.uuid, name: service.name, environment_id: 1, server_id: 1, docker_compose_raw: service.docker_compose_raw, service_type: null, config_hash: "hash" });
      }
      if (route === "GET /services/{uuid}/applications") {
        const status = service.started ? "running (healthy)" : "exited (0)";
        const names = composeServiceNames(service.docker_compose_raw);
        const rows = names.length > 0 ? names : CONTAINER_NAMES;
        return send(200, rows.map((name) => ({ uuid: `${service.uuid}-${name}`, name, status, fqdn: service.urls[0]?.url ?? null })));
      }
      if (route === "POST /services/{uuid}/envs") {
        // Coolify's own words and status for a key that is already there.
        if (service.envs.some((entry) => entry?.key === body?.key)) {
          return send(409, { message: "Environment variable already exists. Use PATCH request to update it." });
        }
        service.envs.push(body);
        return send(201, { uuid: `env-${service.envs.length}` });
      }
      if (route === "PATCH /services/{uuid}/envs") {
        const at = service.envs.findIndex((entry) => entry?.key === body?.key);
        if (at === -1) return send(404, { message: "Environment variable not found." });
        service.envs[at] = body;
        return send(201, { message: "Environment variable updated." });
      }
      if (route === "PATCH /services/{uuid}") {
        if (Array.isArray(body?.urls)) service.urls = body.urls;
        if (typeof body?.docker_compose_raw === "string") service.docker_compose_raw = body.docker_compose_raw;
        return send(200, { uuid: service.uuid, domains: service.urls.map((entry) => entry.url) });
      }
      // stayStopped is a server whose containers do not come up: Coolify queues the start and
      // answers exactly the same, and the containers are still exited a minute later because the
      // image is 5.2 GB and this host has never pulled it. It is what the readiness wait is for.
      if (route === "POST /services/{uuid}/start") { service.started = !api.stayStopped; return send(200, { message: "Service starting request queued." }); }
      if (route === "POST /services/{uuid}/stop") { service.started = false; return send(200, { message: "Service stopping request queued." }); }
      // Coolify's own spelling, kept so a reader of this fake is not surprised by the real one.
      if (route === "POST /services/{uuid}/restart") { service.started = true; return send(200, { message: "Service restaring request queued." }); }
      if (route === "DELETE /services/{uuid}") { services.delete(service.uuid); return send(200, { message: "Service deletion request queued." }); }

      return send(404, { message: "Not found." });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const api = {
    apiKey,
    url: `http://127.0.0.1:${port}`,
    calls,
    services,
    // Set to true and a start leaves the containers where they were. See the start route.
    stayStopped: false,
    routes: () => calls.map((call) => call.route),
    callsTo: (route) => calls.filter((call) => call.route === route),
    failOnce(route, status = 500, message = "Coolify said no") {
      const queued = failures.get(route) ?? [];
      queued.push({ status, message });
      failures.set(route, queued);
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
  return api;
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
    // On, because most of these tests are about what building a tenant does. Production ships it
    // off (deploy/coolify/control-plane.compose.yml says why), and the test that covers the
    // refusal passes CP_ALLOW_NEW_TENANTS: "0" through options.env.
    CP_ALLOW_NEW_TENANTS: "1",
    // The wait for a new box, short. A real run waits 90 seconds for an image the server may not
    // have yet; a test that did would be a test nobody runs.
    CP_BOX_READY_TIMEOUT_MS: "40",
    CP_BOX_READY_INTERVAL_MS: "10",
    ...(options.env ?? {}),
  };
  const config = loadConfig(env);
  const store = openStore({ dataDir: config.dataDir });
  // The box probe always refuses, so the only thing that can answer "is it up" is the fake
  // Coolify's container status. There is no docker network in a test process, so a real probe of
  // titanbot-box-svc-1:1340 would be a name lookup that means nothing.
  const app = createApp({ config, store, probeImpl: () => { throw new Error("there is no docker network in a test"); } });
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
