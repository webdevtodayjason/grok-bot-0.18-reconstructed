#!/usr/bin/env node
// verify-host-upgrade.mjs -- ship a new host bundle WITHOUT recreating the container
// (docs/GAP-ANALYSIS.md SHIP-2).
//
//   SAND_PROFILE_DIRS=... node scripts/verify-host-upgrade.mjs
//
// This gate does not recreate the box, but it does swap the host process out from under everything
// running on it, so it takes /tmp/titanbot-box.lock the same way verify-persistence.mjs does and is
// run DIRECTLY, never through scripts/on-box.sh.
//
// What it proves, in the order the ship would do it:
//   1. the box is pointed at a relay-served bundle source at all (SAND_HOST_BUNDLE_S3_BASE_URL)
//   2. the relay serves the two-file S3 layout out of a runtime directory, and refuses a bad token
//   3. an agent's desktop is open and a shell secret is set, so there is live state to lose
//   4. POST /api/updateHostNow fetches, stages and swaps
//   5. the host process pid changed and the reported host version changed
//   6. the CONTAINER did not restart: same id, same StartedAt, and the desktop's Xvfb pid is the
//      same process it was before -- which is the whole point, because a recreate is what cut every
//      turn in flight and wiped what agents had installed
//   7. the roster is unchanged and the shell secret set before the swap is still set after it
//
// The staged bundle carries a one-line comment naming this run, so its digest -- and therefore its
// version -- differs from whatever the box is already on. Without that a second run of the gate
// would stage the version the box just installed and updateHostNow would rightly answer
// "already-latest", which proves nothing.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireBoxLock } from "./lib/box-lock.mjs";
import { stageHostBundle } from "./stage-host-bundle.mjs";
import { LATEST_VERSION_FILE } from "../ui/host-bundle.mjs";

const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:1340";
const REPO = path.resolve(new URL("..", import.meta.url).pathname);

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

const call = async (method, args = {}, timeoutMs = 60_000) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const roster = async () => (await call("listAgents", {})).map((agent) => `${agent.id} ${agent.name}`).sort();
const hostPid = async () => (await sh("pgrep -f '/home/box/sand-host/host-main.cjs' | head -1")).out.trim();
const boxVersion = async () => (await sh("cat /home/box/sand-host/version 2>/dev/null")).out.trim();
const xvfbPidOf = async (display) => (await sh(`ps -eo pid,args | grep "[X]vfb :${display} " | awk '{print $1}' | head -1`)).out.trim();

const SECRET_FIELD = `VERIFY_SHIP2_${Date.now()}`;
const stage = mkdtempSync(path.join(tmpdir(), "ship2-runtime-"));
let relay;
const release = await acquireBoxLock({ what: "verify-host-upgrade.mjs (swaps the host process)", log: note });
try {
  console.log("== the box's bundle source");
  // The base URL is baked in at container create, so a box that predates the SHIP-2 recreate cannot
  // be talked into this and should say so rather than fail six checks later.
  const env = JSON.parse(await inspect("{{json .Config.Env}}"));
  const base = (env.find((line) => line.startsWith("SAND_HOST_BUNDLE_S3_BASE_URL=")) ?? "").split("=").slice(1).join("=");
  check(base.length > 0, "the box carries SAND_HOST_BUNDLE_S3_BASE_URL", base || "absent: recreate the box with the current recreate script");
  if (base.length === 0) throw new Error("no bundle source on the box");
  const url = new URL(base);
  const tokenSegment = url.pathname === `/runtime/${TOKEN}`;
  check(tokenSegment, "its token segment is this box's gateway bearer", tokenSegment ? `${url.origin}/runtime/<the bearer>` : `${url.origin}${url.pathname.replace(/\/runtime\/.*/, "/runtime/<not the bearer>")}`);
  const port = Number(url.port || 80);

  console.log("== build and stage");
  const built = await run("node", [path.join(REPO, "scripts/build-host.mjs"), "--out", path.join(stage, "build")], { cwd: REPO, timeout: 900_000 });
  check(built.code === 0, "the host bundle built", built.code === 0 ? "" : built.err.trim().slice(0, 300));
  if (built.code !== 0) throw new Error("build failed");
  const staged = await stageHostBundle({ dir: stage, hostMain: path.join(stage, "build/dist/host/host-main.cjs"), repo: REPO });
  // The marker is appended AFTER the first stage and the version recomputed, so the version is the
  // digest of exactly the bytes that will be served.
  appendFileSync(path.join(stage, "host-main.cjs"), `\n// verify-host-upgrade ${new Date().toISOString()}\n`);
  const target = await stageHostBundle({ dir: stage, repo: REPO });
  note(`staged ${target.version} (${target.bytes} bytes), first pass was ${staged.version}`);

  console.log("== the relay serves it");
  relay = spawn("node", [path.join(REPO, "ui/server.mjs")], {
    cwd: REPO,
    env: { ...process.env, SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1", SAND_HOST_RUNTIME_DIR: stage, SAND_BOX_CONTAINER: BOX, SAND_HOST_GATEWAY_URL: GATEWAY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (chunk) => { relayLog += chunk; });
  relay.stderr.on("data", (chunk) => { relayLog += chunk; });
  let listening = false;
  for (let i = 0; i < 40 && !listening; i += 1) {
    await sleep(500);
    try { listening = (await fetch(`http://127.0.0.1:${port}/auth/state`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  }
  check(listening, `a relay is serving the runtime directory on 127.0.0.1:${port}`, listening ? stage : relayLog.slice(-300));
  const served = await (await fetch(`http://127.0.0.1:${port}/runtime/${TOKEN}/${LATEST_VERSION_FILE}`)).text();
  check(served.trim() === target.version, "the version file it serves is the staged one", `${served.trim()} vs ${target.version}`);
  const refused = await fetch(`http://127.0.0.1:${port}/runtime/not-the-token/${LATEST_VERSION_FILE}`);
  check(refused.status === 404, "the same file with a wrong token segment is refused", `HTTP ${refused.status}`);
  // From inside the box, over the name the box resolves, which is the path that actually matters.
  const fromBox = await sh(`curl -s -m 15 ${base}/${LATEST_VERSION_FILE}`);
  check(fromBox.out.trim() === target.version, "the BOX can read that version file over its own base URL", fromBox.out.trim() || "no answer");

  console.log("== live state before the swap");
  const before = { container: await inspect("{{.Id}}"), startedAt: await inspect("{{.State.StartedAt}}"), pid: await hostPid(), version: await boxVersion() };
  const rosterBefore = await roster();
  const first = (await call("listAgents", {}))[0];
  await call("ensureForeverBox", { id: first.id }, 180_000);
  // The assignment file, not the vnc URL: that URL carries the noVNC port as well as the seat token
  // and a regex over it reads :6081 as the display on the shared seat.
  const assignments = JSON.parse((await sh("cat /home/box/.sand-window-assignments.json")).out || "{}").assignments ?? {};
  const display = assignments[first.id];
  const xvfbBefore = Number.isInteger(display) ? await xvfbPidOf(display) : "";
  check(xvfbBefore.length > 0, `an agent's desktop is up on display :${display}`, `Xvfb pid ${xvfbBefore} for ${first.name}`);
  const stored = await call("setShellSecret", { field: SECRET_FIELD, value: `ship2-${target.version}` });
  check(stored?.stored === true, "a shell secret is set before the swap", `${SECRET_FIELD} applied=${stored?.applied}`);
  note(`host pid ${before.pid}, version ${before.version}, container ${before.container.slice(0, 12)} started ${before.startedAt}`);

  console.log("== updateHostNow");
  let update = await call("updateHostNow", {}, 300_000);
  // "already-latest" naming a version that is NOT the one just staged is the ten-minute
  // latest-version cache (host-bundle-source.ts VERSION_CACHE_TTL_MS), not a real answer. Bundles
  // from this commit onward drop that cache on an explicit updateHostNow; an OLDER bundle -- which
  // is exactly what this gate is pointed at the first time it installs the fix -- cannot, so wait
  // the window out once rather than reporting a failure the operator cannot act on.
  if (update?.started === false && update?.reason === "already-latest" && update?.version !== target.version) {
    note(`already-latest named ${update.version}, not the staged ${target.version}: this host bundle caches the version lookup for 10 min and predates the fix that drops it. Waiting the window out once.`);
    await sleep(10 * 60_000 + 30_000);
    update = await call("updateHostNow", {}, 300_000);
  }
  check(update?.started === true && update?.version === target.version, "the gateway staged the new bundle",
    JSON.stringify(update));
  if (update?.started !== true) throw new Error(`updateHostNow refused: ${JSON.stringify(update)}`);

  // The supervisor swaps and relaunches; the gateway is down for a few seconds in between.
  let swapped = false;
  for (let i = 0; i < 90 && !swapped; i += 1) {
    await sleep(2000);
    swapped = await boxVersion() === target.version;
  }
  check(swapped, "the on-disk host version is the new one", `${before.version} -> ${await boxVersion()}`);
  let status;
  for (let i = 0; i < 90 && status == null; i += 1) {
    await sleep(2000);
    try { status = await call("getHostStatus", {}, 10_000); } catch {}
  }
  check(status?.hostVersion === target.version, "the gateway reports the new host version", JSON.stringify(status ?? "no answer"));

  console.log("== what must NOT have changed");
  const after = { container: await inspect("{{.Id}}"), startedAt: await inspect("{{.State.StartedAt}}"), pid: await hostPid() };
  check(after.pid.length > 0 && after.pid !== before.pid, "the host process is a new pid", `${before.pid} -> ${after.pid}`);
  check(after.container === before.container, "the container is the same container", `${before.container.slice(0, 12)}`);
  check(after.startedAt === before.startedAt, "the container was never restarted", before.startedAt);
  const xvfbAfter = await xvfbPidOf(display);
  check(xvfbAfter === xvfbBefore, `the desktop on :${display} is the same X server`, `${xvfbBefore} -> ${xvfbAfter || "gone"}`);
  const rosterAfter = await roster();
  check(rosterAfter.join("|") === rosterBefore.join("|"), "the roster is the same agents", `${rosterBefore.length} -> ${rosterAfter.length}: ${rosterAfter.join(" | ")}`);
  const probe = await call("probeShellSecret", { field: SECRET_FIELD });
  check(probe?.state === "set", "the shell secret set before the swap is still set", JSON.stringify(probe));
} catch (error) {
  check(false, "the gate ran to the end", error instanceof Error ? error.message : String(error));
} finally {
  console.log("== cleanup");
  try { await call("deleteShellSecret", { field: SECRET_FIELD }); } catch {}
  if (relay != null) { relay.kill("SIGTERM"); await sleep(500); relay.kill("SIGKILL"); }
  try { rmSync(stage, { recursive: true, force: true }); } catch {}
  note(`removed ${SECRET_FIELD}, stopped the gate's relay, removed ${stage}`);
  release();
}

console.log(failures === 0 ? "\nOK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
