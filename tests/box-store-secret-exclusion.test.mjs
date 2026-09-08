// PROXY-1 / SECRET-3. The box store may not hold a credential.
//
// MEASURED ON THE R750 2026-09-08, and it is the reason the first absence proof proved nothing. The
// migration deleted the operator's 113-character provider key from box-secrets.json in all three
// customer boxes and read that file back to show it gone. It was not gone: box-store-sync had
// already copied the file into the box's own content-addressed store, so a byte-identical 539-byte
// copy of the same key sat at /var/lib/sand-box-store/<store id>/blobs/<sha256>, mode 0644
// root:root, in every one of the three, and the agent host runs as root inside the box.
//
// Two things fix it and this file pins the first: the sand-data category never offers these two
// files to the store, so a credential cannot enter it again. The second is the removal sweep in
// ui/server.mjs, covered by tests/relay-admin-routes.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".box-store-secret-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};

const policy = await load("source/host/durable-file-policy.ts", "durable-file-policy");
const service = await load("source/host/extensions/box-store-sync/box-store-sync-service.ts", "box-store-sync-service");

test("the two files that hold credentials are excluded from the sand-data category", () => {
  assert.deepEqual([...policy.BOX_STORE_SECRET_FILE_NAMES], ["box-secrets.json", "connector-env-secrets.json"]);

  const categories = service.buildBoxStoreCategories({
    sandRoot: "/home/box/sand-data",
    chromeStageRetry: { attempts: 1, delayMs: 0 },
    reportChromeSessionStage: () => {},
    env: {},
  });
  const sandData = categories.find((category) => category.name === "sand-data");
  assert.ok(sandData != null, "there is no sand-data category any more");
  for (const name of policy.BOX_STORE_SECRET_FILE_NAMES) {
    assert.equal(sandData.excludes.includes(`home/box/sand-data/${name}`), true,
      `${name} is offered to the box store, so a credential can enter a durable copy again`);
  }
  // The neighbours it must not have taken with it: the store DB capture writes agents/**/store.db
  // into the manifest by a different path, and gateway.json was already excluded for its own
  // reason. Losing either would be a different bug wearing this fix's clothes.
  assert.equal(sandData.excludes.includes("home/box/sand-data/gateway.json"), true);
  assert.equal(sandData.containsAgentStoreDbs, true);
});
