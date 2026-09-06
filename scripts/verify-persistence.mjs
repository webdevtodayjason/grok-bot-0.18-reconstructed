#!/usr/bin/env node
// verify-persistence.mjs -- does a container recreate keep what the box store holds?
// (docs/GAP-ANALYSIS.md PERSIST-1.)
//
//   SAND_PROFILE_DIRS=... node scripts/verify-persistence.mjs
//
// THIS GATE RECREATES THE BOX. It takes the shared /tmp/titanbot-box.lock itself and holds it for
// the whole sequence, so it is run DIRECTLY, never through scripts/on-box.sh (that would deadlock).
// Everything on the four volumes survives a recreate by construction; what this proves is the part
// that does not -- /home/box/cli-config and, through its mirror, the agent home's ~/.config: the CLI
// logins, git identity and tool settings that live in the container's own filesystem and are
// restored only by the copy-in the recreate script now enables.
//
// The sequence:
//   1. the roster, and the container's id and start time
//   2. a marker written into every place the store claims to cover, then one sync cycle
//   3. which of those markers the store manifest actually holds
//   4. recreate through .cache/patched-host/recreate-box.sh, wait for the gateway
//   5. /tmp/sand-copy-in-status.json, quoted, and which markers came back
//   6. the roster again: same agents, same count
//   7. the markers are removed and the store is left as it was found
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { acquireBoxLock } from "./lib/box-lock.mjs";

const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:1340";
const RECREATE = process.env.TITANBOT_RECREATE_SCRIPT
  ?? "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/patched-host/recreate-box.sh";

const token = () => {
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {}
  }
  throw new Error("no local-docker-vm.json token under SAND_PROFILE_DIRS");
};
const TOKEN = token();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`); if (!ok) failures += 1; };
const note = (line) => console.log(`        ${line}`);

const run = (file, args, options = {}) => new Promise((resolve) =>
  execFile(file, args, { maxBuffer: 64 << 20, ...options }, (error, out, err) =>
    resolve({ code: error?.code ?? (error ? 1 : 0), out: String(out ?? ""), err: String(err ?? "") })));
const sh = (cmd) => run("docker", ["exec", BOX, "sh", "-c", cmd]);
const inspect = (format) => run("docker", ["inspect", BOX, "--format", format]).then((r) => r.out.trim());

const call = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const roster = async () => (await call("listAgents", {})).map((agent) => `${agent.id} ${agent.name}`).sort();

// One marker per place the operator cares about, so the run reports what the store really holds
// rather than what the design says it holds. Two of the three are in the container's own filesystem
// and on no volume, so only copy-in can bring them back -- they are the whole point of PERSIST-1.
//
// ~/.config does not reach the store directly (the box-home store category is built only when
// SAND_STORE_BETTER_CLI=1 and SAND_USER_NON_ROOT=1, and this box sets neither). It gets there through
// the image's own /usr/local/bin/persist-cli-auth, which every 30 s mirrors each ~/.config/<tool>
// directory -- plus ~/.ssh, ~/.aws, ~/.docker, ~/.netrc, ~/.npmrc, ~/.gitconfig and the rest of its
// CLI_AUTH_TARGETS -- into /home/box/cli-config, which IS a store category. So the manifest key is
// the mirror's, not the live path's, which is why this looks for the tail of the path.
//
// The stamp is in the DIRECTORY NAME, not only in the file. A store entry is pruned a cycle after
// its file goes away, so a run that reused a fixed path could match the PREVIOUS run's manifest
// entry and then "restore" the previous run's bytes -- which is exactly what the first draft of
// this gate did, and it looked like a pass.
const STAMP = `persist-1-${Date.now()}`;
const MARKERS = [
  { name: "cli-config", dir: `/home/box/cli-config/${STAMP}`, needle: `"home/box/cli-config/${STAMP}/marker.txt"`, onVolume: false },
  { name: "home .config", dir: `/home/box/.config/${STAMP}`, needle: `.config/${STAMP}/marker.txt`, onVolume: false, viaMirror: true },
  { name: "sand-data", dir: `/home/box/sand-data/${STAMP}`, needle: `"home/box/sand-data/${STAMP}/marker.txt"`, onVolume: true },
].map((marker) => ({ ...marker, path: `${marker.dir}/marker.txt` }));

const storeId = async () => (await sh("ls /var/lib/sand-box-store")).out.trim().split(/\s+/).filter(Boolean)[0] ?? "";
const manifestHas = async (id, needle) =>
  // grep -F on the key text: the manifest's keys are these relative paths, and a fixed string match
  // needs no quoting dance through two shells the way an inline JSON parse would.
  (await sh(`grep -F -q '${needle}' /var/lib/sand-box-store/${id}/manifest.json && echo yes || echo no`)).out.trim() === "yes";

const release = await acquireBoxLock({ what: "verify-persistence.mjs (recreates the box)", log: note });
try {
  console.log(`== before`);
  const before = await roster();
  const containerBefore = await inspect("{{.Id}}");
  const startedBefore = await inspect("{{.State.StartedAt}}");
  console.log(`  roster ${before.length}: ${before.join(" | ")}`);
  console.log(`  container ${containerBefore.slice(0, 12)} started ${startedBefore}`);
  const id = await storeId();
  check(id.length > 0, "the box store has a store id", id);

  console.log(`== markers`);
  for (const marker of MARKERS) {
    await sh(`mkdir -p ${marker.dir} && printf '%s' '${STAMP}' > ${marker.path}`);
  }
  // The sync is idle-driven, so wait for a cycle that reports the entries rather than for a fixed
  // number of seconds. The cycle line is in the host log; the manifest is the authority.
  // Up to two minutes: the store sync is idle-driven and persist-cli-auth mirrors on a 30 s tick, so
  // the ~/.config marker has two hops to make before the manifest can hold it.
  const inStore = new Map();
  for (let i = 0; i < 60 && inStore.size < MARKERS.length; i += 1) {
    await sleep(3000);
    for (const marker of MARKERS) {
      if (!inStore.has(marker.name) && await manifestHas(id, marker.needle)) inStore.set(marker.name, true);
    }
  }
  const cycles = (await sh("grep '\\[box-store-sync\\] cycle ok' /tmp/sand-host.log | tail -2")).out.trim().split("\n").filter(Boolean);
  for (const line of cycles) note(line.trim());
  for (const marker of MARKERS) {
    check(inStore.has(marker.name), `store manifest holds the ${marker.name} marker`,
      `${marker.needle}${marker.viaMirror ? " (through persist-cli-auth's cli-config mirror)" : ""}`);
  }

  console.log(`== recreate`);
  const recreated = await run("bash", [RECREATE], { timeout: 600_000 });
  check(recreated.code === 0, "the recreate script ran", recreated.code === 0 ? RECREATE : recreated.err.trim().slice(0, 300));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    await sleep(2000);
    try { await call("getHostStatus", {}); up = true; } catch {}
  }
  check(up, "the gateway answered getHostStatus after the recreate");
  const containerAfter = await inspect("{{.Id}}");
  check(containerAfter !== containerBefore, "it is a new container, so this was a recreate and not a restart",
    `${containerBefore.slice(0, 12)} -> ${containerAfter.slice(0, 12)}`);

  console.log(`== copy-in`);
  const status = (await sh("cat /tmp/sand-copy-in-status.json 2>/dev/null")).out.trim();
  note(`/tmp/sand-copy-in-status.json: ${status.length > 0 ? status : "(absent)"}`);
  const copyInLog = (await sh("grep -E 'copy-in|hydrat' /tmp/sand-copy-in.log 2>/dev/null | tail -4")).out.trim();
  for (const line of copyInLog.split("\n").filter(Boolean)) note(line.trim());
  let parsed;
  try { parsed = JSON.parse(status); } catch { parsed = null; }
  check(parsed != null && parsed.outcome !== "failed", "copy-in ran and did not fail", status.slice(0, 200));

  console.log(`== after`);
  for (const marker of MARKERS) {
    const back = (await sh(`cat ${marker.path} 2>/dev/null`)).out.trim();
    // A marker the store never held cannot come back, and saying it failed would be a lie about
    // this mechanism. The expectation is the store's own coverage, measured above.
    const expected = inStore.has(marker.name);
    const where = marker.onVolume ? "on a volume, so this proves the volume, not copy-in" : "container filesystem: only copy-in restores this";
    check(expected ? back === STAMP : back !== STAMP,
      expected ? `${marker.name} came back through the recreate` : `${marker.name} is gone, which is what an uncovered path does`,
      expected ? `${back || "absent"} (${where})` : back.length === 0 ? "absent, as its absence from the manifest predicted" : `unexpectedly ${back}`);
  }
  const after = await roster();
  check(after.length === before.length && after.join("|") === before.join("|"), "the roster is the same agents before and after",
    `${before.length} -> ${after.length}: ${after.join(" | ")}`);

  console.log(`== cleanup`);
  for (const marker of MARKERS) await sh(`rm -rf ${marker.dir}`);
  // And the mirror copy persist-cli-auth made of the ~/.config marker, which the live path's removal
  // does not touch and which would otherwise sit in the store for good.
  await sh("find /home/box/cli-config -type d -name 'persist-1-*' -prune -exec rm -rf {} +");
  // Leave the store as it was found: the marker paths are pruned from the manifest by the next
  // cycle, which is the sync's own job, but the files must not be left behind on the box.
  const left = ((await sh(MARKERS.map((marker) => `test -e ${marker.path} && echo ${marker.name}`).join("; "))).out
    + (await sh("find /home/box/cli-config /home/box/.config /home/box/sand-data -maxdepth 4 -name 'persist-1-*' -print 2>/dev/null")).out).trim();
  check(left.length === 0, "no marker is left on the box", left || "all removed");
} finally {
  release();
}

console.log(failures === 0 ? "\nOK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
