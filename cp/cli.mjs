#!/usr/bin/env node
// cp/cli.mjs -- the operator's side of the control plane.
//
//   node cp/cli.mjs signup add <email> <company> [--name "Jane Doe"]
//   node cp/cli.mjs account add <email> <tenant> [--name "Jane Doe"]
//   node cp/cli.mjs account list
//   node cp/cli.mjs tenant add <slug> <name> [--dry-run]
//   node cp/cli.mjs tenant list
//   node cp/cli.mjs tenant adopt <slug> <coolify-uuid> <host> [--box <container>] [--state <dir>] [--profile <dir>]
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

import { loadConfig, validateSlug } from "./provision.mjs";
import { tenantOfUnverifiedToken, tenantSessionSecret, verifySessionToken } from "./session.mjs";

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
const VALUED_FLAGS = new Set(["--name", "--box", "--state", "--profile"]);
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

const pad = (value, width) => String(value ?? "").padEnd(width);

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
  out(`${pad("EMAIL", 34)}${pad("TENANT", 20)}NAME`);
  for (const account of answer.accounts) out(`${pad(account.email, 34)}${pad(account.tenant, 20)}${account.name}`);
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
    out(`${pad(tenant.slug, 20)}${pad(tenant.boxContainer ?? "(none)", 34)}${pad(tenant.status, 14)}${pad(tenant.coolify?.status ?? "unknown", 14)}${tenant.coolifyServiceUuid ?? ""}`);
    if (tenant.lastError) out(`  last error: ${tenant.lastError}`);
  }
  out("");
  out(`everybody signs in at https://${answer.tenants[0].host}`);
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
  "node cp/cli.mjs tenant add <slug> <name> [--dry-run]",
  "node cp/cli.mjs tenant list",
  "node cp/cli.mjs tenant adopt <slug> <coolify-uuid> <host> [--box <container>] [--state <dir>] [--profile <dir>]",
  "node cp/cli.mjs session verify <token>",
  "",
  "signup add is the one line that adds a customer: account, workspace and box.",
  "CP_ADMIN_TOKEN and CP_PUBLIC_URL come from the environment.",
].join("\n");

const [group, action, ...rest] = process.argv.slice(2);
const commands = {
  "signup add": signupAdd,
  "account add": accountAdd,
  "account list": accountList,
  "tenant add": tenantAdd,
  "tenant list": tenantList,
  "tenant adopt": tenantAdopt,
  "session verify": sessionVerify,
};
const command = commands[`${group} ${action}`];
if (!command) die(USAGE, 1);
await command(rest);
