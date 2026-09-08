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
  ps)
    case "$*" in
      *control-plane*) printf 'the-cp\\n' ;;
      # PROXY-1. Only when a test asks for one, so every other run in this file is still an honest
      # "no proxy on this host" and keeps proving that shape.
      *proxy-db*) [ -n "$STUB_PROXY_DB" ] && printf '%s\\n' "$STUB_PROXY_DB" ;;
    esac
    exit 0 ;;
  exec)
    shift
    printf 'exec %s\\n' "$*" >> "${root}/docker-calls"
    shift
    if [ "$1" = "pg_dump" ]; then
      if [ "$STUB_PG_DUMP_FAILS" = 1 ]; then
        echo "pg_dump: error: connection to server failed" >&2
        exit 1
      fi
      printf -- '-- a logical copy of the proxy database\\nCREATE TABLE "LiteLLM_VerificationToken" (token text);\\n'
      exit 0
    fi
    exit 0 ;;
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
// cp.env. It has held CP_SESSION_SECRET, CP_ADMIN_TOKEN and CP_RELAY_TOKEN since TENANT-1 and was in
// no snapshot at all until PROXY-1 added the proxy's three to the same file. Lose it and every
// customer is signed out of every instance with no way to put the master back, because the session
// key each tenant relay holds is DERIVED from it.
writeFileSync(path.join(relayRoot, "cp.env"), "CP_SESSION_SECRET=placeholder\nPROXY_MASTER_KEY=sk-placeholder\n", { mode: 0o600 });

// The tenant root: the control plane's own sqlite store and one directory per customer. Nothing
// under it was in a snapshot until 2026-09-07, so losing this disk meant losing every account and
// every customer's instance with no way to say who they had been.
const tenantRoot = path.join(root, "tenant-root");
mkdirSync(path.join(tenantRoot, "_control-plane"), { recursive: true });
execFileSync("python3", ["-c", `import sqlite3;db=sqlite3.connect(${JSON.stringify(path.join(tenantRoot, "_control-plane", "control-plane.sqlite"))});db.execute("create table accounts(email)");db.execute("insert into accounts values ('owner@example.com')");db.commit()`]);
for (const slug of ["acme", "demo"]) {
  mkdirSync(path.join(tenantRoot, slug, "state"), { recursive: true });
  writeFileSync(path.join(tenantRoot, slug, "state", "auth.json"), '{"placeholder":true}\n');
}

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
  // cp.env is on this list as of PROXY-1, and it is the one file here that cannot be rebuilt from
  // anything: the session key every tenant relay holds is derived from the master inside it.
  assert.deepEqual(manifest.relay.map((entry) => entry.path).sort(), ["cp.env", "profile", "ui/auth.json"]);
  assert.equal(readFileSync(path.join(dir, "relay/cp.env"), "utf8").includes("CP_SESSION_SECRET"), true);

  // No proxy on this host, which is the shape of every install until PROXY-1 is deployed, and it is
  // not a failure: the snapshot is still complete.
  assert.equal(manifest.proxy, "absent");
  assert.equal(manifest.mode, "consistent");

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

test("a snapshot carries the control plane and every tenant, and pauses the store it cannot rebuild", () => {
  // What was missing: /data/titanbot holds the account store, the tenant table, the provisioning
  // ledger and one directory per customer, and no path in this script named it. Measured on the
  // R750 2026-09-06, the newest snapshot held manifest.json, relay/ and volumes/ and nothing else.
  const output = snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "0", TITANBOT_INSTANCE: "tenants", TITANBOT_TENANT_ROOT: tenantRoot });
  const snaps = execFileSync("ls", ["-1", path.join(dest, "tenants")], { encoding: "utf8" }).trim().split("\n");
  const dir = path.join(dest, "tenants", snaps[0]);
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));

  // Every customer, and the store that says who they are.
  assert.equal(manifest.tenantCount, 2);
  assert.deepEqual(manifest.tenants.map((entry) => entry.slug).sort(), ["acme", "demo"]);
  assert.ok(manifest.tenants.every((entry) => entry.capturedWhile === "live"),
    "a tenant's own box is running, so its copy is live and has to say so");
  assert.ok(existsSync(path.join(dir, "tenants", "acme", "state", "auth.json")));
  assert.ok(existsSync(path.join(dir, "tenants", "_control-plane", "control-plane.sqlite")));

  // The account store is the one file here nothing else can rebuild, and it is small, so it is
  // retaken under a pause rather than left as a live copy that restores without complaint and is
  // still wrong.
  assert.equal(manifest.controlPlane, "paused");
  assert.match(output, /paused the-cp and retook its store/);
  const calls = readFileSync(path.join(root, "docker-calls"), "utf8");
  assert.match(calls, /pause the-cp/);
  assert.match(calls, /unpause the-cp/);
  assert.equal(manifest.mode, "consistent");

  // Password hashes for every customer are in there.
  assert.equal(statSync(path.join(dir, "tenants")).mode & 0o077, 0, "no group or other bits on the tenant copy");
});

test("a host with no tenant root says so and is still a complete snapshot", () => {
  // A single-instance install has no control plane. That is not a degraded run and must not read
  // as one, or every dev box snapshot would be marked live for a thing it never had.
  const output = snapshot({ TITANBOT_BACKUP_REQUIRE_MOUNT: "0", TITANBOT_INSTANCE: "no-tenants", TITANBOT_TENANT_ROOT: path.join(root, "nothing-here") });
  assert.match(output, /is not on this host, so there are no tenants to copy/);
  const snaps = execFileSync("ls", ["-1", path.join(dest, "no-tenants")], { encoding: "utf8" }).trim().split("\n");
  const manifest = JSON.parse(readFileSync(path.join(dest, "no-tenants", snaps[0], "manifest.json"), "utf8"));
  assert.equal(manifest.controlPlane, "absent");
  assert.equal(manifest.tenantCount, 0);
  assert.equal(manifest.mode, "consistent");
});

// ---- the proxy (PROXY-1) --------------------------------------------------------------------------

test("the proxy is captured as a pg_dump, not as a file copy, and needs no pause", () => {
  // A database copied from underneath a running server restores without complaint and is still
  // wrong, which is the same reason the control plane's sqlite is retaken frozen. A logical dump is
  // consistent by construction and costs nobody's inference a pause.
  const output = snapshot({
    TITANBOT_BACKUP_REQUIRE_MOUNT: "0",
    TITANBOT_INSTANCE: "with-proxy",
    TITANBOT_TENANT_ROOT: tenantRoot,
    STUB_PROXY_DB: "titanbot-proxy-db-abc123",
  });
  const snaps = execFileSync("ls", ["-1", path.join(dest, "with-proxy")], { encoding: "utf8" }).trim().split("\n");
  const dir = path.join(dest, "with-proxy", snaps[0]);
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));

  assert.equal(manifest.proxy, "dumped");
  assert.ok(manifest.proxyDumpBytes > 0);
  assert.match(output, /-> proxy\/litellm\.sql/);
  const dump = readFileSync(path.join(dir, "proxy/litellm.sql"), "utf8");
  assert.match(dump, /LiteLLM_VerificationToken/, "the dump is the database's own logical copy");

  // Found by its role label, like everything else Coolify renames, and dumped rather than paused.
  const calls = readFileSync(path.join(root, "docker-calls"), "utf8");
  assert.match(calls, /exec titanbot-proxy-db-abc123 pg_dump/);
  assert.equal(/pause titanbot-proxy-db/.test(calls), false, "a dump needs no pause, so nobody's inference stops for it");

  // It holds every tenant's virtual key.
  assert.equal(statSync(path.join(dir, "proxy")).mode & 0o077, 0, "no group or other bits on the proxy copy");
});

test("a proxy whose dump fails is a snapshot that is NOT a restore point, and says so", () => {
  // The failure has to be loud in the manifest rather than a warning in a log nobody reads: a
  // snapshot missing every virtual key and every spend row looks exactly like a good one on disk.
  const output = snapshot({
    TITANBOT_BACKUP_REQUIRE_MOUNT: "0",
    TITANBOT_INSTANCE: "broken-proxy",
    TITANBOT_TENANT_ROOT: tenantRoot,
    STUB_PROXY_DB: "titanbot-proxy-db-abc123",
    STUB_PG_DUMP_FAILS: "1",
  });
  const snaps = execFileSync("ls", ["-1", path.join(dest, "broken-proxy")], { encoding: "utf8" }).trim().split("\n");
  const manifest = JSON.parse(readFileSync(path.join(dest, "broken-proxy", snaps[0], "manifest.json"), "utf8"));
  assert.equal(manifest.proxy, "failed");
  assert.equal(manifest.mode, "live", "an incomplete copy must never be labelled consistent");
  assert.match(output, /WARNING: pg_dump of titanbot-proxy-db-abc123 failed/);
});

test("the tenant loop never sees the proxy, because its storage is a sibling of the tenant root", () => {
  // /data/titanbot-proxy is deliberately NOT under /data/titanbot. The loop below walks the tenant
  // root one directory at a time and skips exactly one name, so a proxy directory under there would
  // be reported as a customer in every manifest and its Postgres data directory taken as a live file
  // copy: the torn copy the pg_dump pass exists to avoid.
  const script = readFileSync(path.join(repoRoot, "deploy/backup/snapshot.sh"), "utf8");
  assert.equal(/TENANT_ROOT.*titanbot-proxy/.test(script), false);
  assert.match(script, /TENANT_ROOT="\$\{TITANBOT_TENANT_ROOT:-\/data\/titanbot\}"/);
  // And the run itself: a tenant root with two customers in it reports two, whatever the proxy did.
  const output = snapshot({
    TITANBOT_BACKUP_REQUIRE_MOUNT: "0",
    TITANBOT_INSTANCE: "sibling",
    TITANBOT_TENANT_ROOT: tenantRoot,
    STUB_PROXY_DB: "titanbot-proxy-db-abc123",
  });
  const snaps = execFileSync("ls", ["-1", path.join(dest, "sibling")], { encoding: "utf8" }).trim().split("\n");
  const manifest = JSON.parse(readFileSync(path.join(dest, "sibling", snaps[0], "manifest.json"), "utf8"));
  assert.deepEqual(manifest.tenants.map((one) => one.slug).sort(), ["acme", "demo"]);
  assert.equal(manifest.tenants.some((one) => one.slug.includes("proxy")), false);
  assert.equal(output.includes("tenants/titanbot-proxy"), false);
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

test("the drill opens the control plane store, and refuses a snapshot whose copy is damaged", () => {
  // The one file in a snapshot nothing else can rebuild. A drill that opened every agent's store
  // and never opened this one would print a green verdict on a backup that could not bring the
  // customers back.
  const drillEnv = { ...env, TITANBOT_INSTANCE: "tenants" };
  const drill = (snap) => execFileSync("bash", [path.join(repoRoot, "deploy/backup/restore-drill.sh"), snap], { env: drillEnv, encoding: "utf8" });
  const newest = execFileSync("ls", ["-1", path.join(dest, "tenants")], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort().pop();
  const dir = path.join(dest, "tenants", newest);
  const output = drill(dir);
  assert.match(output, /control plane paused, 2 tenant\(s\)/);
  assert.match(output, /control-plane\.sqlite\s+\d+\s+ok/);
  assert.match(output, /2 tenant director\(ies\) restored/);

  // Damaged the way a bad disk would damage it.
  const store = path.join(dir, "tenants/_control-plane/control-plane.sqlite");
  chmodSync(store, 0o644);
  writeFileSync(store, Buffer.alloc(readFileSync(store).length, 0x41));
  assert.throws(() => drill(dir), (error) => {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    assert.match(text, /cannot bring the customers back and is not a restore point/);
    return true;
  });

  // And a snapshot whose manifest says the store was captured and does not carry one is refused
  // outright, which is the shape a half-failed copy leaves behind.
  rmSync(path.join(dir, "tenants/_control-plane"), { recursive: true, force: true });
  assert.throws(() => drill(dir), (error) => {
    assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, /none is in the snapshot/);
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
