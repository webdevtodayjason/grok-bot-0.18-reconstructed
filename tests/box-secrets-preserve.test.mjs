// PROXY-1. Two live hazards in one file, both measured in source before a line was changed, and
// both of them destroy a customer's inference the moment the endpoint pin becomes the thing that
// carries the plan's credential.
//
// The file is /home/box/sand-data/box-secrets.json, and it has TWO writers with two different
// ideas of what it holds:
//
//   the relay      writes the endpoint pin -- SAND_OPENAI_COMPATIBLE_BASE_URL, _MODEL, _API_KEY,
//                  _ENDPOINT_NAME, _CONTEXT_WINDOW, _SERVED_BY -- straight into the file, because
//                  the host re-reads it with readFileSync on every turn and the gateway's own
//                  setBoxSecrets refuses SAND_-prefixed names.
//   this applier   writes the OPERATOR's box secrets, the ones a desktop window's shell needs.
//
//   1. persist() wrote `{version: 1, secrets: this.desired}` and setSecrets replaced `desired`
//      wholesale, so ONE setBoxSecrets call from the desktop app deleted the pin. Today that
//      un-pins a model. After this wave it deletes the base URL and the virtual key, and that
//      customer's Titan stops answering until somebody notices.
//
//   2. applyPersisted() returned early when validateBoxSecrets failed, and
//      RESERVED_BOX_SECRET_PREFIXES contains "SAND_" -- exactly what the relay writes there. So
//      startup re-application was already dead on every box that has ever used the model picker,
//      silently: the box came up, the store was read, the whole document was refused, and the
//      operator's own secrets never reached the box environment.
//
// Both fixes are the shape the other credential plane already has: withShellSecretsPreserved
// (source/host/extensions/shell-tools/shell-secrets.js) carries the store it is not writing along
// with the push, rather than letting one plane's save clear the other's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// secrets-service.ts reaches the scheduling policies, the shared box-secrets rules and the host
// paths, so it is exercised through a real bundle rather than a single-file transform.
async function loadSecretsService() {
  const outfile = path.join(repoRoot, `.tmp-box-secrets-${randomUUID()}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/secrets/secrets-service.ts")],
    bundle: true, format: "esm", platform: "node", target: "node22",
    packages: "external", outfile, logLevel: "silent",
  });
  return { module: await import(`file://${outfile}`), cleanup: () => rm(outfile, { force: true }) };
}

const { module: secrets, cleanup } = await loadSecretsService();
test.after(() => cleanup());

// The two policies the applier needs, with no clock in them: every apply in this file succeeds on
// the first attempt, so a retry schedule that never fires and a deadline that resolves at once are
// the whole of it.
const immediate = {
  retryPolicy: { schedule: () => ({ elapsed: Promise.resolve(), dispose: () => {} }) },
  applyDeadline: { run: (body) => body(new AbortController().signal) },
};

// What the relay writes. Real names, because the point of this file is that these exact names are
// the ones RESERVED_BOX_SECRET_PREFIXES refuses.
const PIN = {
  SAND_OPENAI_COMPATIBLE_BASE_URL: "http://titanbot-proxy:4000/v1",
  SAND_OPENAI_COMPATIBLE_MODEL: "plan-zai",
  SAND_OPENAI_COMPATIBLE_API_KEY: "sk-a-virtual-key-minted-for-one-tenant",
  SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "Z.AI GLM (included with your plan)",
  SAND_OPENAI_COMPATIBLE_SERVED_BY: "Z.AI",
};

async function store(contents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-secrets-"));
  const file = path.join(dir, "box-secrets.json");
  if (contents != null) await writeFile(file, JSON.stringify({ version: 1, secrets: contents }), "utf8");
  return file;
}

const readStore = async (file) => JSON.parse(await readFile(file, "utf8")).secrets;

function applier(storePath) {
  const pushes = [];
  const service = new secrets.BoxSecretsApplier({
    ...immediate,
    storePath,
    log: () => {},
    applyToBox: async (_ctx, update) => { pushes.push(update); },
  });
  return { service, pushes };
}

test("a box-secrets save keeps the endpoint pin the relay wrote into the same file", async () => {
  const file = await store({ ...PIN, CODERABBIT_API_KEY: "an existing shell credential" });
  const { service, pushes } = applier(file);

  // What the desktop app does: setBoxSecrets with the full set of box secrets, which never
  // includes a SAND_ name because setSecrets validates its input and every one of them is refused.
  await service.setSecrets({}, { CODERABBIT_API_KEY: "an existing shell credential", GITHUB_TOKEN: "a token" });

  const written = await readStore(file);
  for (const [name, value] of Object.entries(PIN)) {
    assert.equal(written[name], value, `${name} was deleted by a box-secrets save`);
  }
  assert.equal(written.GITHUB_TOKEN, "a token", "the save still writes what it was given");
  assert.equal(written.CODERABBIT_API_KEY, "an existing shell credential");

  // And the push to the box carries only the box's own secrets: SAND_ names are the host's own
  // resolver's business and were never part of the box environment.
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].replace, true);
  assert.equal(pushes[0].env.SAND_OPENAI_COMPATIBLE_API_KEY, undefined, "a reserved name must not reach the box environment");
  assert.equal(pushes[0].env.GITHUB_TOKEN, "a token");

  // getStatus reports box secrets, so the pin is not in it either.
  assert.deepEqual(service.getStatus().keys, ["CODERABBIT_API_KEY", "GITHUB_TOKEN"]);
  service.stop();
});

test("a save that drops a box secret still keeps the pin, and drops only what it was asked to", async () => {
  const file = await store({ ...PIN, CODERABBIT_API_KEY: "gone after this", GITHUB_TOKEN: "kept" });
  const { service } = applier(file);
  await service.setSecrets({}, { GITHUB_TOKEN: "kept" });
  const written = await readStore(file);
  assert.equal(written.CODERABBIT_API_KEY, undefined, "a removed box secret is still removed");
  assert.equal(written.GITHUB_TOKEN, "kept");
  assert.equal(written.SAND_OPENAI_COMPATIBLE_API_KEY, PIN.SAND_OPENAI_COMPATIBLE_API_KEY);
  service.stop();
});

test("startup re-application survives a store that carries the endpoint pin", async () => {
  const file = await store({ ...PIN, CODERABBIT_API_KEY: "a shell credential", GITHUB_TOKEN: "a token" });
  const { service, pushes } = applier(file);

  await service.applyPersisted({});

  assert.equal(pushes.length, 1, "the operator's box secrets never reached the box on a pinned box");
  assert.equal(pushes[0].env.CODERABBIT_API_KEY, "a shell credential");
  assert.equal(pushes[0].env.GITHUB_TOKEN, "a token");
  assert.equal(pushes[0].env.SAND_OPENAI_COMPATIBLE_API_KEY, undefined, "the pin is not a box environment variable");
  assert.deepEqual(service.getStatus().keys, ["CODERABBIT_API_KEY", "GITHUB_TOKEN"]);

  // And nothing was rewritten by reading: the pin is still exactly as the relay left it.
  assert.deepEqual(await readStore(file), { ...PIN, CODERABBIT_API_KEY: "a shell credential", GITHUB_TOKEN: "a token" });
  service.stop();
});

test("a store that holds nothing but the pin pushes nothing at all", async () => {
  // The box has been pointed at an endpoint and has no box secrets. There is nothing to apply, and
  // an empty push is not a no-op: it is `replace: true` with an empty environment, which is how a
  // boot would clear a live box's variables. Doing nothing is the only correct answer.
  const file = await store({ ...PIN });
  const { service, pushes } = applier(file);
  await service.applyPersisted({});
  assert.equal(pushes.length, 0);
  assert.deepEqual(await readStore(file), PIN, "and the pin is untouched");
  service.stop();
});

test("a name the box runtime reserves for another reason is preserved too, not applied", async () => {
  // The predicate is "a name this store cannot apply", which is validateBoxSecretKey's whole
  // answer, not a hand-kept list of prefixes. PATH could never have been written here by the
  // relay, but if it is on disk, refusing the whole document over it is the failure this test
  // exists to stop, and deleting it is not this writer's business either.
  const file = await store({ PATH: "/usr/bin", GITHUB_TOKEN: "a token" });
  const { service, pushes } = applier(file);
  await service.applyPersisted({});
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].env.PATH, undefined);
  assert.equal(pushes[0].env.GITHUB_TOKEN, "a token");
  assert.equal((await readStore(file)).PATH, "/usr/bin");
  service.stop();
});

test("a malformed store is still no secrets, and a save into one writes only what it was given", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "box-secrets-bad-"));
  const file = path.join(dir, "box-secrets.json");
  await writeFile(file, "{ not json", "utf8");
  const { service, pushes } = applier(file);
  await service.applyPersisted({});
  assert.equal(pushes.length, 0, "an unreadable store is no secrets, never an error");
  await service.setSecrets({}, { GITHUB_TOKEN: "a token" });
  assert.deepEqual(await readStore(file), { GITHUB_TOKEN: "a token" });
  service.stop();
});
