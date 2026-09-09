#!/usr/bin/env node
// verify-box-copy-in.mjs -- BOX-6, proved by a real container recreate.
//
// THE FAILURE. `/home/box/sand-data` is a persistent volume; `/var/lib/sand-box-store` is a
// content-addressed copy of it that box-store-sync refreshes on a cycle. At container start the
// host runs `host-main.cjs --box-copy-in`, which restores every manifest entry over the volume. For
// an ordinary file that is right: the store is the durable copy. For a SQLite database the host is
// writing to, the store's copy is stale by construction -- box-store-sync cannot snapshot a busy
// file and logs `snapshot failed; uncaptured` every cycle -- so what it restores is pages that no
// longer match the live WAL. Measured on the R750 twice: a recreate, then `database disk image is
// malformed` on every turn after it.
//
// WHAT THIS MEASURES, and why it is a recreate rather than a unit test. A unit test over the
// restore functions cannot see a basename being added back to COPY_IN_CRITICAL_BASENAMES by
// somebody who does not know why it is not there. So this seeds the store with a copy that is
// deliberately different from the live file, recreates the container for real, and reads the file
// back:
//
//   the two agent databases   must still hold what the LIVE file held   (the fix)
//   the ordinary file beside them must hold what the STORE held         (the control)
//
// The control leg is what makes a pass mean something. Without it a copy-in that did nothing at all
// would pass, and that is a different, worse bug.
//
// Everything it writes lives under one throwaway directory named for this run, outside `agents/`,
// so the roster never sees it and the cleanup is one `rm -rf` plus the manifest keys it added.
//
//   node scripts/verify-box-copy-in.mjs [--box grok-bot-local-vm] [--keep]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const BOX = arg("--box", "grok-bot-local-vm");
const RECREATE = arg("--recreate", ".cache/patched-host/recreate-box.sh");
const KEEP = args.includes("--keep");

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`PASS  ${m}`); };
const bad = (m) => { fail += 1; console.log(`FAIL  ${m}`); };
const say = (m) => console.log(`      ${m}`);
const step = (m) => console.log(`\n== ${m}`);

const inBox = (script) =>
  execFileSync("docker", ["exec", "-i", BOX, "python3", "-"], { input: script, encoding: "utf8", timeout: 120_000 });

const nonce = randomBytes(6).toString("hex");
const dir = `verify-copy-in-${nonce}`;
const LIVE_DB = `LIVE PAGES ${nonce}`;
const STORE_DB = `STORE COPY ${nonce}`;
const LIVE_CTL = `LIVE CONTROL ${nonce}`;
const STORE_CTL = `STORE CONTROL ${nonce}`;

const seed = `
import glob, hashlib, json, os, sys
store = sorted(glob.glob("/var/lib/sand-box-store/*/manifest.json"))
if not store: sys.exit("no box store manifest in this box")
mpath = store[0]
root = os.path.dirname(mpath)
live_root = "/home/box/sand-data/${dir}"
os.makedirs(live_root, exist_ok=True)
os.makedirs(os.path.join(root, "blobs"), exist_ok=True)
plan = {
  "conversation-blobs.db": (${JSON.stringify(LIVE_DB)}, ${JSON.stringify(STORE_DB)}),
  "store.db":              (${JSON.stringify(LIVE_DB)}, ${JSON.stringify(STORE_DB)}),
  "marker.json":           (${JSON.stringify(LIVE_CTL)}, ${JSON.stringify(STORE_CTL)}),
}
m = json.load(open(mpath))
added = []
for name, (live, stored) in plan.items():
    open(os.path.join(live_root, name), "w").write(live)
    b = stored.encode()
    sha = hashlib.sha256(b).hexdigest()
    open(os.path.join(root, "blobs", sha), "wb").write(b)
    key = "home/box/sand-data/${dir}/" + name
    m["entries"][key] = {"sha": sha, "size": len(b)}
    added.append(key)
json.dump(m, open(mpath, "w"))
print(json.dumps({"manifest": mpath, "added": added}))
`;

const read = `
import json, os
live_root = "/home/box/sand-data/${dir}"
out = {}
for name in ("conversation-blobs.db", "store.db", "marker.json"):
    p = os.path.join(live_root, name)
    out[name] = open(p).read() if os.path.exists(p) else None
print(json.dumps(out))
`;

const cleanup = `
import glob, json, os, shutil
shutil.rmtree("/home/box/sand-data/${dir}", ignore_errors=True)
for mpath in glob.glob("/var/lib/sand-box-store/*/manifest.json"):
    try:
        m = json.load(open(mpath))
    except Exception:
        continue
    before = len(m.get("entries", {}))
    m["entries"] = {k: v for k, v in m.get("entries", {}).items() if "/${dir}/" not in k}
    if len(m["entries"]) != before: json.dump(m, open(mpath, "w"))
print("cleaned")
`;

// Sweep anything an earlier run left behind BEFORE seeding. A run that dies between the seed and
// the cleanup leaves a directory and two manifest keys in the box, and the next run then measures a
// box with a stranger's fixture in it. Found on grok-bot-local-vm after a run that failed on its
// own log wait. Named by prefix, so it only ever removes this gate's own leavings.
step("sweep anything an earlier run left behind");
say(inBox(`
import glob, json, shutil
removed = []
for d in glob.glob("/home/box/sand-data/verify-copy-in-*"):
    shutil.rmtree(d, ignore_errors=True); removed.append(d.rsplit("/", 1)[-1])
keys = 0
for m in glob.glob("/var/lib/sand-box-store/*/manifest.json"):
    try: j = json.load(open(m))
    except Exception: continue
    before = len(j.get("entries", {}))
    j["entries"] = {k: v for k, v in j.get("entries", {}).items() if "/verify-copy-in-" not in k}
    if len(j["entries"]) != before:
        json.dump(j, open(m, "w")); keys += before - len(j["entries"])
print(f"{len(removed)} stale fixture directory(ies), {keys} stale manifest key(s)")
`).trim());

step(`seed the store with a copy that differs from the live file (${BOX})`);
const seeded = JSON.parse(inBox(seed).trim().split("\n").pop());
say(`manifest ${seeded.manifest}`);
for (const key of seeded.added) say(`seeded ${key}`);

try {
  step("recreate the container for real");
  const started = Date.now();
  execFileSync("bash", [RECREATE], { stdio: "inherit", timeout: 600_000 });
  say(`recreate finished in ${Math.round((Date.now() - started) / 1000)} s`);

  step("wait for the copy-in to finish");
  // The result line is the LAST thing the copy-in writes, after the retry loop it may go round, so
  // this waits for that line and not for any earlier one. A run that leaves an agent database alone
  // restores fewer files than the manifest advertises, and an accounting that calls that a partial
  // hydrate retries eight times before giving up -- which is how this loop earned its patience.
  let copyIn = "";
  for (let i = 0; i < 150; i += 1) {
    copyIn = execFileSync("docker", ["logs", BOX], { encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024 * 1024 });
    if (copyIn.includes("[box-copy-in] result")) break;
    execFileSync("sleep", ["2"]);
  }
  const resultLine = copyIn.split("\n").filter((l) => l.includes("[box-copy-in] result")).pop();
  if (resultLine == null) {
    bad("the box never logged a copy-in result within 300 s, so the run below is unverified");
    for (const line of copyIn.split("\n").filter((l) => l.includes("box-copy-in")).slice(-4)) say(line.trim().slice(0, 200));
  } else if (resultLine.includes("outcome=failed")) {
    bad("the copy-in ended in failure, which a skipped agent database must never cause");
    say(resultLine.trim());
  } else {
    ok("the copy-in ran on this start and did not end in failure");
    say(resultLine.trim());
  }

  step("read the three files back");
  const after = JSON.parse(inBox(read).trim().split("\n").pop());

  for (const name of ["conversation-blobs.db", "store.db"]) {
    if (after[name] === LIVE_DB) ok(`${name} still holds what the live box wrote`);
    else if (after[name] === STORE_DB) bad(`${name} was overwritten with the store's stale copy -- BOX-6 is back`);
    else bad(`${name} holds neither the live nor the stored content (${JSON.stringify(after[name])})`);
  }
  if (after["marker.json"] === STORE_CTL) ok("the ordinary file beside them WAS restored, so the copy-in really ran");
  else if (after["marker.json"] === LIVE_CTL) bad("the control file was not restored either, so this run proves nothing about the guard");
  else bad(`the control file holds neither content (${JSON.stringify(after["marker.json"])})`);

  const left = copyIn.split("\n").filter((l) => l.includes("live agent database(s) as they are")).pop();
  if (left != null) { ok("the host said which live databases it left alone"); say(left.trim()); }
  else say("note: the host logged no 'left alone' line; the file check above is the verdict");
} finally {
  if (KEEP) console.log(`\n(--keep) left /home/box/sand-data/${dir} and its manifest keys in place`);
  else { step("clean up"); say(inBox(cleanup).trim()); }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
