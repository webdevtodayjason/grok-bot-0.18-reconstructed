#!/usr/bin/env node
// cp/cli.mjs -- the operator's side of the control plane.
//
//   node cp/cli.mjs signup add <email> <company> [--name "Jane Doe"]
//   node cp/cli.mjs account add <email> <tenant> [--name "Jane Doe"]
//   node cp/cli.mjs account list
//   node cp/cli.mjs account remove <email>
//   node cp/cli.mjs account promote <email>
//   node cp/cli.mjs account demote <email>
//   node cp/cli.mjs tenant add <slug> <name> [--dry-run]
//   node cp/cli.mjs tenant list
//   node cp/cli.mjs tenant adopt <slug> <coolify-uuid> <host> [--box <container>] [--state <dir>] [--profile <dir>]
//   node cp/cli.mjs proxy list
//   node cp/cli.mjs proxy mint <slug|--all>
//   node cp/cli.mjs proxy rotate <slug|--all>
//   node cp/cli.mjs proxy revoke <slug|--all>
//   node cp/cli.mjs proxy migrate <slug|--all> [--forget <sha256 prefix>] [--dry-run]
//   node cp/cli.mjs proxy rollback <slug>
//   node cp/cli.mjs proxy providers
//   node cp/cli.mjs proxy seed [--file <path>] [--dry-run]
//   node cp/cli.mjs proxy key add|roll|park|unpark|remove|quota
//   node cp/cli.mjs proxy model add|set|apply|vision-check|push-label|remove
//   node cp/cli.mjs proxy catalog refresh <provider>
//   node cp/cli.mjs proxy default-model [<alias>|none]
//   node cp/cli.mjs mail list [<slug>]
//   node cp/cli.mjs mail retire <code>
//   node cp/cli.mjs mail senders <slug> | allow <slug> <address> | only <slug> on|off
//   node cp/cli.mjs mail sends <slug>
//   node cp/cli.mjs mail sweep
//   node cp/cli.mjs feedback list|show|approve|suppress|close|issue|digest|github-token
//   node cp/cli.mjs marketplace list
//   node cp/cli.mjs marketplace verify [--row <id>] [--fixtures] [--write]
//   node cp/cli.mjs session verify <token>
//
// `signup add` is the whole of adding a customer in one line: it makes the account, works the
// workspace name out of the company name, and builds the box. `account add` is the older two-step
// way, for adding a second person to a workspace that already exists.
//
// It talks to the running service over HTTP. Two things it needs from the environment:
//
//   CP_ADMIN_TOKEN   the operator bearer, the same value the service runs with
//   CP_PUBLIC_URL    where the service is, https://api.titanium.bot by default
//
// A password is never an argument. Arguments end up in shell history, in `ps` output and in the
// terminal scrollback of whoever is watching, so `account add` asks for it on the terminal with the
// echo turned off, exactly the way ui/set-password.mjs does.

import {
  PROXY_ROLLBACK_NAME,
  ensureProxyKey,
  forgetProxyKey,
  loadConfig,
  proxyKeyFileIn,
  readProxyKey,
  tenantProfileDir,
  validateSlug,
} from "./provision.mjs";
import { TENANT_ALLOWED_ROUTES, createProxyClient, proxyKeyAlias, tenantRoutesFor } from "./proxy.mjs";
import { tenantOfUnverifiedToken, tenantSessionSecret, verifySessionToken } from "./session.mjs";
import { openStore } from "./store.mjs";
import { mailDomain } from "./mail.mjs";
import { buildDigest } from "./feedback.mjs";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// A credential by its hash, never by its value. Everything this file prints about a key, and
// everything it compares, goes through here.
const sha256Of = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

const config = loadConfig();
const BASE = config.publicUrl;

const out = (line) => process.stdout.write(`${line}\n`);
const die = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };

function flag(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return null;
  return args[at + 1] ?? "";
}
const hasFlag = (args, name) => args.includes(name);
// Flags that take a value, so their value is not mistaken for a positional argument. A company
// called "Acme Roofing" is two positionals joined back together by the caller; a --name that was
// not skipped here would silently become part of it.
const VALUED_FLAGS = new Set([
  "--name", "--box", "--state", "--profile", "--forget",
  // PROVIDERS-1. Everything the providers commands take a value for. A flag missing from
  // this set has its VALUE read as a positional, so `--label "subscription two"` would make
  // "subscription two" the thing being acted on.
  "--label", "--slot", "--confirm", "--provider", "--vendor-model", "--served-by", "--context",
  "--vision-fallback", "--keys", "--file", "--total", "--unit", "--window", "--reset",
]);
const positional = (args) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (VALUED_FLAGS.has(args[index])) { index += 1; continue; }
    if (args[index].startsWith("--")) continue;
    values.push(args[index]);
  }
  return values;
};

// One line from the terminal with the echo off. Raw mode means this loop owns every keystroke, so
// ctrl-c has to still quit and backspace has to still delete: an operator cannot correct a typo
// they cannot see.
function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(label);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const finish = (error, result) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(result);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish(null, value);
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); continue; }
        if (character < " ") continue;
        value += character;
      }
    };
    input.on("data", onData);
  });
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (value.length === 0) die("no password on stdin, nothing was done");
    return value;
  }
  const password = await promptHidden("Password: ");
  const again = await promptHidden("Repeat it: ");
  if (password !== again) die("the two entries did not match, nothing was done");
  return password;
}

async function api(method, pathname, body, headers = {}) {
  if (!config.adminToken) die("CP_ADMIN_TOKEN is not set. It is the operator password for this service.");
  const init = { method, headers: { authorization: `Bearer ${config.adminToken}`, accept: "application/json", ...headers } };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  let response;
  try { response = await fetch(`${BASE}${pathname}`, init); }
  catch (error) { die(`could not reach the control plane at ${BASE}: ${String(error?.message ?? error)}`); }
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = { message: text.slice(0, 400) }; } }
  if (!response.ok) die(`${method} ${pathname} answered ${response.status}: ${String(parsed?.message ?? parsed?.error ?? "no message")}`);
  return parsed ?? {};
}

// One space of gutter always, even when the value is wider than the column. Without it a box name
// that fills its column runs straight into the next one, which is what
// "titanbot-box-atonqjq7zx593jsacaccpfaurunning" was.
const pad = (value, width) => `${String(value ?? "").padEnd(width - 1)} `;

// One line adds a customer: the account, the workspace name from the company name, and the box.
//
// The company name is every positional after the email joined back up, so quoting it is optional:
// `signup add jane@acme.com Acme Roofing` and `signup add jane@acme.com "Acme Roofing"` are the
// same command. The password is prompted, never an argument, for the reason at the top of this
// file.
async function signupAdd(args) {
  const [email, ...rest] = positional(args);
  const company = rest.join(" ").trim();
  if (!email || company.length === 0) die("usage: node cp/cli.mjs signup add <email> <company> [--name \"Jane Doe\"]");
  const name = flag(args, "--name") ?? "";
  const password = await readPassword();
  const answer = await api("POST", "/v1/signups", { email, password, company, name });
  out(`added ${answer.account.email} on workspace ${answer.tenant.slug}`);
  out(`they sign in at ${answer.signIn}`);
  out(answer.message);
}

async function accountAdd(args) {
  const [email, tenant] = positional(args);
  if (!email || !tenant) die("usage: node cp/cli.mjs account add <email> <tenant> [--name \"Jane Doe\"]");
  const name = flag(args, "--name") ?? "";
  const password = await readPassword();
  const answer = await api("POST", "/v1/accounts", { email, password, name, tenant });
  out(`added ${answer.account.email} on tenant ${answer.account.tenant}`);
  out(`they sign in at https://${answer.tenant.host}`);
}

async function accountList() {
  const answer = await api("GET", "/v1/accounts");
  if (answer.accounts.length === 0) return out("no accounts yet");
  out(`${pad("EMAIL", 34)}${pad("TENANT", 20)}${pad("ROLE", 14)}NAME`);
  for (const account of answer.accounts) {
    // Two facts about the door, printed where the operator is already looking. "off" matters more
    // than it reads: a disabled account is still in this list and still owns its workspace, and
    // without this column the only symptom is a customer saying they cannot sign in.
    const role = [account.superAdmin ? "super admin" : "", account.disabled ? "off" : ""].filter(Boolean).join(", ") || "customer";
    out(`${pad(account.email, 34)}${pad(account.tenant, 20)}${pad(role, 14)}${account.name}`);
  }
}

// Closing one person's door. The email is typed twice on purpose, the same way the tenant delete
// asks for the slug: an account is somebody's way in and a typo here is a customer locked out of
// their own workspace with nothing on screen to say why.
async function accountRemove(args) {
  const [email] = positional(args);
  if (!email) die("usage: node cp/cli.mjs account remove <email>");
  const answer = await api("DELETE", `/v1/accounts/${encodeURIComponent(email)}`, { confirm: email });
  out(`removed ${answer.email} from workspace ${answer.tenant}`);
  out(answer.message);
}

// The super admin flag: who may open the console at /admin. ADMIN-1.
//
// It is deliberately not a flag on `account add`. Making somebody a super admin is a separate,
// deliberate act with its own line in the shell history, and on a system that has none this is the
// only way to make the first one, because the route it calls is the one route CP_ADMIN_TOKEN opens.
async function accountPromote(args) {
  const [email] = positional(args);
  if (!email) die("usage: node cp/cli.mjs account promote <email>");
  const answer = await api("POST", `/v1/admin/users/${encodeURIComponent(email)}/promote`);
  out(`${answer.account.email} is now a super admin`);
  out(`they open the console at ${BASE}/admin with the same email and password they already have`);
}

async function accountDemote(args) {
  const [email] = positional(args);
  if (!email) die("usage: node cp/cli.mjs account demote <email>");
  const answer = await api("POST", `/v1/admin/users/${encodeURIComponent(email)}/demote`);
  out(`${answer.account.email} is no longer a super admin`);
  out("their own workspace sign-in is unchanged");
}

async function tenantAdd(args) {
  const [slug, ...rest] = positional(args);
  if (!slug) die("usage: node cp/cli.mjs tenant add <slug> <name> [--dry-run]");
  const valid = validateSlug(slug);
  if (!valid.ok) die(valid.reason);
  const name = rest.join(" ");
  const dryRun = hasFlag(args, "--dry-run");
  const answer = await api("POST", "/v1/tenants", { slug, name, dryRun });
  if (dryRun) {
    out(`dry run for ${slug}, nothing was created`);
    out(`console would be https://${answer.host}`);
    for (const step of answer.plan.steps) out(`  ${pad(step.name, 13)}${pad(step.method, 7)}${step.path}`);
    return;
  }
  out(`created ${answer.tenant.slug}, status ${answer.tenant.status}`);
  out(`console https://${answer.tenant.host}`);
  out(`box ${answer.tenant.boxContainer ?? "not created"}`);
  out(answer.message);
}

async function tenantList() {
  const answer = await api("GET", "/v1/tenants");
  if (answer.tenants.length === 0) return out("no tenants yet");
  out(`${pad("SLUG", 20)}${pad("BOX", 34)}${pad("STATUS", 14)}${pad("LIVE", 14)}SERVICE`);
  for (const tenant of answer.tenants) {
    // An adopted row with no box recorded is not a fault and must not read like one: the relay
    // builds the operator's own entry from its own environment, which is what keeps that console
    // working when this service is down. Every other row has to have a box or it cannot be served.
    const box = tenant.boxContainer
      ?? (tenant.status === "adopted" ? "(from the relay's own env)" : "(none yet)");
    out(`${pad(tenant.slug, 20)}${pad(box, 34)}${pad(tenant.status, 14)}${pad(tenant.coolify?.status ?? "unknown", 14)}${tenant.coolifyServiceUuid ?? ""}`);
    if (tenant.lastError) out(`  last error: ${tenant.lastError}`);
  }
  out("");
  out(`everybody signs in at https://${answer.tenants[0].host}`);
}

// Tenant directories on this machine that the ledger has never heard of.
//
// MEASURED ON THE R750 2026-09-08: /data/titanbot held demo, north-bay-roofing, richard-avery and
// titanium, and the ledger held three. north-bay-roofing had a profile directory and a host-secrets
// file with a machineId in it, no box container, no proxy key and no box-secrets -- a provision
// that stopped half way on 2026-09-07 and was never finished or cleaned up. It was invisible to the
// migration, to the spend panel and to any revocation sweep, which is the whole problem with an
// orphan: nothing that walks the ledger will ever look at it again.
//
// This returns the names rather than printing them, because the migration and the revoke path call
// it too: a tenant tree the panel cannot see gets named at the moment somebody is working on the
// fleet, not only when they think to ask.
function orphanTenantDirs(store) {
  const root = String(config.tenantRoot ?? "");
  if (root.length === 0) return [];
  let names;
  try { names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
  const known = new Set(store.listTenants().map((row) => row.slug));
  // A leading dot is ours: .orphans is where a retired tree is moved to, and it is not a tenant.
  return names.filter((name) => !name.startsWith(".") && !known.has(name)).sort();
}

// Named on every fleet-wide command, so an orphan cannot sit unseen for another week.
function reportOrphans(store) {
  const orphans = orphanTenantDirs(store);
  if (orphans.length === 0) return;
  out("");
  out(`${orphans.length} directory tree${orphans.length === 1 ? "" : "s"} under ${config.tenantRoot} that this control plane has no client for:`);
  for (const name of orphans) out(`  ${name}`);
  out("  Nothing above touched them. Finish the provision (node cp/cli.mjs tenant add <slug> <name>) or retire the tree.");
}

// Whether a workspace has a way back, and whether the way back is real.
//
// MEASURED ON THE R750 2026-09-08: demo's snapshot held a REVOKED virtual key pointed at the proxy,
// because the migration ran twice and the second run snapshotted what the first had left; and
// titanium had no snapshot at all, so `proxy rollback titanium` answered 409. Only richard-avery
// had a true pre-migration state. useIncluded no longer overwrites a snapshot, which stops the
// first; this is how an operator sees which of the three they are looking at without opening a
// 0600 file.
function rollbackState(store, slug) {
  const file = path.join(tenantProfileDir(slug, config, store.listSteps(slug)), PROXY_ROLLBACK_NAME);
  let saved;
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { return "none"; }
  const secrets = saved?.secrets;
  if (typeof secrets !== "object" || secrets == null) return "unreadable";
  const base = String(secrets.SAND_OPENAI_COMPATIBLE_BASE_URL ?? "");
  const proxyBase = String(config.proxyUrl ?? "");
  return proxyBase.length > 0 && base.startsWith(proxyBase.replace(/\/v1$/, "")) ? "on-proxy" : "kept";
}

function tenantOrphans() {
  const store = openLedger();
  try {
    const orphans = orphanTenantDirs(store);
    if (orphans.length === 0) return out(`every directory under ${config.tenantRoot} belongs to a client in the ledger`);
    out(`${pad("DIRECTORY", 28)}${pad("BOX-SECRETS", 14)}${pad("PROXY KEY", 12)}CONTENTS`);
    for (const name of orphans) {
      const dir = path.join(config.tenantRoot, name);
      const has = (relative) => { try { statSync(path.join(dir, relative)); return "yes"; } catch { return "no"; } };
      let contents = [];
      try { contents = readdirSync(dir).slice(0, 8); } catch { contents = ["(unreadable)"]; }
      out(`${pad(name, 28)}${pad(has("volumes/data/box-secrets.json"), 14)}${pad(has("profile/model-proxy.json"), 12)}${contents.join(" ")}`);
    }
    out("");
    out("these are invisible to the migration, to the spend panel and to a revocation sweep.");
    out("finish one with `tenant add`, or retire its tree by hand once you have read what is in it.");
  } finally { store.close(); }
}

// Claims an instance that already exists, and tells the registry where its box and its files are so
// the one relay can serve it. The three optional flags are for an instance that was not built from
// this repo's compose; the defaults are what Coolify and deploy/r750 already produce.
async function tenantAdopt(args) {
  const [slug, uuid, host] = positional(args);
  if (!slug || !uuid || !host) die("usage: node cp/cli.mjs tenant adopt <slug> <coolify-uuid> <host> [--box <container>] [--state <dir>] [--profile <dir>]");
  const body = { coolifyServiceUuid: uuid, host };
  const box = flag(args, "--box");
  const stateDir = flag(args, "--state");
  const profileDir = flag(args, "--profile");
  if (box) body.boxContainer = box;
  if (stateDir) body.stateDir = stateDir;
  if (profileDir) body.profileDir = profileDir;
  const answer = await api("POST", `/v1/tenants/${encodeURIComponent(slug)}/adopt`, body);
  out(`${answer.tenant.slug} now points at Coolify service ${answer.tenant.coolifyServiceUuid} on ${answer.tenant.host}`);
  out(`box ${answer.boxContainer}`);
  out(`state ${answer.stateDir}`);
  out(`profile ${answer.profileDir}, which is where its gateway token is read from`);
  out("nothing on that service was changed");
}

// ---- the proxy (PROXY-1) ------------------------------------------------------------------------
//
// These six commands do NOT go through the HTTP api the rest of this file uses, and that is a
// decision rather than an oversight. They need three things only this container has: the tenant
// root on its bind mount, where the 0600 key file lives; CP_PROXY_MASTER_KEY, which reaches exactly
// two places and a browser is not one of them; and CP_RELAY_TOKEN, for the two relay routes that
// change what a box uses. So they run in process against the same store the service has open, which
// is what the WAL in cp/store.mjs is there for.
//
// This is also THE ONLY PATH FOR THE OPERATOR'S OWN WORKSPACE. Tenant "titanium" is an adopted row,
// and tenantProvision refuses a non-dry-run provision on an adopted row on purpose, because
// building it again would be a second copy of Jason's live console. So the eighth provisioning step
// never runs for it and `proxy mint titanium` is how it gets a key.
//
// And the LEDGER is what is iterated, never a directory listing of /data/titanbot. Measured on the
// R750: north-bay-roofing has a directory and a live 0600 gateway token and no ledger row at all,
// and titanium has a box and no directory. A loop over the disk would mint a key for a workspace
// nobody has and miss the one Jason uses.

const openLedger = () => openStore({ dataDir: config.dataDir });

const proxyClient = () => createProxyClient({ config });

// Every tenant in the ledger, or the one named. A slug that is not in the ledger is a stop rather
// than a skip: the operator typed a name, and a name that resolves to nothing is a typo.
function proxyTargets(store, args) {
  if (hasFlag(args, "--all")) return store.listTenants();
  const [slug] = positional(args);
  if (!slug) die("name a workspace, or pass --all");
  const row = store.getTenant(slug);
  if (row == null) die(`there is no workspace called ${slug} in the ledger`);
  return [row];
}

// WHERE THIS WORKSPACE'S KEY FILE GOES, resolved from the ledger rather than assumed.
//
// A workspace this service built keeps its files under CP_TENANT_ROOT. An ADOPTED one keeps them
// wherever the operator already had them, which is exactly the case these commands exist for:
// tenant "titanium" is Jason's own instance, its profile directory is under the release root, and
// it has no directory under the tenant root at all. Writing the key to the wrong place would report
// success and leave his console with nothing included in his plan, which is a failure with no error
// message anywhere. cp/server.mjs resolves it with the same function.
const keyFileFor = (store, slug) => proxyKeyFileIn(tenantProfileDir(slug, config, store.listSteps(slug)));

function requireProxyConfigured() {
  if (String(config.proxyUrl ?? "").length === 0) {
    die("CP_PROXY_URL is not set on this control plane, so there is no proxy to mint keys at.");
  }
  if (String(config.proxyMasterKey ?? "").length === 0) {
    die("CP_PROXY_MASTER_KEY is not set on this control plane, so the proxy cannot be opened.");
  }
}

// The relay's two admin routes, which are the ONLY way a box's provider configuration is changed.
//
// This matters more than the mechanism: anything done to a live box by hand over ssh has to become
// something Jason runs himself, so the migration is a command and not a session. The relay owns the
// docker exec because it is the container with the socket; this holds the relay's own credential
// and asks it.
async function askRelay(method, pathname, body) {
  if (String(config.relayUrl ?? "").length === 0 || String(config.relayToken ?? "").length === 0) {
    die("CP_RELAY_URL and CP_RELAY_TOKEN have to be set for this, because changing what a box uses goes through the relay.");
  }
  const init = { method, headers: { authorization: `Bearer ${config.relayToken}`, accept: "application/json" } };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  let response;
  try { response = await fetch(`${config.relayUrl}${pathname}`, init); }
  catch (error) { die(`could not reach the relay at ${config.relayUrl}: ${String(error?.message ?? error)}`); }
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = { message: text.slice(0, 400) }; } }
  if (!response.ok) die(`${method} ${pathname} answered ${response.status}: ${String(parsed?.message ?? parsed?.error ?? "no message")}`);
  return parsed ?? {};
}

async function proxyMint(args) {
  requireProxyConfigured();
  const store = openLedger();
  try {
    for (const row of proxyTargets(store, args)) {
      const answer = await ensureProxyKey(row.slug, config, { box: row.boxContainer ?? "", file: keyFileFor(store, row.slug), onNote: (note) => out(`  note: ${note}`) });
      if (!answer.ok) { out(`${pad(row.slug, 20)}not minted: ${answer.why}`); continue; }
      // "read" rather than "minted" is the answer a second run gives, and it is the answer that
      // proves this is safe to run twice: the key is read back off the disk and no second one is
      // made at the proxy.
      out(`${pad(row.slug, 20)}${pad(answer.record.alias, 26)}${answer.minted ? "minted" : "read"} ${answer.record.models.map((model) => model.id).join(", ")}`);
    }
  } finally { store.close(); }
}

async function proxyRotate(args) {
  requireProxyConfigured();
  const store = openLedger();
  try {
    for (const row of proxyTargets(store, args)) {
      const answer = await ensureProxyKey(row.slug, config, { force: true, box: row.boxContainer ?? "", file: keyFileFor(store, row.slug), onNote: (note) => out(`  note: ${note}`) });
      if (!answer.ok) { out(`${pad(row.slug, 20)}not rotated: ${answer.why}`); continue; }
      out(`${pad(row.slug, 20)}${pad(answer.record.alias, 26)}rotated`);
      out("  the box picks the new key up on its next message, because the host re-reads that file every turn");
    }
  } finally { store.close(); }
}

async function proxyRevoke(args) {
  requireProxyConfigured();
  const proxy = proxyClient();
  const store = openLedger();
  try {
    for (const row of proxyTargets(store, args)) {
      const answer = await proxy.deleteKeyByAlias(row.slug);
      // The local file goes whatever the proxy said. A file holding a key the proxy has deleted is
      // a registry row that hands a box a credential that answers 401, which is harder to read than
      // a workspace that has no plan key at all.
      const forgotten = forgetProxyKey(row.slug, config, { file: keyFileFor(store, row.slug) });
      out(`${pad(row.slug, 20)}${pad(proxyKeyAlias(row.slug), 26)}${answer.ok ? "revoked at the proxy" : `NOT revoked: ${answer.why}`}${forgotten ? ", key file removed" : ", no key file here"}`);
    }
    out("");
    out("the proxy caches a key for up to its user_api_key_cache_ttl, so a box already mid-request may finish it");
    reportOrphans(store);
  } finally { store.close(); }
}

// The budget and the rate limit applied to keys that ALREADY EXIST, with no re-mint and nothing
// written into a box.
//
// MEASURED ON THE R750 2026-09-08, straight out of the proxy's Postgres: all three tenant keys had
// max_budget NULL, tpm_limit NULL, rpm_limit NULL and max_parallel_requests NULL, and the four
// budget rows carried an advisory soft_budget of 20 and nothing else. So nothing at the proxy
// stopped one customer consuming the whole pooled subscription. mintKey has always sent rpm_limit,
// but only when CP_PROXY_RPM_LIMIT is set, and it was not set on titanbot-cp -- and a key that was
// already minted would not have picked it up in any case.
//
// This is the command that applies the current settings to the fleet. Run it after changing
// CP_PROXY_ALLOWANCE_USD, CP_PROXY_ENFORCE or CP_PROXY_RPM_LIMIT on this service; running it twice
// changes nothing, and running it with none of them set says so rather than quietly doing nothing.
async function proxyLimits(args) {
  requireProxyConfigured();
  const proxy = proxyClient();
  const store = openLedger();
  try {
    // PROVIDERS-1 GAVE THIS COMMAND A SECOND JOB, AND IT IS THE ONE THAT CANNOT BE SKIPPED.
    //
    // Every key already in the field was minted with allowed_routes [] and is unrestricted: from
    // inside any customer's box, that key opens /key/info, /model/info, /model_group/info and
    // /health on the proxy. That was survivable only because ONE GLOBAL LIST in the proxy's config
    // closed those routes to everybody. This wave removes that list, because it is checked before
    // the key is looked up and therefore cannot tell the operator from a tenant.
    //
    // So this sweep pushes the route list and the current model list onto every key that exists,
    // and it MUST be run and measured BEFORE the global list comes out of config.yaml, never after,
    // or there is a window where the admin surface is open to every box on the bridge. The ship
    // plan says so in the same words.
    //
    // MEASURED ON THIS MAC 2026-09-08 against a throwaway v1.100.0 stack: POST /key/update takes
    // allowed_routes and it takes ON THE SAME KEY VALUE. So this writes NOTHING into a box: no
    // re-mint, no new credential in anybody's file, and none of the registry hazard that wrote a
    // REVOKED key back into a box on 2026-09-08. Had it not, this would have had to be a fleet-wide
    // rotate and it would not have happened in this wave at all.
    //
    // It therefore runs whether or not a ceiling is set, and says which of the two it is doing.
    const ceilings = config.proxyAllowanceUsd > 0 || config.proxyRpmLimit > 0;
    if (!ceilings) {
      out("neither CP_PROXY_ALLOWANCE_USD nor CP_PROXY_RPM_LIMIT is set on this control plane, so no ceiling is applied");
      out("the route list and the model list below are applied anyway; that is the part that closes PROXY-8");
      out("");
    } else {
      out(`allowance ${config.proxyAllowanceUsd > 0 ? `$${config.proxyAllowanceUsd} ${config.proxyEnforce ? "enforced (max_budget)" : "observed (soft_budget)"}` : "none"}`);
      out(`rate limit ${config.proxyRpmLimit > 0 ? `${config.proxyRpmLimit} requests a minute per workspace` : "none"}`);
      out("");
    }
    // What the proxy serves RIGHT NOW, so a key minted before a model was added is widened by the
    // same sweep rather than needing a separate one.
    const served = await proxy.models();
    if (!served.ok) return die(`the proxy could not be asked which models it serves: ${served.why}`);
    // The list as the proxy really is. A pass-through whose credential header is empty is dropped:
    // a door that can only fail upstream while booking a metered request is not a door a customer
    // should be given. Measured on the R750 2026-09-08, both TinyFish paths were in that state.
    const routes = tenantRoutesFor(await proxy.listPassThrough());
    out(`route list: ${routes.join(" ")}`);
    const dropped = TENANT_ALLOWED_ROUTES.filter((one) => !routes.includes(one));
    if (dropped.length > 0) out(`left off, because the proxy carries no key on them: ${dropped.join(" ")}`);
    out(`model list: ${served.models.join(", ") || "none"}`);
    out("");
    for (const row of proxyTargets(store, args)) {
      const record = readProxyKey(row.slug, config, { file: keyFileFor(store, row.slug) });
      if (record == null) { out(`${pad(row.slug, 20)}no key here yet; run proxy mint first`); continue; }
      const answer = await proxy.updateKey({
        key: record.key,
        allowanceUsd: config.proxyAllowanceUsd,
        enforce: config.proxyEnforce,
        rpmLimit: config.proxyRpmLimit,
        models: served.models,
        allowedRoutes: routes,
      });
      out(`${pad(row.slug, 20)}${pad(record.alias, 26)}${answer.ok ? "applied, key value unchanged" : `NOT applied: ${answer.why}`}`);
    }
    out("");
    out("nothing was written into any box: the same key value now carries a route list and a model list");
    out("the proxy caches a key for up to its user_api_key_cache_ttl, so a box mid-request may finish on the old ceiling");
  } finally { store.close(); }
}

function proxyList() {
  const store = openLedger();
  try {
    const rows = store.listTenants();
    if (rows.length === 0) return out("no workspaces in the ledger yet");
    out(`${pad("SLUG", 20)}${pad("ALIAS", 26)}${pad("KEY ID", 18)}${pad("WAY BACK", 12)}${pad("MINTED", 26)}MODELS`);
    for (const row of rows) {
      const record = readProxyKey(row.slug, config, { file: keyFileFor(store, row.slug) });
      const back = rollbackState(store, row.slug);
      if (record == null) {
        out(`${pad(row.slug, 20)}${pad(proxyKeyAlias(row.slug), 26)}${pad("-", 18)}${pad(back, 12)}${pad("not minted", 26)}`);
        continue;
      }
      // The alias, the id and when. Never the key, on a terminal an operator may be sharing.
      out(`${pad(row.slug, 20)}${pad(record.alias, 26)}${pad(`${String(record.keyId).slice(0, 12)}...`, 18)}${pad(back, 12)}${pad(record.mintedAt || "unknown", 26)}${record.models.map((model) => model.id).join(", ")}`);
    }
    if (rows.some((row) => rollbackState(store, row.slug) !== "kept")) {
      out("");
      out("WAY BACK is the pre-migration snapshot `proxy rollback` replays. `on-proxy` means the snapshot");
      out("holds a plan endpoint rather than what the box had before, so replaying it would leave that box");
      out("on the proxy; `none` means that workspace rolls back by picking an endpoint in its console instead.");
    }
    out("");
    out(config.proxyUrl ? `proxy ${config.proxyUrl}` : "CP_PROXY_URL is not set on this control plane, so nothing is included with any plan yet");
    reportOrphans(store);
  } finally { store.close(); }
}

// The migration. Mint the key, point the box at it, and forget the copied operator key.
//
// THE ORDER IS THE SAFETY. The key is minted and the box is switched over BEFORE anything is
// deleted, so a customer is never between two credentials. And the forget step matches on a sha256
// PREFIX rather than on a name: matching the hash is what makes it impossible for this to delete a
// customer's own key by accident, because the only thing it will remove is a value it was told the
// hash of.
async function proxyMigrate(args) {
  requireProxyConfigured();
  const dryRun = hasFlag(args, "--dry-run");
  const prefix = String(flag(args, "--forget") ?? "").trim();
  const store = openLedger();
  try {
    for (const row of proxyTargets(store, args)) {
      const profileDir = tenantProfileDir(row.slug, config, store.listSteps(row.slug));
      const keyFile = proxyKeyFileIn(profileDir);
      out(`${row.slug}`);
      if (dryRun) {
        const existing = readProxyKey(row.slug, config, { file: keyFile });
        out(`  would ${existing ? "reuse the key already in" : "mint a key into"} ${keyFile}`);
        out(`  would ask the relay to point the box at ${config.proxyUrl}/v1, snapshotting what it holds now to ${profileDir}/${PROXY_ROLLBACK_NAME}`);
        out(prefix
          ? `  would ask the relay to delete every stored value whose sha256 starts ${prefix}, and nothing else`
          : "  would delete nothing, because no --forget <sha256 prefix> was given");
        out("  nothing was written");
        continue;
      }
      const minted = await ensureProxyKey(row.slug, config, { box: row.boxContainer ?? "", file: keyFile, onNote: (note) => out(`  note: ${note}`) });
      if (!minted.ok) { out(`  stopped: ${minted.why}`); continue; }
      out(`  key ${minted.record.alias} ${minted.minted ? "minted" : "already there"}`);

      // THE BOX IS WRITTEN THE KEY THE RELAY HOLDS, NOT THE ONE THIS FILE HOLDS, and the relay
      // refreshes its registry on a sixty second cycle. Measured on the R750 2026-09-08 doing
      // exactly this: demo's key was revoked and minted again, and the migrate that followed
      // reported "the box now answers through the plan" while writing the REVOKED key back into
      // the box, because that was still what the relay's cache held. The box answered 401 on every
      // turn and the command that caused it had said it worked.
      //
      // The relay's answer names what it wrote by hash prefix, and this file knows the hash of the
      // key it just minted, so the two are compared. No key travels in either direction to do it.
      const wantHash = sha256Of(minted.record.key).slice(0, 12);
      let used = null;
      // Two minutes by default, which is two of the relay's refresh cycles. Shrunk by the gate so
      // the lagging case can be measured without waiting out a real one.
      const waitMs = Number(process.env.CP_PROXY_SWITCH_WAIT_MS ?? "120000") || 120_000;
      const deadline = Date.now() + waitMs;
      for (;;) {
        used = await askRelay("POST", `/admin/tenants/${encodeURIComponent(row.slug)}/use-included`, {});
        const wroteHash = (used.wrote ?? []).find((one) => one.name === "SAND_OPENAI_COMPATIBLE_API_KEY")?.sha256 ?? "";
        if (wroteHash === wantHash) break;
        if (Date.now() >= deadline) {
          out(`  STOPPED: the console is still handing out an older key for ${row.slug} (it wrote ${wroteHash || "nothing"}, this key is ${wantHash}).`);
          out("  Nothing was deleted. The console refreshes its list about once a minute; run this again in a moment.");
          used = null;
          break;
        }
        out(`  the console is still on an older key (${wroteHash || "none"}); waiting for it to catch up`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(200, Math.floor(waitMs / 4)))));
      }
      if (used == null) continue;
      out(`  the box now answers through the plan: ${String(used.endpointName ?? used.using ?? "switched")}`);
      if (used.rollbackFile) out(`  the way back is kept at ${used.rollbackFile}`);

      if (!prefix) {
        out("  nothing was deleted, because no --forget <sha256 prefix> was given. Run again with it once you have read what the box holds.");
        continue;
      }
      // The field is `prefix`, which is what the relay route reads. It is a PREFIX and never a
      // value, so this call proves the caller knows WHICH credential without the route ever
      // accepting one, and a typo deletes nothing rather than something.
      const forgotten = await askRelay("POST", `/admin/tenants/${encodeURIComponent(row.slug)}/forget-provider-keys`, { prefix });
      // Names, lengths and hash prefixes, of what went and of what is left. Never a value, so this
      // output is safe to paste into a ticket, which is exactly what it is for. The remaining list
      // is the absence proof: the operator reads it and sees the hash they asked to remove is not
      // in it, rather than taking a count on trust.
      for (const line of forgotten.removed ?? []) {
        out(`  removed ${line.file}.${line.name}: ${line.length} chars, sha256 ${String(line.sha256 ?? "").slice(0, 12)}`);
      }
      for (const line of forgotten.remaining ?? []) {
        out(`  remaining ${line.where}.${line.name}: ${line.length} chars, sha256 ${String(line.sha256 ?? "").slice(0, 12)}`);
      }
      out(`  removed ${forgotten.removedCount ?? 0} value${forgotten.removedCount === 1 ? "" : "s"} matching ${prefix}`);
      // The store sweep's own verdict, said out loud. `storeCarrying` counts files inside the box's
      // content-addressed store that STILL hold the value and were deliberately not deleted -- a
      // pack of unrelated files, an agent's conversation database, an audit log. Removing one of
      // those to chase a credential is the customer's data gone, so they are named and the honest
      // next step is said rather than implied.
      if (Number(forgotten.storeCarrying ?? 0) > 0) {
        out(`  ${forgotten.storeCarrying} file(s) in this box's own store still carry that value and were NOT deleted.`);
        out("  Rotate the credential at the vendor. That is the only thing that ends it.");
      } else if (forgotten.storeSwept) {
        out("  the box's own store was swept as well and carries nothing matching");
      }
    }
    reportOrphans(store);
  } finally { store.close(); }
}

// ---- PROVIDERS-1: the panel, without a browser -------------------------------------------------
//
// Jason, 2026-09-08: "the mechanism for both me and the AI agent needs to be able to do this on our
// own." A page an operator clicks is half of that. This is the other half, and it matters more than
// it looks: an agent has no browser, and anything that can only be done by hand on a live instance
// is the thing this whole wave exists to end.
//
// THESE GO OVER THE API, and that is a deliberate break with the proxy commands above, which talk
// to the proxy directly out of this container. The reason is parity. Every one of these operations
// has a rule attached -- a routing alias never reaches a customer's page, a key that still serves
// cannot be removed, a label is never pushed at a workspace nobody named -- and a second
// implementation here would be a second set of rules to keep in step. Going through the same routes
// the console uses means the CLI cannot drift from the page, and it writes the same admin_actions
// row, with `via` reading cli instead of console.
//
// A KEY IS NEVER AN ARGUMENT. It is read from the terminal with the echo off, or from stdin when
// this is not a terminal, exactly the way a password is: arguments end up in shell history, in `ps`
// output and in the scrollback of whoever is watching.

// One call to this service's own admin API, as the operator, marked as having come from here.
//
// The header is the only difference from `api` above and it is what the change record reads: a
// change made without a browser lands in admin_actions with `via` reading cli instead of console,
// so "who changed the plan model" is answerable whichever way it was done.
const askAdmin = (method, pathname, body) => api(method, pathname, body, { "x-titanbot-via": "cli" });

/** A credential off the terminal, never off the command line. */
async function readSecret(label) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "").trim();
    if (value.length === 0) die("nothing on stdin, so nothing was done");
    return value;
  }
  const value = (await promptHidden(label)).trim();
  if (value.length === 0) die("nothing typed, so nothing was done");
  return value;
}

const say = (line) => out(line);
const evidenceLine = (value) => `${String(value).length} characters, sha256 ${sha256Of(value).slice(0, 8)}`;

async function proxyProviders() {
  const answer = await askAdmin("GET", "/v1/admin/providers");
  if (answer.configured !== true) return say(answer.why || "this control plane has no proxy configured");
  say(`the proxy stores its model list in its database: ${answer.db.on === true ? "yes" : (answer.db.on === false ? "NO -- changes made here will not take" : "cannot be told yet")}`);
  say(answer.db.why);
  say("");
  for (const provider of answer.providers) {
    say(`${provider.name} (${provider.id})  ${provider.baseUrl || "no base url, the vendor's own default"}`);
    if (provider.keys.length === 0) say("  no key here yet");
    for (const key of provider.keys) {
      const quota = key.quota.total != null ? `  plan window ${key.quota.used}/${key.quota.total} ${key.quota.unit}${key.quota.warn ? " -- OVER 80%" : ""}` : "";
      // The mask the PROXY returned, never one this side built.
      say(`  ${pad(key.slot, 12)}${pad(key.masked, 12)}${pad(key.parked ? "parked" : "serving", 9)}${pad(`$${(key.spend.month ?? 0).toFixed(4)}`, 12)}${key.serves.join(", ") || "nothing"}${quota}`);
      if (key.lastError) say(`    last error ${key.lastError.at}: ${key.lastError.why}`);
    }
    say(`  models: ${provider.catalog.models.join(", ") || "none"}  (${provider.catalog.live ? `read from ${provider.name}` : "the curated list"})`);
    say("");
  }
  say(`${pad("ALIAS", 20)}${pad("RUNS ON", 26)}${pad("CUSTOMERS SEE", 22)}${pad("LABEL", 14)}${pad("KEYS", 6)}WORKSPACES`);
  for (const model of answer.planModels) {
    say(`${pad(model.alias, 20)}${pad(model.vendorModel, 26)}${pad(model.shownToCustomers ? model.customerName : "-- not shown --", 22)}${pad(model.customerLabel || "-", 14)}${pad(String(model.deployments.length), 6)}${model.workspaces}`);
  }
  say("");
  say(`new workspaces get ${answer.defaults.planModel || "whatever the proxy serves"}`);
  if (answer.actions.length > 0) {
    say("");
    say("what changed most recently:");
    for (const row of answer.actions.slice(0, 5)) say(`  ${row.at}  ${pad(row.actor, 26)}${pad(row.via, 9)}${row.action} ${row.target} -- ${row.outcome}`);
  }
}

/**
 * A FRESH install seeded from the file beside the proxy's config, idempotently.
 *
 * bootstrap.json describes the providers, the credential slots, the plan models and the fallback
 * map a new install starts with. It holds NO KEY: a slot names the environment variable its value
 * would come from and nothing else, which is why the file can sit in git and in a bind mount.
 *
 * AN EXISTING INSTALL NEVER RE-SEEDS. Everything below checks what is really at the proxy first and
 * skips what is already there, so running this twice changes nothing and running it after somebody
 * has edited a model in the panel does not put the file's version back.
 *
 * The keys are the honest gap and the output says so. The vendor keys live in the PROXY service's
 * environment, not this one's, so a slot is filled here only when this container happens to carry
 * the named variable too. Otherwise the slot is reported empty with its variable named, and the
 * panel is where the key goes -- which is the design, not a shortfall: live keys go in through the
 * panel and the file is a bootstrap.
 */
async function proxySeed(args) {
  const dryRun = hasFlag(args, "--dry-run");
  const file = String(flag(args, "--file") ?? "") || path.join(process.cwd(), "deploy", "coolify", "proxy-config", "bootstrap.json");
  let plan;
  try { plan = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { return die(`could not read ${file}: ${String(error?.message ?? error)}`); }
  // THE FILE'S OWN SCHEMA, read as it is written rather than as this reader once assumed. Item A
  // shipped bootstrap.json with schemaVersion, a top-level credentials list and modelName on a plan
  // model; this function was reading version, provider.keys and alias, so on the R750 it stopped on
  // "version unknown" and would have written nothing had it got past that. tests/proxy-deploy.test.mjs
  // pins the file's shape, so the file is the contract and this is the side that moves.
  if (Number(plan?.schemaVersion) !== 1) die(`${file} is schema version ${plan?.schemaVersion ?? "unknown"}; this build seeds version 1`);

  // `let`, because the credential loop below changes it: a plan model's keys have to be checked
  // against the pool as it is AFTER the keys went in, not as it was before.
  let state = await askAdmin("GET", "/v1/admin/providers");
  // Plan models this pass could not create for want of a key. Named at the end, because an install
  // that stopped half way has to say what is left rather than exit 0 looking finished.
  const skipped = [];
  if (state.configured !== true) die(state.why || "this control plane has no proxy configured");
  // THE REFUSAL THAT MATTERS. With store_model_in_db off, a credential write answers 200 and really
  // persists while a deployment write answers 500, so a seed that ignored the flag would write half
  // a configuration and report success: green checkmarks on the half that did nothing.
  if (state.db.on === false) {
    die(`the proxy is not storing its model list in its database, so this seed would write half a configuration. ${state.db.why}`);
  }
  say(`seeding from ${file}${dryRun ? " (dry run, nothing is written)" : ""}`);

  // A provider that is already a preset in cp/proxy.mjs is registered by being a preset; the file
  // only has to register one that is not.
  for (const provider of plan.providers ?? []) {
    const existing = state.providers.find((row) => row.id === provider.id);
    if (existing != null) { say(`  provider ${provider.id}: already here`); continue; }
    say(`  provider ${provider.id}: register`);
    if (!dryRun) {
      await askAdmin("POST", "/v1/admin/providers", {
        id: provider.id,
        name: provider.name,
        // The file says what the vendor's API looks like; the route wants the litellm prefix a new
        // plan model gets, and openai-compatible is spelled openai there.
        kind: String(provider.kind ?? "openai") === "openai-compatible" ? "openai" : String(provider.kind ?? "openai"),
        baseUrl: String(provider.apiBase ?? ""),
        catalogBaseUrl: String(provider.catalog?.baseUrl ?? provider.apiBase ?? ""),
        catalogPath: String(provider.catalog?.path ?? ""),
        curated: Array.isArray(provider.curatedModels) ? provider.curatedModels : [],
      });
    }
  }

  // THE KEYS, from the environment names the file records and never from a value in the file. A
  // name this container does not carry is said out loud and skipped: the Providers panel is where
  // that key goes, and a seed that invented one would be worse than one that stopped.
  for (const slot of plan.credentials ?? []) {
    const name = String(slot.credentialName ?? "");
    const provider = String(slot.provider ?? "");
    if (state.providers.find((row) => row.id === provider)?.keys.some((row) => row.slot === name)) {
      say(`    ${name}: already holds a key`);
      continue;
    }
    const value = String(process.env[String(slot.env ?? "")] ?? "");
    if (value.length === 0) {
      say(`    ${name}: EMPTY. Its value would come from ${slot.env}, which this container does not carry. Add the key in the Providers panel.`);
      continue;
    }
    say(`    ${name}: adding a key from ${slot.env} (${evidenceLine(value)})`);
    if (!dryRun) {
      await askAdmin("POST", `/v1/admin/providers/${encodeURIComponent(provider)}/keys`, {
        slot: name, label: slot.label, order: slot.order, apiKey: value,
      });
    }
  }

  // The pool as it is NOW, after whatever keys this pass managed to add.
  if (!dryRun) state = await askAdmin("GET", "/v1/admin/providers");

  // The plan models in the file's own order, which is how a vision route comes before the model
  // that falls back to it: POST /fallback validates that its target exists.
  for (const model of plan.planModels ?? []) {
    const alias = String(model.modelName ?? "");
    // IN THE DATABASE, not merely being served. During the move the proxy serves the file's own
    // deployments AND the database's, and /model/info reports both, so "is this alias served" says
    // yes to a file row that stage 2 is about to delete. A plan model counts as seeded only when a
    // deployment behind it came out of the database, which is what fromDb answers.
    const already = state.planModels.find((row) => row.alias === alias);
    if (already != null && (already.deployments ?? []).some((row) => row.fromDb === true)) {
      say(`  ${alias}: already in the database`);
      continue;
    }
    if (already != null) say(`  ${alias}: served from the file only, so it is created in the database now`);
    const slots = Array.isArray(model.credentials) ? model.credentials.map(String) : [];
    // A PLAN MODEL WITH NO KEY IS SKIPPED, NOT A DEATH.
    //
    // This is the fresh-install path and it used to end here. The keys in bootstrap.json are named
    // by their environment variable, those variables live on the PROXY service, and the container
    // this command runs in is the CONTROL PLANE, which deliberately carries no vendor key at all --
    // that is the whole point of the panel. So on a genuinely fresh install every credential slot
    // is skipped with a line above, and then every plan model asked the panel to create a
    // deployment on a slot that holds nothing, got 502, and `api()` turned that into a die. The
    // operator was left with a proxy serving no plan model, which also refuses to mint the first
    // tenant ("the proxy serves no plan models, so there is nothing to mint a key against").
    //
    // The install is therefore TWO PASSES and says so: seed, add the keys in the Providers panel,
    // seed again. docs/PROXY.md section 4 carries the same order. A skip is a named line, not
    // silence, because an install that quietly did half its work is worse than one that stopped.
    const present = new Set((state.providers.find((row) => row.id === String(model.provider))?.keys ?? []).map((row) => String(row.slot)));
    const missing = slots.filter((slot) => !present.has(slot));
    if (slots.length > 0 && missing.length === slots.length) {
      say(`  ${alias}: SKIPPED. Not one of its keys (${slots.join(", ")}) is in the pool yet.`);
      say(`     Add the key in the Providers panel at ${BASE.replace(/\/$/, "")}/admin, then run this command again.`);
      skipped.push(alias);
      continue;
    }
    if (missing.length > 0) say(`  ${alias}: ${missing.join(", ")} holds no key yet, so it is created on the rest and you can add it later from the panel`);
    const usable = slots.filter((slot) => present.has(slot));
    say(`  ${alias}: create on ${model.vendorModel} across ${usable.join(", ") || "every key this provider has"}`);
    if (!dryRun) {
      const made = await askAdmin("POST", "/v1/admin/plan-models", {
        alias,
        provider: model.provider,
        vendorModel: model.vendorModel,
        keySlots: usable,
        customerName: model.customerName,
        customerLabel: model.customerLabel,
        servedBy: model.servedBy,
        customerVisible: model.customerVisible,
        supportsVision: model.supportsVision,
        visionFallback: model.visionFallback,
        contextWindow: model.contextWindow,
        plans: model.plans,
      });
      for (const row of made.deployments ?? []) if (!row.ok) say(`    ${row.slot}: NOT created, ${row.why}`);
    }
  }

  // The fallback map is set by each plan model's own visionFallback as it is created, which is the
  // order POST /fallback needs. This loop is the check that it landed, not a second way to write it.
  for (const pair of plan.fallbacks ?? []) {
    const after = await askAdmin("GET", "/v1/admin/providers");
    const row = after.planModels.find((one) => one.alias === String(pair.model ?? ""));
    const wanted = String((pair.fallbackModels ?? [])[0] ?? "");
    if (dryRun) { say(`  fallback ${pair.model} -> ${wanted}: would be set when ${pair.model} is created`); continue; }
    say(`  fallback ${pair.model} -> ${wanted}: ${row?.visionFallback === wanted ? "set" : `NOT set, the proxy says ${row?.visionFallback || "nothing"}`}`);
  }
  say("");
  if (skipped.length > 0) {
    // THE SECOND PASS, named with the command that finishes it. A fresh install is meant to end
    // here the first time: the control plane carries no vendor key, so the first pass registers the
    // providers and stops, and the keys go in through the panel like every other key ever will.
    say(`${skipped.length} plan model(s) were not created because their keys are not in the pool yet: ${skipped.join(", ")}`);
    say(`Add each key at ${BASE.replace(/\/$/, "")}/admin under Providers, then run this command again. It only creates what is missing.`);
    say("Until they exist the proxy serves no plan model, and a new workspace cannot be minted against one.");
  }
  say(dryRun ? "nothing was written" : "done. Run proxy providers to see what is there now.");
}

async function proxyKey(args) {
  const [action, target] = positional(args);
  const providers = () => askAdmin("GET", "/v1/admin/providers");
  if (action === "add") {
    if (!target) die("usage: node cp/cli.mjs proxy key add <provider> [--label \"subscription two\"] [--slot <name>]");
    const apiKey = await readSecret(`Key for ${target}: `);
    const answer = await askAdmin("POST", `/v1/admin/providers/${encodeURIComponent(target)}/keys`, {
      apiKey, label: String(flag(args, "--label") ?? "") || undefined, slot: String(flag(args, "--slot") ?? "") || undefined,
    });
    say(`${answer.slot}  ${answer.evidence}`);
    return say(answer.message);
  }
  if (action === "roll") {
    if (!target) die("usage: node cp/cli.mjs proxy key roll <slot>");
    const state = await providers();
    const provider = state.providers.find((row) => row.keys.some((key) => key.slot === target));
    if (provider == null) die(`there is no key in slot ${target}`);
    const apiKey = await readSecret(`New key for ${target}: `);
    const answer = await askAdmin("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(target)}/roll`, { apiKey });
    say(`${target}  ${answer.evidence}`);
    return say(answer.message);
  }
  if (action === "park" || action === "unpark") {
    if (!target) die(`usage: node cp/cli.mjs proxy key ${action} <slot>`);
    const state = await providers();
    const provider = state.providers.find((row) => row.keys.some((key) => key.slot === target));
    if (provider == null) die(`there is no key in slot ${target}`);
    const answer = await askAdmin("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(target)}/park`, { parked: action === "park" });
    return say(answer.message);
  }
  if (action === "remove") {
    if (!target) die("usage: node cp/cli.mjs proxy key remove <slot> --confirm <slot>");
    const state = await providers();
    const provider = state.providers.find((row) => row.keys.some((key) => key.slot === target));
    if (provider == null) die(`there is no key in slot ${target}`);
    // The same typed confirmation the console takes, for the same reason: this is a decision and
    // not a click.
    const answer = await askAdmin("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(target)}/remove`, { confirm: String(flag(args, "--confirm") ?? "") });
    return say(answer.message);
  }
  if (action === "quota") {
    if (!target) die("usage: node cp/cli.mjs proxy key quota <slot> --total 40000 --unit \"thousands of tokens\" [--window \"7 days\"] [--reset <iso>]");
    const state = await providers();
    const provider = state.providers.find((row) => row.keys.some((key) => key.slot === target));
    if (provider == null) die(`there is no key in slot ${target}`);
    const answer = await askAdmin("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(target)}/quota`, {
      total: Number(flag(args, "--total") ?? 0),
      unit: String(flag(args, "--unit") ?? ""),
      window: String(flag(args, "--window") ?? ""),
      resetAt: String(flag(args, "--reset") ?? ""),
    });
    return say(answer.message);
  }
  return die("usage: node cp/cli.mjs proxy key add|roll|park|unpark|remove|quota");
}

async function proxyModel(args) {
  const [action, alias, ...rest] = positional(args);
  const flags = () => ({
    ...(flag(args, "--vendor-model") === null ? {} : { vendorModel: String(flag(args, "--vendor-model")) }),
    ...(flag(args, "--name") === null ? {} : { customerName: String(flag(args, "--name")) }),
    ...(flag(args, "--label") === null ? {} : { customerLabel: String(flag(args, "--label")) }),
    ...(flag(args, "--served-by") === null ? {} : { servedBy: String(flag(args, "--served-by")) }),
    ...(flag(args, "--context") === null ? {} : { contextWindow: Number(flag(args, "--context")) }),
    ...(flag(args, "--vision-fallback") === null ? {} : { visionFallback: String(flag(args, "--vision-fallback")) }),
    ...(hasFlag(args, "--vision") ? { supportsVision: true } : {}),
    ...(hasFlag(args, "--hidden") ? { customerVisible: false } : {}),
  });
  if (action === "add") {
    if (!alias) die("usage: node cp/cli.mjs proxy model add <alias> --provider <id> --vendor-model <model> --name \"...\" --label \"...\" [--context 200000] [--vision-fallback <alias>] [--vision] [--hidden] [--keys a,b]");
    const answer = await askAdmin("POST", "/v1/admin/plan-models", {
      alias,
      provider: String(flag(args, "--provider") ?? ""),
      ...(flag(args, "--keys") === null ? {} : { keySlots: String(flag(args, "--keys")).split(",").map((one) => one.trim()).filter(Boolean) }),
      ...flags(),
    });
    for (const row of answer.deployments ?? []) say(`  ${pad(row.slot, 12)}${row.ok ? row.id : `NOT created: ${row.why}`}`);
    return say(answer.message);
  }
  if (action === "set") {
    if (!alias) die("usage: node cp/cli.mjs proxy model set <alias> [--vendor-model <model>] [--label \"...\"] [--name \"...\"] [--context n] [--vision-fallback <alias>] [--hidden]");
    const answer = await askAdmin("POST", `/v1/admin/plan-models/${encodeURIComponent(alias)}/update`, {
      ...(flag(args, "--provider") === null ? {} : { provider: String(flag(args, "--provider")) }),
      ...flags(),
    });
    return say(answer.message);
  }
  if (action === "apply") {
    if (!alias) die("usage: node cp/cli.mjs proxy model apply <alias>");
    const answer = await askAdmin("POST", `/v1/admin/plan-models/${encodeURIComponent(alias)}/apply`, {});
    for (const row of answer.rows ?? []) say(`  ${pad(row.slug, 20)}${row.ok ? "scoped" : `NOT scoped: ${row.why}`}`);
    return say(answer.message);
  }
  if (action === "vision-check") {
    if (!alias) die("usage: node cp/cli.mjs proxy model vision-check <alias>");
    const answer = await askAdmin("POST", `/v1/admin/plan-models/${encodeURIComponent(alias)}/vision-check`, {});
    return say(answer.message);
  }
  if (action === "push-label") {
    if (!alias) die("usage: node cp/cli.mjs proxy model push-label <alias> <slug> [<slug>...]");
    // Named workspaces only, and the route refuses without them. The door it drives sets the MODEL
    // as well as the label, so pushed at a box running something else it would move that customer.
    const answer = await askAdmin("POST", `/v1/admin/plan-models/${encodeURIComponent(alias)}/push-label`, { slugs: rest });
    for (const row of answer.workspaces ?? []) say(`  ${pad(row.slug, 20)}${row.ok ? "told" : `NOT told: ${row.why}`}`);
    return say(answer.message);
  }
  if (action === "remove") {
    if (!alias) die("usage: node cp/cli.mjs proxy model remove <alias> --confirm <alias>");
    const answer = await askAdmin("POST", `/v1/admin/plan-models/${encodeURIComponent(alias)}/remove`, { confirm: String(flag(args, "--confirm") ?? "") });
    return say(answer.message);
  }
  return die("usage: node cp/cli.mjs proxy model add|set|apply|vision-check|push-label|remove");
}

async function proxyCatalog(args) {
  const [action, provider] = positional(args);
  if (action !== "refresh" || !provider) die("usage: node cp/cli.mjs proxy catalog refresh <provider>");
  const answer = await askAdmin("POST", `/v1/admin/providers/${encodeURIComponent(provider)}/catalog/refresh`, {});
  say(`${answer.models.length} name(s) ${answer.live ? `read from the vendor just now` : "from the curated list"}`);
  say(answer.models.join(", "));
  if (answer.why) say(answer.why);
  say(answer.note);
}

async function proxyDefaultModel(args) {
  const [alias] = positional(args);
  if (alias === undefined) {
    const state = await askAdmin("GET", "/v1/admin/providers");
    return say(`new workspaces get ${state.defaults.planModel || "whatever the proxy serves"}`);
  }
  const answer = await askAdmin("POST", "/v1/admin/defaults", { planModel: alias === "none" ? "" : alias });
  return say(answer.message);
}

// Putting one customer back the way they were, from the snapshot the migration took. Kept for the
// first week and then deleted in a follow-up: from the migration onward the proxy is a single point
// of failure for every tenant's inference, and that is a change in the failure model rather than
// just in where a key lives.
async function proxyRollback(args) {
  const store = openLedger();
  try {
    for (const row of proxyTargets(store, args)) {
      const answer = await askRelay("POST", `/admin/tenants/${encodeURIComponent(row.slug)}/rollback-included`, {});
      out(`${pad(row.slug, 20)}${answer.restoredFrom ? `restored from ${answer.restoredFrom}` : String(answer.message ?? "restored")}`);
      out("  it takes effect on that workspace's next message, with no restart and no recreate");
    }
  } finally { store.close(); }
}

// Verified here rather than at the service when CP_SESSION_SECRET is in the environment, because
// that is the check a relay does and this is the way to reproduce it by hand. Without the secret it
// asks the service instead.
//
// CP_SESSION_SECRET here is the MASTER. Each tenant's relay holds only its own derived key, so the
// key this checks with is derived from the tenant the token names, which is what the control plane
// signed with. Pointing this at a tenant's own key instead would only verify that tenant's tokens.
async function sessionVerify(args) {
  const [token] = positional(args);
  if (!token) die("usage: node cp/cli.mjs session verify <token>");
  if (config.sessionSecret) {
    const now = Date.now();
    const claimed = tenantOfUnverifiedToken(token);
    if (claimed.length === 0) return die("this is not a session token from this service", 2);
    const verdict = verifySessionToken(token, tenantSessionSecret(config.sessionSecret, claimed), now);
    if (!verdict.ok) {
      const said = { malformed: "this is not a session token from this service", bad_signature: `the signature does not match the key for tenant ${claimed}`, expired: "this session has expired" };
      return die(said[verdict.reason] ?? verdict.reason, 2);
    }
    const left = Math.round((verdict.payload.exp - now) / 60000);
    out(JSON.stringify(verdict.payload, null, 2));
    out(`valid, expires ${new Date(verdict.payload.exp).toISOString()} (${left} minutes from now)`);
    return undefined;
  }
  let response;
  try { response = await fetch(`${BASE}/v1/sessions/current`, { headers: { authorization: `Bearer ${token}` } }); }
  catch (error) { return die(`could not reach the control plane at ${BASE}: ${String(error?.message ?? error)}`); }
  if (!response.ok) return die("that session is not valid", 2);
  const answer = await response.json();
  out(JSON.stringify(answer, null, 2));
  out("valid");
  return undefined;
}

// ---- what the agents reported (FEEDBACK-1) -----------------------------------------------------
//
// Everything here goes over the api through askAdmin, so it keeps the same rules the console keeps
// and writes the same admin_actions row with `via` reading cli. The digest is a command today and a
// timer later, deliberately: a digest nobody has read once is not a thing to put on a schedule.
//
// THE REPOSITORY TOKEN IS NEVER AN ARGUMENT, the same as every provider key: it is read off the
// terminal with the echo off, or off stdin, and what this prints is a length and eight characters
// of a digest.

/** "7d", "24h", "30" (days) or an ISO date, as a millisecond stamp. */
function sinceMs(value) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return 0;
  const match = /^(\d+)([dh])?$/.exec(raw);
  if (match != null) {
    const n = Number(match[1]);
    return Date.now() - n * (match[2] === "h" ? 3600_000 : 86_400_000);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

const feedbackQuery = (args) => {
  const query = new URLSearchParams();
  for (const name of ["tier", "state", "tenant"]) {
    const value = flag(args, `--${name}`);
    if (value) query.set(name, String(value));
  }
  const since = flag(args, "--since");
  if (since) query.set("since", String(sinceMs(since)));
  query.set("limit", String(flag(args, "--limit") ?? 200));
  return query;
};

async function feedbackList(args) {
  const answer = await askAdmin("GET", `/v1/admin/feedback?${feedbackQuery(args).toString()}`);
  say(`${answer.total} report(s) on record: ${answer.counts.new} new, ${answer.counts.criticalNew} critical and unread, ${answer.counts.filed} filed`);
  say(answer.github.stored ? `issues are filed in ${answer.github.repo} (token ${answer.github.evidence})` : answer.github.why);
  say("");
  say(`${pad("ID", 6)}${pad("WHEN", 26)}${pad("WORKSPACE", 18)}${pad("TIER", 14)}${pad("STATE", 12)}TITLE`);
  for (const row of answer.rows) {
    say(`${pad(String(row.id), 6)}${pad(row.at, 26)}${pad(row.tenant, 18)}${pad(row.tier, 14)}${pad(row.state, 12)}${row.title}`);
    if (row.issueUrl) say(`      ${row.issueUrl}`);
  }
  if (answer.rows.length === 0) say("nothing in this filter, which is a real answer and not an empty page");
}

async function feedbackShow(args) {
  const [id] = positional(args);
  if (!id) die("usage: node cp/cli.mjs feedback show <id>");
  const answer = await askAdmin("GET", `/v1/admin/feedback?limit=2000`);
  const row = (answer.rows ?? []).find((one) => String(one.id) === String(id));
  if (row == null) return die(`there is no report ${id}`, 2);
  say(`#${row.id}  ${row.at}  ${row.tenant}  ${row.tier}  ${row.state}`);
  if (row.agentName || row.agent) say(`reported by ${row.agentName || row.agent}`);
  if (row.issueUrl) say(row.issueUrl);
  say("");
  say(row.title);
  say("");
  say(row.body);
  if (row.payload) {
    say("");
    say("what the agent sent:");
    say(JSON.stringify(row.payload, null, 2));
  }
  return undefined;
}

const feedbackDecide = (verb) => async (args) => {
  const [id] = positional(args);
  if (!id) die(`usage: node cp/cli.mjs feedback ${verb} <id>`);
  const answer = await askAdmin("POST", `/v1/admin/feedback/${encodeURIComponent(id)}/${verb}`, {});
  say(String(answer.message ?? "done"));
};

async function feedbackIssue(args) {
  const [id] = positional(args);
  if (!id) die("usage: node cp/cli.mjs feedback issue <id>");
  const answer = await askAdmin("POST", `/v1/admin/feedback/${encodeURIComponent(id)}/issue`, {});
  if (answer.filed === true) return say(String(answer.message));
  // The prepared body, printed. The door is proven and the operator can paste it by hand today.
  say(String(answer.message));
  say("");
  say(String(answer.title ?? ""));
  say("");
  say(String(answer.body ?? ""));
  return undefined;
}

async function feedbackDigest(args) {
  const query = feedbackQuery(args);
  if (!query.get("tier")) query.set("tier", "quality");
  if (!query.get("since")) query.set("since", String(sinceMs("7d")));
  query.set("limit", "2000");
  const answer = await askAdmin("GET", `/v1/admin/feedback?${query.toString()}`);
  const rows = (answer.rows ?? []).map((row) => ({ ...row, at: Date.parse(row.at) }));
  say(buildDigest(rows, { tier: query.get("tier"), since: Number(query.get("since")) }));
}

async function feedbackGithubToken(args) {
  const [repo] = positional(args);
  if (!repo) die("usage: node cp/cli.mjs feedback github-token <owner/name>");
  const token = await readSecret(`Repository token for ${repo}: `);
  const answer = await askAdmin("POST", "/v1/admin/feedback/github-token", { repo, token });
  say(`${String(answer.message)} (${evidenceLine(token)})`);
  say(`checked with ${answer.checkedWith}`);
}

// ---- MARKET-26: the marketplace rows' vendor documentation ---------------------------------------
//
// Two verbs. `marketplace list` reads the state; `marketplace verify` re-reads the vendors' pages
// and writes the record. The run goes OVER THE API by default, so it happens inside the control
// plane's own container -- which is where the egress is, where the record belongs, and the only
// place a "verified today" line is worth anything. `--fixtures` and `--write` run here instead,
// because one reads files on this disk and the other edits a file in this repo.
//
// Neither verb spends anything. Every line printed says so, because the first question anybody
// sensibly asks of a job that talks to seven vendors every week is what it costs.

/** One row's state, said the way somebody reading a terminal wants it. */
const marketplaceStateWord = (state) => (state === "verified"
  ? "verified"
  : state === "needs-re-verification" ? "NEEDS RE-VERIFICATION" : state === "not-measured" ? "not measured" : String(state ?? "unknown"));

async function marketplaceList() {
  const answer = await askAdmin("GET", "/v1/marketplace/verification");
  if (answer.catalogProblem) say(`the catalog could not be read: ${answer.catalogProblem}`);
  const records = new Map((answer.records ?? []).map((record) => [String(record.rowId), record]));
  say(`${pad("ROW", 16)}${pad("CATEGORY", 12)}${pad("LAST RUN", 22)}${pad("STATE", 24)}${pad("FACTS", 7)}CUSTOMER SEES`);
  for (const row of answer.catalog ?? []) {
    const record = records.get(row.id);
    say(`${pad(row.id, 16)}${pad(row.category, 12)}${pad(record?.checkedOn ?? "never", 22)}${pad(marketplaceStateWord(record?.state ?? "never run"), 24)}${pad(String(row.docs.length), 7)}${row.customerSees}`);
  }
  const rollup = answer.rollup;
  say("");
  say(rollup == null
    ? "this job has not run in this container yet"
    : `last run ${rollup.ranAt} (${rollup.source}): ${rollup.verified.length} verified, ${rollup.needsReVerification.length} need re-verification, ${rollup.notMeasured.length} not measured, ${rollup.meteredRuns} metered runs`);
  if ((answer.ignores ?? []).length > 0) say(`ignored as boilerplate: ${answer.ignores.join("; ")}`);
  say("a customer's console reads the dates in the released bundle, so between releases their page goes by age; `marketplace verify --write` is what moves those dates");
}

async function marketplaceVerify(args) {
  const only = flag(args, "--row") ?? "";
  const useFixtures = args.includes("--fixtures");
  const write = args.includes("--write");

  if (useFixtures || write) {
    // Local, in this process. Fixtures read this disk; --write edits catalog.ts in this repo. Both
    // are developer verbs, and neither belongs on an HTTP route that a running service answers.
    const { fixtureFetcher, stampCatalogFile, verifyCatalog } = await import("./verification.mjs");
    const fixtures = flag(args, "--fixtures-dir") ?? new URL("../tests/fixtures/vendor-docs/", import.meta.url).pathname;
    const answer = await verifyCatalog({
      fetchDoc: useFixtures ? fixtureFetcher(fixtures) : undefined,
      source: useFixtures ? "fixtures" : "cli-local",
      only,
    });
    for (const record of answer.records) marketplaceSayRecord(record);
    if (write) {
      const stamped = stampCatalogFile(answer.records);
      say("");
      say(stamped.length === 0
        ? "nothing to stamp: every date in the catalog already matches what this run found"
        : `stamped ${stamped.length} doc ${stamped.length === 1 ? "fact" : "facts"} back into source/shared/marketplace/catalog.ts -- commit it, and the next release is what carries it to a customer`);
      for (const row of stamped) say(`  ${row.rowId} ${row.docId} -> ${row.state} ${row.checkedOn}`);
    }
    say("");
    say(`${answer.rollup.meteredRuns} metered runs: this reads documentation pages and never starts a browser`);
    return;
  }

  const answer = await askAdmin("POST", "/v1/marketplace/verification/run", only.length > 0 ? { row: only } : {});
  for (const record of answer.records ?? []) marketplaceSayRecord(record);
  say("");
  say(`${(answer.verified ?? []).length} verified, ${(answer.needsReVerification ?? []).length} need re-verification, ${(answer.notMeasured ?? []).length} not measured, ${answer.meteredRuns ?? 0} metered runs`);
}

/** One row, with every fact's source named and both sides of anything that moved. */
function marketplaceSayRecord(record) {
  say(`${record.name} (${record.rowId}): ${marketplaceStateWord(record.state)} on ${record.checkedOn}`);
  for (const doc of record.docs ?? []) {
    say(`  ${pad(doc.state, 16)}${pad(doc.id, 26)}${doc.url}`);
    if (doc.state === "changed") {
      say(`      we expect: ${doc.expected}`);
      say(`      the page now says: ${String(doc.found).slice(0, 200)}`);
    }
    if (doc.state === "unreadable") say(`      ${doc.reason}`);
  }
}

const USAGE = [
  "node cp/cli.mjs signup add <email> <company> [--name \"Jane Doe\"]",
  "node cp/cli.mjs account add <email> <tenant> [--name \"Jane Doe\"]",
  "node cp/cli.mjs account list",
  "node cp/cli.mjs account remove <email>",
  "node cp/cli.mjs account promote <email>",
  "node cp/cli.mjs account demote <email>",
  "node cp/cli.mjs tenant add <slug> <name> [--dry-run]",
  "node cp/cli.mjs tenant list",
  "node cp/cli.mjs tenant orphans",
  "node cp/cli.mjs tenant adopt <slug> <coolify-uuid> <host> [--box <container>] [--state <dir>] [--profile <dir>]",
  "node cp/cli.mjs proxy list",
  "node cp/cli.mjs proxy mint <slug|--all>",
  "node cp/cli.mjs proxy rotate <slug|--all>",
  "node cp/cli.mjs proxy revoke <slug|--all>",
  "node cp/cli.mjs proxy limits <slug|--all>",
  "node cp/cli.mjs proxy migrate <slug|--all> [--forget <sha256 prefix>] [--dry-run]",
  "node cp/cli.mjs proxy rollback <slug>",
  "node cp/cli.mjs proxy providers",
  "node cp/cli.mjs proxy seed [--file <path>] [--dry-run]",
  "node cp/cli.mjs proxy key add <provider> [--label \"subscription two\"] | roll <slot> | park <slot> | unpark <slot> | remove <slot> --confirm <slot> | quota <slot> --total n --unit \"...\"",
  "node cp/cli.mjs proxy model add <alias> --provider <id> --vendor-model <model> --name \"...\" --label \"...\" [--context n] [--vision-fallback <alias>] [--vision] [--hidden] [--keys a,b]",
  "node cp/cli.mjs proxy model set <alias> [--vendor-model <model>] [--label \"...\"] [--context n] [--hidden]",
  "node cp/cli.mjs proxy model apply <alias> | vision-check <alias> | push-label <alias> <slug>... | remove <alias> --confirm <alias>",
  "node cp/cli.mjs proxy catalog refresh <provider>",
  "node cp/cli.mjs proxy default-model [<alias>|none]",
  "node cp/cli.mjs mail list [<slug>]",
  "node cp/cli.mjs mail retire <code>",
  "node cp/cli.mjs mail senders <slug> | allow <slug> <address> | only <slug> on|off",
  "node cp/cli.mjs mail sends <slug>",
  "node cp/cli.mjs mail sweep",
  "node cp/cli.mjs feedback list [--tier critical|quality|observation] [--state new|approved|filed|suppressed|closed] [--tenant <slug>] [--since 7d]",
  "node cp/cli.mjs feedback show <id>",
  "node cp/cli.mjs feedback approve|suppress|close <id>",
  "node cp/cli.mjs feedback issue <id>",
  "node cp/cli.mjs feedback digest [--tier quality] [--since 7d]",
  "node cp/cli.mjs feedback github-token <owner/name>",
  "node cp/cli.mjs marketplace list",
  "node cp/cli.mjs marketplace verify [--row <id>] [--fixtures] [--write]",
  "node cp/cli.mjs session verify <token>",
  "",
  "signup add is the one line that adds a customer: account, workspace and box.",
  "proxy mint, rotate, revoke, limits, migrate and rollback run in this container: they read the tenant root and CP_PROXY_MASTER_KEY.",
  "proxy providers, seed, key, model, catalog and default-model go over the api, so they keep the same rules the console keeps and write the same record.",
  "a provider key is never an argument. These read it from the terminal with the echo off, or from stdin.",
  "proxy mint is the only way the operator's own workspace gets a key, because an adopted row is never re-provisioned.",
  "mail list shows the address each bot answers at. A code is minted once and never reused; retire kills one for good.",
  "mail sweep goes through the relay, because the roster lives inside a box and only the relay can read one.",
  "account promote makes somebody a super admin, which opens the console at /admin.",
  "feedback lists what the agents reported and their operators chose to send. Both gates already happened: approve, file or suppress.",
  "feedback github-token reads the token off the terminal, proves it against the repository, and prints a length and a hash. Never an argument.",
  "marketplace verify re-reads the vendor documentation the marketing rows depend on. It fetches pages and starts no browser, so it spends nothing.",
  "marketplace verify --write also stamps the corrected dates back into source/shared/marketplace/catalog.ts, which is how a flip reaches a customer at the next release.",
  "CP_ADMIN_TOKEN and CP_PUBLIC_URL come from the environment.",
].join("\n");

// ---- the per-bot mail directory (MAIL-2, docs/MAIL.md) -------------------------------------------
//
// The address every bot answers at is agent<code>@<domain>, six digits minted once per (workspace,
// bot) and never reused. These verbs are the operator's whole view of it: what exists, killing one,
// who is allowed to write to a workspace, and forcing a mint pass without waiting for the relay's
// five minute timer.
//
// NOTHING HERE DELETES A ROW. `retire` sets the state, because the row is the reservation: a code
// handed back to the pool could be minted for a different bot in a different workspace, and mail
// still addressed to the old one would then reach a stranger. Retiring kills the ADDRESS and not
// the bot, so the next sweep gives that bot a new one.
// EVERY MAIL VERB GOES OVER HTTP, like every other verb in this file. They used to open the sqlite
// store directly, which reads the right database only on the machine that holds it. On the R750 the
// store is inside the control plane container and the operator types this on his Mac, so `mail
// list` opened an empty file of its own and said "no addresses yet" over a live directory of nine
// (measured 2026-09-09 14:07Z, api.titanium.bot). Reading the service is also the only way these
// answers can agree with the console's.
async function mailList(args) {
  const slug = positional(args)[0] ?? null;
  const answer = await api("GET", slug ? `/v1/admin/mail?slug=${encodeURIComponent(slug)}` : "/v1/admin/mail");
  const rows = Array.isArray(answer?.rows) ? answer.rows : [];
  if (rows.length === 0) {
    out(slug ? `no addresses for ${slug} yet` : "no addresses yet");
    out("the relay mints them when it sweeps, which is at its start and every five minutes; `mail sweep` asks for one now");
    return;
  }
  // The bot's name is last because it is the one column with no length limit, so everything to
  // the left of it stays lined up however a customer names their bots.
  out(`${pad("code", 10)}${pad("address", 34)}${pad("workspace", 18)}${pad("state", 10)}bot`);
  for (const row of rows) {
    out(`${pad(row.code, 10)}${pad(row.address, 34)}${pad(row.tenant, 18)}${pad(row.state, 10)}${row.agentName || "(no name)"}`);
  }
  out(`${rows.length} address(es) at ${answer?.domain || mailDomain()}`);
}

async function mailRetire(args) {
  const code = positional(args)[0] ?? "";
  if (code.length === 0) die("node cp/cli.mjs mail retire <code>");
  const answer = await api("POST", "/v1/admin/mail/retire", { code }).catch(() => null);
  const row = answer?.retired ?? null;
  if (row == null) die(`no address holds the code ${code}`);
  out(`${row.address} is retired. Mail to it is refused from now on, and that code is never given to anybody else.`);
  out(`${row.agentName || "that bot"} gets a fresh address on the relay's next sweep, which is within five minutes.`);
}

async function mailSenders(args) {
  const [group, ...rest] = positional(args);
  // `mail senders <slug>` lists; `mail allow` and `mail only` are their own verbs below.
  const slug = group ?? "";
  if (slug.length === 0) die("node cp/cli.mjs mail senders <slug>");
  const answer = await api("GET", `/v1/admin/mail/senders?slug=${encodeURIComponent(slug)}`);
  const senders = Array.isArray(answer?.senders) ? answer.senders : [];
  out(`${slug}: ${answer?.approvedSendersOnly ? "only the addresses below can write to these bots" : "anybody can write to these bots (the default)"}`);
  for (const sender of senders) out(`  ${sender}`);
  if (senders.length === 0) out("  (nobody has been allowed yet)");
  void rest;
}

async function mailAllow(args) {
  const [slug, address] = positional(args);
  if (!slug || !address) die("node cp/cli.mjs mail allow <slug> <address>");
  const answer = await api("POST", "/v1/admin/mail/senders", { slug, sender: address }).catch(() => null);
  const row = answer?.allowed ?? null;
  if (row == null) die("name a workspace and an email address");
  out(`${row.sender} may write to ${slug}'s bots`);
  if (!answer?.approvedSendersOnly) {
    out("note: this workspace takes mail from anybody today, so the list is not being enforced. `mail only <slug> on` enforces it.");
  }
}

async function mailOnly(args) {
  const [slug, setting] = positional(args);
  if (!slug || !["on", "off"].includes(String(setting))) die("node cp/cli.mjs mail only <slug> on|off");
  const answer = await api("POST", "/v1/admin/mail/only", { slug, on: setting === "on" });
  const on = answer?.approvedSendersOnly === true;
  out(`${slug}: ${on ? "only allowed senders can write to these bots now" : "anybody can write to these bots now"}`);
  if (on) {
    out("WARNING: a verification mail from a site nobody has allowed yet will be refused. That is the shape that eats a first sign-up.");
    out(`allowed today: ${(Array.isArray(answer?.senders) ? answer.senders : []).join(", ") || "nobody"}`);
  }
  out("the relay picks this up on its next sweep, which is within five minutes");
}

// MAIL-3. What a workspace's bots have sent through the relay's send route. Over the API like every
// other verb in this section, for the reason written above it: on the R750 the rows are inside the
// control plane container and this is typed on a Mac, so a verb that opened the store would answer
// "nothing sent yet" over a live log and nothing would error.
//
// No subject on this list, because there is none in that table. The subject is the customer's and
// it is on their own console, beside the mail that arrived for them.
async function mailSends(args) {
  const slug = positional(args)[0] ?? "";
  if (slug.length === 0) die("node cp/cli.mjs mail sends <slug>");
  const answer = await api("GET", `/v1/mail/sends?slug=${encodeURIComponent(slug)}`);
  const rows = Array.isArray(answer?.rows) ? answer.rows : [];
  const caps = answer?.caps ?? {};
  if (rows.length === 0) {
    out(`${slug} has sent no mail yet`);
    out("bots send from their own address through the relay; every one of them lands here");
    return;
  }
  // The bot's name is last for the reason mail list gives: it is the one column with no length
  // limit, so everything to the left of it stays lined up however a customer names their bots.
  out(`${pad("when", 26)}${pad("code", 9)}${pad("to", 32)}${pad("outcome", 10)}${pad("resend id", 38)}bot`);
  for (const row of rows) {
    out(`${pad(row.at, 26)}${pad(row.code, 9)}${pad(row.to, 32)}${pad(row.outcome, 10)}${pad(row.resendId || "-", 38)}${row.agentName || row.agentId || "(unknown)"}`);
  }
  out(`${rows.length} send(s); the caps are ${caps.hourlyPerAgent ?? "?"} an hour for one bot and ${caps.dailyPerWorkspace ?? "?"} a day for the workspace`);
  out("a row reading `sending` is one nothing came back about, which counts against the cap until it does");
}

async function mailSweep() {
  const answer = await askRelay("POST", "/mail/sweep");
  for (const row of Array.isArray(answer?.swept) ? answer.swept : []) {
    out(`${pad(row.slug, 20)}${row.addresses} address(es), ${row.minted} minted this pass`);
  }
  out(answer?.directory?.ok
    ? `the relay re-read the directory: ${answer.directory.addresses} address(es)`
    : `the relay could not re-read the directory: ${answer?.directory?.why ?? "it did not say"}`);
}

const [group, action, ...rest] = process.argv.slice(2);
const commands = {
  "signup add": signupAdd,
  "account add": accountAdd,
  "account list": accountList,
  "account remove": accountRemove,
  "account promote": accountPromote,
  "account demote": accountDemote,
  "tenant add": tenantAdd,
  "tenant list": tenantList,
  "tenant orphans": tenantOrphans,
  "tenant adopt": tenantAdopt,
  "proxy list": proxyList,
  "proxy mint": proxyMint,
  "proxy rotate": proxyRotate,
  "proxy revoke": proxyRevoke,
  "proxy limits": proxyLimits,
  "proxy migrate": proxyMigrate,
  "proxy rollback": proxyRollback,
  "proxy providers": proxyProviders,
  "proxy seed": proxySeed,
  "proxy key": proxyKey,
  "proxy model": proxyModel,
  "proxy catalog": proxyCatalog,
  "proxy default-model": proxyDefaultModel,
  "mail list": mailList,
  "mail retire": mailRetire,
  "mail senders": mailSenders,
  "mail allow": mailAllow,
  "mail only": mailOnly,
  "mail sends": mailSends,
  "mail sweep": mailSweep,
  "feedback list": feedbackList,
  "feedback show": feedbackShow,
  "feedback approve": feedbackDecide("approve"),
  "feedback suppress": feedbackDecide("suppress"),
  "feedback close": feedbackDecide("close"),
  "feedback issue": feedbackIssue,
  "feedback digest": feedbackDigest,
  "feedback github-token": feedbackGithubToken,
  "marketplace list": marketplaceList,
  "marketplace verify": marketplaceVerify,
  "session verify": sessionVerify,
};
const command = commands[`${group} ${action}`];
if (!command) die(USAGE, 1);
await command(rest);
