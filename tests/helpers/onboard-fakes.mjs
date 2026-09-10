// Doubles for the ONBOARD-2 invite: a stub box that COUNTS EVERY GATEWAY CALL IT RECEIVES, a stub
// relay, a welcome sender that records what it was asked to send, a removal that records what it was
// asked to remove, and a bare createAdminApi mounted on a port so a test can hand those last two in.
//
// The call counter on the stub box is the point of this file. The one rule the onboarding sequence
// cannot break is that it must never prompt a box: onboarding-state.ts marks a fresh box done:true
// with doneReason "existing-box" for ever if, at the FIRST read, it holds a prompted conversation,
// and resetOnboarding is 403 without SAND_TEST_HOOKS. So a test asserts the NEGATIVE -- that this
// stub saw listAgents and getOnboardingState and nothing else -- and the only way to assert that is
// to record every path that arrives.
//
// Every secret in here is generated for the run. Nothing reads a real key, endpoint or token.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { createAdminApi } from "../../cp/admin.mjs";
import { loadConfig, tenantPaths } from "../../cp/provision.mjs";
import { openStore } from "../../cp/store.mjs";

const json = (response, status, value) => {
  const text = JSON.stringify(value ?? {});
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  response.end(text);
};

/**
 * A box on a real port, and a ledger of every call it took.
 *
 * GET /health answers whatever `health` is set to, including "refuse", which is a box that has a
 * container and no host listening yet. POST /api/<command> answers out of `answers`, and anything
 * not in there is a 404 -- a command this stub does not know about is a command the sequence should
 * not be making.
 */
export async function startStubBox(options = {}) {
  const calls = [];
  const api = {
    calls,
    // "up" answers 200, "refuse" closes the socket (which is what a box with no host looks like from
    // the outside), "slow" answers after the probe's own abort.
    health: options.health ?? "up",
    healthStatus: options.healthStatus ?? 200,
    answers: new Map(Object.entries(options.answers ?? {})),
    paths: () => calls.map((call) => call.path),
    commands: () => calls.filter((call) => call.path.startsWith("/api/")).map((call) => call.path.slice("/api/".length)),
    countOf: (command) => api.commands().filter((one) => one === command).length,
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://stub-box.invalid");
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      calls.push({
        method: request.method, path: url.pathname, body,
        bearer: String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""),
        userAgent: String(request.headers["user-agent"] ?? ""),
      });
      if (request.method === "GET" && url.pathname === "/health") {
        if (api.health === "refuse") { request.socket.destroy(); return; }
        return json(response, api.healthStatus, { ok: true, pid: 1, isBusy: false, activeAgentId: null, startedAt: new Date().toISOString() });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/")) {
        const command = url.pathname.slice("/api/".length);
        if (!api.answers.has(command)) return json(response, 404, { error: `not found: ${command}` });
        const answer = api.answers.get(command);
        return json(response, 200, typeof answer === "function" ? answer(body) : answer);
      }
      return json(response, 404, { error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.port = server.address().port;
  api.origin = `http://127.0.0.1:${api.port}`;
  api.close = () => new Promise((resolve) => server.close(resolve));
  return api;
}

/**
 * A probe that routes every box call to one stub box, whatever container name it was asked for.
 *
 * This is what stands in for the docker network. The sequence builds its url out of the tenant row's
 * boxContainer, which resolves to nothing in a test process, so the host part is rewritten and the
 * path is kept exactly as the sequence asked for it -- which is the part under test.
 */
export function probeThrough(box) {
  return async (target, init) => {
    const url = new URL(String(target));
    if (box == null) throw new Error("there is no box in this test");
    return fetch(`${box.origin}${url.pathname}${url.search}`, init);
  };
}

/** A probe that refuses everything, which is a box that is not there. */
export const probeRefuses = async () => { throw new Error("there is no docker network in a test"); };

/**
 * A relay on a real port, with the four doors the invite uses.
 *
 * `ceiling`, `useIncluded`, `running` and `sweep` are each either a body or a function of the
 * request, so a test drives a pinned model, a box that reports no ceiling, a 503 from a sweep that
 * is already going, and a registry that takes a moment to see a new tenant.
 */
export async function startStubRelay(options = {}) {
  const calls = [];
  const api = {
    calls,
    token: options.token ?? `stub-relay-${randomBytes(8).toString("hex")}`,
    ceiling: options.ceiling ?? { read: true, maxAgents: 40, bots: 1, pinned: false },
    useIncluded: options.useIncluded ?? { ok: true, pinned: false },
    running: options.running ?? { read: true, model: "plan-zai", modelLabel: "GLM-5.3", pinned: false },
    sweep: options.sweep ?? { ok: true, swept: [] },
    // POST /mail/product, the relay's product-mail door. Here so the REAL cp/welcome.mjs can be
    // driven through the real sequencer with nothing stubbed between them: the seam between the two
    // is the one thing neither item's own suite could test, and the R750 must not be where it is
    // first tried. The From is the relay's to decide, so the stub decides one too.
    product: options.product ?? ((request, body) => ({
      id: `stub-resend-${randomBytes(6).toString("hex")}`,
      from: "Titanium Bot <welcome@titanium.bot>",
      to: body?.to ?? "",
    })),
    boxes: options.boxes ?? { boxes: [] },
    routes: () => calls.map((call) => `${call.method} ${call.path}`),
    callsTo: (route) => calls.filter((call) => `${call.method} ${call.path}` === route),
  };

  const resolve = (value, request, body) => (typeof value === "function" ? value(request, body, api) : value);

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://stub-relay.invalid");
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      const presented = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      calls.push({ method: request.method, path: url.pathname, body, authorized: presented === api.token });
      if (presented !== api.token) return json(response, 401, { error: "unauthorized" });

      const ceiling = /^\/admin\/tenants\/([^/]+)\/ceiling$/.exec(url.pathname);
      const useIncluded = /^\/admin\/tenants\/([^/]+)\/use-included$/.exec(url.pathname);
      const running = /^\/admin\/tenants\/([^/]+)\/running$/.exec(url.pathname);
      if (ceiling != null) {
        const answer = resolve(api.ceiling, request, body);
        return json(response, answer.status ?? 200, answer);
      }
      if (useIncluded != null) {
        const answer = resolve(api.useIncluded, request, body);
        return json(response, answer.status ?? 200, answer);
      }
      if (running != null) {
        const answer = resolve(api.running, request, body);
        return json(response, answer.status ?? 200, answer);
      }
      if (url.pathname === "/mail/sweep") {
        const answer = resolve(api.sweep, request, body);
        return json(response, answer.status ?? (answer.ok === false ? 503 : 200), answer);
      }
      if (url.pathname === "/mail/product") {
        const answer = resolve(api.product, request, body);
        return json(response, answer.status ?? (answer.ok === false ? 502 : 200), answer);
      }
      if (url.pathname === "/admin/boxes") return json(response, 200, resolve(api.boxes, request, body));
      return json(response, 404, { error: "not found" });
    });
  });
  await new Promise((resolve2) => server.listen(0, "127.0.0.1", resolve2));
  api.port = server.address().port;
  api.url = `http://127.0.0.1:${api.port}`;
  api.close = () => new Promise((resolve2) => server.close(resolve2));
  return api;
}

/** A welcome sender that records every send and answers whatever it is told to. */
export function stubWelcome(options = {}) {
  const sends = [];
  const recorded = {
    sends,
    // The shape is a FUNCTION of what it was handed, the way a real sender's is: a send with a
    // password carries both, a send without one carries the link alone. A stub that always answered
    // the same shape would let the route's own guess pass for the sender's answer.
    answer: options.answer ?? ((asked) => ({
      ok: true,
      resendId: "stub-resend-1",
      shape: String(asked?.temporaryPassword ?? "").length > 0 ? "link and a password" : "link only",
    })),
    async sendWelcome(asked) {
      const link = typeof asked.signInLink === "function" ? asked.signInLink() : null;
      sends.push({ ...asked, mintedLink: link });
      const answer = typeof recorded.answer === "function" ? recorded.answer(asked) : recorded.answer;
      return { to: asked.to, signIn: link?.url ?? "", ...answer };
    },
  };
  return recorded;
}

/** A removal that records what it was asked to remove and answers whatever it is told to. */
export function stubDecommission(options = {}) {
  const removals = [];
  const plans = [];
  const recorded = {
    removals,
    plans,
    answer: options.answer ?? { ok: true, slug: "", effects: [], dataDeleted: false, message: "gone" },
    async plan(asked) { plans.push(asked); return { effects: [{ name: "stop", what: "stop the container" }] }; },
    async removeClient(asked) {
      removals.push(asked);
      const answer = typeof recorded.answer === "function" ? recorded.answer(asked) : recorded.answer;
      return { slug: asked.slug, dataDeleted: asked.deleteData === true, ...answer };
    },
  };
  return recorded;
}

/**
 * The admin api on a port, with nothing else.
 *
 * cp/server.mjs builds the whole control plane and does not hand the onboarding deps through, which
 * is correct: the two cross-item calls are defaulted by a dynamic import inside their own handlers.
 * So a test that wants to read what those deps were called with mounts the admin api on its own,
 * which is also the only way to drive the box probe.
 */
export async function startAdminOnly(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cp-onboard-"));
  const env = {
    CP_PORT: "0",
    CP_DATA_DIR: path.join(root, "data"),
    CP_SESSION_SECRET: randomBytes(32).toString("hex"),
    CP_ADMIN_TOKEN: randomBytes(24).toString("hex"),
    CP_BASE_DOMAIN: "titanium.bot",
    CP_TENANT_ROOT: path.join(root, "tenants"),
    CP_RELEASE_ROOT: path.join(root, "release"),
    CP_PUBLIC_URL: "https://api.titanium.bot",
    CP_ALLOW_NEW_TENANTS: "1",
    CP_BOX_READY_TIMEOUT_MS: "40",
    CP_BOX_READY_INTERVAL_MS: "10",
    // A Coolify when one is handed in. Without it provisionTenant stops at the service step, which
    // is a real state and is not the one most of these tests are about.
    COOLIFY_URL: options.coolify?.url ?? "",
    COOLIFY_API_KEY: options.coolify?.apiKey ?? "",
    COOLIFY_PROJECT_UUID: "project-uuid",
    COOLIFY_SERVER_UUID: "server-uuid",
    COOLIFY_ENVIRONMENT_NAME: "production",
    ...(options.relay == null ? {} : { CP_RELAY_URL: options.relay.url, CP_RELAY_TOKEN: options.relay.token }),
    ...(options.env ?? {}),
  };
  const config = loadConfig(env);
  const store = openStore({ dataDir: config.dataDir });

  const admin = createAdminApi({
    config, store,
    client: options.client ?? null,
    now: options.now ?? (() => Date.now()),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    probeImpl: options.probeImpl ?? probeRefuses,
    json,
    noContent: (response) => { response.writeHead(204); response.end(); },
    publicAccount: (account) => (account == null ? null : { id: account.id, email: account.email, name: account.name ?? "", tenant: account.tenant, superAdmin: account.superAdmin === true, disabled: account.disabled === true, createdAt: account.createdAt }),
    publicTenant: (tenant) => (tenant == null ? null : { slug: tenant.slug, name: tenant.name, host: tenant.host, status: tenant.status, ownerEmail: tenant.ownerEmail ?? null, boxReady: tenant.boxReady === true }),
    tenantView: async (tenant) => ({ slug: tenant.slug, name: tenant.name, status: tenant.status, host: tenant.host, lastError: tenant.lastError ?? null, coolify: { reachable: false, status: "", reason: "no Coolify in this test" } }),
    tenantPower: async (response) => json(response, 200, { ok: true }),
    tenantProvision: async (response) => json(response, 200, { ok: true }),
    currentSession: () => ({ ok: false }),
    version: "test",
    deps: options.deps ?? {},
    log: options.log ?? (() => {}),
    // The invite's waits, turned down. A gate that sat through the production ten minute health
    // budget is a gate nobody runs, and a background job still writing when the store is closed is a
    // stack trace nobody can act on.
    onboard: { healthIntervalMs: 10, healthBudgetMs: 200, addressBudgetMs: 200, runningBudgetMs: 120, deadlineMs: 5_000, ...(options.onboard ?? {}) },
  });

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const url = new URL(request.url, "http://cp.invalid");
        let body = null;
        if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
        const segments = url.pathname.split("/").filter(Boolean);
        try {
          if (await admin.handle(request, response, { segments, method: request.method, body, url })) return;
          json(response, 404, { error: "not_found" });
        } catch (error) {
          json(response, 500, { error: "threw", message: String(error?.message ?? error) });
        }
      })();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (method, pathname, { body, token = config.adminToken, headers = {} } = {}) => {
    const init = { method, headers: { accept: "application/json", "user-agent": "titanbot-gate/onboard-fakes", ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    const response = await fetch(`${base}${pathname}`, init);
    const text = await response.text();
    let parsed = null;
    if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    return { status: response.status, text, body: parsed };
  };

  return {
    base, config, store, env, root, admin, request,
    admin_: (method, pathname, body) => request(method, pathname, { body }),
    /**
     * A tenant whose box the probe can reach, written the way a provisioning run would leave it.
     *
     * The gateway token file is real, because readGatewayToken reads it off the disk and a box call
     * with no bearer is a box call the sequence refuses to make.
     */
    seedTenant({ slug, name = slug, ownerEmail = `owner@${slug}.invalid`, container = `titanbot-box-${slug}`, token = randomBytes(16).toString("hex"), status = "provisioning" } = {}) {
      store.createTenant({ slug, name, host: "console.titanium.bot", status, ownerEmail, coolifyServiceUuid: `svc-${slug}`, boxContainer: container });
      const account = store.createAccount({ email: ownerEmail, password: randomBytes(12).toString("base64url"), name, tenant: slug });
      const paths = tenantPaths(slug, config);
      mkdirSync(path.dirname(paths.profileTokenFile), { recursive: true });
      writeFileSync(paths.profileTokenFile, JSON.stringify({ token }), { mode: 0o600 });
      return { tenant: store.getTenant(slug), account, token };
    },
    async dispose() {
      // An invite still going when the store closes is a background job writing into a closed
      // database. Settled first, always.
      await admin.onboarding.settle().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
