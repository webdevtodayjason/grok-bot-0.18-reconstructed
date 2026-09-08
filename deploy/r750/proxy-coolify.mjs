#!/usr/bin/env node
// proxy-coolify.mjs -- the other half of the proxy deploy, run FROM THE MAC (PROXY-1).
//
// deploy/r750/proxy-install.sh makes the two directories, copies config.yaml in and generates the
// three secrets on the R750. This makes the Coolify object that runs the image: one service named
// titanbot-proxy, its compose, and its environment. Together they replace a page of clicks in a UI,
// which is the point: a step done by hand on a live server is a step nobody can repeat or review.
//
//   node deploy/r750/proxy-coolify.mjs --dry-run     # prints the plan, calls nothing
//   node deploy/r750/proxy-coolify.mjs
//
// It is idempotent. A second run finds the service by name, updates its compose, adds only the
// environment keys that are missing and corrects only the ones whose value changed. Nothing here
// deletes anything, and nothing here starts or restarts the service: the proxy is a single point of
// failure for every tenant's inference once the migration has run, so the restart is a decision an
// operator makes in Coolify with their eyes on it, not a side effect of running a script.
//
// IT IS NEVER SHIPPED TO THE SERVER. deploy/r750/sync.sh deliberately does not carry this file, for
// the same reason it does not carry control-plane-coolify.mjs: it holds the Coolify api key in its
// environment while it runs, and that key can delete every resource on the machine.
//
// ---- what it needs -------------------------------------------------------------------------------
//
// The Coolify pair, from wherever you keep them:
//
//   COOLIFY_URL, COOLIFY_API_KEY
//
// The three secrets, read off the server into your shell rather than into a file:
//
//   export PROXY_MASTER_KEY="$(ssh dell-remote "grep '^PROXY_MASTER_KEY=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
//   export PROXY_SALT_KEY="$(ssh dell-remote "grep '^PROXY_SALT_KEY=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
//   export PROXY_DB_PASSWORD="$(ssh dell-remote "grep '^PROXY_DB_PASSWORD=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
//
// ...or let this script read them itself, which is the default: with --read-secrets (on unless you
// pass --no-read-secrets) it runs exactly those three ssh lines for you and holds the values in
// memory only.
//
// And the operator's provider subscriptions, loaded BY EXACT NAME from ~/.api_keys:
//
//   PROXY_ZAI_KEY_1       <- ZAI_API_KEY
//   PROXY_ZAI_KEY_2       <- ZAI_API_KEY_JASON
//   PROXY_MINIMAX_KEY     <- MINIMAX_API_KEY
//   PROXY_QWEN_KEY        <- QWEN_API_KEY          (measured 2026-09-08: not in ~/.api_keys)
//   PROXY_TINYFISH_KEY_1  <- TINYFISH_API_KEY      (measured 2026-09-08: not in ~/.api_keys)
//   PROXY_TINYFISH_KEY_2  <- TINYFISH_API_KEY_2    (measured 2026-09-08: not in ~/.api_keys)
//
// ---- THESE SIX ARE THE FRESH-INSTALL BOOTSTRAP ONLY, AS OF PROVIDERS-1 --------------------------
// Providers, their keys, the pools those keys form and the plan models customers run on live in the
// proxy's own database and are managed live from the Providers panel at api.titanium.bot/admin. What
// this script sets is what `node cp/cli.mjs proxy seed` reads ONCE on a fresh install, and nothing
// after that. On a running install, adding a key, rolling one and taking one out are done from the
// panel, take effect on the next request, and do not come back through here. Re-running this script
// against an install that has already been seeded changes an environment field nothing reads any
// more, which is the quiet kind of wrong: if a key needs to change, change it in the panel.
//
// A name that is not in that file is SKIPPED and NAMED in the output. It is never guessed at, never
// looked for in another file, and never posted as an empty value -- an empty provider key is a model
// that starts cleanly and then 401s on a customer's turn, which is the worst place to find out. Any
// of these six can also come straight from your shell under its PROXY_ name, which is how a key that
// lives somewhere other than ~/.api_keys (TinyFish's does) gets in without this script going looking
// for it.
//
// None of the nine values is ever printed. Every line goes through a redactor, so a value cannot
// reach the terminal even inside an error message quoted back from Coolify.
//
// ---- where the settings come from ----------------------------------------------------------------
//
// From deploy/coolify/proxy.compose.yml, not from a list in here, for the same reason
// control-plane-coolify.mjs reads its own compose: that file is what an operator reviews, and a
// second copy of the environment in a script is a second copy to forget.
//
// One rule that file's header states and this script is written against: Coolify names an
// environment field after what is INSIDE the braces, not after the key on the left. So a line like
// `LITELLM_MASTER_KEY: ${PROXY_MASTER_KEY}` becomes a field named PROXY_MASTER_KEY, and that is the
// name posted here. A literal value with no braces is posted under its own key, so a shell override
// still works the way it does for the control plane.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE_PATH = process.env.PROXY_COMPOSE_PATH
  ? path.resolve(process.env.PROXY_COMPOSE_PATH)
  : path.join(repoRoot, "deploy", "coolify", "proxy.compose.yml");

const PROJECT_NAME = process.env.COOLIFY_PROJECT_NAME ?? "Titanium Computing";
// The R750. A uuid in the source rather than a name, because there is exactly one server and a
// server's name in Coolify is not unique the way a project's is.
const SERVER_UUID = process.env.COOLIFY_SERVER_UUID ?? "zl2ti5llrtpx83918j8arb9f";
const ENVIRONMENT_NAME = process.env.COOLIFY_ENVIRONMENT_NAME ?? "production";
// The Coolify resource name, which is not a compose service name. This is what GET /services
// matches on and what shows in the Coolify sidebar.
const RESOURCE_NAME = process.env.PROXY_RESOURCE_NAME ?? "titanbot-proxy";
// The ssh destination the three secrets are read from, and the file they are in.
const SSH_HOST = process.env.TITANBOT_HOST ?? "dell-remote";
const CP_ENV_PATH = process.env.TITANBOT_CP_ENV ?? "/home/sem/titanbot/cp.env";
// Where the operator's provider subscriptions are. Read by exact name, never scanned for anything
// that looks like a key.
const API_KEYS_PATH = process.env.TITANBOT_API_KEYS ?? path.join(homedir(), ".api_keys");

const DRY_RUN = process.argv.includes("--dry-run");
const READ_SECRETS = !process.argv.includes("--no-read-secrets");

// PROXY_ name -> the exact name it is loaded from in ~/.api_keys. Extend BOTH this and the compose
// when a subscription is added to a pool; docs/PROXY.md walks it.
const API_KEY_NAMES = {
  PROXY_ZAI_KEY_1: "ZAI_API_KEY",
  PROXY_ZAI_KEY_2: "ZAI_API_KEY_JASON",
  PROXY_MINIMAX_KEY: "MINIMAX_API_KEY",
  PROXY_QWEN_KEY: "QWEN_API_KEY",
  PROXY_TINYFISH_KEY_1: "TINYFISH_API_KEY",
  PROXY_TINYFISH_KEY_2: "TINYFISH_API_KEY_2",
};

// The three read off the server. Names only here; the values are fetched at run time.
const SERVER_SECRET_NAMES = ["PROXY_MASTER_KEY", "PROXY_SALT_KEY", "PROXY_DB_PASSWORD"];

// Which values must never reach the terminal. Everything else is a port, a mode or a log level, and
// printing those is how an operator checks the plan before it runs.
const SECRET_KEYS = new Set([
  ...SERVER_SECRET_NAMES,
  ...Object.keys(API_KEY_NAMES),
  "PROXY_DATABASE_URL",
  "COOLIFY_API_KEY",
  "COOLIFY_URL",
]);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write([
    "proxy-coolify.mjs -- create or update the titanbot-proxy Coolify service.",
    "",
    "  node deploy/r750/proxy-coolify.mjs --dry-run          print the plan, call nothing",
    "  node deploy/r750/proxy-coolify.mjs                    do it",
    "  node deploy/r750/proxy-coolify.mjs --no-read-secrets  take the three server secrets from",
    "                                                        your shell instead of over ssh",
    "",
    "Needs in the environment: COOLIFY_URL and COOLIFY_API_KEY. The three PROXY_ secrets are read",
    `over ssh from ${CP_ENV_PATH} unless --no-read-secrets is given. The provider keys are loaded`,
    `by exact name from ${API_KEYS_PATH}, and any of them may be set in your shell instead.`,
    "",
    "It never starts or restarts the service. Deploy it in Coolify yourself, with your eyes on it.",
    "",
    "Exit 0 done, 1 a call failed, 2 the environment is not set up.",
    "",
  ].join("\n"));
  process.exit(0);
}

// ---- printing, with the secrets taken out --------------------------------------------------------
// A secret shorter than eight characters is not redacted, because a short string would blank out
// unrelated text and make the output a lie in the other direction.
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

// How a key is reported: by name, length and the first twelve of its sha256, and never by value.
// That is enough to tell two keys apart, enough to match one against what a box holds, and not
// enough to use.
export function fingerprint(value) {
  const text = String(value ?? "");
  return `${text.length} characters, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

// ---- reading the compose -------------------------------------------------------------------------
// A targeted reader, not a YAML parser, for the same reason control-plane-coolify.mjs has one: this
// file's environment blocks are flat, the shapes in them are `KEY: value` and `KEY: "value"`, and
// anything else would be a change worth noticing rather than a change to parse.
//
// Unlike the control plane's, this compose has TWO services with environment blocks, and both have
// to be read: the database's password is declared on the database.

export function composeServiceNames(text) {
  const lines = String(text).split("\n");
  const at = lines.findIndex((line) => line.trimEnd() === "services:");
  if (at === -1) throw new Error("the compose has no services: block");
  const names = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line) && line.trim() !== "") break;
    const match = /^ {2}([A-Za-z0-9][A-Za-z0-9_.-]*):\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  if (names.length === 0) throw new Error("the compose has a services: block with no service in it");
  return names;
}

// Every `KEY: value` under every `environment:` block, in file order, deduplicated by key. A key
// that appears twice with two different values is a mistake worth stopping on rather than a merge to
// perform quietly.
export function composeEnvironment(text) {
  const lines = String(text).split("\n");
  const found = [];
  const seen = new Map();
  let inBlock = false;
  for (const line of lines) {
    if (/^ {4}environment:\s*$/.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^ {6}\S/.test(line)) { inBlock = false; continue; }
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (seen.has(match[1])) {
      if (seen.get(match[1]) !== value) {
        throw new Error(`${match[1]} is declared twice in the compose with two different values`);
      }
      continue;
    }
    seen.set(match[1], value);
    found.push([match[1], value]);
  }
  if (found.length === 0) throw new Error("the compose has no environment block on any service");
  return found;
}

// Turn the compose's entries into the environment records Coolify has to hold.
//
// A `${NAME}` reference becomes a record named NAME, because that is the field Coolify's parser
// makes from the braces. A literal becomes a record under its own key, so a shell override still
// works. A reference with no value anywhere is SKIPPED and reported: for a provider key that is the
// right answer (the model simply is not served), and for anything in `required` it is fatal.
export function resolveEnvironment(entries, sources, required = []) {
  const resolved = [];
  const skipped = [];
  const missing = [];
  const seen = new Set();
  for (const [key, raw] of entries) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
    const name = reference ? reference[1] : key;
    if (seen.has(name)) continue;
    let value;
    if (reference) {
      value = sources[name] ?? "";
      if (value === "") {
        (required.includes(name) ? missing : skipped).push(name);
        continue;
      }
    } else {
      // A literal in the compose. Unlike control-plane-coolify.mjs, an environment variable of the
      // same name does NOT override one here, and that is deliberate: the literals in this compose
      // are STORE_MODEL_IN_DB, LITELLM_MODE and LITELLM_LOG, and a stray LITELLM_LOG in somebody's
      // shell silently turning per-request logging on for every customer is not a convenience.
      // Changing one of those is an edit to the compose, which is a thing a reviewer can see.
      value = sources[key] ?? raw;
    }
    seen.add(name);
    resolved.push({ key: name, value });
  }
  return { resolved, skipped, missing };
}

// ---- talking to Coolify --------------------------------------------------------------------------
// The same shape as control-plane-coolify.mjs's client: same base handling, same bearer in the one
// header, same error carrying the status and Coolify's message and never the request.

function apiBase(url) {
  const base = String(url ?? "").replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

export function createClient({ url, apiKey, fetchImpl = globalThis.fetch }) {
  const base = apiBase(url);
  async function call(method, pathname, options = {}) {
    const init = { method, headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } };
    if (options.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response;
    try { response = await fetchImpl(`${base}${pathname}`, init); }
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

const asList = (answer) => (Array.isArray(answer) ? answer : Array.isArray(answer?.data) ? answer.data : []);

// ---- the operator's own files --------------------------------------------------------------------

// KEY=value lines, read by EXACT name. It does not scan for anything key-shaped, it does not follow
// an export, and a name that is not there simply is not there.
export function readNamedValues(text, names) {
  const found = {};
  for (const line of String(text).split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    if (!names.includes(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value !== "") found[match[1]] = value;
  }
  return found;
}

// The three the installer generated, read over ssh and held in memory only. BatchMode so a missing
// key fails fast instead of hanging on a password prompt.
function readServerSecrets() {
  const names = SERVER_SECRET_NAMES.join("|");
  const command = `grep -E '^(${names})=' ${CP_ENV_PATH} 2>/dev/null || true`;
  let text;
  try {
    text = execFileSync("ssh", ["-o", "BatchMode=yes", SSH_HOST, command], { encoding: "utf8", timeout: 30_000 });
  } catch (error) {
    throw new Error(`could not read ${CP_ENV_PATH} on ${SSH_HOST}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  return readNamedValues(text, SERVER_SECRET_NAMES);
}

// ---- the run ---------------------------------------------------------------------------------------

async function main() {
  const env = process.env;
  for (const name of ["COOLIFY_API_KEY", "COOLIFY_URL"]) if (env[name]) secrets.add(env[name]);

  let composeText;
  try { composeText = readFileSync(COMPOSE_PATH, "utf8"); }
  catch (error) { return die(`could not read ${COMPOSE_PATH}: ${String(error?.message ?? error)}`, 2); }

  let serviceNames;
  let entries;
  try {
    serviceNames = composeServiceNames(composeText);
    entries = composeEnvironment(composeText);
  } catch (error) { return die(`${COMPOSE_PATH} is not the shape this expects: ${String(error?.message ?? error)}`, 2); }

  if (!env.COOLIFY_URL || !env.COOLIFY_API_KEY) {
    return die("COOLIFY_URL and COOLIFY_API_KEY have to be set. Those two are yours, not the R750's.", 2);
  }

  out(`proxy -> Coolify${DRY_RUN ? "   (dry run: nothing below is called)" : ""}`);
  say(`compose      ${path.relative(repoRoot, COMPOSE_PATH)}, ${composeText.length} bytes`);
  say(`services     ${serviceNames.join(", ")}`);
  say(`service      ${RESOURCE_NAME} in project ${PROJECT_NAME}, environment ${ENVIRONMENT_NAME}`);
  say("address      none. No port is published and no Domain is set, so nothing outside the bridge reaches it.");

  // ---- the three from the server ---------------------------------------------------------------
  step("the three secrets the installer generated");
  const sources = {};
  const fromShell = SERVER_SECRET_NAMES.filter((name) => env[name]);
  for (const name of fromShell) sources[name] = env[name];
  if (READ_SECRETS && fromShell.length < SERVER_SECRET_NAMES.length) {
    try {
      const read = readServerSecrets();
      for (const [name, value] of Object.entries(read)) if (!sources[name]) sources[name] = value;
      say(`read from ${CP_ENV_PATH} on ${SSH_HOST}`);
    } catch (error) {
      say(String(error?.message ?? error));
    }
  }
  for (const name of SERVER_SECRET_NAMES) {
    if (sources[name]) { secrets.add(sources[name]); say(`${name.padEnd(20)} ${fingerprint(sources[name])}`); }
    else say(`${name.padEnd(20)} NOT FOUND`);
  }

  // The database url is assembled here rather than interpolated in the compose, because a ${...}
  // inside a longer string is the shape Coolify's field-naming rule reads worst.
  if (sources.PROXY_DB_PASSWORD) {
    sources.PROXY_DATABASE_URL = `postgresql://litellm:${encodeURIComponent(sources.PROXY_DB_PASSWORD)}@titanbot-proxy-db:5432/litellm`;
    secrets.add(sources.PROXY_DATABASE_URL);
    say(`PROXY_DATABASE_URL   assembled from PROXY_DB_PASSWORD, host titanbot-proxy-db, database litellm`);
  }

  // ---- the operator's provider subscriptions ----------------------------------------------------
  step("the operator's provider keys");
  let apiKeysText = "";
  if (existsSync(API_KEYS_PATH)) {
    try { apiKeysText = readFileSync(API_KEYS_PATH, "utf8"); }
    catch (error) { say(`could not read ${API_KEYS_PATH}: ${String(error?.message ?? error)}`); }
  } else {
    say(`${API_KEYS_PATH} is not on this machine, so every provider key has to come from your shell`);
  }
  const wanted = Object.values(API_KEY_NAMES);
  const fromFile = readNamedValues(apiKeysText, wanted);
  const absent = [];
  for (const [proxyName, fileName] of Object.entries(API_KEY_NAMES)) {
    // The shell wins, which is how a key that lives somewhere other than ~/.api_keys gets in
    // without this script going looking for it.
    const value = env[proxyName] || fromFile[fileName] || "";
    if (value === "") { absent.push(`${proxyName} (looked for ${fileName})`); continue; }
    sources[proxyName] = value;
    secrets.add(value);
    say(`${proxyName.padEnd(20)} from ${env[proxyName] ? "your shell" : `${fileName} in ${path.basename(API_KEYS_PATH)}`}, ${fingerprint(value)}`);
  }
  if (absent.length > 0) {
    say("");
    say("NOT FOUND, so these are not set on the service and the models behind them are not served:");
    for (const one of absent) say(`  ${one}`);
    say("Nothing was guessed at and no other file was read. Set the PROXY_ name in your shell to");
    say("supply one from somewhere else, or add the name above to ~/.api_keys.");
  }
  // PROVIDERS-1. Said here rather than only in the header, because this is the output an operator
  // reads at the moment they are thinking about a key.
  say("");
  say("These names are the FRESH-INSTALL BOOTSTRAP only. `node cp/cli.mjs proxy seed` reads them once");
  say("into the proxy's database; after that, a live key is added, rolled and removed from the");
  say("Providers panel at api.titanium.bot/admin, takes effect on the next request, and never comes");
  say("back through here. Changing one of these on a seeded install changes a field nothing reads.");

  // ---- what will be set --------------------------------------------------------------------------
  // The four the service cannot run without. Everything else may legitimately be absent.
  const REQUIRED = ["PROXY_MASTER_KEY", "PROXY_SALT_KEY", "PROXY_DATABASE_URL", "PROXY_DB_PASSWORD"];
  const { resolved, skipped, missing } = resolveEnvironment(entries, sources, REQUIRED);

  if (missing.length > 0) {
    return die([
      `these are not set and the proxy cannot run without them: ${missing.join(", ")}`,
      "",
      `  All of them come from ${CP_ENV_PATH} on ${SSH_HOST}, written there by`,
      "  deploy/r750/proxy-install.sh. Run that first, or read them into your shell:",
      "",
      ...SERVER_SECRET_NAMES.map((name) =>
        `    export ${name}="$(ssh ${SSH_HOST} "grep '^${name}=' ${CP_ENV_PATH} | cut -d= -f2-")"`),
      "",
      "  PROXY_DATABASE_URL is assembled from PROXY_DB_PASSWORD and is never set by hand.",
    ].join("\n"), 2);
  }

  step(`the environment it will set, ${resolved.length} keys`);
  for (const one of resolved) {
    const shown = SECRET_KEYS.has(one.key) ? `(set, ${one.value.length} characters, not printed)` : one.value;
    say(`${one.key.padEnd(22)}${shown}`);
  }
  if (skipped.length > 0) say(`skipped, because nothing supplied a value: ${skipped.join(", ")}`);

  const composeBase64 = Buffer.from(composeText, "utf8").toString("base64");
  const client = DRY_RUN ? null : createClient({ url: env.COOLIFY_URL, apiKey: env.COOLIFY_API_KEY });

  step("where it goes");
  let projectUuid = env.COOLIFY_PROJECT_UUID ?? "";
  let environmentUuid = env.COOLIFY_ENVIRONMENT_UUID ?? "";
  if (DRY_RUN) {
    say(`project      ${projectUuid || "(looked up at run time)"} (GET /projects, matched on the name ${PROJECT_NAME})`);
    say(`environment  ${environmentUuid || "(looked up at run time)"} (inside that project, matched on ${ENVIRONMENT_NAME})`);
  } else {
    if (!projectUuid) {
      const projects = asList(await client.call("GET", "/projects"));
      const match = projects.find((project) => String(project?.name ?? "") === PROJECT_NAME);
      if (!match?.uuid) {
        return die(`no Coolify project is named ${PROJECT_NAME}. Check the name in Coolify, or set COOLIFY_PROJECT_UUID.`);
      }
      projectUuid = String(match.uuid);
    }
    if (!environmentUuid) {
      try {
        const project = await client.call("GET", `/projects/${projectUuid}`);
        environmentUuid = String(asList(project?.environments).find((one) => String(one?.name ?? "") === ENVIRONMENT_NAME)?.uuid ?? "");
      } catch { /* environment_name alone is what tenant creates already use today */ }
    }
    say(`project      ${projectUuid}`);
    say(`environment  ${environmentUuid || "- (environment_name is sent on its own)"}`);
  }
  say(`server       ${SERVER_UUID}`);

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
    say("");
    say("and then it STOPS. No start, no restart, no deploy: once the migration has run this");
    say("service is every tenant's inference, so bringing it up is a decision you make in Coolify.");
    out("\nnothing was called. Run it again without --dry-run.");
    return 0;
  }

  step("the service");
  const services = asList(await client.call("GET", "/services"));
  let serviceUuid = String(services.find((service) => String(service?.name ?? "") === RESOURCE_NAME)?.uuid ?? "");
  if (serviceUuid) {
    say(`found ${RESOURCE_NAME} at ${serviceUuid}`);
    await client.call("PATCH", `/services/${serviceUuid}`, { body: { docker_compose_raw: composeBase64 } });
    say("compose updated");
  } else {
    const body = {
      name: RESOURCE_NAME,
      description: "The proxy: one place the provider subscriptions live, one key per customer in front",
      project_uuid: projectUuid,
      environment_name: ENVIRONMENT_NAME,
      server_uuid: SERVER_UUID,
      instant_deploy: false,
      docker_compose_raw: composeBase64,
    };
    if (environmentUuid) body.environment_uuid = environmentUuid;
    const created = await client.call("POST", "/services", { body });
    serviceUuid = String(created?.uuid ?? "");
    if (!serviceUuid) throw new Error("Coolify created the service but did not answer with its uuid");
    say(`created ${RESOURCE_NAME} at ${serviceUuid}`);
  }

  step("the environment");
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
  for (const one of resolved) {
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

  out("\n== done, and NOT started");
  say(`service ${serviceUuid}`);
  say("Deploy it in Coolify yourself. Then, on the server:");
  say("  ssh dell-remote bash /home/sem/titanbot/deploy/proxy-install.sh --pin-url");
  say("  systemctl --user start titanbot-isolation.service   # a USER unit; sudo says not found");
  say("  sudo bash /home/sem/titanbot/deploy/box-isolation.sh --verify");
  return 0;
}

// Only when this file is the thing that was run. The readers above are exported so a test can hold
// the compose parsing to the real file without starting a run.
const runDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) {
  main().then((code) => process.exit(code ?? 0)).catch((error) => die(String(error?.message ?? error)));
}
