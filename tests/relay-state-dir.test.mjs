// TENANT-2, item 2. Where the relay's writable files go.
//
// The bug this closes is quiet and expensive. On a multi-tenant server every tenant's container
// mounts the same host ui/ directory, and every writable file the relay had defaulted to that
// directory: auth.json, endpoints.json, subscriptions.json, mail.json, mail-inbox.jsonl. Two
// tenants would share one password file and one mail inbox, and the mount could never be made read
// only, so a customer could edit the code the other customers run. SAND_UI_STATE_DIR moves those
// five into a directory that belongs to one instance.
//
// The half that matters just as much: unset, nothing moves. Jason's instance and every developer
// Mac keep writing beside the code, so a deploy that forgets the variable behaves the way it did
// yesterday instead of losing its password file.
//
// The module defaults are read at import time, so the three checks below that measure a real module
// run it in a child process with the environment already set. Reading the constant back in this
// process would only ever measure this process's environment.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stateDir, stateFile, STATE_DIR_ENV } from "../ui/state-dir.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERE = "/opt/titanbot/ui";

test("unset, a file is beside the code, which is every install that came before this", () => {
  for (const env of [{}, { SAND_UI_STATE_DIR: "" }, { SAND_UI_STATE_DIR: "   " }]) {
    assert.equal(stateDir(env), "");
    assert.equal(stateFile("auth.json", HERE, env), path.join(HERE, "auth.json"));
  }
});

test("set, every file comes out of the state directory instead", () => {
  const env = { SAND_UI_STATE_DIR: "/data/titanbot/demo/state" };
  for (const name of ["auth.json", "endpoints.json", "subscriptions.json", "mail.json", "mail-inbox.jsonl"]) {
    assert.equal(stateFile(name, HERE, env), path.join("/data/titanbot/demo/state", name));
  }
  // A stray space around a value typed into a compose file is invisible and would otherwise make a
  // directory called " /state".
  assert.equal(stateFile("auth.json", HERE, { SAND_UI_STATE_DIR: " /state " }), "/state/auth.json");
  // A relative value resolves against the working directory rather than being pasted onto HERE,
  // which is what any other relative path in a compose file does.
  assert.equal(stateFile("auth.json", HERE, { SAND_UI_STATE_DIR: "state" }), path.resolve("state", "auth.json"));
  assert.equal(STATE_DIR_ENV, "SAND_UI_STATE_DIR");
});

// Runs one expression in a child with the given environment and prints the answer, so the module
// constants are computed against that environment and not this one.
function resolvedIn(env, expression) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", expression], {
    cwd: repo,
    env: { ...process.env, SAND_UI_STATE_DIR: "", GROK_BOT_SUBSCRIPTIONS_FILE: "", GROK_BOT_MAIL_FILE: "",
      GROK_BOT_MAIL_LEDGER_FILE: "", SAND_UI_AUTH_FILE: "", SAND_UI_ENDPOINTS_FILE: "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

test("subscriptions.json and the two mail files follow the state directory, and their own env still wins", () => {
  const dir = "/data/titanbot/demo/state";
  const subs = 'import { STORE_FILE } from "./ui/subscriptions.mjs"; console.log(STORE_FILE);';
  const mail = 'import { MAIL_SETTINGS_FILE, MAIL_LEDGER_FILE } from "./ui/mail-edge.mjs"; console.log(MAIL_SETTINGS_FILE); console.log(MAIL_LEDGER_FILE);';

  assert.equal(resolvedIn({ SAND_UI_STATE_DIR: dir }, subs), path.join(dir, "subscriptions.json"));
  assert.deepEqual(resolvedIn({ SAND_UI_STATE_DIR: dir }, mail).split("\n"),
    [path.join(dir, "mail.json"), path.join(dir, "mail-inbox.jsonl")]);

  // Unset is the old answer: beside the code.
  assert.equal(resolvedIn({}, subs), path.join(repo, "ui", "subscriptions.json"));
  assert.deepEqual(resolvedIn({}, mail).split("\n"),
    [path.join(repo, "ui", "mail.json"), path.join(repo, "ui", "mail-inbox.jsonl")]);

  // And the per-file variables, which are older than the state directory and are what the gates and
  // the tests set to work in a temp directory, still win over both.
  assert.equal(resolvedIn({ SAND_UI_STATE_DIR: dir, GROK_BOT_SUBSCRIPTIONS_FILE: "/tmp/subs.json" }, subs), "/tmp/subs.json");
  assert.deepEqual(resolvedIn({ SAND_UI_STATE_DIR: dir, GROK_BOT_MAIL_FILE: "/tmp/m.json", GROK_BOT_MAIL_LEDGER_FILE: "/tmp/m.jsonl" }, mail).split("\n"),
    ["/tmp/m.json", "/tmp/m.jsonl"]);

  // An empty override is not a path. It is what a compose file writes for a variable that was
  // declared and never given a value, and the old `??` read it as the file called "": the store
  // would have been written to a file named nothing, in the working directory, silently.
  assert.equal(resolvedIn({ SAND_UI_STATE_DIR: dir, GROK_BOT_SUBSCRIPTIONS_FILE: "" }, subs), path.join(dir, "subscriptions.json"));
  assert.deepEqual(resolvedIn({ SAND_UI_STATE_DIR: dir, GROK_BOT_MAIL_FILE: "  ", GROK_BOT_MAIL_LEDGER_FILE: "" }, mail).split("\n"),
    [path.join(dir, "mail.json"), path.join(dir, "mail-inbox.jsonl")]);
});

test("the relay resolves auth.json and endpoints.json the same way, in the same order", () => {
  // These two live inside server.mjs, which starts a listener on import, so they are read out of the
  // source rather than by importing it. The shape is pinned rather than the whole line, so an edit
  // that drops the override or drops the state directory is caught either way.
  const source = readFileSync(path.join(repo, "ui/server.mjs"), "utf8");
  assert.match(source, /const AUTH_FILE = process\.env\.SAND_UI_AUTH_FILE\?\.trim\(\) \|\| stateFile\("auth\.json", HERE\)/);
  // endpoints.json is per tenant since TENANT-5, so the shape to pin is the pair: the operator's
  // override still wins, and every other tenant's file comes out of its own state directory.
  assert.match(source, /const ENDPOINTS_OVERRIDE = process\.env\.SAND_UI_ENDPOINTS_FILE\?\.trim\(\) \|\| ""/);
  assert.match(source, /endpointsFile: entry\.operator && ENDPOINTS_OVERRIDE\.length > 0 \? ENDPOINTS_OVERRIDE : file\("endpoints\.json"\)/);
  // tenantFile is what puts the operator's own files through stateFile (the per-file override, then
  // SAND_UI_STATE_DIR, then beside the code) and a tenant's into its own state directory.
  assert.match(source, /const file = \(name\) => tenantFile\(entry, name, \{ here: HERE, stateFile \}\)/);
  // The job bus token is the one writable file that does NOT move: it was never beside the code, it
  // lives in the first SAND_PROFILE_DIRS entry, which is already the tenant's own profile mount.
  assert.match(source, /await writeFile\(file, JSON\.stringify\(\{ token \}\)/);
  assert.equal(source.includes('stateFile("job-bus.json"'), false);
});

// The one that proves it end to end: a relay whose password lives in the state directory and
// nowhere else. If AUTH_FILE did not follow, this relay would find no auth.json, and a relay with no
// password on a non-loopback address refuses to start at all -- but on loopback it would come up
// wide open and answer "auth none", which is the failure the assertion below names.
test("a relay reads its password out of the state directory and says so on the way up", async () => {
  const { copyFileSync, readdirSync } = await import("node:fs");
  const { newAuthRecord, writeAuthFile } = await import("../ui/auth.mjs");
  const code = mkdtempSync(path.join(tmpdir(), "relay-state-code-"));
  for (const name of readdirSync(path.join(repo, "ui")).filter((f) => f.endsWith(".mjs"))) {
    copyFileSync(path.join(repo, "ui", name), path.join(code, name));
  }
  const state = mkdtempSync(path.join(tmpdir(), "relay-state-dir-"));
  writeAuthFile(path.join(state, "auth.json"), newAuthRecord("a password no test types"));
  // Deliberately NOT beside the code: nothing must be able to fall back to it.
  assert.equal(readdirSync(code).includes("auth.json"), false);

  const { spawn } = await import("node:child_process");
  const lines = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(code, "server.mjs")], {
      env: { ...process.env, SAND_UI_PORT: "0", SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_UI_AUTH_FILE: "", SAND_UI_STATE_DIR: state, SAND_HOST_GATEWAY_TOKEN: "not-a-real-token" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("tnnt ")) { child.kill("SIGKILL"); resolve(out); } });
    child.on("exit", () => resolve(out));
    setTimeout(() => { child.kill("SIGKILL"); resolve(out); }, 15_000).unref();
  });
  assert.match(lines, /auth password login/, `it came up with no password: ${lines}`);
  assert.match(lines, new RegExp(`state ${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  // And a state directory that does not exist yet is made rather than met on the first write, which
  // is a person clicking Save in the console and getting an unexplained 500.
  const missing = path.join(state, "not", "made", "yet");
  writeFileSync(path.join(code, "auth.json"), readFileSync(path.join(state, "auth.json")));
  const made = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(code, "server.mjs")], {
      env: { ...process.env, SAND_UI_PORT: "0", SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_UI_AUTH_FILE: path.join(code, "auth.json"), SAND_UI_STATE_DIR: missing,
        SAND_HOST_GATEWAY_TOKEN: "not-a-real-token" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("tnnt ")) { child.kill("SIGKILL"); resolve(out); } });
    child.on("exit", () => resolve(out));
    setTimeout(() => { child.kill("SIGKILL"); resolve(out); }, 15_000).unref();
  });
  assert.match(made, /auth password login/, `it did not come up: ${made}`);
  const { statSync } = await import("node:fs");
  assert.equal(statSync(missing).isDirectory(), true, "the state directory is made at boot");
});
