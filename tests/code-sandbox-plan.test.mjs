// The rules of a coding sandbox, with no daemon anywhere near them (CODE-1, docs/CODE.md).
//
// Every dangerous failure in this wave is an OMISSION from a plan: a mount that is two mounts, a
// --cap-drop that went missing when somebody edited an argv by index, a network that is the shared
// one, a credential that reached a label. None of those throw. All of them produce a container that
// runs, which is why the plan is asserted as a whole list rather than spot-checked.
//
// The pool allocator gets its own case for a different reason. The obvious implementation is a counter
// in the relay's memory, and the relay is restarted as the LAST step of every ship, so a counter hands
// out 10.97.0.0/24 again while the network of that name is still there. Discovery from docker's own
// list is right across a restart, a crash and two relays on one machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODE_CRED_FILE, CODE_DEFAULTS, CODE_FILES_MAX, CODE_POOL, CODE_POOL_PREFIX, CODE_REFUSALS,
  CODE_ROLE, CODE_WORKDIR, PROXY_ALIAS, SHARED_NETWORK, allocateSubnet, argvCarriesSecret, capCheck,
  codeLabels, containerName, copyInPlan, createArgs, credentialEnv, deadlineFor, elapsedSeconds,
  foldTasks, isTaskId, listShape, logTail, networkCreateArgs, networkName, newTaskId,
  parseNetworkSubnets, redactLog, refuse, safeCopyPath, tarOneFile, taskRow, usedPoolSlots,
} from "../ui/code-edge.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLAN = {
  taskId: "a1b2c3d4e5f6",
  slug: "demo",
  agentId: "a_titan",
  taskRoot: "/data/titanbot/demo/volumes/workspace/code/a1b2c3d4e5f6",
  uid: 1000,
  gid: 1000,
  deadlineAt: 1_760_000_000_000,
  image: "titanbot/code-sandbox:1",
  model: "plan-zai-code",
  cpus: 2,
  memory: "2g",
  pids: 512,
};

// ---- the argv, asserted whole -------------------------------------------------------------------

test("the create plan is exactly one mount, no socket, every limit, and nothing but non-secret env", () => {
  const argv = createArgs(PLAN);

  // EXACTLY ONE MOUNT, and it is the bot's own directory. Counted rather than searched, because the
  // failure worth catching is a second one appearing.
  const mounts = argv.filter((part, i) => argv[i - 1] === "-v" || argv[i - 1] === "--volume");
  assert.deepEqual(mounts, [`${PLAN.taskRoot}:${CODE_WORKDIR}`], "one mount, the task directory");

  // The socket, by every spelling anybody would reach for.
  const flat = argv.join(" ");
  assert.ok(!/docker\.sock/.test(flat), "the docker socket is never mounted into a task");
  assert.ok(!/\/home\/sem/.test(flat), "nothing of the operator's own tree reaches a task");
  assert.ok(!flat.includes("--privileged"), "a task is never privileged");
  assert.ok(!flat.includes("--network host"), "a task is never on the host network");
  assert.ok(!flat.includes("--rm"), "no --rm: the exit code, the logs and the summary are read after it exits");

  // The network is the task's own and nothing else.
  assert.equal(argv[argv.indexOf("--network") + 1], networkName(PLAN.taskId));
  assert.notEqual(argv[argv.indexOf("--network") + 1], SHARED_NETWORK);

  // Every limit, by value.
  const flagValue = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(flagValue("--cpus"), "2");
  assert.equal(flagValue("--memory"), "2g");
  assert.equal(flagValue("--memory-swap"), "2g", "swap equal to memory, or the limit is not one");
  assert.equal(flagValue("--pids-limit"), "512");
  assert.equal(flagValue("--cap-drop"), "ALL");
  assert.equal(flagValue("--security-opt"), "no-new-privileges");
  assert.equal(flagValue("--user"), "1000:1000");
  assert.equal(flagValue("--tmpfs"), "/tmp");
  assert.equal(flagValue("--workdir"), CODE_WORKDIR);
  assert.equal(argv.at(-1), PLAN.image, "the image is the last argument");

  // THE ENV: three names and no more, and every value is something a person could read aloud.
  const env = argv.filter((part, i) => argv[i - 1] === "-e");
  assert.deepEqual(env.map((pair) => pair.split("=")[0]).sort(),
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CODE_MAX_TURNS"]);
  assert.equal(env.find((p) => p.startsWith("ANTHROPIC_BASE_URL")), `ANTHROPIC_BASE_URL=http://${PROXY_ALIAS}:4000`);
  assert.ok(!env.some((pair) => /TOKEN|SECRET|KEY=/.test(pair)), "no credential is ever an -e value; docker inspect prints those");
});

test("the credential can never be in the plan, and the check that says so is run on the real argv", () => {
  const key = "sk-titanbot-per-task-0123456789";
  const argv = createArgs(PLAN);
  assert.equal(argvCarriesSecret(argv, key), false);
  // And it catches one that is. This is the assertion the create path runs before it execs.
  assert.equal(argvCarriesSecret([...argv, "-e", `ANTHROPIC_AUTH_TOKEN=${key}`], key), true);
  // A short value is not a secret, so a one-character "key" cannot make every plan look poisoned.
  assert.equal(argvCarriesSecret(argv, "2g"), false);
});

test("the labels carry what a sweep on a relay that has never heard of the task needs", () => {
  const labels = codeLabels(PLAN);
  assert.equal(labels["com.titanbot.role"], CODE_ROLE);
  assert.equal(labels["com.titanbot.tenant"], "demo");
  assert.equal(labels["com.titanbot.task"], PLAN.taskId);
  assert.equal(labels["com.titanbot.agent"], "a_titan");
  // THE DEADLINE IS ON THE CONTAINER, as epoch ms. A timer in the relay's memory does not survive the
  // restart that ends every ship, so this is the only durable wall clock there is.
  assert.equal(labels["com.titanbot.deadline"], String(PLAN.deadlineAt));
  assert.equal(labels["com.titanbot.image"], PLAN.image);
  // And no label is ever a credential: `docker inspect` prints every one of these.
  for (const [name, value] of Object.entries(labels)) {
    assert.ok(!/^sk-/.test(String(value)), `${name} looks like a key`);
  }
});

test("the fallback credential mount is the one case with two mounts, and it is read only", () => {
  const argv = createArgs({ ...PLAN, credFile: "/data/titanbot/demo/code-cred/a1b2c3d4e5f6.env" });
  const mounts = argv.filter((part, i) => argv[i - 1] === "-v");
  assert.equal(mounts.length, 2, "the task directory and the credential, and nothing else");
  assert.equal(mounts[1], `/data/titanbot/demo/code-cred/a1b2c3d4e5f6.env:${CODE_CRED_FILE}:ro`);
  // OUTSIDE volumes/, which is the whole point: a credential under the workspace mount is one the box
  // can open, and the box must never hold this key.
  assert.ok(!mounts[1].includes("/volumes/"), "the fallback credential is outside every box mount");
  // And the rest of the plan is unchanged, which is why it is rebuilt through createArgs rather than
  // spliced out of an argv by index.
  assert.equal(argv[argv.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(argv[argv.indexOf("--user") + 1], "1000:1000");
});

test("the task network is internal, labelled, and cut from the fixed pool", () => {
  const argv = networkCreateArgs({ taskId: PLAN.taskId, subnet: "10.97.3.0/24", slug: "demo" });
  assert.ok(argv.includes("--internal"), "--internal is the boundary; without it a task has egress");
  assert.equal(argv[argv.indexOf("--subnet") + 1], "10.97.3.0/24");
  assert.ok(argv.at(-1).startsWith("tbcode-"));
  assert.ok(argv.join(" ").includes(`com.titanbot.role=${CODE_ROLE}`), "found by label, never by name shape");
  assert.ok(argv[argv.indexOf("--subnet") + 1].startsWith(CODE_POOL_PREFIX),
    "the subnet is inside the pool box-isolation.sh drops, or the host is open to the task");
});

// ---- the pool -----------------------------------------------------------------------------------

test("the allocator takes the lowest free /24 and ignores every network that is not ours", () => {
  // Sixty other networks on the machine, none of them in the pool.
  const others = ["172.17.0.0/16", "192.168.32.0/20", "192.168.48.0/20", "10.96.0.0/16", "109.7.0.0/16"];
  assert.equal(allocateSubnet(others), "10.97.0.0/24");
  assert.equal(allocateSubnet([...others, "10.97.0.0/24"]), "10.97.1.0/24");
  // A GAP IS FILLED, which is the behaviour a counter cannot have: task 0 and task 2 are running and
  // task 1 ended, so the next task takes 1 back.
  assert.equal(allocateSubnet([...others, "10.97.0.0/24", "10.97.2.0/24"]), "10.97.1.0/24");
  // Full is a refusal and not a throw.
  const full = Array.from({ length: 256 }, (_, n) => `10.97.${n}.0/24`);
  assert.equal(allocateSubnet(full), "");
  assert.equal(usedPoolSlots(full).size, 256);
  // 10.970 is not 10.97, and a near miss must not eat a slot.
  assert.equal(usedPoolSlots(["10.97.999.0/24"]).size, 0);
});

test("docker's network listing parses into subnets, including a network on two of them", () => {
  const parsed = parseNetworkSubnets([
    "bridge\t172.17.0.0/16,",
    "titanbot-net\t192.168.48.0/20,",
    "tbcode-aaaa\t10.97.0.0/24,",
    "two\t10.97.1.0/24,fd00::/64,",
    "   ",
  ].join("\n"));
  assert.deepEqual(parsed.filter((r) => r.name === "two").map((r) => r.subnet), ["10.97.1.0/24", "fd00::/64"]);
  assert.equal(allocateSubnet(parsed.map((r) => r.subnet)), "10.97.2.0/24");
});

test("the pool in the planner is the pool the host rule drops, because neither can be derived", () => {
  const script = readFileSync(path.join(repo, "deploy/r750/box-isolation.sh"), "utf8");
  // The nftables rule has to cover a network that does not exist yet, so it cannot be read off docker.
  // That makes the constant load-bearing in two files, and this is the line that keeps them equal.
  assert.match(script, /CODE_POOL="\$\{TITANBOT_CODE_POOL:-10\.97\.0\.0\/16\}"/);
  assert.equal(CODE_POOL, "10.97.0.0/16");
  assert.match(script, /ip saddr %s counter drop comment "CODE-1/, "the pool is dropped, not merely counted");
});

test("the host rule is inside the existing prerouting guard and drops in every mode", () => {
  const script = readFileSync(path.join(repo, "deploy/r750/box-isolation.sh"), "utf8");
  const chain = script.slice(script.indexOf("printf '  chain guarded {"), script.indexOf("printf '  chain host {"));
  assert.ok(chain.includes("CODE-1 coding sandboxes"), "the rule is in the guarded chain the prerouting hook jumps to");
  // FIRST, before the exemptions, so nothing above it can accept a sandbox.
  assert.ok(chain.indexOf("CODE-1 coding sandboxes") < chain.indexOf("EXEMPT_PAIRS"),
    "the pool drop comes before the exemptions");
  // A literal `drop`, not $VERDICT: shadow mode exists to gather evidence before taking something
  // away, and nothing has ever used this pool.
  assert.match(chain, /ip saddr %s counter drop comment/);
  // And --verify is untouched, which is the other half of "additive": the scan that the deploy gate's
  // isolation leg runs must behave exactly as it did, or this wave has moved a proof it did not write.
  // Sliced to the verify block itself, which ends where the apply section begins.
  const verify = script.slice(script.indexOf('if [ "$MODE" = verify ]'), script.indexOf("# ---- apply ---"));
  assert.ok(verify.length > 1000, "the verify block was not found, so this assertion proves nothing");
  assert.ok(!verify.includes("CODE_POOL") && !verify.includes("CODE-1"),
    "the verify leg is not changed by this wave");
});

// ---- what may be copied in ----------------------------------------------------------------------

test("the copy-in guard refuses a climb, a relative path, the host's own store and anything outside", () => {
  const refused = [
    "/home/box/../../etc/shadow",
    "../secrets",
    "notes.md",
    "/home/box/sand-data/store.db",
    "/home/box/sand-data",
    "/etc/passwd",
    "/var/run/docker.sock",
    "/workspace/../etc/hosts",
    "",
    "/home/box/a\nb",
  ];
  for (const path_ of refused) {
    assert.equal(safeCopyPath(path_).ok, false, `${JSON.stringify(path_)} must be refused`);
  }
  // And what is allowed: the bot's own two directories.
  assert.equal(safeCopyPath("/home/box/notes.md").ok, true);
  assert.equal(safeCopyPath("/workspace/src/app.py").ok, true);
  // A path that merely STARTS with an allowed root is not under it.
  assert.equal(safeCopyPath("/workspace-other/x").ok, false);
  // A climb that lands back inside is fine, because it is the resolved path that is checked.
  assert.deepEqual(safeCopyPath("/workspace/src/../app.py").path, "/workspace/app.py");
});

test("the copy-in plan caps the count and numbers two files with one name", () => {
  const many = Array.from({ length: CODE_FILES_MAX + 1 }, (_, n) => `/workspace/f${n}.py`);
  assert.equal(copyInPlan(many).error, "too_many_files");
  const plan = copyInPlan(["/workspace/a/app.py", "/workspace/b/app.py", "/home/box/notes.md"]);
  assert.deepEqual(plan.files.map((f) => f.name), ["app.py", "app-2.py", "notes.md"],
    "two files with one basename do not overwrite each other in the task directory");
  // A refusal names the path, so a bot can fix the one that was wrong.
  const bad = copyInPlan(["/workspace/ok.py", "/etc/passwd"]);
  assert.equal(bad.error, "bad_file");
  assert.match(bad.detail, /\/etc\/passwd/);
});

// ---- the redactor -------------------------------------------------------------------------------

test("the log redactor takes the key out by value and by shape, and keeps the rest readable", () => {
  const key = "sk-titanbot-demo-0123456789abcdef";
  const log = [
    `calling http://titanbot-proxy:4000 with Authorization: Bearer ${key}`,
    `ANTHROPIC_AUTH_TOKEN=${key}`,
    "E2B_API_KEY=e2b_abcdef0123456789",
    "ran pytest: 3 passed",
  ].join("\n");
  const out = redactLog(log, [key]);
  assert.ok(!out.includes(key), "the key this process is holding is removed by value");
  assert.ok(!out.includes("e2b_abcdef0123456789"));
  assert.ok(out.includes("ran pytest: 3 passed"), "a log that says nothing is no use to anybody");
  assert.ok(out.includes("titanbot-proxy:4000"), "the endpoint is not a secret and is worth seeing");
});

test("the normal unrecognized-model line never reaches a model as a failure", () => {
  // CODE-8. This is what the agent always prints against a proxy whose model name is not in its own
  // table, and the turn completes. A model handed this line narrates it to a person as a broken model.
  const lines = logTail([
    "[claude-code:unrecognized_model] plan-zai-code",
    "",
    "writing primes.py",
    "3 passed",
  ].join("\n"));
  assert.deepEqual(lines, ["writing primes.py", "3 passed"]);
});

test("the log tail is bounded by lines and by characters", () => {
  const lines = logTail(Array.from({ length: 500 }, (_, n) => `line ${n}`).join("\n"), { lines: 10 });
  assert.equal(lines.length, 10);
  assert.equal(lines.at(-1), "line 499", "the TAIL, so the newest is kept");
  const long = logTail(Array.from({ length: 50 }, () => "x".repeat(500)).join("\n"), { lines: 40, chars: 1000 });
  assert.ok(long.join("\n").length <= 1000);
});

// ---- the record ---------------------------------------------------------------------------------

test("the task id is short, opaque and never a name a person typed", () => {
  const id = newTaskId();
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(isTaskId(id), true);
  // The id goes into a container name, a network name, a label and a directory name, so anything a
  // route would accept back has to be unable to be any of those things.
  for (const bad of ["../x", "a b", "a/b", "a;rm -rf /", "", "Z".repeat(12), "-rf"]) {
    assert.equal(isTaskId(bad), false, `${JSON.stringify(bad)} must not pass as a task id`);
  }
  assert.equal(containerName(id), `tbcode-${id}`);
  assert.equal(networkName(id), `tbcode-${id}`);
});

test("the rows fold last-write-wins and a list carries no instructions", () => {
  const jsonl = [
    JSON.stringify(taskRow({ taskId: "aa", title: "one", state: "running", startedAt: 100 })),
    JSON.stringify(taskRow({ taskId: "bb", title: "two", state: "running", startedAt: 200 })),
    "{ not json",
    JSON.stringify(taskRow({ taskId: "aa", title: "one", state: "done", startedAt: 100, endedAt: 300 })),
  ].join("\n");
  const rows = foldTasks(jsonl);
  assert.equal(rows.length, 2, "a torn line is skipped rather than failing the read");
  assert.equal(rows[0].taskId, "bb", "newest first");
  assert.equal(rows.find((r) => r.taskId === "aa").state, "done");
  // The box-facing list, which goes into a model's context on every poll.
  const shaped = listShape(rows);
  for (const row of shaped) {
    assert.deepEqual(Object.keys(row).sort(), ["endedAt", "provider", "startedAt", "state", "taskId", "title"]);
  }
});

test("an unknown state is recorded as failed rather than believed", () => {
  assert.equal(taskRow({ taskId: "aa", state: "definitely-fine" }).state, "failed");
  assert.equal(taskRow({ taskId: "aa", state: "spend_cap" }).state, "spend_cap");
});

test("the caps count this workspace's own rows, and the concurrency one is the one that matters", () => {
  const running = (n) => Array.from({ length: n }, (_, i) => ({ taskId: `r${i}`, state: "running", startedAt: Date.now() }));
  assert.equal(capCheck(running(1)).ok, true);
  assert.equal(capCheck(running(2)).error, "concurrent", "two at once is the cap, so the third is refused");
  // Twenty a day, counted over a rolling day and not a calendar one.
  const now = Date.now();
  const today = Array.from({ length: 20 }, (_, i) => ({ taskId: `d${i}`, state: "done", startedAt: now - 1000 }));
  assert.equal(capCheck(today, { nowMs: now }).error, "daily");
  const yesterday = today.map((row) => ({ ...row, startedAt: now - 25 * 60 * 60 * 1000 }));
  assert.equal(capCheck(yesterday, { nowMs: now }).ok, true);
});

test("a deadline is arithmetic on the start, and elapsed never goes backwards", () => {
  const start = 1_760_000_000_000;
  assert.equal(deadlineFor(start, 30), start + 30 * 60_000);
  assert.equal(deadlineFor(start, 0), start + 60_000, "a zero is one minute, not no minutes");
  assert.equal(deadlineFor(start, undefined), start + CODE_DEFAULTS.minutes * 60_000);
  assert.equal(elapsedSeconds(start, start + 90_000), 90);
  assert.equal(elapsedSeconds(start, start - 5000), 0, "a clock that went backwards is not a negative age");
});

// ---- the credential's shape ---------------------------------------------------------------------

test("the credential tar is one readable ustar entry with the key in its body and not its name", () => {
  const key = "sk-titanbot-demo-0123456789abcdef";
  const tar = tarOneFile("env", credentialEnv(key), { mode: 0o600, uid: 1000, gid: 1000 });
  // A header, a padded body and the two end blocks, all on 512-byte boundaries.
  assert.equal(tar.length % 512, 0);
  assert.equal(tar.subarray(0, 3).toString("ascii"), "env");
  assert.equal(tar.subarray(257, 262).toString("ascii"), "ustar");
  assert.equal(tar.subarray(156, 157).toString("ascii"), "0", "a regular file");
  assert.equal(parseInt(tar.subarray(100, 107).toString("ascii"), 8), 0o600);
  assert.equal(parseInt(tar.subarray(108, 115).toString("ascii"), 8), 1000, "owned by the run uid, so it can be truncated");
  // The checksum, recomputed the way tar does it.
  const header = Buffer.from(tar.subarray(0, 512));
  const stored = parseInt(header.subarray(148, 154).toString("ascii"), 8);
  header.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  assert.equal(stored, sum, "a wrong checksum is a tar docker refuses, which reads as the daemon being broken");
  // And the key is in the BODY, which is what makes it invisible to docker inspect.
  assert.ok(tar.subarray(512).toString("utf8").includes(key));
  assert.ok(!tar.subarray(0, 512).toString("binary").includes(key), "never in the header, which is the name");
});

test("a quote in a key cannot break out of the credential file", () => {
  // Not a realistic key, and that is the point: the one that escapes is the one nobody designed for.
  assert.equal(credentialEnv("a'b"), "ANTHROPIC_AUTH_TOKEN='a'\\''b'\n");
  assert.equal(credentialEnv("x"), "ANTHROPIC_AUTH_TOKEN='x'\n");
});

// ---- the sentences ------------------------------------------------------------------------------

test("every refusal is one plain sentence with no tool name, no vendor and no jargon", () => {
  for (const [name, sentence] of Object.entries(CODE_REFUSALS)) {
    assert.ok(sentence.length > 0 && /[.]$/.test(sentence), `${name} is not a sentence: ${sentence}`);
    assert.ok(!sentence.includes("—"), `${name} carries an em dash`);
    // The tool's name never appears in a reply, and neither does a vendor's or a container's.
    assert.ok(!/docker|container|e2b|anthropic|claude|litellm|sandbox|HTTP|409|503|exec/i.test(sentence),
      `${name} says a word a business owner should not have to read: ${sentence}`);
  }
  // And the body shape: `message` first, because it is the string the model reads out verbatim.
  assert.deepEqual(Object.keys(refuse("no_image")), ["message", "started", "error"]);
  assert.equal(refuse("no_image").started, false);
  // An unknown reason still answers a sentence rather than undefined.
  assert.equal(refuse("something nobody wrote").message, CODE_REFUSALS.bad_request);
});

// ---- and that the three files actually ship -----------------------------------------------------

test("sync.sh ships the sandbox image directory, because the Dockerfile's context is that directory", () => {
  const script = readFileSync(path.join(repo, "deploy/r750/sync.sh"), "utf8");
  // A directory rsync with --delete, on the deploy/backup precedent. The entrypoint is COPYd from
  // beside the Dockerfile, so shipping the files anywhere but together builds nothing.
  assert.match(script, /ssh "\$HOST" "mkdir -p '\$ROOT\/deploy\/code-sandbox'"/);
  assert.match(script, /rsync -a --delete "\$REPO\/deploy\/r750\/code-sandbox\/" "\$HOST:\$ROOT\/deploy\/code-sandbox\/"/);
  assert.match(script, /code-sandbox\/\}/, "the say line names it, or a deploy cannot be read back");

  const dockerfile = readFileSync(path.join(repo, "deploy/r750/code-sandbox/Dockerfile"), "utf8");
  // PINNED, both of them. A moving base tag or an @latest agent means the image that answered the
  // gate is not the image the next build installs.
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m, "the base is pinned by digest");
  assert.match(dockerfile, /claude-code@\$\{CLAUDE_CODE_VERSION\}/);
  assert.match(dockerfile, /ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/, "the agent is pinned to an exact version");
  // NO KEYS IN THE IMAGE, asserted rather than trusted.
  assert.ok(!/sk-|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|E2B_API_KEY|ZAI/i.test(dockerfile),
    "nothing in the image is a credential");
  assert.match(dockerfile, /chmod 0711 \/run\/code/, "the credential directory is traversable and not listable");

  const entry = readFileSync(path.join(repo, "deploy/r750/code-sandbox/entrypoint.sh"), "utf8");
  assert.match(entry, /: > "\$CRED"/, "the credential file is truncated as soon as it is sourced");
  assert.match(entry, /jq -r '\.instructions/, "the prompt comes out of a file and never off a command line");
  assert.ok(!/claude -p "/.test(entry), "the instructions are never an argument to the agent");

  // THE PROMPT REALLY REACHES THE AGENT. This assertion used to read `assert.match(entry,
  // /< \/dev\/null/)` -- it pinned the bug instead of the rule. The redirect sat AFTER the pipe on
  // the same command, so it won, the agent read an empty stdin, and every task on the R750 died on
  // "Error: Input must be provided either through stdin or as a prompt argument when using --print"
  // (measured 2026-09-10) while this test stayed green. A pipe and a redirect cannot both feed one
  // stdin, so what has to be true is that the prompt is piped in and nothing takes stdin back.
  const invocation = entry.slice(entry.indexOf("printf '%s' \"$PREAMBLE\""), entry.indexOf("CODE=$?"));
  assert.ok(invocation.length > 0, "the agent is still invoked with the preamble on a pipe");
  assert.match(invocation, /\|\s*claude -p/, "the prompt goes in on a pipe");
  assert.ok(!/<\s*\/dev\/null/.test(invocation),
    "and nothing redirects the agent's stdin away from that pipe, which is what made every task fail");

  // THE LOG REACHES THE CONTAINER'S OWN STREAM AS WELL AS THE FILE. The relay reads a RUNNING task's
  // log with `docker logs`, which is the container's streams and nothing else: measured on the R750
  // 2026-09-10, `docker logs` on a live mid-turn container printed nothing at all, because stderr went
  // only into a file. Every status answer then carried an empty log, and the log strip is the stated
  // reason no terminal was built.
  assert.match(entry, /tail -n \+1 -F "\$LOG" >&2/, "the log is followed onto the container's own stream");
  assert.match(entry, /kill "\$LOG_TAIL"/, "and the follower is stopped when the agent is done");
});

test("a ship rebuilds the sandbox image, and one keeper container makes it un-prunable", () => {
  // MEASURED ON THE R750 2026-09-10: `docker image inspect titanbot/code-sandbox:1` answered "No such
  // image" twenty minutes after a real task had run on it. The image was built by a script no deploy
  // step called, and this host's Coolify has force_docker_cleanup on with a nightly image prune that
  // spares only the repos Coolify itself deploys -- so the coding feature had already gone dead in
  // production and the only cure was a person running the build by hand, which is the hand operation
  // no-hand-operations-on-the-product exists to stop.
  const deploy = readFileSync(path.join(repo, "deploy/r750/install.sh"), "utf8");
  assert.match(deploy, /bash "\$ROOT\/deploy\/code-sandbox\/install\.sh"/,
    "a ship builds the sandbox image, so a prune between ships is repaired by the next one");

  const build = readFileSync(path.join(repo, "deploy/r750/code-sandbox/install.sh"), "utf8");
  // `docker image prune -a` skips any image a container references, running or not. One created and
  // never started container is the whole defence, and it must be recreated on a rebuild or it goes on
  // holding the previous image id while the new one is pruned.
  assert.match(build, /docker create --name "\$KEEPER" "\$IMAGE"/, "one never-started container holds the image");
  assert.match(build, /docker rm -f "\$KEEPER"/, "and it is recreated on a rebuild, not left on the old image");
  assert.ok(!/docker start "\$KEEPER"/.test(build), "the keeper is never started; it is a reference and not a process");

  // And the relay says so in its own log when the image is missing, so the next prune is visible
  // before a customer finds it.
  const edge = readFileSync(path.join(repo, "ui/code-edge.mjs"), "utf8");
  assert.match(edge, /is NOT on this machine, so every coding task will be refused/);
});
