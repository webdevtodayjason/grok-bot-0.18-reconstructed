// cp/provision.mjs -- turning a company name into a customer's sandbox.
//
// TENANT-5 changed what a tenant IS. It used to be a box and a relay and a hostname of its own, and
// Jason's words for why that stopped are the whole design: "Every time we add somebody new, we're
// basically duplicating everything. That sounds crazy." A tenant is now ONE container, the sandbox
// their agents live in, plus one directory on the disk. There is one relay and one console at
// console.titanium.bot for everybody, and it works out which box a request belongs to from the
// session. So there is no relay to build here, no hostname to set, and no second login door.
//
// Eight steps, in this order, every one of them idempotent and every one of them written to the
// provisioning ledger with the answer Coolify gave:
//
//   directories  the tenant's own tree under CP_TENANT_ROOT
//   secrets      the gateway token, generated once and never again
//   compose      deploy/coolify/box.compose.yml re-pointed at that tree
//   service      POST /services, and the container name Coolify will give the box written down
//   envs         POST /services/{uuid}/envs, the one value the compose refers to but does not carry
//                (PATCH instead when Coolify already made the field from the compose's ${VAR})
//   proxy-key    PROXY-1: this tenant's own virtual key at the proxy, minted once and written 0600
//                beside the gateway token. Skipped, and recorded as skipped, on a server with no
//                CP_PROXY_URL, so it runs the day one is configured
//   start        POST /services/{uuid}/start
//   ready        wait for that box to answer, so "created" means something
//
// "Idempotent" is doing work here, not decoration. A step that already succeeded is skipped on a
// retry, and every step that can be run twice safely is written so that it can be: mkdir -p, a
// secrets step that reads the token back off disk rather than minting a second one, a service step
// that reuses the uuid already in the ledger. So POST /v1/tenants/{slug}/provision after a failure
// picks up at the step that failed instead of building a second half-instance beside the first.
//
// One thing never reaches the ledger and never reaches the compose text: the gateway token. It goes
// into Coolify's environment store and into a 0600 file in the tenant's profile directory, and the
// relay is handed it over GET /v1/relay/tenants behind CP_RELAY_TOKEN. Nothing puts it in a
// browser, in a plan preview or in a log line.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tenantSessionSecret } from "./session.mjs";
import { createProxyClient, includedModelRows, proxyKeyAlias } from "./proxy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

// The operator's own two-container stack, which nothing here renders any more. It stays named
// because deploy/r750 and the docs still point at it as the file Jason's own instance is pasted
// from, and because the box template below is derived from its box half.
export const BASE_COMPOSE_PATH = path.join(REPO_ROOT, "deploy", "coolify", "docker-compose.yml");

// The compose a tenant is cut from: one service, the box, on the shared network. Read from disk at
// render time rather than at import, so a container that ships a different copy of it does not need
// this file rebuilt.
export const BOX_COMPOSE_PATH = path.join(REPO_ROOT, "deploy", "coolify", "box.compose.yml");

// What Coolify calls the box's container. Measured on the R750 2026-09-07: every Coolify service's
// containers are named "<compose service name>-<resource uuid>", and both live boxes are exactly
// titanbot-box-p927bfqm83ioloibamlvyd7g and titanbot-box-sy74dau8ilh1g4u7a9eaw8f8. It is computed
// once, when the service is created, and WRITTEN DOWN, because a re-provision mints a new uuid and
// a relay that rebuilt this name from a stale row would land on a container that is not this
// customer's.
export const BOX_SERVICE_NAME = "titanbot-box";
export const boxContainerName = (uuid) => `${BOX_SERVICE_NAME}-${String(uuid ?? "")}`;

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

// PROXY-1. The two file names in a tenant's profile directory that belong to the proxy, pinned as
// constants because the relay joins them onto the profileDir it is handed over the registry route
// and two spellings of one name is a bug nobody sees until a rollback does nothing.
export const PROXY_KEY_NAME = "model-proxy.json";
export const PROXY_ROLLBACK_NAME = "model-proxy-rollback.json";

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

// ---- a name from a company name ------------------------------------------------------------
//
// TENANT-5, item 5. Nobody signing up types a slug. They type the name of their company, and this
// is the one place that turns one into the other, so the sign-up route and the CLI cannot disagree
// about what "Acme Roofing & Sons" becomes.
//
// Accents are folded rather than dropped, so "Café Noir" is cafe-noir and not caf-noir. Everything
// that is not a letter or a number becomes one dash, the dashes at the ends come off, and the
// result is cut to the 32 characters a name may be. A company whose name has no letters or numbers
// in it at all gets an empty string back and the caller asks them for a different one, which is
// better than inventing a name they will not recognise.
export function slugFromCompany(company) {
  return String(company ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

// The name that company actually gets: theirs if it is free, and theirs with a number on the end if
// it is not. `taken` answers whether a name is already in the ledger; the reserved list and the
// character rules are applied here so a customer can never be handed "api" or "titanium" because
// that happened to be their company name.
//
// Two below the minimum length is a real case: a company called "GK" is a two character name and
// the rule is three. It becomes "gk-workspace", which is a name they will recognise, rather than a
// refusal they cannot do anything about.
export function deriveSlug(company, taken = () => false) {
  let base = slugFromCompany(company);
  if (base.length === 0) return null;
  if (base.length < SLUG_MIN) base = `${base}-workspace`.slice(0, SLUG_MAX);
  for (let suffix = 1; suffix <= 99; suffix += 1) {
    const tail = suffix === 1 ? "" : `-${suffix}`;
    const candidate = `${base.slice(0, SLUG_MAX - tail.length).replace(/-+$/g, "")}${tail}`;
    if (!validateSlug(candidate).ok) continue;
    if (taken(candidate)) continue;
    return candidate;
  }
  return null;
}

// ---- configuration -------------------------------------------------------------------------
//
// One reader for every environment variable the control plane takes, so the names live in one
// place and both the server and the CLI see the same defaults.

export const CONFIG_DEFAULTS = {
  port: 7790,
  baseDomain: "titanium.bot",
  // Where every customer signs in, and the only hostname the product has. Per-tenant hostnames are
  // retired: TENANT-5 put one relay and one console in front of everybody.
  consoleHost: "console.titanium.bot",
  tenantRoot: "/data/titanbot",
  releaseRoot: "/home/sem/titanbot",
  environmentName: "production",
  publicUrl: "https://api.titanium.bot",
  // The one docker network the relay and every box share. Made once on the server, declared
  // external in the box template, never created by a deploy.
  sharedNetwork: "titanbot-net",
  // What the box calls the relay on that network, for the host bundle route. The relay's compose
  // service name is titanbot-relay and Coolify keeps a compose service name as a network alias.
  relayHost: "titanbot-relay",
  // How long provisioning waits for a new box to answer before it stops waiting and says so. A
  // 5.2 GB image that is not on the server yet takes longer than any wait worth having, so a
  // timeout here is a sentence about a box that is still starting, never a failed tenant.
  boxReadyTimeoutMs: 90_000,
  boxReadyIntervalMs: 3_000,
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
    // TENANT-5. The relay's own credential, and the only thing that opens GET /v1/relay/tenants.
    // It is not the admin token and the admin token does not open that route: two doors, neither
    // holding the other's key. Unset, the route answers 401 to everybody, which is what a single
    // box install with no relay to feed should do.
    relayToken: text("CP_RELAY_TOKEN"),
    baseDomain: text("CP_BASE_DOMAIN", CONFIG_DEFAULTS.baseDomain),
    consoleHost: text("CP_CONSOLE_HOST", CONFIG_DEFAULTS.consoleHost),
    sharedNetwork: text("CP_SHARED_NETWORK", CONFIG_DEFAULTS.sharedNetwork),
    relayHost: text("CP_RELAY_HOST", CONFIG_DEFAULTS.relayHost),
    boxReadyTimeoutMs: Number(text("CP_BOX_READY_TIMEOUT_MS", String(CONFIG_DEFAULTS.boxReadyTimeoutMs))) || CONFIG_DEFAULTS.boxReadyTimeoutMs,
    boxReadyIntervalMs: Number(text("CP_BOX_READY_INTERVAL_MS", String(CONFIG_DEFAULTS.boxReadyIntervalMs))) || CONFIG_DEFAULTS.boxReadyIntervalMs,
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
    // Whether a stranger may sign themselves up, or only the operator may add them. Off by default,
    // because the day this is on is a decision about who pays for a 5.2 GB container, not a default.
    allowSignup: /^(1|true|yes)$/i.test(text("CP_ALLOW_SIGNUP", "")),
    // Which peers may say who the visitor is. Same two settings the relay already runs with, read
    // by the same code, because two implementations of one answer is how one of them goes stale.
    trustedProxies: text("CP_TRUSTED_PROXIES"),
    cloudflareRanges: text("CP_CLOUDFLARE_RANGES"),
    // And which of those callers are a RELAY forwarding a customer rather than a customer. Every
    // tenant console posts its sign-ins here from one machine's egress address, so the address half
    // of the lockout is one bucket for the whole fleet unless this says so. See loginLock.
    relayPeers: text("CP_RELAY_PEERS"),
    // ADMIN-1. Where this service reaches the one relay, for the two facts only the relay can see:
    // the failed sign-in ledger (a refusal happens at that door and never arrives here) and box
    // health (that container has the docker socket and this one deliberately does not). The default
    // is the compose service name on the shared network, which Coolify keeps as a network alias, and
    // the relay's own port. The credential is CP_RELAY_TOKEN, already above.
    relayUrl: text("CP_RELAY_URL", `http://${text("CP_RELAY_HOST", CONFIG_DEFAULTS.relayHost)}:7777`).replace(/\/+$/, ""),
    // How long to wait on that relay. The box-health sweep on the other end is bounded, so the
    // default is comfortably longer than that budget and this exists for a fleet that outgrows it.
    relayTimeoutMs: Number(text("CP_RELAY_TIMEOUT_MS", "")) || 0,
    // Where the nightly backup manifests are, IF anybody ever mounts them in. They live on
    // /mnt/rosa-storage, which is mounted into no container, so unset is the normal state and the
    // admin console reads "not measured" rather than guessing. See docs/ADMIN.md.
    backupManifestDir: text("CP_BACKUP_MANIFEST_DIR"),
    // And the box isolation timer's verdict, for the day it writes one. box-isolation.sh --verify
    // prints its result today and writes no file, so this is unset and the panel says why.
    isolationReport: text("CP_ISOLATION_REPORT"),

    // ---- the proxy (PROXY-1) -------------------------------------------------------------------
    //
    // All four are CP_ prefixed for the reason CP_COOLIFY_URL is: Coolify injects names of its own
    // into every service container and its value wins, so a name this product wants has to be one
    // Coolify does not also use.
    //
    // UNSET MEANS THE FEATURE IS OFF, EVERYWHERE, AND EVERY SURFACE SAYS SO. None of these ever
    // goes in configProblems: `required` would stop the control plane booting for every install
    // that has no proxy yet, which is every existing customer including Jason's own console. The
    // pattern is CP_RELAY_TOKEN's: unset is a closed door that answers honestly, set but malformed
    // is the thing that gets refused.
    proxyUrl: text("CP_PROXY_URL").replace(/\/+$/, ""),
    // The proxy's master key. It reaches exactly two places, this service's environment and the
    // proxy's own, and it is never written into a box, into git or into the sync payload.
    proxyMasterKey: text("CP_PROXY_MASTER_KEY"),
    // What one tenant's plan includes in a month, in dollars. Called an allowance and not a plan
    // anywhere in cp/, because `plan` already means the seven step provisioning plan in four files
    // here and one word for two things is how a reader ends up reading the wrong one.
    proxyAllowanceUsd: Number(text("CP_PROXY_ALLOWANCE_USD", "0")) || 0,
    // Observe first. Unset mints soft_budget, which never fails a request and still produces the
    // number the 80 percent chip reads. Set, the mint sends max_budget and a spent allowance is a
    // refusal the box turns into a plain sentence. Arming it is a decision of its own.
    proxyEnforce: /^(1|true|yes)$/i.test(text("CP_PROXY_ENFORCE", "")),
    // Requests a minute, per tenant, at the proxy. 0 leaves the key unlimited, which is what an
    // install that has not thought about it should get rather than a number somebody guessed.
    proxyRpmLimit: Number(text("CP_PROXY_RPM_LIMIT", "0")) || 0,
  };
}

// The switch that decides whether this server builds new customers at all.
//
// It used to be about a safety condition that TENANT-2 met and TENANT-5 removed outright: a tenant
// relay mounted the operator's shared ui directory and could read the provider API keys in it. A
// tenant has no relay now, so there is nothing to read. What is left is the ordinary operator
// question, which is that every new customer is a 5.2 GB container on this server, so switching
// them on is a decision somebody makes rather than a default.
//
// Adopting an instance that already exists is unaffected, and so is finishing one that was already
// started, so this cannot strand a half-built tenant.
export const NEW_TENANTS_BLOCKED =
  "New customer workspaces are turned off on this server. Every new one is another container, so turning them on is deliberate. Set CP_ALLOW_NEW_TENANTS=1 on the control plane. Finishing a workspace that was already started and claiming one that already exists both still work.";

// The things a config must have before it can sign anybody in. Reported as sentences because this
// is what the service prints and refuses to start on.
export function configProblems(config) {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    problems.push("CP_SESSION_SECRET is missing or shorter than 32 characters. Every tenant relay checks sessions with this value, so set it once and set the same value on every relay.");
  }
  if (!config.adminToken || config.adminToken.length < 16) {
    problems.push("CP_ADMIN_TOKEN is missing or shorter than 16 characters. It is the password for the routes that add accounts and tenants.");
  }
  // Unset is fine and means the relay route is closed to everybody. Set and short is not fine: this
  // one value hands out every customer's gateway token, so a guessable one is every customer's box.
  if (config.relayToken && config.relayToken.length < 32) {
    problems.push("CP_RELAY_TOKEN is shorter than 32 characters. It is the console relay's own password and it hands out every customer's gateway token, so make it at least 32 characters or leave it unset.");
  }
  return problems;
}

// Where a tenant's people sign in. One console for everybody as of TENANT-5, so this does not
// depend on the tenant at all, and the argument is kept only so a caller reads at the call site
// which tenant it was asking about.
export function consoleHost(config) {
  return config.consoleHost || CONFIG_DEFAULTS.consoleHost;
}

export function tenantDirectory(slug, config) {
  return path.join(config.tenantRoot, slug);
}

// Every directory a tenant owns. The volumes are the four the box writes into; profile holds the
// gateway token file; credential is the placeholder inference file the box refuses to start
// without; state is this tenant's writable corner of the one relay, which is what lets the relay's
// own code and the release directory be one shared copy instead of a copy per customer.
//
// There is no auth.json here any more, and that is deliberate. Provisioning used to write one, with
// a generated password printed to the operator once. Under TENANT-5 there is one relay with one
// operator auth.json, so that file opened nothing: a credential on disk that looks like a second
// door and is not one is worse than no credential at all. A customer signs in with their account.
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
    // PROXY-1. This tenant's virtual key at the proxy, beside its gateway token and written the
    // same way: 0600, in the profile directory, read back on a retry rather than minted twice.
    proxyKeyFile: path.join(root, "profile", PROXY_KEY_NAME),
    // And the snapshot the migration takes of what the box held BEFORE it was pointed at the
    // proxy, so `proxy rollback` can put it back. Written by the relay, which is the only thing in
    // this product that can read a box's own files, and named here so both sides use one name.
    proxyRollbackFile: path.join(root, "profile", PROXY_ROLLBACK_NAME),
  };
}

export function tenantDirectoryList(slug, config) {
  const paths = tenantPaths(slug, config);
  return [paths.root, paths.profile, paths.credential, paths.state, paths.volumes, paths.workspace, paths.data, paths.store, paths.chrome];
}

// ---- rendering the compose ---------------------------------------------------------------------

// Every substitution refuses to guess. If a thing this renderer replaces is not in the template
// exactly as many times as it expects, the template changed underneath it and the honest answer is
// to stop: a tenant compose that quietly kept the shared docker volumes is a customer looking at
// Jason's agents, and nobody would find that until they said so.
function substitute(text, from, to, { atLeast = 1, exactly = null } = {}) {
  const parts = String(text).split(from);
  const found = parts.length - 1;
  // Gone entirely reads better as gone entirely, whichever rule was going to catch it.
  if (found === 0) {
    throw new Error(`the box compose no longer has "${from}", so this tenant cannot be rendered`);
  }
  if (exactly !== null && found !== exactly) {
    throw new Error(`the box compose has "${from}" ${found} times and this renderer expects ${exactly}, so this tenant cannot be rendered`);
  }
  if (found < atLeast) {
    throw new Error(`the box compose has "${from}" ${found} times and this renderer needs at least ${atLeast}, so this tenant cannot be rendered`);
  }
  return parts.join(to);
}

// deploy/coolify/box.compose.yml, pointed at one customer's own tree.
//
// What changes per tenant: the name (twice, as the network alias and as TENANT_ID), the four data
// mounts, the credential directory. What is shared by every tenant and therefore does not change:
// the runtime directory, which is one copy of the release on the server, which is what makes an
// update one ship rather than one ship per customer. What is a secret and is therefore not in this
// text at all: the gateway token, which is a Coolify environment value on the resource.
export function renderBoxCompose({ slug, config, composeText = readFileSync(BOX_COMPOSE_PATH, "utf8") }) {
  const paths = tenantPaths(slug, config);
  let text = composeText;

  // The name, in the alias and in TENANT_ID.
  text = substitute(text, "TENANT_SLUG", slug, { exactly: 2 });

  // The four data mounts, off the shared docker volumes and onto this tenant's own directories. A
  // named volume would be renamed by Coolify's parser and created empty; these are plain paths.
  const volumeMap = [
    ["/data/docker/volumes/titanbot-box-workspace/_data", paths.workspace],
    ["/data/docker/volumes/titanbot-box-data/_data", paths.data],
    ["/data/docker/volumes/titanbot-box-store/_data", paths.store],
    ["/data/docker/volumes/titanbot-box-chrome/_data", paths.chrome],
  ];
  for (const [from, to] of volumeMap) text = substitute(text, from, to, { exactly: 1 });

  // Per tenant. The credential is a placeholder inference file the box refuses to start without.
  text = substitute(text, "/home/sem/titanbot/credential", paths.credential, { exactly: 1 });
  // Shared by every tenant: the release directory the host bundle and the exec daemon are shipped
  // into. Two mounts, so exactly two.
  text = substitute(text, "/home/sem/titanbot/runtime", path.join(config.releaseRoot, "runtime"), { exactly: 2 });

  // The network everybody shares and the relay's name on it. Both are configurable because an
  // install that calls them something else should say so once here rather than editing the
  // template, and both are replaced everywhere including in the comments, so a rendered file never
  // explains a name it does not use.
  text = substitute(text, "titanbot-relay", config.relayHost, { atLeast: 1 });
  text = substitute(text, "titanbot-net", config.sharedNetwork, { atLeast: 3 });

  const header = [
    `# Rendered for tenant "${slug}" by the control plane (cp/provision.mjs). Do not hand-edit this`,
    `# copy: the next provisioning run renders it again from deploy/coolify/box.compose.yml and your`,
    `# change would go with it. Edit the template instead.`,
    `#`,
    `#   tenant        ${slug}`,
    `#   console       https://${consoleHost(config)} (shared, this customer has no hostname)`,
    `#   data          ${paths.root}`,
    `#   release       ${config.releaseRoot} (shared by every tenant on this server)`,
    `#   network       ${config.sharedNetwork} (shared, so the one relay can reach this box)`,
    `#`,
    `# There is no secret in this text. TITANBOT_GATEWAY_TOKEN is a Coolify environment value on the`,
    `# resource and a 0600 file in ${paths.profile}.`,
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

// There is no second secret here any more. Provisioning used to mint a relay password as well and
// hand it to the operator once, because a tenant had a console of its own with its own password
// box. It has not had one since TENANT-5: there is one relay, one operator auth.json, and a
// customer signs in with the account the control plane holds. A generated password that opens
// nothing is worse than none, so it is gone rather than kept "just in case".

// ---- the plan ------------------------------------------------------------------------------------

// Every step, as the operator would see it before anything happens. bodyPreview never carries a
// secret: the env step previews its keys with the values written as "(set)", which is the whole
// reason a dry run is safe to paste into a ticket.
export function provisioningPlan({ slug, name, config }) {
  const paths = tenantPaths(slug, config);
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
      bodyPreview: { write: [paths.profileTokenFile], gatewayToken: "(generated)" },
    },
    {
      name: "compose",
      method: "local",
      path: BOX_COMPOSE_PATH,
      bodyPreview: { rendersFor: slug, dataRoot: paths.root, releaseRoot: config.releaseRoot, network: config.sharedNetwork },
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
      // One key now, not two. The session key used to be written into the tenant's own Coolify
      // environment because the tenant had a relay of its own to verify with it. It has no relay,
      // so the one relay is handed that key over GET /v1/relay/tenants instead and Coolify never
      // sees it.
      bodyPreview: { keys: ["TITANBOT_GATEWAY_TOKEN"], values: "(set)" },
    },
    // PROXY-1. The eighth step, and it had to be a NEW step rather than something folded into
    // "secrets" or "envs": demo and richard-avery both have all seven of the others marked ok on
    // the R750, and completedSteps skips a step that is already ok, so anything added inside an
    // existing one would never run again for the two customers who exist.
    //
    // Nothing about the key itself is previewed, because a dry run is a thing an operator pastes
    // into a ticket. The alias and the file are facts about where it lives, not the key.
    {
      name: "proxy-key",
      method: config.proxyUrl ? "POST" : "local",
      path: config.proxyUrl ? `${config.proxyUrl}/key/generate` : "(no proxy configured on this server)",
      bodyPreview: config.proxyUrl
        ? { key_alias: proxyKeyAlias(slug), tags: [`tenant:${slug}`], writes: [paths.proxyKeyFile], key: "(generated)", allowanceUsd: config.proxyAllowanceUsd, enforced: Boolean(config.proxyEnforce && config.proxyAllowanceUsd > 0) }
        : { skipped: "CP_PROXY_URL is not set, so this workspace keeps whatever provider configuration it already has" },
    },
    // No urls step. A tenant has no hostname: everybody signs in at the one console, and a PATCH
    // that put <slug>.titanium.bot on this service would publish a customer's box to the internet.
    {
      name: "start",
      method: "POST",
      path: "/services/{uuid}/start",
      bodyPreview: {},
    },
    {
      name: "ready",
      method: "local",
      path: `${BOX_SERVICE_NAME}-{uuid}:1340`,
      bodyPreview: { waitsUpToMs: config.boxReadyTimeoutMs, everyMs: config.boxReadyIntervalMs },
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

  if (existsSync(paths.profileTokenFile)) {
    try { gatewayToken = String(JSON.parse(readFileSync(paths.profileTokenFile, "utf8"))?.token ?? "") || null; }
    catch { gatewayToken = null; }
  }
  if (gatewayToken === null) {
    gatewayToken = newGatewayToken(bytes);
    writeFileSync(paths.profileTokenFile, `${JSON.stringify({ token: gatewayToken }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(paths.profileTokenFile, 0o600);
  }

  return { gatewayToken };
}

// The token a tenant's box authenticates with, read back off the disk. This is the one place that
// reads it, and it is read for exactly one caller: GET /v1/relay/tenants, which hands it to the
// relay so the relay can talk to that customer's box. It never goes to a browser and never goes in
// an answer to anybody holding any other credential.
export function readGatewayToken(slug, config) {
  const paths = tenantPaths(slug, config);
  if (!existsSync(paths.profileTokenFile)) return null;
  try {
    const token = String(JSON.parse(readFileSync(paths.profileTokenFile, "utf8"))?.token ?? "");
    return token.length > 0 ? token : null;
  } catch { return null; }
}

// ---- the proxy key (PROXY-1) -------------------------------------------------------------------
//
// Read then mint, exactly the shape ensureSecrets uses for the gateway token, and for the same
// reason: a retry of a half finished provisioning run has to be a READ. Minting a second key would
// leave the tenant's box holding the first one and the registry handing out the second, the
// symptom would be a customer whose agent answers 401 with nothing in any log to say why, and the
// first key would go on spending against an allowance nobody could see.
//
// The models are not assumed. The proxy is asked which plan- models it actually serves, and the
// key is minted against that list, so an install where the operator has no Qwen key does not hand
// a customer a model that 400s the moment they pick it. That answer is written into the file with
// the key, so the registry never has to call the proxy to answer the relay.

// WHERE A TENANT'S PROFILE DIRECTORY IS, in one place.
//
// For a workspace this service built it is under CP_TENANT_ROOT. For one that was ADOPTED it is
// wherever the operator already had it, which is recorded in the adopt step and nowhere else: tenant
// "titanium" is Jason's own instance, its files are under the release root, and it has no directory
// under the tenant root at all. That matters here more than anywhere, because `proxy mint titanium`
// through the CLI is the ONLY way the operator's own workspace ever gets a key, and a CLI that
// wrote it under the tenant root would write a file the registry never reads: the mint would report
// success and Jason's console would still show nothing included with his plan.
export function adoptionDirs(steps = []) {
  for (const step of [...steps].reverse()) {
    if (step.step !== "adopt" || step.status !== "ok") continue;
    try {
      const parsed = JSON.parse(step.detail || "{}");
      return {
        stateDir: typeof parsed.stateDir === "string" ? parsed.stateDir : "",
        profileDir: typeof parsed.profileDir === "string" ? parsed.profileDir : "",
      };
    } catch { return { stateDir: "", profileDir: "" }; }
  }
  return { stateDir: "", profileDir: "" };
}

export function tenantProfileDir(slug, config, steps = []) {
  return adoptionDirs(steps).profileDir || tenantPaths(slug, config).profile;
}

/** The path of one tenant's plan key, adopted or not. */
export const proxyKeyFileIn = (profileDir) => path.join(profileDir, PROXY_KEY_NAME);

/** The single reader. Called by the registry and by the CLI, and by nothing else. */
export function readProxyKey(slug, config, { file = null } = {}) {
  const target = file ?? tenantPaths(slug, config).proxyKeyFile;
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    const key = String(parsed?.key ?? "");
    if (key.length === 0) return null;
    return {
      key,
      keyId: String(parsed?.keyId ?? ""),
      alias: String(parsed?.alias ?? proxyKeyAlias(slug)),
      mintedAt: String(parsed?.mintedAt ?? ""),
      models: Array.isArray(parsed?.models) ? parsed.models : [],
      enforced: parsed?.enforced === true,
    };
  } catch { return null; }
}

export function writeProxyKey(slug, config, record, { file = null } = {}) {
  const target = file ?? tenantPaths(slug, config).proxyKeyFile;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  return record;
}

/** Forgetting one locally, which is what a revoke and a rotate both do before anything else. */
export function forgetProxyKey(slug, config, { file = null } = {}) {
  const target = file ?? tenantPaths(slug, config).proxyKeyFile;
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}

/**
 * The tenant's key, minted once.
 *
 * Answers {ok, minted, record} or {ok: false, why}. It never throws, because it is called from a
 * provisioning step whose job is to record a sentence and stop, and from a CLI whose job is to
 * print one.
 *
 * `force` is the rotate: the old key is deleted at the proxy BY ALIAS before a new one is minted,
 * rather than being left orphaned holding a budget nobody is reading.
 */
export async function ensureProxyKey(slug, config, options = {}) {
  const {
    proxy = createProxyClient({ config, fetchImpl: options.fetchImpl }),
    force = false,
    box = "",
    now = () => Date.now(),
    // Where to write it. Defaults to this tenant's own profile directory under the tenant root,
    // and is passed in by the CLI for an ADOPTED workspace whose files are somewhere else.
    file = null,
  } = options;

  if (String(config.proxyUrl ?? "").length === 0) {
    return { ok: false, skipped: true, why: "this server has no proxy configured (CP_PROXY_URL is not set)" };
  }

  const existing = readProxyKey(slug, config, { file });
  if (existing && !force) return { ok: true, minted: false, record: existing };

  const served = await proxy.models();
  if (!served.ok) return { ok: false, why: `the proxy could not be asked which models it serves: ${served.why}` };
  if (served.models.length === 0) {
    return { ok: false, why: "the proxy serves no plan models, so there is nothing to mint a key against" };
  }

  if (force && existing) {
    const removed = await proxy.deleteKeyByAlias(slug);
    // A rotate whose delete failed is still a rotate, and the new key is what the box will use, so
    // this is reported rather than fatal. The old one keeps its own budget until somebody revokes
    // it, and `proxy revoke` is the way to.
    if (!removed.ok) options.onNote?.(`the old key could not be deleted at the proxy: ${removed.why}`);
  }

  const minted = await proxy.mintKey({
    slug,
    models: served.models,
    allowanceUsd: config.proxyAllowanceUsd,
    enforce: config.proxyEnforce,
    rpmLimit: config.proxyRpmLimit,
    box,
  });
  if (!minted.ok) return { ok: false, why: `the proxy would not mint a key: ${minted.why}` };

  const record = {
    key: minted.key,
    keyId: minted.keyId,
    alias: minted.alias,
    mintedAt: new Date(now()).toISOString(),
    enforced: minted.enforced,
    // The rows the relay serves, worked out once here rather than on every registry read.
    models: includedModelRows({ models: served.models, windows: served.windows }),
  };
  writeProxyKey(slug, config, record, { file });
  return { ok: true, minted: true, record };
}

// ---- waiting for the box -------------------------------------------------------------------
//
// "Created" used to mean "Coolify said it queued the start", which is a sentence about a request
// and not about a customer's workspace. This waits for the box itself, two ways, and takes
// whichever answers first:
//
//   the gateway   an http request straight to that box on the shared network. ANY answer counts,
//                 including a 401 or a 404: the question is whether something is listening on
//                 1340, and only a connection error says no. This is the definitive one and it
//                 works when the control plane is on the shared network too.
//   Coolify       the service's own container status. This is what answers when the control plane
//                 is not on that network, which is the ordinary case: it is an api call, not a
//                 connection to the box.
//
// A timeout is NOT a failure. Pulling a 5.2 GB image the server does not have yet takes longer than
// any wait worth putting a customer through, so the answer says "still starting" and provisioning
// carries on. The ledger records which of the two answered, so an operator reading it afterwards
// knows whether the box really spoke or whether Coolify merely said the container was up.
export async function waitForBox(options = {}) {
  const {
    client = null,
    uuid = "",
    gateway = "",
    token = "",
    // The thing that talks to the BOX, which is not the thing that talks to Coolify. They are the
    // same fetch in production and they are not in a test: a test process has no docker network, so
    // a probe of titanbot-box-svc-1:1340 is a name lookup that means nothing. Separating them is
    // what lets a test drive the Coolify half honestly and skip the half it cannot have.
    probeImpl = globalThis.fetch,
    timeoutMs = CONFIG_DEFAULTS.boxReadyTimeoutMs,
    intervalMs = CONFIG_DEFAULTS.boxReadyIntervalMs,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const started = now();
  const deadline = started + Math.max(0, timeoutMs);
  let lastReason = "nothing answered yet";

  for (;;) {
    if (gateway && typeof probeImpl === "function") {
      try {
        // A short abort of its own, so one hung connection cannot eat the whole wait.
        const answer = await probeImpl(`${gateway.replace(/\/+$/, "")}/api/health`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(Math.min(5_000, Math.max(1_000, intervalMs))),
        });
        return { ready: true, how: "gateway", status: answer?.status ?? 0, waitedMs: now() - started };
      } catch (error) { lastReason = `the box has not answered yet (${String(error?.message ?? error)})`; }
    }

    if (client != null && uuid) {
      const live = await readCoolifyState(uuid, client);
      if (live.reachable && live.status === "running") {
        return { ready: true, how: "coolify", status: live.status, waitedMs: now() - started };
      }
      lastReason = live.reachable ? `Coolify says this box is ${live.status}` : `Coolify could not be read (${live.reason})`;
    }

    if (now() + intervalMs >= deadline) {
      return { ready: false, how: "timeout", reason: lastReason, waitedMs: now() - started };
    }
    await sleep(intervalMs);
  }
}

// The one entry point. Returns {ok, tenant, plan?, ran?, boxReady?, steps}. Throws nothing an
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
    readyTimeoutMs = config.boxReadyTimeoutMs,
    readyIntervalMs = config.boxReadyIntervalMs,
    // The box probe, separate from the Coolify fetch. See waitForBox.
    probeImpl = fetchImpl,
    sleep,
  } = options;

  const paths = tenantPaths(slug, config);
  const host = consoleHost(config);
  const plan = provisioningPlan({ slug, name, config });

  if (dryRun) {
    // Everything a real run reads, and every render, with nothing created. The rendered compose is
    // built here too, because a rendering failure is exactly the thing a dry run is for.
    let rendered;
    try { rendered = renderBoxCompose({ slug, config, composeText }); }
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
  let rendered = null;
  let serviceUuid = store.getTenant(slug)?.coolifyServiceUuid ?? null;
  let boxContainer = store.getTenant(slug)?.boxContainer ?? null;

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

  // 2. secrets. Run even when the ledger says it is done, because it is a read when the file is
  // there and the later steps need the token in hand.
  try {
    const secrets = ensureSecrets(slug, config, { bytes });
    gatewayToken = secrets.gatewayToken;
    if (!done.has("secrets")) {
      store.recordStep({ slug, step: "secrets", status: "ok", detail: JSON.stringify({ wrote: [paths.profileTokenFile] }) });
      ran.push("secrets");
    }
  } catch (error) { return fail("secrets", error); }

  // 3. compose
  try {
    rendered = renderBoxCompose({ slug, config, composeText });
    if (!done.has("compose")) {
      store.recordStep({ slug, step: "compose", status: "ok", detail: JSON.stringify({ sha256: sha256(rendered), bytes: Buffer.byteLength(rendered, "utf8"), network: config.sharedNetwork }) });
      ran.push("compose");
    }
  } catch (error) { return fail("compose", error); }

  // 4. the Coolify service, and the name of the container it will run the box in.
  //
  // The name is written down here rather than rebuilt at read time, and that is the point of the
  // column: a re-provision mints a new uuid, and a relay resolving a box by rebuilding a name from
  // a stale row would land on a container belonging to nobody or, worse, to somebody else.
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
      boxContainer = boxContainerName(serviceUuid);
      store.updateTenant(slug, { coolifyServiceUuid: serviceUuid, boxContainer, boxReady: false });
      store.recordStep({ slug, step: "service", status: "ok", detail: JSON.stringify({ uuid: serviceUuid, boxContainer, domains: created?.domains ?? [] }) });
      ran.push("service");
    }
    // A row from before this column existed, or one whose service was made by an older run. The
    // name is knowable from the uuid, so fill it in rather than leaving the relay with nothing.
    if (!boxContainer && serviceUuid) {
      boxContainer = boxContainerName(serviceUuid);
      store.updateTenant(slug, { boxContainer });
    }
  } catch (error) { return fail("service", error); }

  // 5. the one environment value the compose refers to. Posted first and PATCHed on the collision,
  // rather than reading the list and deciding: when Coolify creates a service it reads the compose
  // and makes an empty field for every ${VAR} in it, so this key already exists by the time this
  // runs and the POST answers 409 "Environment variable already exists. Use PATCH request to update
  // it." That is what failed the first real tenant build on the R750, 2026-09-07. Re-running this
  // step has to be safe too, because a retry is the normal way out of a half-finished provision.
  //
  // One key, not two. The session key is not here any more: a tenant has no relay of its own to
  // verify tokens with, so the one relay is handed each tenant's derived key over
  // GET /v1/relay/tenants and Coolify's environment store never holds it.
  try {
    if (!done.has("envs")) {
      const envs = [{ key: "TITANBOT_GATEWAY_TOKEN", value: gatewayToken }];
      for (const env of envs) {
        // is_literal, because a generated secret has to reach the container byte for byte and
        // Coolify escapes $ in a value that is not marked literal.
        const body = { key: env.key, value: env.value, is_preview: false, is_literal: true, is_multiline: false, is_shown_once: false };
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

  // 6. the proxy key (PROXY-1). One virtual key for this tenant, metered and revocable, written
  // 0600 into the profile directory beside the gateway token.
  //
  // Recorded as "skipped" rather than "ok" when this server has no proxy, so completedSteps does
  // not count it and the day CP_PROXY_URL is set the next provisioning run actually mints. A
  // failure IS fatal here: a workspace whose agents cannot reach a model is not a workspace, and
  // the retry route picks up at this step with the container and the directories already built.
  try {
    if (!done.has("proxy-key")) {
      const notes = [];
      const answer = await ensureProxyKey(slug, config, { fetchImpl, box: boxContainer ?? "", onNote: (note) => notes.push(note) });
      if (answer.skipped) {
        store.recordStep({ slug, step: "proxy-key", status: "skipped", detail: answer.why });
      } else if (!answer.ok) {
        return fail("proxy-key", new Error(answer.why));
      } else {
        // The alias, the key id and the file. Never the key: this detail is read back by the admin
        // console and by `tenant list`, and the ledger is the one place a secret has never been.
        store.recordStep({
          slug,
          step: "proxy-key",
          status: "ok",
          detail: JSON.stringify({
            alias: answer.record.alias,
            keyId: answer.record.keyId,
            file: paths.proxyKeyFile,
            models: answer.record.models.map((row) => row.id),
            enforced: answer.record.enforced,
            minted: answer.minted,
            ...(notes.length > 0 ? { notes } : {}),
          }),
        });
        ran.push("proxy-key");
      }
    }
  } catch (error) { return fail("proxy-key", error); }

  // No urls step. A tenant has no hostname of its own: everybody signs in at the one console, and a
  // PATCH that put <slug>.titanium.bot on this service would publish a customer's box to the
  // internet with no login page in front of it. The host on the tenant row is the shared console,
  // which is what the session token says and what the relay checks.

  // 7. start. Asynchronous on Coolify's side: it queues the request and answers immediately, which
  // is why the wait below exists at all.
  try {
    if (!done.has("start")) {
      const answer = await client.startService(serviceUuid);
      store.recordStep({ slug, step: "start", status: "ok", detail: JSON.stringify({ message: answer?.message ?? "" }) });
      ran.push("start");
    }
  } catch (error) { return fail("start", error); }

  // 8. ready. Waits for the box to answer and records which way it answered.
  //
  // A timeout here is NOT a failure and never marks the tenant failed: the image is 5.2 GB and a
  // server that does not have it yet takes longer than any wait worth putting a customer through.
  // The step is recorded as "waiting" rather than "ok", so completedSteps does not count it and the
  // next provisioning run waits again instead of assuming.
  let ready = { ready: false, how: "skipped", reason: "the wait was turned off" };
  try {
    if (!done.has("ready")) {
      ready = await waitForBox({
        client,
        uuid: serviceUuid,
        gateway: boxContainer ? `http://${boxContainer}:1340` : "",
        token: gatewayToken,
        probeImpl,
        timeoutMs: readyTimeoutMs,
        intervalMs: readyIntervalMs,
        ...(sleep ? { sleep } : {}),
      });
      store.recordStep({
        slug,
        step: "ready",
        status: ready.ready ? "ok" : "waiting",
        detail: JSON.stringify({ how: ready.how, waitedMs: ready.waitedMs, ...(ready.reason ? { reason: ready.reason } : {}) }),
      });
      if (ready.ready) ran.push("ready");
    } else {
      ready = { ready: true, how: "already", waitedMs: 0 };
    }
  } catch (error) {
    // The wait itself throwing is a bug in this code, not a broken tenant, and it must not lose a
    // workspace that is otherwise built. It is recorded and the run carries on.
    store.recordStep({ slug, step: "ready", status: "waiting", detail: String(error?.message ?? error) });
  }

  store.updateTenant(slug, {
    status: ready.ready ? "running" : "provisioning",
    host,
    boxContainer,
    boxReady: ready.ready,
    lastError: null,
  });
  return {
    ok: true,
    tenant: store.getTenant(slug),
    boxContainer,
    boxReady: ready.ready,
    // The sentence an operator or a customer reads, in words rather than a status word. A box that
    // is still starting is the normal case on a server that has never pulled the image.
    boxNote: ready.ready
      ? "The workspace is up and answering."
      : "The workspace was created and is still starting. It usually takes a few minutes the first time, because the server has to pull a large image.",
    ran,
    steps: store.listSteps(slug),
  };
}
