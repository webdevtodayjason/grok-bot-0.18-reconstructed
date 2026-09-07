#!/usr/bin/env node
// control-plane-coolify.mjs -- the other half of the control plane deploy, run from the Mac.
//
// deploy/r750/control-plane-install.sh makes the tenant root, builds the image and generates the
// two secrets on the R750. This makes the Coolify object that starts that image: one service named
// titanbot-cp, its environment, its address, and a start. Together they replace the twelve manual
// clicks docs/TENANCY.md section 5 used to describe, which is the point: a step done by hand on a
// live server is a step nobody can repeat or review.
//
//   node deploy/r750/control-plane-coolify.mjs --dry-run     # prints the plan, calls nothing
//   node deploy/r750/control-plane-coolify.mjs
//
// It is idempotent. A second run finds the service by name, updates its compose, adds only the
// environment keys that are missing, corrects only the ones whose value changed, re-sets the same
// address, and starts it, or restarts it when it is already up so the settings it just wrote are
// the ones running. Nothing here deletes anything, ever.
//
// ---- what it needs in the environment ----------------------------------------------------------
//
// The two secrets, read off the server into your shell rather than into a file:
//
//   export CP_SESSION_SECRET="$(ssh dell-remote "grep '^CP_SESSION_SECRET=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
//   export CP_ADMIN_TOKEN="$(ssh dell-remote "grep '^CP_ADMIN_TOKEN=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
//
// And the Coolify pair, from wherever you keep them:
//
//   COOLIFY_URL, COOLIFY_API_KEY
//
// None of those four is ever printed. Every line this writes goes through a redactor that replaces
// any of them with <redacted>, so a value cannot reach the terminal even inside an error message
// quoted back from Coolify.
//
// No uuid has to be in your shell. The server is a constant in this file, the project is found by
// its name, and the environment is found inside the project.
//
// ---- where the settings come from --------------------------------------------------------------
//
// From deploy/coolify/control-plane.compose.yml, not from a list in here. That file is what an
// operator reads and reviews; a second copy of CP_CLOUDFLARE_RANGES in this script would be a
// second copy to forget. Every `KEY: value` in its environment block becomes an environment record
// on the service. A value written as ${NAME} is taken from your shell or worked out here instead,
// and one that is neither stops the run by name before anything is created.
//
// Two deliberate differences from that file:
//
//   CP_ALLOW_NEW_TENANTS      "1" here, "0" in the file. The file is the safe default for anyone
//                             who pastes it by hand; this script is run by the operator standing
//                             the service up after the relay reads its settings out of each
//                             tenant's own state directory, which is the condition that gate is
//                             about. Set CP_ALLOW_NEW_TENANTS=0 in your shell to keep it off.
//   COOLIFY_ENVIRONMENT_UUID  not in the file at all. Coolify's openapi lists it in the required
//                             set for POST /services while its own description says the name will
//                             do, so both are sent and this one is looked up.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE_PATH = process.env.CP_COMPOSE_PATH
  ? path.resolve(process.env.CP_COMPOSE_PATH)
  : path.join(repoRoot, "deploy", "coolify", "control-plane.compose.yml");

// The Coolify project every tenant service already lives in, resolved by name because a uuid in a
// script is a uuid nobody can check. COOLIFY_PROJECT_UUID in your shell skips the lookup.
const PROJECT_NAME = process.env.COOLIFY_PROJECT_NAME ?? "Titanium Computing";
// The R750. A uuid in the source rather than a name, because there is exactly one server and a
// server's name in Coolify is not unique the way a project's is.
const SERVER_UUID = process.env.COOLIFY_SERVER_UUID ?? "zl2ti5llrtpx83918j8arb9f";
const ENVIRONMENT_NAME = process.env.COOLIFY_ENVIRONMENT_NAME ?? "production";
// The Coolify resource name, which is not the compose's service name. This is what GET /services
// matches on and what shows in the Coolify sidebar.
const RESOURCE_NAME = process.env.CP_RESOURCE_NAME ?? "titanbot-cp";
// The address. The :7790 is the CONTAINER port for the proxy, not a published one; the public url
// is plain https://api.titanium.bot.
const PUBLIC_HOST = process.env.CP_PUBLIC_HOST ?? "api.titanium.bot";
const CONTAINER_PORT = process.env.CP_CONTAINER_PORT ?? "7790";

const DRY_RUN = process.argv.includes("--dry-run");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write([
    "control-plane-coolify.mjs -- create or update the titanbot-cp Coolify service.",
    "",
    "  node deploy/r750/control-plane-coolify.mjs --dry-run     print the plan, call nothing",
    "  node deploy/r750/control-plane-coolify.mjs               do it",
    "",
    "Needs in the environment: COOLIFY_URL, COOLIFY_API_KEY, CP_SESSION_SECRET, CP_ADMIN_TOKEN.",
    "The two secrets are in /home/sem/titanbot/cp.env on the R750, put there by",
    "deploy/r750/control-plane-install.sh. The header of this file has the two ssh lines that read",
    "them into your shell without writing them to a file here.",
    "",
    "Everything else comes out of deploy/coolify/control-plane.compose.yml. Override any of it by",
    "setting the same name in your shell.",
    "",
    "Exit 0 done, 1 a call failed, 2 the environment is not set up.",
    "",
  ].join("\n"));
  process.exit(0);
}

// ---- printing, with the secrets taken out ------------------------------------------------------
// Filled in before the first line is written. A secret shorter than eight characters is not
// redacted, because a short string would blank out unrelated text and make the output a lie in the
// other direction; a real one here is 48 or 64 hex characters.
const secrets = new Set();
function redact(line) {
  let text = String(line);
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join("<redacted>");
  }
  return text;
}
const out = (line = "") => process.stdout.write(`${redact(line)}\n`);
const say = (line) => out(`  ${line}`);
const step = (line) => out(`\n== ${line}`);
function die(message, code = 1) {
  process.stderr.write(`${redact(`\nFAILED: ${message}`)}\n`);
  process.exit(code);
}

// ---- reading the compose -----------------------------------------------------------------------
// A targeted reader, not a YAML parser: this file has one service, its environment block is flat,
// and the two shapes that appear in it are `KEY: value` and `KEY: "value"`. Anything else in there
// would be a change worth noticing rather than a change to parse, so an unexpected line is left
// alone and never becomes a half-read environment record.

export function composeServiceName(text) {
  const lines = String(text).split("\n");
  const at = lines.findIndex((line) => line.trimEnd() === "services:");
  if (at === -1) throw new Error("the compose has no services: block");
  for (const line of lines.slice(at + 1)) {
    const match = /^ {2}([A-Za-z0-9][A-Za-z0-9_.-]*):\s*$/.exec(line);
    if (match) return match[1];
    if (/^\S/.test(line)) break;
  }
  throw new Error("the compose has a services: block with no service in it");
}

export function composeEnvironment(text) {
  const lines = String(text).split("\n");
  const at = lines.findIndex((line) => /^ {4}environment:\s*$/.test(line));
  if (at === -1) throw new Error("the compose has no environment: block on its service");
  const found = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // Anything not indented six spaces ends the block: the next key on the service, or the next
    // service, or the end of the file.
    if (!/^ {6}\S/.test(line)) break;
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    found.push([match[1], value]);
  }
  if (found.length === 0) throw new Error("the compose's environment block is empty");
  return found;
}

// The compose value, your shell, or something this script worked out for itself. Returns the
// resolved list and the names of everything that had to come from the shell and did not.
//
// `supplied` is that third source, and it is what keeps the uuids out of your shell: the server
// uuid is a constant in this file, the project uuid is looked up from the project's name, and the
// environment uuid is looked up from the project. All three read as ${VAR} in the compose, because
// the compose is also a thing an operator can paste by hand.
export function resolveEnvironment(entries, env, supplied = {}) {
  const resolved = [];
  const missing = [];
  for (const [key, raw] of entries) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
    let value;
    if (reference) {
      value = env[reference[1]] || supplied[reference[1]] || "";
      if (value === "") { missing.push(reference[1]); continue; }
    } else {
      // A literal in the file, which your shell may still override. This is how
      // CP_ALLOW_NEW_TENANTS gets to be 1 without editing the file everybody reads.
      value = env[key] ?? supplied[key] ?? raw;
    }
    resolved.push({ key, value });
  }
  return { resolved, missing };
}

// Which of them must never reach the terminal. Everything else is a path, a domain, a port or a
// list of networks, and printing those is how an operator checks the plan before it runs.
const SECRET_KEYS = new Set(["CP_SESSION_SECRET", "CP_ADMIN_TOKEN", "COOLIFY_API_KEY", "COOLIFY_URL", "CP_COOLIFY_URL"]);

// ---- talking to Coolify ------------------------------------------------------------------------
// The same shape as cp/provision.mjs's client, deliberately: same base handling, same bearer in the
// one header, same error carrying the status and Coolify's message and never the request. Not
// imported from there because that module loads a whole config out of the environment, and this
// script is the thing that puts that config in place.

function apiBase(url) {
  const base = String(url ?? "").replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

export function createClient({ url, apiKey, fetchImpl = globalThis.fetch }) {
  const base = apiBase(url);
  async function call(method, pathname, options = {}) {
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const init = { method, headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } };
    if (options.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response;
    try { response = await fetchImpl(`${base}${pathname}${query}`, init); }
    catch (cause) { throw new Error(`could not reach Coolify at ${base}: ${String(cause?.message ?? cause)}`); }
    const raw = await response.text();
    let parsed = null;
    if (raw.length > 0) { try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 400) }; } }
    if (!response.ok) {
      const error = new Error(`Coolify answered ${response.status} to ${method} ${pathname}: ${String(parsed?.message ?? "no message")}`);
      error.status = response.status;
      throw error;
    }
    return parsed;
  }
  return { base, call };
}

// Coolify answers a bare array on some list routes and {data: [...]} on others, and neither is
// worth guessing about. Anything else reads as empty rather than as a crash.
const asList = (answer) => (Array.isArray(answer) ? answer : Array.isArray(answer?.data) ? answer.data : []);

async function resolveProject(client, env) {
  if (env.COOLIFY_PROJECT_UUID) return { uuid: env.COOLIFY_PROJECT_UUID, from: "your shell" };
  const projects = asList(await client.call("GET", "/projects"));
  const match = projects.find((project) => String(project?.name ?? "") === PROJECT_NAME);
  if (!match?.uuid) {
    throw new Error(`no Coolify project is named ${PROJECT_NAME}. Check the name in Coolify, or set COOLIFY_PROJECT_UUID.`);
  }
  return { uuid: String(match.uuid), from: `the project named ${PROJECT_NAME}` };
}

// The environment uuid is optional in Coolify's own description of POST /services and required by
// its schema, so it is looked up rather than argued with. Two shapes have been seen: the project
// object carrying an environments array, and a sub-route. Neither is trusted to exist, and a lookup
// that finds nothing is not fatal, because environment_name alone is what tenant creates already
// use today.
async function resolveEnvironmentUuid(client, projectUuid, env) {
  if (env.COOLIFY_ENVIRONMENT_UUID) return { uuid: env.COOLIFY_ENVIRONMENT_UUID, from: "your shell" };
  const pick = (list) => list.find((one) => String(one?.name ?? "") === ENVIRONMENT_NAME)?.uuid;
  try {
    const project = await client.call("GET", `/projects/${projectUuid}`);
    const uuid = pick(asList(project?.environments));
    if (uuid) return { uuid: String(uuid), from: "the project's environments list" };
  } catch { /* fall through to the sub-route */ }
  try {
    const uuid = pick(asList(await client.call("GET", `/projects/${projectUuid}/environments`)));
    if (uuid) return { uuid: String(uuid), from: "GET /projects/{uuid}/environments" };
  } catch { /* neither shape answered, and that is allowed */ }
  return { uuid: "", from: `not found, so environment_name ${ENVIRONMENT_NAME} is sent on its own` };
}

async function findService(client) {
  const services = asList(await client.call("GET", "/services"));
  const match = services.find((service) => String(service?.name ?? "") === RESOURCE_NAME);
  return match?.uuid ? String(match.uuid) : null;
}

// ---- the run -----------------------------------------------------------------------------------

async function main() {
  const env = process.env;

  // Into the redactor before a single line is written.
  for (const name of SECRET_KEYS) if (env[name]) secrets.add(env[name]);

  let composeText;
  try { composeText = readFileSync(COMPOSE_PATH, "utf8"); }
  catch (error) { return die(`could not read ${COMPOSE_PATH}: ${String(error?.message ?? error)}`, 2); }

  let serviceName;
  let entries;
  try {
    serviceName = composeServiceName(composeText);
    entries = composeEnvironment(composeText);
  } catch (error) { return die(`${COMPOSE_PATH} is not the shape this expects: ${String(error?.message ?? error)}`, 2); }

  if (!env.COOLIFY_URL || !env.COOLIFY_API_KEY) {
    return die("COOLIFY_URL and COOLIFY_API_KEY have to be set. Those two are yours, not the R750's.", 2);
  }

  const url = `https://${PUBLIC_HOST}:${CONTAINER_PORT}`;
  const composeBase64 = Buffer.from(composeText, "utf8").toString("base64");

  out(`control plane -> Coolify${DRY_RUN ? "   (dry run: nothing below is called)" : ""}`);
  say(`compose      ${path.relative(repoRoot, COMPOSE_PATH)}, ${composeText.length} bytes`);
  say(`service      ${RESOURCE_NAME} in project ${PROJECT_NAME}, environment ${ENVIRONMENT_NAME}`);
  say(`address      ${url}   (the :${CONTAINER_PORT} is the container port; the public url is https://${PUBLIC_HOST})`);

  // Resolved first, because three of the compose's ${VAR} references are these and the operator
  // should not have to carry a uuid in their shell to run this.
  const client = DRY_RUN ? null : createClient({ url: env.COOLIFY_URL, apiKey: env.COOLIFY_API_KEY });
  step("where it goes");
  let project = { uuid: env.COOLIFY_PROJECT_UUID ?? "", from: "your shell" };
  let environment = { uuid: env.COOLIFY_ENVIRONMENT_UUID ?? "", from: "your shell" };
  if (DRY_RUN) {
    if (!project.uuid) project = { uuid: "(looked up at run time)", from: `GET /projects, matched on the name ${PROJECT_NAME}` };
    if (!environment.uuid) environment = { uuid: "(looked up at run time)", from: `inside that project, matched on the name ${ENVIRONMENT_NAME}` };
  } else {
    project = await resolveProject(client, env);
    environment = await resolveEnvironmentUuid(client, project.uuid, env);
  }
  say(`project      ${project.uuid} (${project.from})`);
  say(`environment  ${environment.uuid || "-"} (${environment.from})`);
  say(`server       ${SERVER_UUID}`);

  const { resolved, missing } = resolveEnvironment(entries, env, {
    CP_ALLOW_NEW_TENANTS: "1",
    COOLIFY_SERVER_UUID: SERVER_UUID,
    COOLIFY_PROJECT_UUID: project.uuid,
  });
  for (const one of resolved) if (SECRET_KEYS.has(one.key)) secrets.add(one.value);

  if (missing.length > 0) {
    return die([
      `these are not set in your shell and the compose expects them: ${missing.join(", ")}`,
      "",
      "  CP_SESSION_SECRET and CP_ADMIN_TOKEN are in /home/sem/titanbot/cp.env on the R750, written",
      "  there by deploy/r750/control-plane-install.sh. Read them into your shell rather than into a",
      "  file, and the header of this script has the two ssh lines that do it.",
      "",
      "  COOLIFY_URL and COOLIFY_API_KEY are your own.",
      "",
      "  CP_RELAY_PEERS is the server's own outbound address, because every customer's sign-in",
      "  reaches the control plane from it. On the server: curl -s https://api.ipify.org, then",
      "  export CP_RELAY_PEERS=<that address>/32 here. Without it the login lockout counts every",
      "  customer on every instance in one bucket.",
    ].join("\n"), 2);
  }

  // The environment uuid is not in the compose, so it is appended rather than resolved. In a dry
  // run there is no value to append yet, and the plan below says where it comes from.
  const willSet = environment.uuid && !DRY_RUN
    ? [...resolved, { key: "COOLIFY_ENVIRONMENT_UUID", value: environment.uuid }]
    : resolved;

  step(`the environment it will set, ${willSet.length} keys`);
  for (const one of willSet) {
    const shown = SECRET_KEYS.has(one.key) ? `(set, ${one.value.length} characters, not printed)` : one.value;
    say(`${one.key.padEnd(26)}${shown}`);
  }

  if (DRY_RUN) {
    step("the plan, in order");
    say("resolve  GET    /projects                       the project's uuid, matched on its name");
    say("resolve  GET    /projects/{uuid}                the environment's uuid, matched on its name");
    say(`look     GET    /services                       is there already one named ${RESOURCE_NAME}`);
    say("create   POST   /services                       name, project, environment, server, compose base64");
    say("   or, when it is already there");
    say("update   PATCH  /services/{uuid}                compose base64");
    say("envs     GET    /services/{uuid}/envs           what is set on it now");
    say("envs     POST   /services/{uuid}/envs           once per key that is missing");
    say("envs     PATCH  /services/{uuid}/envs           once per key whose value is different");
    say("envs     +1                                     COOLIFY_ENVIRONMENT_UUID, once it is known");
    say(`urls     PATCH  /services/{uuid}                urls[{name: ${serviceName}, url: ${url}}]`);
    say("start    POST   /services/{uuid}/start          queued by Coolify, not immediate");
    say("     or, when it is already up");
    say("restart  POST   /services/{uuid}/restart        so the settings above are the ones running");
    out("\nnothing was called. Run it again without --dry-run.");
    return 0;
  }

  step("the service");
  let serviceUuid = await findService(client);
  if (serviceUuid) {
    say(`found ${RESOURCE_NAME} at ${serviceUuid}`);
    await client.call("PATCH", `/services/${serviceUuid}`, { body: { docker_compose_raw: composeBase64 } });
    say("compose updated");
  } else {
    const body = {
      name: RESOURCE_NAME,
      description: "The control plane: accounts, tenants and sessions for titanium.bot",
      project_uuid: project.uuid,
      environment_name: ENVIRONMENT_NAME,
      server_uuid: SERVER_UUID,
      instant_deploy: false,
      docker_compose_raw: composeBase64,
    };
    if (environment.uuid) body.environment_uuid = environment.uuid;
    const created = await client.call("POST", "/services", { body });
    serviceUuid = String(created?.uuid ?? "");
    if (!serviceUuid) throw new Error("Coolify created the service but did not answer with its uuid");
    say(`created ${RESOURCE_NAME} at ${serviceUuid}`);
  }

  step("the environment");
  // Whatever is on the service now, so a second run is quiet instead of rewriting every key.
  let current = new Map();
  try {
    for (const one of asList(await client.call("GET", `/services/${serviceUuid}/envs`))) {
      if (one?.key) current.set(String(one.key), String(one.value ?? ""));
    }
    say(`${current.size} keys are set on it now`);
  } catch (error) {
    say(`could not read the current keys (${String(error?.message ?? error)}), so every key is treated as new`);
    current = new Map();
  }

  let added = 0;
  let corrected = 0;
  let same = 0;
  for (const one of willSet) {
    // is_literal, because a generated secret has to reach the container byte for byte and Coolify
    // escapes $ in a value that is not marked literal.
    const body = { key: one.key, value: one.value, is_preview: false, is_literal: true, is_multiline: false, is_shown_once: false };
    if (!current.has(one.key)) {
      await client.call("POST", `/services/${serviceUuid}/envs`, { body });
      added += 1;
    } else if (current.get(one.key) !== one.value) {
      await client.call("PATCH", `/services/${serviceUuid}/envs`, { body });
      corrected += 1;
    } else {
      same += 1;
    }
  }
  say(`${added} added, ${corrected} corrected, ${same} already right`);

  step("the address");
  // The service-level urls PATCH is what works on Coolify 4.0.0; the per-component PATCH answers
  // Not found (measured on this server for DOMAIN-1). The name is the compose's service name, not
  // the Coolify resource name, because a url is attached to a container.
  await client.call("PATCH", `/services/${serviceUuid}`, { body: { urls: [{ name: serviceName, url }] } });
  say(`${serviceName} -> ${url}`);

  step("start");
  // A start and a restart are different calls, and Coolify answers 400 "Service is already
  // running." to the first one rather than treating it as a no-op. That matters more than a tidy
  // exit code: the compose and the environment were both just written, and a service that is
  // already up is still running the old ones until something recreates its containers. So a
  // running service gets a restart, which is the call that picks the new settings up.
  let started;
  try {
    started = await client.call("POST", `/services/${serviceUuid}/start`);
    say(String(started?.message ?? "queued"));
  } catch (error) {
    if (!/already running/i.test(String(error?.message ?? ""))) throw error;
    say("already running, so restarting it instead to pick up the compose and the environment");
    started = await client.call("POST", `/services/${serviceUuid}/restart`);
    say(String(started?.message ?? "queued"));
  }

  out("\n== done");
  say(`service ${serviceUuid}`);
  say("Coolify queues a start rather than doing it, so give it a minute and then:");
  say(`  curl -s https://${PUBLIC_HOST}/v1/health`);
  say("Health needs no bearer and answers counts only.");
  return 0;
}

// Only when this file is the thing that was run. The readers above are exported so a test can hold
// the compose parsing to the real file without starting a run, and an import that started one would
// make that impossible.
const runDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) {
  main().then((code) => process.exit(code ?? 0)).catch((error) => die(String(error?.message ?? error)));
}
