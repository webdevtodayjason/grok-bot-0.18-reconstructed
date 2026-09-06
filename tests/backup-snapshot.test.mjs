// The nightly snapshot's own logic, run for real against a stub docker (BACKUP-1).
//
// deploy/backup/snapshot.sh and restore-drill.sh are the only copy of an instance that exists, so
// the parts that decide whether a run is safe -- the mount-point refusal, the manifest, the
// retention sweep -- are exercised here rather than left to a nightly timer nobody watches. A tiny
// `docker` on PATH stands in for the daemon: the volumes are directories in a temp tree, so the
// scripts take their rsync path and no container is involved.
//
// What is NOT covered here, and is measured on the box instead (docs/OPERATOR-RUNBOOK.md): the pause
// itself, and the docker-stream copy the dev box needs because a Mac's daemon runs in a VM.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "backup-snapshot-"));
after(() => rmSync(root, { recursive: true, force: true }));

const volumes = path.join(root, "volumes");
const bin = path.join(root, "bin");
const dest = path.join(root, "backups");
const relayRoot = path.join(root, "relay-root");

// A stub docker. `volume inspect --format {{.Mountpoint}}` hands back a real directory, so the
// scripts use rsync and never start a container; pause and unpause record that they were called.
mkdirSync(bin, { recursive: true });
writeFileSync(path.join(bin, "docker"), `#!/bin/sh
case "$1 $2" in
  "volume inspect")
    dir="${volumes}/$3"
    [ -d "$dir" ] || exit 1
    case "$4" in --format) printf '%s\\n' "$dir" ;; esac
    exit 0 ;;
esac
case "$1" in
  inspect) [ "$2" = "the-box" ] || exit 1; printf 'the-box\\n'; exit 0 ;;
  pause|unpause) printf '%s\\n' "$1 $2" >> "${root}/docker-calls"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

// Four volumes and one relay side, with two agent stores in sand-data.
for (const name of ["workspace", "data", "store", "chrome"]) mkdirSync(path.join(volumes, `tb-${name}`), { recursive: true });
writeFileSync(path.join(volumes, "tb-workspace", "note.txt"), "a file an agent wrote\n");
writeFileSync(path.join(volumes, "tb-store", "manifest.json"), "{}\n");
writeFileSync(path.join(volumes, "tb-chrome", "Preferences"), "{}\n");
const agents = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
for (const agent of agents) {
  const dir = path.join(volumes, "tb-data", "agents", agent);
  mkdirSync(dir, { recursive: true });
  // A real sqlite file, so the drill's integrity check is answering about a database rather than
  // about a text file that happens to be named store.db. Each store carries its own agent id, so
  // two stores are never byte-identical and swapping them between directories is detectable.
  execFileSync("python3", ["-c", `import sqlite3;db=sqlite3.connect(${JSON.stringify(path.join(dir, "store.db"))});db.execute("create table t(x)");db.execute('insert into t values (\\'${agent}\\')');db.commit()`]);
}
mkdirSync(path.join(relayRoot, "ui"), { recursive: true });
mkdirSync(path.join(relayRoot, "profile"), { recursive: true });
writeFileSync(path.join(relayRoot, "ui", "auth.json"), '{"placeholder":true}\n');
writeFileSync(path.join(relayRoot, "profile", "local-docker-vm.json"), '{"token":"placeholder"}\n');

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  TITANBOT_BACKUP_DEST: dest,
  TITANBOT_INSTANCE: "tb",
  TITANBOT_BOX: "the-box",
  TITANBOT_VOLUME_PREFIX: "tb",
  TITANBOT_ROOT: relayRoot,
};
const snapshot = (extra = {}) =>
  execFileSync("bash", [path.join(repoRoot, "deploy/backup/snapshot.sh")], { env: { ...env, ...extra }, encoding: "utf8" });

test("it refuses a destination that is not a mount point", () => {
  // The failure this prevents: /mnt/rosa-storage with the array unmounted is an ordinary empty
  // directory, and a nightly job would fill it with the only copy of the data, on the disk that
  // copy exists to survive.
  // The guard now asks which mounted filesystem holds the destination; pinning an expected mount that
  // is not the one the scratch directory sits on is how a Mac (whose scratch is never on "/") drives the refusal.
  assert.throws(() => snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "1", TITANBOT_BACKUP_MOUNT: "/mnt/an-array-that-is-not-here" }), (error) => {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    assert.match(output, /expected mount|root filesystem/);
    return true;
  });
  assert.ok(!existsSync(dest) || execFileSync("find", [dest, "-name", "manifest.json"], { encoding: "utf8" }).trim() === "",
    "a refused run leaves no snapshot behind");
});

test("a snapshot pauses the box, copies all five sources, and writes a manifest that names them", () => {
  const output = snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "0" });
  assert.match(output, /MOUNT CHECK OFF/);
  const calls = readFileSync(path.join(root, "docker-calls"), "utf8");
  assert.match(calls, /pause the-box/);
  assert.match(calls, /unpause the-box/);

  const snaps = execFileSync("ls", ["-1", path.join(dest, "tb")], { encoding: "utf8" }).trim().split("\n");
  assert.equal(snaps.length, 1);
  assert.match(snaps[0], /^\d{4}-\d{2}-\d{2}-\d{4}$/, "the snapshot is named by the minute it was taken");
  const dir = path.join(dest, "tb", snaps[0]);
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));

  assert.equal(manifest.mode, "consistent", "the pause held, so the stores were captured frozen");
  assert.equal(manifest.copyMethod, "rsync");
  assert.deepEqual(manifest.volumes.map((entry) => entry.name).sort(), ["chrome", "data", "store", "workspace"]);
  // The marker that keeps a live copy from being read as a frozen one: only the two volumes the
  // paused pass retakes may say "paused".
  assert.deepEqual(Object.fromEntries(manifest.volumes.map((entry) => [entry.name, entry.capturedWhile])),
    { workspace: "paused", data: "paused", store: "live", chrome: "live" });
  assert.deepEqual(manifest.relay.map((entry) => entry.path).sort(), ["profile", "ui/auth.json"]);

  assert.equal(manifest.storeDbCount, 2);
  for (const agent of agents) {
    const entry = manifest.storeDbs.find((item) => item.path.includes(agent));
    assert.ok(entry, `${agent} is in the manifest`);
    const onDisk = execFileSync("shasum", ["-a", "256", path.join(dir, entry.path)], { encoding: "utf8" }).split(" ")[0];
    assert.equal(entry.sha256, onDisk, "the recorded hash is the hash of the copy that was written");
    assert.equal(entry.bytes, readFileSync(path.join(dir, entry.path)).length);
  }
  // The relay side carries the password hash and the gateway token, so it must not be world
  // readable in the backup either.
  assert.equal(statSync(path.join(dir, "relay")).mode & 0o077, 0, "no group or other bits on the relay copy");
});

test("the retention sweep keeps the newest and only the newest", () => {
  // Its own instance directory, because a snapshot refuses to run twice in the same minute and the
  // case above already took this minute under "tb". Planted rather than run five times: the names
  // sort lexically, which is the whole reason the stamp is YYYY-MM-DD-HHMM.
  const planted = ["2026-01-01-0100", "2026-01-02-0100", "2026-01-03-0100", "2026-01-04-0100", "2026-01-05-0100"];
  for (const stamp of planted) {
    mkdirSync(path.join(dest, "tb3", stamp), { recursive: true });
    writeFileSync(path.join(dest, "tb3", stamp, "manifest.json"), "{}\n");
  }
  const otherBefore = execFileSync("ls", ["-1", path.join(dest, "tb")], { encoding: "utf8" }).trim().split("\n").length;
  const output = snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "0", TITANBOT_BACKUP_KEEP: "3", TITANBOT_INSTANCE: "tb3" });
  assert.match(output, /3 snapshots kept \(limit 3\)/);
  const kept = execFileSync("ls", ["-1", path.join(dest, "tb3")], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  // Three left: the two newest planted ones and the run that just happened. The three oldest are
  // gone, and nothing newer was touched.
  assert.equal(kept.length, 3, kept.join(" "));
  assert.ok(!kept.includes("2026-01-01-0100") && !kept.includes("2026-01-02-0100") && !kept.includes("2026-01-03-0100"));
  assert.ok(kept.includes("2026-01-04-0100") && kept.includes("2026-01-05-0100"));
  // And one instance's sweep never reaches another's: they share a destination root.
  assert.equal(execFileSync("ls", ["-1", path.join(dest, "tb")], { encoding: "utf8" }).trim().split("\n").length, otherBefore);
});

test("the restore drill opens every store, and says so when one is damaged", () => {
  const drill = (snap) => execFileSync("bash", [path.join(repoRoot, "deploy/backup/restore-drill.sh"), snap], { env, encoding: "utf8" });
  const newest = execFileSync("ls", ["-1", path.join(dest, "tb")], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort().pop();
  const dir = path.join(dest, "tb", newest);
  const output = drill(dir);
  assert.match(output, /2 store\(s\) opened and passed, 0 did not/);
  for (const agent of agents) assert.match(output, new RegExp(`${agent}\\s+\\d+\\s+\\w+\\s+ok / sha ok`));

  // Now break one the way a bad disk would: the bytes change after the snapshot was taken, so the
  // hash drifts from the manifest AND sqlite refuses to open it. A drill that passed this would be
  // worthless.
  const broken = path.join(dir, "volumes/data/agents", agents[0], "store.db");
  chmodSync(broken, 0o644);
  writeFileSync(broken, Buffer.alloc(readFileSync(broken).length, 0x41));
  assert.throws(() => drill(dir), (error) => {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    assert.match(text, /sha DRIFTED/);
    assert.match(text, /1 store\(s\) opened and passed, 1 did not/);
    assert.match(text, /not a restore point/);
    return true;
  });
});

test("a snapshot that lost stores is not a restore point, however clean the ones it kept are", () => {
  // The drill used to count only what it found. snapshot.sh removes the live copy of a volume before
  // retaking it under the pause, so a failure in that second copy takes both, and a snapshot could
  // land holding one agent out of five. Every store it did keep opens and hashes fine, so the old
  // verdict was green on a backup that had lost four agents.
  const output = snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "0", TITANBOT_INSTANCE: "tb4" });
  assert.match(output, /2 store\.db/);
  const dir = path.join(dest, "tb4", execFileSync("ls", ["-1", path.join(dest, "tb4")], { encoding: "utf8" }).trim());
  rmSync(path.join(dir, "volumes/data/agents", agents[1]), { recursive: true, force: true });
  assert.throws(() => execFileSync("bash", [path.join(repoRoot, "deploy/backup/restore-drill.sh"), dir], { env, encoding: "utf8" }), (error) => {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    assert.match(text, /1 store\(s\) opened and passed, 0 did not/, "the store it kept is fine, which is exactly why the count is the only check that catches this");
    assert.match(text, /the manifest names 2 store\.db and 1 were found/);
    assert.match(text, /not a restore point/);
    return true;
  });
});

test("two stores swapped between agent directories both read DRIFTED", () => {
  // The hash check used to ask whether a sha appeared anywhere in the manifest. Swap two stores and
  // both shas are still present, so both read "sha ok" while every agent holds another agent's
  // conversations. The hash has to be the one recorded for that path.
  snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "0", TITANBOT_INSTANCE: "tb5" });
  const dir = path.join(dest, "tb5", execFileSync("ls", ["-1", path.join(dest, "tb5")], { encoding: "utf8" }).trim());
  const stores = agents.map((agent) => path.join(dir, "volumes/data/agents", agent, "store.db"));
  const [first, second] = stores.map((store) => readFileSync(store));
  assert.notDeepEqual(first, second, "the two stores differ, so a swap is something the check can see");
  for (const store of stores) chmodSync(store, 0o644);
  writeFileSync(stores[0], second);
  writeFileSync(stores[1], first);
  assert.throws(() => execFileSync("bash", [path.join(repoRoot, "deploy/backup/restore-drill.sh"), dir], { env, encoding: "utf8" }), (error) => {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    assert.match(text, /0 store\(s\) opened and passed, 2 did not/);
    assert.equal((text.match(/sha DRIFTED/g) ?? []).length, 2);
    return true;
  });
});

test("retention never sweeps the newest consistent snapshot, however many degraded ones follow it", () => {
  // The sweep evicted strictly by name, and a "live" snapshot (the pause did not hold) or a torn run
  // with no manifest at all took a slot exactly like a good one. With KEEP=14 and a nightly timer,
  // fourteen degraded runs in a row would delete the last restore point one night at a time.
  const planted = [
    ["2026-01-01-0100", '{"mode": "consistent"}\n'],
    ["2026-01-02-0100", '{"mode": "live"}\n'],
    ["2026-01-03-0100", '{"mode": "live"}\n'],
    ["2026-01-04-0100", null], // a torn run: it never got as far as a manifest
  ];
  for (const [stamp, manifest] of planted) {
    mkdirSync(path.join(dest, "tb6", stamp), { recursive: true });
    if (manifest != null) writeFileSync(path.join(dest, "tb6", stamp, "manifest.json"), manifest);
  }
  // TITANBOT_BOX names a container the stub docker does not know, so this run cannot pause and is
  // itself a "live" snapshot: the degraded run that would have evicted the good one.
  const output = snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "0", TITANBOT_BACKUP_KEEP: "2", TITANBOT_INSTANCE: "tb6", TITANBOT_BOX: "absent-box" });
  assert.match(output, /mode live/, "the run under test is itself degraded");
  assert.match(output, /kept 2026-01-01-0100: the newest consistent snapshot/);
  const kept = execFileSync("ls", ["-1", path.join(dest, "tb6")], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  assert.ok(kept.includes("2026-01-01-0100"), `the last consistent snapshot survived: ${kept.join(" ")}`);
  assert.ok(!kept.includes("2026-01-02-0100") && !kept.includes("2026-01-03-0100"), "the degraded older ones went");
  assert.equal(kept.length, 3, kept.join(" "));
});
