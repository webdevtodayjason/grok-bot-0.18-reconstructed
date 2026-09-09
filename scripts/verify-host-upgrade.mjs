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
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// GH-1. Jason's box lost its GitHub CLI credential twice, on 2026-09-06 and again on 2026-09-08,
// each time asking him to "gh auth re-login whenever you're ready". The row blamed host swaps, and
// two of its premises turned out to be wrong when they were measured on grok-bot-local-vm
// 2026-09-09:
//
//   * ~/.config/gh is ALREADY the first entry in the image's persist-cli-auth CLI_AUTH_TARGETS,
//     mirrored to /home/box/cli-config every 30 s and copied back in on a container recreate.
//   * A host bundle swap never touches a home at all. The supervisor writes under
//     /home/box/sand-host and /usr/local/bin and nothing else.
//   * The shell store's name rule already allows GITHUB_TOKEN, and gh honours GH_TOKEN then
//     GITHUB_TOKEN AHEAD of hosts.yml, falling back to the file when the value is empty. Measured
//     with gh 2.46.0 in the box: an unset environment gives "You are not logged into any GitHub
//     hosts", a set one gives "Failed to log in to github.com using token (GITHUB_TOKEN)", so gh
//     names the source it read.
//
// What actually bit is persist-cli-auth's PRUNE: when the live ~/.config/gh has no content, the
// mirror is deleted too, so the one path that could have restored the credential is cleared by the
// same sweep that was meant to protect it. That makes the stored GITHUB_TOKEN the primary path and
// the file only a convenience, which is what these legs prove: the store's value still reaches an
// agent's own shell after a real swap, gh's verdict is unchanged, and the config directory and its
// mirror are byte-for-byte what they were. docs/CUSTODY.md carries the whole reasoning.
const GH_FIELD = "GITHUB_TOKEN";
const GH_SIGNATURE_SCRIPT = [
  "#!/bin/sh",
  "# GH-1: a signature of gh's config directory and its persist-cli-auth mirror. Names and content",
  "# hashes only, never a value: hosts.yml holds an OAuth token and this output is printed.",
  "for d in /root/.config/gh /home/box/.config/gh /home/box/cli-config/.config/gh; do",
  '  if [ -d "$d" ]; then',
  '    printf "%s " "$d"',
  '    find "$d" -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum 2>/dev/null | sha256sum | cut -c1-16',
  "  else",
  '    echo "$d absent"',
  "  fi",
  "done",
].join("\n");
const GH_STATUS_SCRIPT = [
  "#!/bin/sh",
  "# GH-1: gh's own verdict, normalised to the shape rather than the wording, so a gh upgrade does",
  "# not read as a regression. No token is ever printed: gh names the SOURCE, never the value.",
  "out=$(gh auth status 2>&1)",
  'case "$out" in',
  '  *"using token (GH_TOKEN)"*) echo "verdict=token:GH_TOKEN" ;;',
  '  *"using token (GITHUB_TOKEN)"*) echo "verdict=token:GITHUB_TOKEN" ;;',
  '  *"Logged in to"*) echo "verdict=logged-in:config-file" ;;',
  '  *"not logged into any"*) echo "verdict=no-credential" ;;',
  '  *) echo "verdict=other" ;;',
  "esac",
].join("\n");

/** Write a script into the box and run it. Nested quoting through `docker exec sh -c` does not survive. */
const runScriptInBox = async (name, body) => {
  const local = path.join(stage, name);
  writeFileSync(local, body, { mode: 0o755 });
  const copied = await run("docker", ["cp", local, `${BOX}:/tmp/${name}`]);
  if (copied.code !== 0) return { code: copied.code, out: copied.err || copied.out };
  const answer = await run("docker", ["exec", BOX, "sh", `/tmp/${name}`]);
  await run("docker", ["exec", BOX, "rm", "-f", `/tmp/${name}`]);
  return answer;
};
const ghSignature = async () => (await runScriptInBox("gh-signature.sh", GH_SIGNATURE_SCRIPT)).out.trim();
const ghVerdict = async () => (await runScriptInBox("gh-status.sh", GH_STATUS_SCRIPT)).out.trim();

let relay;
/** Set only if this gate put it there. An operator's own stored token is never overwritten or removed. */
let ghTokenIsOurs = false;
const release = await acquireBoxLock({ what: "verify-host-upgrade.mjs (swaps the host process)", log: note });
try {
  // The gate before this one may have recreated the box, and the lock is released the moment its
  // process exits rather than when the gateway is answering again. Measured on grok-bot-local-vm
  // 2026-09-09 with three waves queued on this lock: this gate won the lock twice and died on its
  // first call with a bare "fetch failed", which reads as a product fault and is not one. So the
  // first thing it does with the lock is wait for the box to be up, and say so if it never is.
  console.log("== the box answers");
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await call("listAgents", {}, 10_000); ready = true; } catch { await sleep(2000); }
  }
  check(ready, "the box's gateway is answering before anything is measured",
    ready ? "" : "no answer in 120 s: the box is down, or the gate that held the lock before this one left it recreating");
  if (!ready) throw new Error("the box never came up");

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

  // GH-1, the credential Jason actually lost. Set only if this box holds none: an operator's own
  // stored token is read, used and left exactly where it was, never overwritten and never deleted
  // by a gate.
  const ghBefore = await call("probeShellSecret", { field: GH_FIELD }).catch((error) => ({ state: `unreadable: ${error.message}` }));
  if (ghBefore?.state === "set") {
    note(`${GH_FIELD} is already stored on this box; the gate reads it and leaves it alone`);
  } else {
    const ghStored = await call("setShellSecret", { field: GH_FIELD, value: `verify-host-upgrade-${target.version}` });
    ghTokenIsOurs = ghStored?.stored === true;
    check(ghTokenIsOurs, `${GH_FIELD} is in the store before the swap`, `applied=${ghStored?.applied}`);
  }
  // ENV-1 and GATE-11: probed through an agent that HAS a window, never the primary daemon. An
  // agent with a desktop runs every command through that window's own exec daemon, which holds its
  // own environment, and a probe of the primary answered "set" for a variable Chief of staff read
  // zero characters from. `first` is the agent whose desktop was opened above.
  const ghProbeBefore = await call("probeShellSecret", { field: GH_FIELD, agentId: first.id })
    .catch((error) => ({ state: `unreadable: ${error.message}`, shell: "none" }));
  check(ghProbeBefore?.state === "set" && String(ghProbeBefore?.shell ?? "").startsWith("agent:"),
    `${GH_FIELD} reaches the shell of an agent that has a window`,
    `${ghProbeBefore?.state} in ${ghProbeBefore?.shell}${ghProbeBefore?.windowIndex == null ? "" : ` (window ${ghProbeBefore.windowIndex})`}`);
  // gh's own verdict and the two directories persist-cli-auth mirrors. This is the pair that was
  // wiped: a swap must leave both untouched.
  const ghVerdictBefore = await ghVerdict();
  const ghSignatureBefore = await ghSignature();
  note(`gh before the swap: ${ghVerdictBefore || "no answer"}`);
  for (const line of ghSignatureBefore.split("\n")) note(`  ${line}`);

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

  console.log("== AGENTS-CAP-2: the ceiling the new bundle brought with it");
  // Measured HERE, inside the gate, while the lock is still held. Read after the gate exits it is
  // not a measurement of this bundle: grok-bot-local-vm is shared, /opt/titanbot-runtime is a bind
  // mount from another checkout, and on 2026-09-09 a `build-host.mjs --deploy` from a parallel
  // worktree overwrote /home/box/sand-host/host-main.cjs two minutes after a green swap, leaving
  // the version file naming a bundle whose bytes were gone.
  //
  // No literal, for GATE-15's reason: the expected number is read out of the source this bundle was
  // built from. And the box's own setting wins over the default, so a box somebody raised is
  // checked against ITS number rather than against the product's.
  const declaredDefault = Number(
    /SAND_DEFAULT_MAX_AGENTS\s*=\s*(\d+)/.exec(readFileSync(path.join(REPO, "source/shared/agents/agents.ts"), "utf8"))?.[1],
  );
  const settingsRaw = (await sh("cat /home/box/sand-data/sand-host-settings.json 2>/dev/null")).out.trim();
  let pinned;
  try {
    const parsed = JSON.parse(settingsRaw || "{}");
    const value = parsed?.SAND_MAX_AGENTS ?? parsed?.settings?.SAND_MAX_AGENTS;
    // A number rather than a string is ignored by the host's own reader, so it is not a pin here either.
    if (typeof value === "string" && /^\d+$/.test(value)) pinned = Number(value);
  } catch {}
  const containerPin = (await sh("printenv SAND_MAX_AGENTS")).out.trim();
  const expected = containerPin.length > 0 ? Number(containerPin) : pinned ?? declaredDefault;
  const capacity = await call("getAgentCapacity", {}, 30_000).catch((error) => ({ error: error.message }));
  check(Number.isInteger(declaredDefault) && declaredDefault > 1,
    "the tree this bundle was built from declares a default ceiling", `SAND_DEFAULT_MAX_AGENTS ${declaredDefault}`);
  check(Number(capacity?.maxAgents) === expected,
    "the box reports the ceiling this bundle carries",
    `maxAgents ${capacity?.maxAgents ?? capacity?.error} against ${expected} (${containerPin.length > 0 ? "container env" : pinned != null ? "this box's own setting" : "the bundle's default"})`);
  check(capacity?.refusal === `This workspace holds Titan and ${expected - 1} more bots. Remove one to add another.`,
    "and the refusal a person would read names that number in plain words", capacity?.refusal ?? "no refusal");

  console.log("== GH-1: the GitHub credential across a real swap");
  // The same windowed agent, the same question. This is the leg that would have caught what Jason
  // hit: if the swap ever costs an agent its credentials, this reads "unset" here.
  const ghProbeAfter = await call("probeShellSecret", { field: GH_FIELD, agentId: first.id })
    .catch((error) => ({ state: `unreadable: ${error.message}`, shell: "none" }));
  check(ghProbeAfter?.state === "set" && String(ghProbeAfter?.shell ?? "").startsWith("agent:"),
    `${GH_FIELD} still reaches that agent's own shell after the swap`,
    `${ghProbeBefore?.state} -> ${ghProbeAfter?.state} in ${ghProbeAfter?.shell}`);
  const ghVerdictAfter = await ghVerdict();
  check(ghVerdictAfter === ghVerdictBefore && ghVerdictAfter.startsWith("verdict="),
    "gh auth status gives the same verdict it gave before the swap",
    `${ghVerdictBefore || "no answer"} -> ${ghVerdictAfter || "no answer"}`);
  const ghSignatureAfter = await ghSignature();
  check(ghSignatureAfter === ghSignatureBefore,
    "gh's config directory and its persist-cli-auth mirror are unchanged",
    ghSignatureAfter === ghSignatureBefore
      ? ghSignatureAfter.split("\n").join(" | ")
      : `before: ${ghSignatureBefore.split("\n").join(" | ")} / after: ${ghSignatureAfter.split("\n").join(" | ")}`);
  // Said out loud rather than left for a reader to infer, because a green run means two different
  // things depending on what the box holds. gh reads GH_TOKEN, then GITHUB_TOKEN, then
  // ~/.config/gh/hosts.yml, so on a box with no gh login of its own the verdict compared above is
  // "no credential" on both sides -- which proves the swap invented nothing and destroyed nothing,
  // while the credential that actually survived is the stored one the probe just read. The two
  // legs are not interchangeable and the log should never let them be confused.
  note(ghVerdictAfter === "verdict=no-credential"
    ? `this box holds no gh login of its own, so the verdict leg proves the swap left that state alone; the credential proved to survive is the stored ${GH_FIELD}, read through ${ghProbeAfter?.shell}`
    : `gh is authenticating from ${ghVerdictAfter.replace("verdict=", "")}, unchanged across the swap`);
} catch (error) {
  check(false, "the gate ran to the end", error instanceof Error ? error.message : String(error));
} finally {
  console.log("== cleanup");
  try { await call("deleteShellSecret", { field: SECRET_FIELD }); } catch {}
  // Only the placeholder this run put there. A token the operator stored is left where it was:
  // removing somebody's real credential to tidy up after a gate is the failure this row is about.
  if (ghTokenIsOurs) { try { await call("deleteShellSecret", { field: GH_FIELD }); } catch {} }
  if (relay != null) { relay.kill("SIGTERM"); await sleep(500); relay.kill("SIGKILL"); }
  try { rmSync(stage, { recursive: true, force: true }); } catch {}
  note(`removed ${SECRET_FIELD}${ghTokenIsOurs ? ` and this gate's ${GH_FIELD}` : `, left ${GH_FIELD} as it was`}, stopped the gate's relay, removed ${stage}`);
  release();
}

console.log(failures === 0 ? "\nOK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
