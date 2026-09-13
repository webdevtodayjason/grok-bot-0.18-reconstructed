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
import { makePurgeDouble } from "./purge-double.mjs";

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
  // The container names this host is holding, which is a different fact from the services Coolify
  // remembers and is the whole point of the removal's container-gone step. A name goes in when the
  // service is started and comes out when the delete's remote half really runs -- which, on the real
  // Coolify, is later than the 200 and sometimes never.
  const containers = new Set();
  const timers = [];
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
      if (route === "POST /services/{uuid}/start") {
        service.started = !api.stayStopped;
        // The name exists from here on, whether or not the container came up: `docker ps -a` lists
        // an exited container by name, and a name held is exactly what the removal has to see go.
        containers.add(`titanbot-box-${service.uuid}`);
        return send(200, { message: "Service starting request queued." });
      }
      // A stopped container KEEPS ITS NAME. That is not a detail: a removal that treated "stopped"
      // as "gone" would report success over a container still sitting on the host.
      if (route === "POST /services/{uuid}/stop") { service.started = false; return send(200, { message: "Service stopping request queued." }); }
      // Coolify's own spelling, kept so a reader of this fake is not surprised by the real one.
      if (route === "POST /services/{uuid}/restart") { service.started = true; return send(200, { message: "Service restaring request queued." }); }
      // DELETE IS ASYNCHRONOUS, and this fake is asynchronous because the real one is.
      //
      // Coolify answers 200 "Service deletion request queued" and dispatches DeleteResourceJob
      // later. That job's remote block is wrapped in a catch that logs "Remote cleanup failed,
      // continuing with local deletion" and deletes the LOCAL record anyway. So the worst failure
      // in the product -- Coolify forgetting the service while titanbot-box-<uuid> keeps running
      // with the customer's gateway token -- answers 200 and looks like success.
      //
      // Three behaviours, and a test picks one:
      //   deleteDelayMs 0 (the default)  the record and the container both go at once, which is
      //                                  what every existing test has always seen
      //   deleteDelayMs > 0              the record goes now, the container lingers that long
      //   neverRemoves true              the record goes and the container NEVER does. This is
      //                                  Coolify's catch-and-continue, and a removal that reports
      //                                  success against it is a bug the gate must catch
      if (route === "DELETE /services/{uuid}") {
        const name = `titanbot-box-${service.uuid}`;
        services.delete(service.uuid);
        if (api.neverRemoves) containers.add(name);
        else if (api.deleteDelayMs > 0) {
          containers.add(name);
          const timer = setTimeout(() => containers.delete(name), api.deleteDelayMs);
          if (typeof timer.unref === "function") timer.unref();
          timers.push(timer);
        } else containers.delete(name);
        return send(200, { message: "Service deletion request queued." });
      }

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
    // How long after the 200 the delete's remote half actually removes the container. 0 keeps every
    // existing test exactly as it was.
    deleteDelayMs: 0,
    // Coolify's catch-and-continue: the record goes, the container never does. See the DELETE route.
    neverRemoves: false,
    containers,
    containerPresent: (name) => containers.has(String(name)),
    routes: () => calls.map((call) => call.route),
    callsTo: (route) => calls.filter((call) => call.route === route),
    failOnce(route, status = 500, message = "Coolify said no") {
      const queued = failures.get(route) ?? [];
      queued.push({ status, message });
      failures.set(route, queued);
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return api;
}

// An in-process relay, for the routes the control plane asks it for rather than does itself.
//
// It answers the six doors ONBOARD-2 uses and nothing else: the tenant registry's `running`, the
// two plan doors (`use-included` and `ceiling`), the address sweep, the product mail send, and the
// purge that is both the container probe and the data delete. The purge reads its container view
// from the fake Coolify it is handed, because on the real server the relay is the process with the
// docker socket and Coolify is a different opinion of the same host.
//
// Every call is recorded, so a test can assert the sweep was asked once per slug rather than
// fleet-wide, and that the removal revoked the model key before it deleted the service.
export async function startFakeRelay(options = {}) {
  const token = options.token ?? `fake-relay-${randomBytes(12).toString("hex")}`;
  const coolify = options.coolify ?? null;
  const calls = [];
  // Tenant data trees this relay believes in, slug -> {path, bytes}. purge deletes from here.
  const data = new Map(Object.entries(options.data ?? {}));
  // slug -> container name, which the real relay reads off the tenant registry.
  const names = new Map(Object.entries(options.containers ?? {}));
  const state = {
    // How many 503s the sweep answers before it works. Models "a sweep is already running".
    sweepBusy: Number(options.sweepBusy ?? 0),
    // The model label `running` reports back, which is what proves use-included took.
    modelLabel: String(options.modelLabel ?? ""),
    // Set to refuse the purge, so a test can watch the removal carry on and say so.
    purgeRefusal: options.purgeRefusal ?? null,
    // Where the control plane is, so the sweep can mint the way the real relay does. Set AFTER the
    // control plane starts, because the control plane needs this relay's url to be built at all.
    cpUrl: String(options.cpUrl ?? ""),
    // The roster this relay pretends to have read out of the box before minting.
    roster: options.roster ?? [{ id: "agent-titan", name: "Titan", isGroup: false }],
    // Product mail sends captured here rather than posted anywhere.
    mail: [],
    // Where this relay believes workspaces live. Inferred from the first tree a test declared, because
    // the relay is started before the control plane that knows the root. The real route realpaths it,
    // so it has to be a directory that exists.
    tenantRoot: String(options.tenantRoot ?? ""),
    // How many more times the registry answers "I can still reach that workspace" after the container
    // is gone. The real relay's registry refreshes on its own clock, so a caller that reads the 409 as
    // a failure rather than asking again deletes nothing.
    registryLag: Number(options.registryLag ?? 0),
    // docker unanswerable, which the route refuses on rather than proceeding from.
    dockerSilent: options.dockerSilent === true,
    // Containers on the host this relay can see that no tenant row points at.
    extraContainers: options.extraContainers ?? [],
    // HOW MANY PURGE REQUESTS DIE ON THE WIRE BEFORE ONE ARRIVES. Measured on the R750 2026-09-10:
    // the removal's container-gone step makes a dozen keep-alive POSTs at 2 s intervals, a Node
    // server closes an idle connection at 5 s, and undici does not retry a POST it dispatched onto a
    // socket the other end had already closed. The next single-shot POST -- the purge -- answered
    // nothing at all, and the operator was told the data could not be deleted while this route had
    // never run. The socket is destroyed, which is exactly what the caller saw.
    purgeTransportFailures: Number(options.purgeTransportFailures ?? 0),
  };

  // The purge door, built out of ui/purge-edge.mjs itself.
  const fallbackRoot = await mkdtemp(path.join(os.tmpdir(), "fake-relay-tenants-"));
  const purge = makePurgeDouble({
    relayToken: token,
    tenantRootOf: () => {
      if (state.tenantRoot.length > 0) return state.tenantRoot;
      for (const row of data.values()) {
        const held = String(row?.path ?? "");
        if (held.length > 0) return path.dirname(held);
      }
      return fallbackRoot;
    },
    containerFor: (slug) => String(names.get(String(slug)) ?? ""),
    onHost: (name) => coolify != null && coolify.containerPresent(name),
    rows: data,
    state,
  });

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://fake-relay.invalid");
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      const authorized = String(request.headers.authorization ?? "") === `Bearer ${token}`;
      calls.push({ method: request.method, path: url.pathname, body, authorized });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };
      if (!authorized) return send(401, { error: "unauthorized" });

      const tenantAdmin = /^\/admin\/tenants\/([^/]+)\/(use-included|ceiling|running)$/.exec(url.pathname);
      if (tenantAdmin) {
        const slug = decodeURIComponent(tenantAdmin[1]);
        if (tenantAdmin[2] === "use-included") { state.modelLabel = String(body?.model ?? options.modelLabel ?? "plan-included"); return send(200, { ok: true, slug, model: state.modelLabel, pinned: false }); }
        // `read: true` IS PART OF BOTH ANSWERS ON THE REAL RELAY (ui/server.mjs: the ceiling route at
        // :1913 and the running route at :1757 both carry it), and it means THE BOX ANSWERED as
        // against this route merely working. Without it here, a fake relay looked healthy while the
        // onboarding sequence correctly read every answer as "nothing could be read back" and stopped
        // amber before the welcome -- a fake disagreeing with the thing it stands in for.
        if (tenantAdmin[2] === "ceiling") return send(200, { ok: true, read: true, slug, maxAgents: Number(body?.maxAgents ?? 40), bots: 1, pinned: false });
        return send(200, { ok: true, read: true, slug, model: state.modelLabel, modelLabel: state.modelLabel, running: state.modelLabel.length > 0 });
      }

      if (url.pathname === "/mail/sweep") {
        if (state.sweepBusy > 0) { state.sweepBusy -= 1; return send(503, { ok: false, error: "sweep_running", message: "a sweep is already running" }); }
        const slug = String(body?.slug ?? "");
        if (slug.length === 0) return send(200, { ok: true, swept: [], scope: "fleet" });
        // A SWEEP THAT ONLY ANSWERS MINTS NOTHING, and a fake that answers 200 over a workspace it
        // never gave an address to is the exact shape of a green light somebody believes. The real
        // relay does not mint either: it reads the box's roster and POSTs it to the control plane's
        // own /v1/relay/mail/mint (ui/server.mjs's mailMintSweep), which is what puts the row in the
        // store that cp/mail.mjs directory(slug) later reads -- and that directory read, in the
        // control plane's own process, is what the onboarding sequence takes as step 4's green.
        // So this fake does what the real one does, when it has been told where the control plane is.
        if (String(state.cpUrl ?? "").length === 0) {
          return send(200, { ok: true, asked: slug, scope: "one", swept: [{ slug, addresses: 0, minted: 0, retired: 0 }] });
        }
        void fetch(`${state.cpUrl}/v1/relay/mail/mint`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ slug, agents: state.roster }),
        }).then(async (minted) => {
          const answer = await minted.json().catch(() => ({}));
          const addresses = Array.isArray(answer?.addresses) ? answer.addresses : [];
          send(200, { ok: true, asked: slug, scope: "one", swept: [{ slug, addresses: addresses.length, minted: Number(answer?.minted ?? 0), retired: Number(answer?.retired ?? 0) }] });
        }).catch((error) => send(200, { ok: true, asked: slug, scope: "one", swept: [{ slug, addresses: 0, minted: 0, retired: 0 }], why: String(error?.message ?? error) }));
        return undefined;
      }

      if (url.pathname === "/mail/product") {
        const id = `resend-${randomBytes(8).toString("hex")}`;
        state.mail.push({ to: body?.to ?? "", subject: body?.subject ?? "", html: body?.html ?? "", text: body?.text ?? "", id });
        return send(200, { ok: true, id });
      }

      if (url.pathname === "/tenant/purge") {
        if (Number(state.purgeTransportFailures ?? 0) > 0 && body?.probeOnly !== true) {
          state.purgeTransportFailures -= 1;
          request.socket.destroy();
          return undefined;
        }
        // THE REAL ROUTE ANSWERS THIS, not a hand-written guess at it. See tests/purge-double.mjs:
        // both ends of this contract shipped in one wave disagreeing on every field, and two fakes
        // that had copied the caller's guess are what let that through 78 green tests.
        if (state.purgeRefusal && body?.probeOnly !== true) {
          return send(409, { ok: false, error: "purge_refused", message: String(state.purgeRefusal) });
        }
        void purge(request, response, Buffer.concat(chunks).toString("utf8"));
        return undefined;
      }

      return send(404, { error: "not_found" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    token,
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    data,
    names,
    state,
    mail: () => state.mail,
    callsTo: (pathname) => calls.filter((call) => call.path === pathname),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(fallbackRoot, { recursive: true, force: true });
    },
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
  // The box probe refuses by default, because there is no docker network in a test process and a real
  // probe of titanbot-box-svc-1:1340 would be a name lookup that means nothing. WITH
  // CP_BOX_URL_OVERRIDE SET the caller has given the box a real address, so the probe becomes a real
  // fetch: a gate that wants to measure what the onboarding sequence reads off a box needs a probe
  // that can actually reach one, and a refusing probe would make every box read fail for a reason
  // that has nothing to do with the code under test.
  const app = createApp({
    config, store,
    // One word, so a test can stand a relay in front of the routes that ask one for something only
    // it can see: the device list and the device revoke a removed account's bearers go through.
    // Production passes nothing and gets globalThis.fetch, which is what createApp defaults to.
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    probeImpl: config.boxUrlOverride.length > 0
      ? (options.probeImpl ?? globalThis.fetch)
      : (options.probeImpl ?? (() => { throw new Error("there is no docker network in a test"); })),
  });
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
      // AN INVITE STILL GOING WHEN THE STORE CLOSES is a background job writing into a closed
      // database, which surfaces as "statement has been finalized" on stderr with no line number an
      // operator could act on. Settled first, always. ONBOARD-2 made this reachable: before it, no
      // route on this control plane left work running after it answered.
      await Promise.resolve(app.onboarding?.settle?.()).catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function makeTempRoot(prefix = "cp-unit-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
