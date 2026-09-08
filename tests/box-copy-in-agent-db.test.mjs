// BOX-6. A container recreate must never overwrite a live agent store.
//
// MEASURED ON THE R750. Jason's box logged `[box-copy-in] result outcome=hydrated store_entries=1607
// files=1607 bytes=732641817` at its last start: 732 MB written over the bind-mounted sand-data of a
// box holding a customer's data. Two of those files were `store.db` and `conversation-blobs.db`, and
// the store's copies are stale by construction because box-store-sync cannot snapshot a busy SQLite
// file (`snapshot failed; uncaptured`, every cycle). What the box got back was pages that no longer
// matched its live WAL, and every turn after that failed with `database disk image is malformed`.
//
// Two pins, because either alone can be undone by accident:
//   1. the agent databases are not in COPY_IN_CRITICAL_BASENAMES -- a re-added basename is the way
//      this comes back, and the unit test below would not notice if only the phase were checked;
//   2. an agent database that already exists on the persistent mount is not a candidate in ANY
//      phase, so the bind mount is the truth wherever a live box has written one.
//
// The real container recreate that proves this end to end is scripts/verify-box-copy-in.mjs, run on
// grok-bot-local-vm. This file is the cheap half that runs on every `npm test`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".box-copy-in-agent-db-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/box-store-sync/box-store-download.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const bundlePath = path.join(stage, "box-store-download.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const download = createRequire(import.meta.url)(bundlePath);

test("an agent database is never a critical copy-in basename", () => {
  for (const name of ["store.db", "conversation-blobs.db"]) {
    assert.equal(download.COPY_IN_CRITICAL_BASENAMES.has(name), false,
      `${name} is back in the critical phase, so a recreate writes the store's stale copy over the live one first`);
  }
  // The neighbours that must stay: these are Chrome's, they are not databases the host writes
  // while the box runs, and losing them would be a different bug wearing this fix's clothes.
  assert.equal(download.COPY_IN_CRITICAL_BASENAMES.has("Cookies"), true);
  assert.equal(download.COPY_IN_CRITICAL_BASENAMES.has("Login Data"), true);
});

test("the agent database matcher covers the databases and their SQLite sidecars", () => {
  for (const rel of [
    "home/box/sand-data/agents/abc/store.db",
    "home/box/sand-data/agents/abc/conversation-blobs.db",
    "home/box/sand-data/agents/abc/store.db-wal",
    "home/box/sand-data/agents/abc/conversation-blobs.db-shm",
    "home/box/sand-data/agents/abc/store.db-journal",
  ]) assert.equal(download.isAgentDatabaseRelPath(rel), true, `${rel} is not protected`);
  for (const rel of [
    "home/box/sand-data/agents/abc/profile.json",
    "home/box/sand-data/gateway.json",
    "home/box/chrome-profile/Default/Cookies",
    "home/box/sand-data/agents/abc/store.db.backup",
  ]) assert.equal(download.isAgentDatabaseRelPath(rel), false, `${rel} is protected and should not be`);
});

test("a live file on the persistent mount is seen, a symlink and a missing path are not", async () => {
  const dir = path.join(stage, "live");
  mkdirSync(dir, { recursive: true });
  const live = path.join(dir, "store.db");
  writeFileSync(live, "live pages");
  assert.equal(await download.isExistingRegularFile(live), true);
  assert.equal(await download.isExistingRegularFile(path.join(dir, "absent.db")), false);
  const { symlinkSync } = await import("node:fs");
  symlinkSync(live, path.join(dir, "linked.db"));
  assert.equal(await download.isExistingRegularFile(path.join(dir, "linked.db")), false,
    "a symlink named like an agent database would protect whatever it points at");
  assert.equal(readFileSync(live, "utf8"), "live pages");
});
