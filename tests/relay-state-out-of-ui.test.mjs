// The operator's own secrets do not live in the directory every customer mounts.
//
// /home/sem/titanbot/ui is the shared release directory: every tenant's relay mounts it, and the
// operator's auth.json, endpoints.json and subscriptions.json sat in there beside the code. The
// mount is read-only, which stops a customer WRITING them and does nothing about reading them.
// Measured inside the demo tenant's relay on the R750, 2026-09-07, running as root: /app/ui/auth.json
// (this console's password hash and the cookie secret that signs its sessions), /app/ui/endpoints.json
// (the provider API keys) and /app/ui/subscriptions.json (the adopted provider tokens) were all
// readable. No console route serves those paths today, so it was one file-read bug away rather than
// open; the answer is that ui/ holds nothing but code.
//
// Two halves here: the compose that points this instance's writes somewhere else, and the script
// that moves the files, which must never be the step that loses a password.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderCompose } from "../cp/provision.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = path.join(repo, "deploy/coolify/docker-compose.yml");
const SCRIPT = path.join(repo, "deploy/r750/move-relay-state.sh");
const FILES = ["auth.json", "endpoints.json", "subscriptions.json", "mail.json", "mail-inbox.jsonl"];

test("the operator's own compose writes its state somewhere the tenants do not mount", () => {
  const compose = readFileSync(COMPOSE, "utf8");
  assert.match(compose, /^ {6}SAND_UI_STATE_DIR: \/state$/m);
  assert.match(compose, /^ {6}- \/home\/sem\/titanbot\/state:\/state$/m);
  // A directory, never a bind to a single file: Coolify reads a single-file bind into its own
  // database, and the file it would read is the one with the password hash in it.
  assert.equal(/- \/home\/sem\/titanbot\/(ui|state)\/[^:]*\.json:/.test(compose), false);
});

test("a tenant's render keeps exactly one state directory, and it is the tenant's own", () => {
  // The base file now carries the operator's. Left in, a tenant would have two SAND_UI_STATE_DIR
  // keys in one environment block, which docker will not read, and two mounts on /state, which is
  // a container that will not start.
  const rendered = renderCompose({
    slug: "acme",
    config: { releaseRoot: "/home/sem/titanbot", tenantRoot: "/data/titanbot", publicUrl: "https://api.titanium.bot", baseDomain: "titanium.bot" },
  });
  assert.equal((rendered.match(/^ *SAND_UI_STATE_DIR:/gm) ?? []).length, 1);
  assert.equal((rendered.match(/^ *- .*:\/state$/gm) ?? []).length, 1);
  assert.match(rendered, /^ *- \/data\/titanbot\/acme\/state:\/state$/m);
  assert.equal(rendered.includes("/home/sem/titanbot/state:/state"), false,
    "no tenant may mount the operator's own state directory");
  // And the shared release directory is still there, still read-only, still the code.
  assert.match(rendered, /- \/home\/sem\/titanbot\/ui:\/app\/ui:ro/);
});

function world() {
  const root = mkdtempSync(path.join(tmpdir(), "relay-state-"));
  mkdirSync(path.join(root, "ui"), { recursive: true });
  for (const name of FILES) writeFileSync(path.join(root, "ui", name), `${name} as it was\n`);
  writeFileSync(path.join(root, "ui", "server.mjs"), "// code\n");
  return root;
}

const run = (root, stage) =>
  execFileSync("bash", [SCRIPT, ...(stage ? [stage] : [])], { env: { ...process.env, TITANBOT_ROOT: root }, encoding: "utf8" });

test("the copy stage copies and removes nothing, so it is safe on a live console", () => {
  const root = world();
  try {
    const out = run(root);
    for (const name of FILES) {
      assert.ok(existsSync(path.join(root, "state", name)), `${name} is in state/`);
      assert.ok(existsSync(path.join(root, "ui", name)), `${name} is still in ui/, because nothing is removed yet`);
      assert.equal(readFileSync(path.join(root, "state", name), "utf8"), `${name} as it was\n`);
    }
    assert.match(out, /nothing was removed and nothing running has changed/);
    // Run it again: the same answer, no second copy, no complaint.
    assert.match(run(root), /is already in state\/ and identical/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the clean stage removes the originals only when the copies are identical", () => {
  const root = world();
  try {
    run(root);
    const out = run(root, "clean");
    for (const name of FILES) {
      assert.equal(existsSync(path.join(root, "ui", name)), false, `${name} is out of ui/`);
      assert.ok(existsSync(path.join(root, "state", name)));
    }
    assert.match(out, /ui\/ is code now/);
    // The code is untouched, which is the half a tenant is supposed to mount.
    assert.ok(existsSync(path.join(root, "ui", "server.mjs")));
    // And running it again is a sentence, not an error.
    assert.match(run(root, "clean"), /nothing to remove/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clean refuses rather than being the step that loses a password", () => {
  // The two ways this could go wrong, and the only two that matter: the copy was never made, and
  // the relay has been writing to one of the pair since it was.
  const missing = world();
  try {
    assert.throws(() => run(missing, "clean"), (error) => {
      assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, /run the copy stage first/);
      return true;
    });
    for (const name of FILES) assert.ok(existsSync(path.join(missing, "ui", name)), `${name} was not removed`);
  } finally { rmSync(missing, { recursive: true, force: true }); }

  const drifted = world();
  try {
    run(drifted);
    writeFileSync(path.join(drifted, "ui", "endpoints.json"), "a model the operator added after the copy\n");
    assert.throws(() => run(drifted, "clean"), (error) => {
      assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, /are different; the relay has been writing/);
      return true;
    });
    assert.ok(existsSync(path.join(drifted, "ui", "endpoints.json")));
    assert.ok(existsSync(path.join(drifted, "ui", "auth.json")), "one drifted file stops the whole stage");
  } finally { rmSync(drifted, { recursive: true, force: true }); }

  // And a copy that would overwrite a DIFFERENT file already in state/ is refused too, because the
  // one in state/ is the one the relay is running on.
  const clash = world();
  try {
    mkdirSync(path.join(clash, "state"), { recursive: true });
    writeFileSync(path.join(clash, "state", "auth.json"), "the password this console is running on\n");
    assert.throws(() => run(clash), (error) => {
      assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, /already exists and is DIFFERENT/);
      return true;
    });
    assert.equal(readFileSync(path.join(clash, "state", "auth.json"), "utf8"), "the password this console is running on\n");
  } finally { rmSync(clash, { recursive: true, force: true }); }
});

test("sync.sh puts the script on the server, because that is where it runs", () => {
  const sync = readFileSync(path.join(repo, "deploy/r750/sync.sh"), "utf8");
  assert.match(sync, /move-relay-state\.sh/);
});
