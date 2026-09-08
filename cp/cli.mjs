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
import { createProxyClient, proxyKeyAlias } from "./proxy.mjs";
import { tenantOfUnverifiedToken, tenantSessionSecret, verifySessionToken } from "./session.mjs";
import { openStore } from "./store.mjs";
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
const VALUED_FLAGS = new Set(["--name", "--box", "--state", "--profile", "--forget"]);
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

async function api(method, pathname, body) {
  if (!config.adminToken) die("CP_ADMIN_TOKEN is not set. It is the operator password for this service.");
  const init = { method, headers: { authorization: `Bearer ${config.adminToken}`, accept: "application/json" } };
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
    if (config.proxyAllowanceUsd <= 0 && config.proxyRpmLimit <= 0) {
      out("neither CP_PROXY_ALLOWANCE_USD nor CP_PROXY_RPM_LIMIT is set on this control plane, so there is no ceiling to apply");
      out("set them on the titanbot-cp service and run this again");
      return;
    }
    out(`allowance ${config.proxyAllowanceUsd > 0 ? `$${config.proxyAllowanceUsd} ${config.proxyEnforce ? "enforced (max_budget)" : "observed (soft_budget)"}` : "none"}`);
    out(`rate limit ${config.proxyRpmLimit > 0 ? `${config.proxyRpmLimit} requests a minute per workspace` : "none"}`);
    out("");
    for (const row of proxyTargets(store, args)) {
      const record = readProxyKey(row.slug, config, { file: keyFileFor(store, row.slug) });
      if (record == null) { out(`${pad(row.slug, 20)}no key here yet; run proxy mint first`); continue; }
      const answer = await proxy.updateKey({
        key: record.key,
        allowanceUsd: config.proxyAllowanceUsd,
        enforce: config.proxyEnforce,
        rpmLimit: config.proxyRpmLimit,
      });
      out(`${pad(row.slug, 20)}${pad(record.alias, 26)}${answer.ok ? "applied" : `NOT applied: ${answer.why}`}`);
    }
    out("");
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
  "node cp/cli.mjs session verify <token>",
  "",
  "signup add is the one line that adds a customer: account, workspace and box.",
  "the proxy commands run in this container: they read the tenant root and CP_PROXY_MASTER_KEY, so they do not go over the api.",
  "proxy mint is the only way the operator's own workspace gets a key, because an adopted row is never re-provisioned.",
  "account promote makes somebody a super admin, which opens the console at /admin.",
  "CP_ADMIN_TOKEN and CP_PUBLIC_URL come from the environment.",
].join("\n");

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
  "session verify": sessionVerify,
};
const command = commands[`${group} ${action}`];
if (!command) die(USAGE, 1);
await command(rest);
