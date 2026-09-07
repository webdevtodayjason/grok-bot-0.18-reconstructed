// cp/provision.mjs -- turning a slug into a customer's own instance.
//
// Seven steps, in this order, every one of them idempotent and every one of them written to the
// provisioning ledger with the answer Coolify gave:
//
//   directories  the tenant's own tree under CP_TENANT_ROOT
//   secrets      the gateway token and the relay password, generated once and never again
//   compose      deploy/coolify/docker-compose.yml re-pointed at that tree
//   service      POST /services
//   envs         POST /services/{uuid}/envs, the two values the compose refers to but does not carry
//                (PATCH instead when Coolify already made the field from the compose's ${VAR})
//   urls         PATCH /services/{uuid}, which is what puts https://<slug>.titanium.bot on the relay
//   start        POST /services/{uuid}/start
//
// "Idempotent" is doing work here, not decoration. A step that already succeeded is skipped on a
// retry, and every step that can be run twice safely is written so that it can be: mkdir -p, a
// secrets step that reads the token back off disk rather than minting a second one, a service step
// that reuses the uuid already in the ledger. So POST /v1/tenants/{slug}/provision after a failure
// picks up at the step that failed instead of building a second half-instance beside the first.
//
// Two things never reach the ledger and never reach the compose text: the gateway token and the
// relay password. The token goes into Coolify's environment store and into a 0600 file in the
// tenant's profile directory, which is where the relay already looks for it. The relay password is
// hashed into the tenant's auth.json and handed back to the operator exactly once, in the answer to
// the request that created the tenant. Nothing can print it again, and the operator's way to change
// it is the same `node ui/set-password.mjs <file>` that has always been the way.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newAuthRecord, writeAuthFile } from "../ui/auth.mjs";
import { tenantSessionSecret } from "./session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

// The compose the tenants are cut from. Read from disk at render time rather than at import, so a
// container that ships a different copy of it does not need this file rebuilt.
export const BASE_COMPOSE_PATH = path.join(REPO_ROOT, "deploy", "coolify", "docker-compose.yml");

// Names a tenant may not take. www, console, api, mail, app, admin, status, docs, blog, help and
// support are the hostnames the product itself will want; titanium and titan are the brand; resend,
// send, rsend and _dmarc are the mail records already published under titanium.bot, and handing one
// of those to a customer would point their instance at the place mail authentication is answered
// from.
export const RESERVED_SLUGS = new Set([
  "www", "console", "api", "mail", "app", "admin", "status", "docs", "blog", "help", "support",
  "titanium", "titan", "resend", "send", "rsend", "_dmarc",
]);

export const SLUG_MIN = 3;
export const SLUG_MAX = 32;

// The answers are the sentences an operator reads, so they say what to do rather than which rule
// fired.
export function validateSlug(slug) {
  const value = String(slug ?? "");
  if (value.length < SLUG_MIN || value.length > SLUG_MAX) {
    return { ok: false, reason: `a tenant name is ${SLUG_MIN} to ${SLUG_MAX} characters long` };
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    return { ok: false, reason: "a tenant name uses lowercase letters, numbers and dashes only" };
  }
  // Not in the written rule, added because it is the difference between a name and a broken web
  // address: a hostname label may not begin or end with a dash, so https://-acme.titanium.bot
  // would never resolve and the customer would be handed a link that cannot work.
  if (value.startsWith("-") || value.endsWith("-")) {
    return { ok: false, reason: "a tenant name cannot start or end with a dash" };
  }
  if (RESERVED_SLUGS.has(value)) {
    return { ok: false, reason: "that name is reserved, please pick another" };
  }
  return { ok: true, reason: "" };
}

// ---- configuration -------------------------------------------------------------------------
//
// One reader for every environment variable the control plane takes, so the names live in one
// place and both the server and the CLI see the same defaults.

export const CONFIG_DEFAULTS = {
  port: 7790,
  baseDomain: "titanium.bot",
  tenantRoot: "/data/titanbot",
  releaseRoot: "/home/sem/titanbot",
  environmentName: "production",
  publicUrl: "https://api.titanium.bot",
};

export function loadConfig(env = process.env) {
  const text = (key, fallback = "") => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  };
  return {
    port: Number(text("CP_PORT", String(CONFIG_DEFAULTS.port))) || CONFIG_DEFAULTS.port,
    dataDir: text("CP_DATA_DIR", path.join(REPO_ROOT, "cp", ".data")),
    sessionSecret: text("CP_SESSION_SECRET"),
    adminToken: text("CP_ADMIN_TOKEN"),
    baseDomain: text("CP_BASE_DOMAIN", CONFIG_DEFAULTS.baseDomain),
    // CP_COOLIFY_URL first, because COOLIFY_URL is a name Coolify owns. Coolify injects its own
    // COOLIFY_URL into every service container, set to that service's public address, and its
    // value wins over the environment record an operator sets with the same name. Measured on the
    // R750 on 2026-09-07: this service was given the Coolify api's address and read back
    // https://api.titanium.bot, its own front door, so every POST /services it made answered 404
    // and the demo tenant came out `failed`. COOLIFY_URL is still read second so an install that
    // predates this line keeps working, and so does a plain `docker run` where nothing shadows it.
    coolifyUrl: (text("CP_COOLIFY_URL") || text("COOLIFY_URL")).replace(/\/+$/, ""),
    coolifyApiKey: text("COOLIFY_API_KEY"),
    coolifyProjectUuid: text("COOLIFY_PROJECT_UUID"),
    coolifyServerUuid: text("COOLIFY_SERVER_UUID"),
    coolifyEnvironmentName: text("COOLIFY_ENVIRONMENT_NAME", CONFIG_DEFAULTS.environmentName),
    // Not in the contract's list of keys and not required. Coolify's create-service body asks for
    // an environment name or an environment uuid; the name is what the operator knows, so that is
    // what is sent. When an install has the uuid to hand, setting this sends both and takes the
    // ambiguity out.
    coolifyEnvironmentUuid: text("COOLIFY_ENVIRONMENT_UUID"),
    tenantRoot: text("CP_TENANT_ROOT", CONFIG_DEFAULTS.tenantRoot),
    releaseRoot: text("CP_RELEASE_ROOT", CONFIG_DEFAULTS.releaseRoot),
    publicUrl: text("CP_PUBLIC_URL", CONFIG_DEFAULTS.publicUrl).replace(/\/+$/, ""),
    dryRun: /^(1|true|yes)$/i.test(text("CP_DRY_RUN", "")),
    allowNewTenants: /^(1|true|yes)$/i.test(text("CP_ALLOW_NEW_TENANTS", "")),
    // Which peers may say who the visitor is. Same two settings the relay already runs with, read
    // by the same code, because two implementations of one answer is how one of them goes stale.
    trustedProxies: text("CP_TRUSTED_PROXIES"),
    cloudflareRanges: text("CP_CLOUDFLARE_RANGES"),
    // And which of those callers are a RELAY forwarding a customer rather than a customer. Every
    // tenant console posts its sign-ins here from one machine's egress address, so the address half
    // of the lockout is one bucket for the whole fleet unless this says so. See loginLock.
    relayPeers: text("CP_RELAY_PEERS"),
  };
}

// Off until a customer's relay reads its own files, which it does as of TENANT-2.
//
// A tenant relay mounts the operator's shared ui directory, and the relay still opens
// ui/endpoints.json beside its own code: that file holds the provider API keys. Read-only, which
// the render now is, stops a tenant WRITING them. It does not stop a tenant reading them, and the
// variable that moves that file (SAND_UI_ENDPOINTS_FILE) is set in the render but not yet read by
// the relay. So building a second instance is refused until it is, and the operator turns it on
// deliberately with CP_ALLOW_NEW_TENANTS=1 once the relay wave has landed.
//
// Adopting an instance that already exists is unaffected, and so is finishing one that was already
// started, so this cannot strand a half-built tenant.
export const NEW_TENANTS_BLOCKED =
  "New customer instances are turned off. A customer's console would still read the shared settings file on this server, which holds your provider API keys, so it is not safe to build one yet. Adopting an instance that already exists still works. Set CP_ALLOW_NEW_TENANTS=1 once the relay reads its settings from each customer's own state directory.";

// The two things a config must have before it can sign anybody in. Reported as sentences because
// this is what the service prints and refuses to start on.
export function configProblems(config) {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    problems.push("CP_SESSION_SECRET is missing or shorter than 32 characters. Every tenant relay checks sessions with this value, so set it once and set the same value on every relay.");
  }
  if (!config.adminToken || config.adminToken.length < 16) {
    problems.push("CP_ADMIN_TOKEN is missing or shorter than 16 characters. It is the password for the routes that add accounts and tenants.");
  }
  return problems;
}

export function tenantHost(slug, config) {
  return `${slug}.${config.baseDomain}`;
}

export function tenantDirectory(slug, config) {
  return path.join(config.tenantRoot, slug);
}

// Every directory a tenant owns. The volumes are the four the box writes into; profile holds the
// gateway token file the relay reads; credential is the placeholder inference file the box refuses
// to start without; state is the relay's own writable corner, which is what lets the release's ui
// directory be shared by every tenant instead of copied per tenant.
export function tenantPaths(slug, config) {
  const root = tenantDirectory(slug, config);
  return {
    root,
    profile: path.join(root, "profile"),
    credential: path.join(root, "credential"),
    state: path.join(root, "state"),
    volumes: path.join(root, "volumes"),
    workspace: path.join(root, "volumes", "workspace"),
    data: path.join(root, "volumes", "data"),
    store: path.join(root, "volumes", "store"),
    chrome: path.join(root, "volumes", "chrome"),
    profileTokenFile: path.join(root, "profile", "local-docker-vm.json"),
    authFile: path.join(root, "state", "auth.json"),
  };
}

export function tenantDirectoryList(slug, config) {
  const paths = tenantPaths(slug, config);
  return [paths.root, paths.profile, paths.credential, paths.state, paths.volumes, paths.workspace, paths.data, paths.store, paths.chrome];
}

// ---- rendering the compose ---------------------------------------------------------------------

// A splice that refuses to guess. If the anchor is gone or appears twice, the base compose has
// changed underneath this renderer and the honest answer is to stop: a tenant compose that quietly
// lost its TENANT_ID or its state mount is a broken instance nobody would look at until a customer
// complained.
function spliceBefore(text, anchor, lines) {
  const first = text.indexOf(anchor);
  if (first === -1) throw new Error(`the base compose no longer has the line "${anchor.trim()}", so this tenant cannot be rendered`);
  if (text.indexOf(anchor, first + anchor.length) !== -1) throw new Error(`the base compose has "${anchor.trim()}" more than once, so this tenant cannot be rendered`);
  return `${text.slice(0, first)}${lines.join("\n")}\n${text.slice(first)}`;
}

function spliceAfter(text, anchor, lines) {
  const first = text.indexOf(anchor);
  if (first === -1) throw new Error(`the base compose no longer has the line "${anchor.trim()}", so this tenant cannot be rendered`);
  if (text.indexOf(anchor, first + anchor.length) !== -1) throw new Error(`the base compose has "${anchor.trim()}" more than once, so this tenant cannot be rendered`);
  const at = first + anchor.length;
  return `${text.slice(0, at)}\n${lines.join("\n")}${text.slice(at)}`;
}

// Takes one line OUT and leaves an explanation where it was. Same refusal to guess as the two
// above: a tenant compose that quietly kept a line this renderer thought it had removed is a
// tenant that quietly has something it must not have.
// The anchor here is a WHOLE line, matched exactly, unlike the two above: a line that has grown a
// suffix (`...docker.sock:ro`) is not the line this was written against, and replacing its prefix
// would leave the tail behind as a broken half mount.
//
// The comment lines directly above the anchor go with it. They were written about the line being
// replaced, so keeping them would leave a tenant's compose explaining a mount that is not in it,
// in words that contradict the replacement two lines further down.
function replaceLine(text, anchor, lines) {
  const rows = text.split("\n");
  const hits = rows.reduce((all, row, index) => (row === anchor ? [...all, index] : all), []);
  if (hits.length === 0) throw new Error(`the base compose no longer has the line "${anchor.trim()}", so this tenant cannot be rendered`);
  if (hits.length > 1) throw new Error(`the base compose has "${anchor.trim()}" more than once, so this tenant cannot be rendered`);
  let from = hits[0];
  while (from > 0 && rows[from - 1].trim().startsWith("#")) from -= 1;
  rows.splice(from, hits[0] - from + 1, ...lines);
  return rows.join("\n");
}

const BOX_ENV_ANCHOR = '      SAND_SUPERVISOR_ENABLED: "1"';
const RELAY_ENV_ANCHOR = '      SAND_UI_PORT: "7777"';
// The three the base compose names for an instance nobody built, so an operator can turn tenancy on
// in Coolify without a different file. A tenant's copy carries its own values written in, so these
// placeholders come out and the block below goes in. Removing them is not optional: two TENANT_ID
// keys in one environment block is a compose docker will not read.
const RELAY_TENANT_ID_PLACEHOLDER = "      TENANT_ID: ${TENANT_ID}";
const RELAY_CP_URL_PLACEHOLDER = "      CP_URL: ${CP_URL}";
const RELAY_CP_SECRET_PLACEHOLDER = "      CP_SESSION_SECRET: ${CP_SESSION_SECRET}";
const RELAY_UI_MOUNT_ANCHOR = "      - /home/sem/titanbot/ui:/app/ui";
// The operator's own state directory and the variable that points at it. A tenant has its own of
// both, written by the block below, so these two come out rather than leaving a second copy of the
// same key: two SAND_UI_STATE_DIR lines in one environment block is a compose docker will not read,
// and two /state mounts is a container that will not start.
const RELAY_STATE_DIR_PLACEHOLDER = "      SAND_UI_STATE_DIR: /state";
const RELAY_STATE_MOUNT_ANCHOR = "      - /home/sem/titanbot/state:/state";
const RELAY_SOCKET_ANCHOR = "      - /var/run/docker.sock:/var/run/docker.sock";
const RELAY_LAST_VOLUME_ANCHOR = "      - /home/sem/titanbot/deploy:/init:ro";

export function renderCompose({ slug, config, composeText = readFileSync(BASE_COMPOSE_PATH, "utf8") }) {
  const paths = tenantPaths(slug, config);
  const host = tenantHost(slug, config);
  let text = composeText;

  // The insertions run FIRST and the path substitutions after, because the anchors are lines that
  // carry the release paths and substituting those paths first would leave nothing to anchor to.
  // A release root anywhere but /home/sem/titanbot used to render a compose with no state mount and
  // no tenancy block at all, silently.
  text = spliceBefore(text, BOX_ENV_ANCHOR, [
    `      # Which customer this box belongs to. Nothing in the host reads it yet; it is here so a`,
    `      # \`docker inspect\` on a server with twenty boxes on it answers the question directly.`,
    `      TENANT_ID: ${slug}`,
  ]);

  // Out first, comment and all: replaceLine takes the comment block above the line it replaces, and
  // the tenancy block below carries its own.
  text = replaceLine(text, RELAY_STATE_DIR_PLACEHOLDER, []);
  text = replaceLine(text, RELAY_CP_SECRET_PLACEHOLDER, []);
  text = replaceLine(text, RELAY_CP_URL_PLACEHOLDER, []);
  text = replaceLine(text, RELAY_TENANT_ID_PLACEHOLDER, []);

  text = spliceBefore(text, RELAY_ENV_ANCHOR, [
    `      # ---- tenancy -----------------------------------------------------------------------`,
    `      # Written by the control plane when this tenant was created. TENANT_ID and CP_URL are`,
    `      # plain values and are in this text; CP_SESSION_SECRET and TITANBOT_GATEWAY_TOKEN are`,
    `      # references, and their values live in Coolify's environment store for this resource, so`,
    `      # neither secret is ever in a file anyone can paste into a chat window.`,
    `      TENANT_ID: ${slug}`,
    `      CP_URL: ${config.publicUrl}`,
    `      # THIS TENANT'S OWN signing key, not the control plane's master. It is`,
    `      # HMAC-SHA256(master, "${slug}"), so reading it out of this container signs for ${slug} and`,
    `      # for nobody else. cp/session.mjs, tenantSessionSecret, says why that matters.`,
    `      CP_SESSION_SECRET: \${CP_SESSION_SECRET}`,
    `      # The relay's own writable corner, so the release's ui directory above can be one shared`,
    `      # copy instead of a copy per customer. Every file the relay writes goes under here, and`,
    `      # the five below name the ones that also have a variable of their own. SAND_UI_AUTH_FILE`,
    `      # is what makes this tenant's password their own.`,
    `      SAND_UI_STATE_DIR: /state`,
    `      SAND_UI_AUTH_FILE: /state/auth.json`,
    `      # The three writable stores the relay already takes from the environment, pointed at this`,
    `      # tenant's own directory so nothing this instance saves lands in the shared ui directory`,
    `      # beside the operator's own files.`,
    `      GROK_BOT_SUBSCRIPTIONS_FILE: /state/subscriptions.json`,
    `      GROK_BOT_MAIL_FILE: /state/mail.json`,
    `      GROK_BOT_MAIL_LEDGER_FILE: /state/mail-inbox.jsonl`,
    `      # The provider list, and the reason a second instance is safe to build at all. Without`,
    `      # this the relay read and wrote the shared ui/endpoints.json beside its own code, which`,
    `      # holds the operator's provider API keys, and a customer's console could have opened it.`,
    `      # The shared directory is mounted read-only above and this points the reads and the`,
    `      # writes at the tenant's own copy. See CP_ALLOW_NEW_TENANTS in cp/provision.mjs.`,
    `      SAND_UI_ENDPOINTS_FILE: /state/endpoints.json`,
  ]);

  // Read-only for a tenant. It is the operator's own console directory: endpoints.json holds the
  // provider API keys, subscriptions.json the adopted tokens, auth.json the console password hash
  // and the cookie signing secret. A tenant's relay had this mounted read-write, so a second
  // customer's console could overwrite all three. It cannot now.
  text = replaceLine(text, RELAY_UI_MOUNT_ANCHOR, [
    `      # Shared, and READ-ONLY for a tenant. This is the operator's own ui directory and the`,
    `      # files beside the code in it are theirs: endpoints.json (provider API keys),`,
    `      # subscriptions.json (adopted tokens), auth.json (the console password hash and the cookie`,
    `      # signing secret). Every file this tenant writes goes to /state below instead.`,
    `      - /home/sem/titanbot/ui:/app/ui:ro`,
  ]);

  // The docker socket does not go to a customer.
  //
  // On the operator's own instance it is what lets the console reach into the box with
  // `docker exec` for box-secrets.json, connectors.json and the desktop buttons. On a tenant's
  // instance it is root on the R750: anything running in that customer's relay could read every
  // other customer's data, the control plane's account store and its Coolify api key. The three
  // surfaces that need it are off on a tenant until they have a path scoped to that tenant's own
  // box, and off is the right direction to fail.
  text = replaceLine(text, RELAY_SOCKET_ANCHOR, [
    `      # NO DOCKER SOCKET. The operator's own compose mounts one here; a tenant does not get it,`,
    `      # because a socket in this container is root on the host, and root on the host is every`,
    `      # other customer's files, the control plane's account store and the Coolify api key.`,
    `      # What a tenant gives up for that: the model picker, the connector editor and the desktop`,
    `      # buttons, all three of which reach the box with \`docker exec\` today. They come back when`,
    `      # they have a path that can only touch this tenant's own box.`,
    `      #`,
  ]);

  // This tenant's own state directory in place of the operator's. Replaced rather than added: the
  // base file now mounts one of its own, and two mounts on /state is a container that will not
  // start.
  text = replaceLine(text, RELAY_STATE_MOUNT_ANCHOR, [
    `      # This tenant's own writable files: auth.json, endpoints.json, subscriptions and mail.`,
    `      # Nothing this instance writes lands in the shared release directory above.`,
    `      - ${paths.state}:/state`,
  ]);

  // The four data mounts. On Jason's own instance these are the docker volume directories; a tenant
  // has no such volumes and never should, because a named volume here is the rename trap the base
  // file's header is about. Each one becomes a plain directory in the tenant's tree.
  const volumeMap = [
    ["/data/docker/volumes/titanbot-box-workspace/_data", paths.workspace],
    ["/data/docker/volumes/titanbot-box-data/_data", paths.data],
    ["/data/docker/volumes/titanbot-box-store/_data", paths.store],
    ["/data/docker/volumes/titanbot-box-chrome/_data", paths.chrome],
  ];
  for (const [from, to] of volumeMap) {
    if (!text.includes(from)) throw new Error(`the base compose no longer mounts ${from}, so this tenant cannot be rendered`);
    text = text.split(from).join(to);
  }

  // Per tenant: the profile (their gateway token) and the credential placeholder.
  text = text.split("/home/sem/titanbot/profile").join(paths.profile);
  text = text.split("/home/sem/titanbot/credential").join(paths.credential);
  // Shared by every tenant: one copy of the release on the host. These three are the same bytes for
  // everybody, which is what makes an update one ship rather than one ship per customer.
  text = text.split("/home/sem/titanbot/runtime").join(path.join(config.releaseRoot, "runtime"));
  text = text.split("/home/sem/titanbot/deploy").join(path.join(config.releaseRoot, "deploy"));
  text = text.split("/home/sem/titanbot/ui").join(path.join(config.releaseRoot, "ui"));

  const header = [
    `# Rendered for tenant "${slug}" by the control plane (cp/provision.mjs). Do not hand-edit this`,
    `# copy: the next provisioning run renders it again from deploy/coolify/docker-compose.yml and`,
    `# your change would go with it. Edit the base file instead.`,
    `#`,
    `#   tenant        ${slug}`,
    `#   console       https://${host}`,
    `#   data          ${paths.root}`,
    `#   release       ${config.releaseRoot} (shared by every tenant on this server)`,
    `#`,
    `# There are no secrets in this text. TITANBOT_GATEWAY_TOKEN and CP_SESSION_SECRET are Coolify`,
    `# environment values on the resource, and the relay password is a scrypt hash in`,
    `# ${paths.authFile} on the server.`,
    ``,
  ].join("\n");

  return `${header}${text}`;
}

// ---- talking to Coolify ------------------------------------------------------------------------

function apiBase(coolifyUrl) {
  const base = String(coolifyUrl ?? "").replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

// A tiny client, with fetch passed in so the tests can answer as Coolify does without a network.
// It never puts the API key anywhere but the Authorization header, and an error carries the status
// and the server's message, never the request headers.
export function createCoolifyClient({ config, fetchImpl = globalThis.fetch }) {
  const base = apiBase(config.coolifyUrl);

  async function call(method, pathname, options = {}) {
    if (!config.coolifyUrl || !config.coolifyApiKey) {
      const error = new Error("Coolify is not configured. Set CP_COOLIFY_URL and COOLIFY_API_KEY on the control plane.");
      error.code = "coolify_unconfigured";
      throw error;
    }
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const url = `${base}${pathname}${query}`;
    const init = {
      method,
      headers: { authorization: `Bearer ${config.coolifyApiKey}`, accept: "application/json" },
    };
    if (options.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response;
    try { response = await fetchImpl(url, init); }
    catch (cause) {
      const error = new Error(`could not reach Coolify at ${base}: ${String(cause?.message ?? cause)}`);
      error.code = "coolify_unreachable";
      throw error;
    }
    const raw = await response.text();
    let parsed = null;
    if (raw.length > 0) { try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 400) } ; } }
    if (!response.ok) {
      const error = new Error(`Coolify answered ${response.status} to ${method} ${pathname}: ${String(parsed?.message ?? "no message")}`);
      error.code = "coolify_error";
      error.status = response.status;
      error.body = parsed;
      throw error;
    }
    return parsed;
  }

  return {
    base,
    call,
    createService: (body) => call("POST", "/services", { body }),
    getService: (uuid) => call("GET", `/services/${uuid}`),
    getServiceApplications: (uuid) => call("GET", `/services/${uuid}/applications`),
    addEnv: (uuid, body) => call("POST", `/services/${uuid}/envs`, { body }),
    updateEnv: (uuid, body) => call("PATCH", `/services/${uuid}/envs`, { body }),
    patchService: (uuid, body) => call("PATCH", `/services/${uuid}`, { body }),
    startService: (uuid) => call("POST", `/services/${uuid}/start`),
    stopService: (uuid) => call("POST", `/services/${uuid}/stop`),
    restartService: (uuid) => call("POST", `/services/${uuid}/restart`),
    // delete_volumes stays false on purpose and the docs say so out loud: a customer's agents,
    // transcripts and workspace are in the tenant directories, and no route on this service deletes
    // those. Removing a tenant removes the Coolify service and leaves the data on the disk.
    deleteService: (uuid) => call("DELETE", `/services/${uuid}`, {
      query: { delete_configurations: "true", delete_volumes: "false", docker_cleanup: "true", delete_connected_networks: "true" },
    }),
  };
}

// Coolify writes a status per container as "running:healthy", "running:unknown", "exited" and so
// on, and this reads defensively and says "unknown" rather than guessing, because the shape is
// untyped in their own schema.
export function coolifyStatusOf(applications) {
  const rows = Array.isArray(applications) ? applications : [];
  const statuses = rows.map((row) => String(row?.status ?? "").trim().toLowerCase()).filter((value) => value.length > 0);
  if (statuses.length === 0) return "unknown";
  const running = statuses.filter((value) => value.startsWith("running"));
  if (running.length === statuses.length) return "running";
  if (running.length === 0) return "stopped";
  // Half up. That is a stack on its way somewhere, not a stack that is anywhere.
  return "provisioning";
}

export async function readCoolifyState(uuid, client) {
  if (!uuid) return { reachable: false, status: "unknown", reason: "this tenant has no Coolify service yet" };
  try {
    const service = await client.getService(uuid);
    // Measured against the R750's Coolify 4.0.0 on 2026-09-07, and it is not what the openapi says.
    // GET /services/{uuid}/applications, the documented place for a container status, answers
    // 404 {"message":"Not found."} on this build, the same way the per-component PATCH did in
    // DOMAIN-1. What that build does return is a service object RICHER than the documented Service
    // schema: a service-level `status` ("running:unknown"), a `server_status` boolean, and an inline
    // `applications` array of {uuid, name, fqdn, status} per container. So the service object is
    // read first and the sub-route is only asked when the object carries nothing, which keeps this
    // working on a Coolify that has the documented route and no inline list.
    let applications = Array.isArray(service?.applications) ? service.applications : [];
    if (applications.length === 0) {
      try {
        const listed = await client.getServiceApplications(uuid);
        if (Array.isArray(listed)) applications = listed;
      } catch { /* the route is not on every Coolify. The service-level status below still answers */ }
    }
    const fromContainers = coolifyStatusOf(applications);
    // If there are no containers to read, the service's own status line is the next best thing, and
    // it is written in the same vocabulary.
    const status = fromContainers === "unknown" && service?.status
      ? coolifyStatusOf([{ status: service.status }])
      : fromContainers;
    return {
      reachable: true,
      status,
      name: service?.name ?? null,
      containers: applications.map((row) => ({
        name: row?.name ?? null,
        status: row?.status ?? null,
        fqdn: row?.fqdn ?? null,
      })),
    };
  } catch (error) {
    return { reachable: false, status: "unknown", reason: String(error?.message ?? error) };
  }
}

// ---- secrets -----------------------------------------------------------------------------------

// 32 bytes as 64 hex characters, the same width the existing install minted, because the box takes
// it as SAND_GATEWAY_TOKEN and the relay serves it as a path segment on /runtime.
export const newGatewayToken = (bytes = randomBytes) => bytes(32).toString("hex");
// 24 url-safe bytes: 32 characters an operator can read out over the phone without a spelling
// alphabet, and far past anything the relay's ten-tries-a-minute lockout could be walked through.
export const newRelayPassword = (bytes = randomBytes) => bytes(24).toString("base64url");

// ---- the plan ------------------------------------------------------------------------------------

// Every step, as the operator would see it before anything happens. bodyPreview never carries a
// secret: the env step previews its keys with the values written as "(set)", which is the whole
// reason a dry run is safe to paste into a ticket.
export function provisioningPlan({ slug, name, config }) {
  const paths = tenantPaths(slug, config);
  const host = tenantHost(slug, config);
  return [
    {
      name: "directories",
      method: "local",
      path: paths.root,
      bodyPreview: { create: tenantDirectoryList(slug, config) },
    },
    {
      name: "secrets",
      method: "local",
      path: paths.profile,
      bodyPreview: { write: [paths.profileTokenFile, paths.authFile], gatewayToken: "(generated)", relayPassword: "(generated, shown once)" },
    },
    {
      name: "compose",
      method: "local",
      path: BASE_COMPOSE_PATH,
      bodyPreview: { rendersFor: slug, dataRoot: paths.root, releaseRoot: config.releaseRoot },
    },
    {
      name: "service",
      method: "POST",
      path: "/services",
      bodyPreview: {
        name: `titanbot-${slug}`,
        description: name || slug,
        project_uuid: config.coolifyProjectUuid,
        environment_name: config.coolifyEnvironmentName,
        server_uuid: config.coolifyServerUuid,
        instant_deploy: false,
        docker_compose_raw: "(base64 of the rendered compose)",
      },
    },
    {
      name: "envs",
      method: "POST",
      path: "/services/{uuid}/envs",
      bodyPreview: { keys: ["TITANBOT_GATEWAY_TOKEN", "CP_SESSION_SECRET"], values: "(set)" },
    },
    {
      name: "urls",
      method: "PATCH",
      path: "/services/{uuid}",
      bodyPreview: { urls: [{ name: "titanbot-relay", url: `https://${host}:7777` }] },
    },
    {
      name: "start",
      method: "POST",
      path: "/services/{uuid}/start",
      bodyPreview: {},
    },
  ];
}

// ---- provisioning --------------------------------------------------------------------------------

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function ensureDirectories(slug, config) {
  for (const directory of tenantDirectoryList(slug, config)) mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// Reads the token back when it is already there, which is what makes a retry safe: minting a second
// token would leave a box authenticating with the first one and a relay presenting the second, and
// the symptom is a console that answers 401 to everything with nothing in any log to say why.
function ensureSecrets(slug, config, { bytes = randomBytes } = {}) {
  const paths = tenantPaths(slug, config);
  let gatewayToken = null;
  let relayPassword = null;

  if (existsSync(paths.profileTokenFile)) {
    try { gatewayToken = String(JSON.parse(readFileSync(paths.profileTokenFile, "utf8"))?.token ?? "") || null; }
    catch { gatewayToken = null; }
  }
  if (gatewayToken === null) {
    gatewayToken = newGatewayToken(bytes);
    writeFileSync(paths.profileTokenFile, `${JSON.stringify({ token: gatewayToken }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(paths.profileTokenFile, 0o600);
  }

  if (!existsSync(paths.authFile)) {
    relayPassword = newRelayPassword(bytes);
    // The relay's own routine, imported rather than copied, so this file cannot drift from what
    // ui/server.mjs reads at boot. Same record, same 0600, same rotated cookie secret.
    writeAuthFile(paths.authFile, newAuthRecord(relayPassword));
  }

  return { gatewayToken, relayPassword };
}

// The one entry point. Returns {ok, tenant, plan?, relayPassword?, steps}. Throws nothing an
// operator would have to read a stack trace to understand: a failure lands in the ledger, marks the
// tenant failed with the message, and comes back as {ok: false, error}.
export async function provisionTenant(options) {
  const {
    store,
    config,
    slug,
    name = "",
    dryRun = false,
    fetchImpl = globalThis.fetch,
    bytes = randomBytes,
    composeText,
  } = options;

  const paths = tenantPaths(slug, config);
  const host = tenantHost(slug, config);
  const plan = provisioningPlan({ slug, name, config });

  if (dryRun) {
    // Everything a real run reads, and every render, with nothing created. The rendered compose is
    // built here too, because a rendering failure is exactly the thing a dry run is for.
    let rendered;
    try { rendered = renderCompose({ slug, config, composeText }); }
    catch (error) {
      store.recordStep({ slug, step: "plan", status: "failed", detail: String(error?.message ?? error) });
      return { ok: false, dryRun: true, error: String(error?.message ?? error), plan: { steps: plan } };
    }
    store.recordStep({ slug, step: "plan", status: "dry-run", detail: JSON.stringify({ steps: plan, composeSha256: sha256(rendered), composeBytes: Buffer.byteLength(rendered, "utf8") }) });
    return { ok: true, dryRun: true, plan: { steps: plan }, composeSha256: sha256(rendered), composeBytes: Buffer.byteLength(rendered, "utf8"), host };
  }

  const client = createCoolifyClient({ config, fetchImpl });
  const done = store.completedSteps(slug);
  const ran = [];
  let gatewayToken = null;
  let relayPassword = null;
  let rendered = null;
  let serviceUuid = store.getTenant(slug)?.coolifyServiceUuid ?? null;

  const fail = (step, error) => {
    const message = String(error?.message ?? error);
    store.recordStep({ slug, step, status: "failed", detail: message });
    store.updateTenant(slug, { status: "failed", lastError: message });
    return { ok: false, step, error: message, steps: store.listSteps(slug), tenant: store.getTenant(slug) };
  };

  // 1. directories
  try {
    if (!done.has("directories")) {
      ensureDirectories(slug, config);
      store.recordStep({ slug, step: "directories", status: "ok", detail: JSON.stringify({ created: tenantDirectoryList(slug, config) }) });
      ran.push("directories");
    }
  } catch (error) { return fail("directories", error); }

  // 2. secrets. Run even when the ledger says it is done, because it is a read when the files are
  // there and the later steps need the token in hand.
  try {
    const secrets = ensureSecrets(slug, config, { bytes });
    gatewayToken = secrets.gatewayToken;
    relayPassword = secrets.relayPassword;
    if (!done.has("secrets")) {
      store.recordStep({ slug, step: "secrets", status: "ok", detail: JSON.stringify({ wrote: [paths.profileTokenFile, paths.authFile] }) });
      ran.push("secrets");
    }
  } catch (error) { return fail("secrets", error); }

  // 3. compose
  try {
    rendered = renderCompose({ slug, config, composeText });
    if (!done.has("compose")) {
      store.recordStep({ slug, step: "compose", status: "ok", detail: JSON.stringify({ sha256: sha256(rendered), bytes: Buffer.byteLength(rendered, "utf8") }) });
      ran.push("compose");
    }
  } catch (error) { return fail("compose", error); }

  // 4. the Coolify service
  try {
    if (!done.has("service") || !serviceUuid) {
      const body = {
        name: `titanbot-${slug}`,
        description: name || slug,
        project_uuid: config.coolifyProjectUuid,
        environment_name: config.coolifyEnvironmentName,
        server_uuid: config.coolifyServerUuid,
        instant_deploy: false,
        docker_compose_raw: Buffer.from(rendered, "utf8").toString("base64"),
      };
      if (config.coolifyEnvironmentUuid) body.environment_uuid = config.coolifyEnvironmentUuid;
      const created = await client.createService(body);
      serviceUuid = String(created?.uuid ?? "");
      if (!serviceUuid) throw new Error("Coolify created the service but did not answer with its uuid");
      store.updateTenant(slug, { coolifyServiceUuid: serviceUuid });
      store.recordStep({ slug, step: "service", status: "ok", detail: JSON.stringify({ uuid: serviceUuid, domains: created?.domains ?? [] }) });
      ran.push("service");
    }
  } catch (error) { return fail("service", error); }

  // 5. the two environment values the compose refers to. Posted one at a time because the bulk
  // route is a PATCH and a PATCH of a key that does not exist yet is not a create.
  try {
    if (!done.has("envs")) {
      const envs = [
        { key: "TITANBOT_GATEWAY_TOKEN", value: gatewayToken },
        // This tenant's own key, never the master. Whoever can read this container's environment
        // can sign a session for this tenant, and that is all they can sign: the master never
        // leaves the control plane, and one tenant's key does not derive another's.
        { key: "CP_SESSION_SECRET", value: tenantSessionSecret(config.sessionSecret, slug) },
      ];
      for (const env of envs) {
        // is_literal, because a generated secret has to reach the container byte for byte and
        // Coolify escapes $ in a value that is not marked literal.
        const body = { key: env.key, value: env.value, is_preview: false, is_literal: true, is_multiline: false, is_shown_once: false };
        // POST first and PATCH on the collision, rather than reading the list and deciding. When
        // Coolify creates a service it reads the compose and makes an empty field for every ${VAR}
        // it finds, so both of these keys already exist by the time this runs and the POST answers
        // 409 "Environment variable already exists. Use PATCH request to update it." That is what
        // failed the first real tenant build on the R750, 2026-09-07: the service, the directories
        // and the secrets were all made and the row still came out `failed`. Re-running this step
        // has to be safe too, because a retry is the normal way out of a half-finished provision.
        try {
          await client.addEnv(serviceUuid, body);
        } catch (error) {
          if (error?.status !== 409) throw error;
          await client.updateEnv(serviceUuid, body);
        }
      }
      store.recordStep({ slug, step: "envs", status: "ok", detail: JSON.stringify({ keys: envs.map((env) => env.key) }) });
      ran.push("envs");
    }
  } catch (error) { return fail("envs", error); }

  // 6. the public address. The service-level urls PATCH is what works on Coolify 4.0.0; the
  // per-component PATCH answers Not found (measured on this server for DOMAIN-1).
  try {
    if (!done.has("urls")) {
      const urls = [{ name: "titanbot-relay", url: `https://${host}:7777` }];
      let answer;
      try { answer = await client.patchService(serviceUuid, { urls }); }
      catch (error) {
        // Measured 2026-09-07 while re-provisioning demo: a tenant deleted seconds earlier still
        // held its hostname in Coolify's books, and the PATCH answered 409 "Domain conflicts
        // detected. Use force_domain_override". The name is this tenant's by construction, so the
        // override is the right answer to that one refusal and to nothing else.
        if (error?.status !== 409 || !/domain conflict/i.test(String(error?.message ?? ""))) throw error;
        answer = await client.patchService(serviceUuid, { urls, force_domain_override: true });
      }
      store.updateTenant(slug, { host });
      store.recordStep({ slug, step: "urls", status: "ok", detail: JSON.stringify({ url: `https://${host}:7777`, domains: answer?.domains ?? [] }) });
      ran.push("urls");
    }
  } catch (error) { return fail("urls", error); }

  // 7. start. Asynchronous on Coolify's side: it queues the request and answers immediately, which
  // is why the tenant is left "provisioning" and GET /v1/tenants/{slug} is the thing that says when
  // the containers are actually up.
  try {
    if (!done.has("start")) {
      const answer = await client.startService(serviceUuid);
      store.recordStep({ slug, step: "start", status: "ok", detail: JSON.stringify({ message: answer?.message ?? "" }) });
      ran.push("start");
    }
  } catch (error) { return fail("start", error); }

  store.updateTenant(slug, { status: "provisioning", host, lastError: null });
  return {
    ok: true,
    tenant: store.getTenant(slug),
    // Once, and only on the run that created it. A retry answers null here and the note says where
    // the operator goes instead.
    relayPassword,
    relayPasswordNote: relayPassword
      ? "Write this down now. It is the tenant's relay password and nothing can print it again."
      : "The relay password was set on an earlier run and cannot be shown again. Reset it with node ui/set-password.mjs on the server.",
    ran,
    steps: store.listSteps(slug),
  };
}
