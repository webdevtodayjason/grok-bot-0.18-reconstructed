// ui/code-edge.mjs -- coding tasks in a throwaway computer (CODE-1, docs/CODE.md).
//
// A bot hands a piece of work to a sandbox: "write the script and run its test". The sandbox is a
// container with a coding agent in it, one directory, a wall clock and no way out to the internet.
// It writes its files where the bot can already read them and it is gone when the task ends.
//
// WHY THE RELAY OWNS IT. This process is the only one on the machine holding /var/run/docker.sock,
// it mounts /data/titanbot at the identical path the host uses, and it already drives docker through
// the CLI in its own image. The box holds nothing but the gateway bearer it already has, which the
// registry maps to a workspace -- the same credential and the same comparison POST /mail/send takes.
// A box with no relay in front of it resolves nothing and the tool withholds itself rather than
// offering a control that cannot work.
//
// FIVE MEASURED FACTS THIS MODULE IS SHAPED BY. They are in docs/CODE.md with their machines; the
// short version, because each one is a line of code here:
//
//   1. `docker network create --internal` is a real kernel boundary. From inside the finished image
//      on this Mac (Docker Desktop 29.5.3): one on-link route, no default route, no external DNS,
//      Errno 101 to 1.1.1.1:443, api.anthropic.com:443 and registry.npmjs.org:443, while the proxy
//      attached to the same network answered 200.
//   2. ONE NETWORK PER TASK is not optional. On a shared internal network a task reached a peer
//      container by name; turning ICC off to stop that killed the proxy too. Create and attach cost
//      0.07-0.09 s and teardown 0.22-0.24 s, so a network per task is cheap enough to be the rule.
//   3. `--internal` does NOT close the host. Every host port on the bridge gateway answered
//      ConnectionRefused rather than unreachable, and on the R750 the host really listens on 22,
//      2049, 445, 11434, 5000, 8000, 47291, 80 and 443. That is why deploy/r750/box-isolation.sh
//      carries one static drop for the whole 10.97.0.0/16 pool, and why the pool is fixed.
//   4. LiteLLM registers /v1/messages, but on an `openai/` deployment it drives the vendor's
//      /responses endpoint. Declared `hosted_vllm/<model>` against the same api_base and key it
//      bridges to upstream chat/completions and the whole Anthropic surface comes back correct.
//      The prefix is a routing choice, not a claim about the upstream. cp/code.mjs holds that.
//   5. /v1/messages is absent from the tenant key's allowed routes, so the per-task key is minted
//      with its own list. A key minted the ordinary way answers 403, which a model narrates to a
//      person as the model refusing.
//
// THE CREDENTIAL NEVER TOUCHES DISK, ARGV, A LABEL OR AN ENV FLAG. MARKET-17 is the whole measured
// story of a key in a root process argument list that any agent's own shell could read, and `docker
// inspect` prints -e values. So the container is created with non-secret env only, the key is piped
// in as a tar on stdin to `docker cp - <container>:/run/code`, and only then is it started. The
// entrypoint sources that file and truncates it. The named fallback, when a daemon will not take a
// tar on stdin, is a 0600 file owned by the run uid bind-mounted read only and deleted by the end
// path and by the sweep.
//
// Nothing here imports anything outside node builtins: the relay image has no node_modules at all.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, chmod, chown, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// ---- the numbers, all of them named ------------------------------------------------------------

/** The fixed pool every task network is cut from. box-isolation.sh drops this whole /16 to a local
 *  address, once, forever: see fact 3. A task network is a /24 inside it. */
export const CODE_POOL = "10.97.0.0/16";
export const CODE_POOL_PREFIX = "10.97.";
/** 10.97.0.0/24 through 10.97.255.0/24, which is 256 concurrent tasks on one machine. The real cap
 *  is two per workspace, so the pool is never the limit; it is sized so the allocator never has to
 *  think about reuse within a ship. */
export const CODE_POOL_SLOTS = 256;

/** One prefix for the container and its network. They are different namespaces in docker, so the
 *  same name is unambiguous, and one prefix means one thing to recognise in `docker ps`. */
export const CODE_NAME_PREFIX = "tbcode-";
export const CODE_ROLE = "code-sandbox";
export const CODE_ROLE_LABEL = `com.titanbot.role=${CODE_ROLE}`;
/** Found by LABEL and never by name. Coolify regenerates container names, and a name shape is a
 *  string somebody eventually mistypes; the label is written by us on every container we make. */
export const PROXY_ROLE_LABEL = "com.titanbot.role=proxy";
/** The alias the sandbox reaches the proxy by. Aliases are NOT copied when a container is connected
 *  to another network, so this has to be passed on every `docker network connect`. */
export const PROXY_ALIAS = "titanbot-proxy";
export const PROXY_PORT = 4000;
/** The one network a task may never land on, checked by resolved id and not by name. */
export const SHARED_NETWORK = "titanbot-net";

/** The unprivileged user the sandbox image itself runs as (`USER 1000:1000` in its Dockerfile). A
 *  task is never root: the coding agent refuses `--dangerously-skip-permissions` under root, and a
 *  root box can read a file this user owns anyway. See runUidOf. */
export const CODE_IMAGE_UID = 1000;

export const CODE_DEFAULTS = {
  provider: "local",
  /** Wall clock. Enforced off the container's own deadline LABEL by the sweep, never by a timer in
   *  this process's memory (the relay is restarted as the last step of every ship) and never by the
   *  agent's own --timeout (a hung agent never reaches it). */
  minutes: 30,
  /** A real stop, because the per-task key carries max_budget and not soft_budget. Sized for
   *  UNCACHED pricing: LiteLLM drops cache_control on the way to chat/completions, so a coding turn
   *  re-bills its context every time. CODE-6. */
  capUsd: 2,
  concurrent: 2,
  daily: 20,
  cpus: 2,
  memory: "2g",
  pids: 512,
  image: "titanbot/code-sandbox:1",
  /** E2B is off until an operator fills the key and picks it per workspace. CODE-3. */
  e2bTemplate: "",
};

/** Instructions are prose and can be long; 256 KB is far past anything a person writes and small
 *  enough that a looping caller cannot spend this process's memory. */
export const CODE_BODY_LIMIT = 256 * 1024;
/** What may be copied INTO a task. A hard count and a hard byte cap, because the copy runs `docker
 *  exec <box> cat` once per file and a caller naming two thousand paths is a denial of service on
 *  the relay rather than on itself. */
export const CODE_FILES_MAX = 20;
export const CODE_FILE_BYTES_MAX = 256 * 1024;
export const CODE_FILES_BYTES_MAX = 2 * 1024 * 1024;
/** How much log a status call hands back. Enough to see what the agent is doing, short enough that
 *  it fits in a turn beside everything else the model is carrying. */
export const CODE_LOG_LINES = 40;
export const CODE_LOG_CHARS = 8_000;
/** The artifact list. A task that wrote four hundred files is reported as the first hundred and a
 *  count, because the list goes into a model's context. */
export const CODE_FILES_LISTED = 100;
/** How many rows the console is sent, and how many of those carry their log and their file list: the
 *  strip draws four, so four are read in full and the rest are the one-line form. */
export const CODE_CONSOLE_ROWS = 20;
export const CODE_CONSOLE_SHOWN = 4;
/** The tasks file's tail. A few thousand rows, which is more than any workspace's history needs. */
export const CODE_TASKS_TAIL_BYTES = 256 * 1024;
/** The sweep's cadence, and the mail sweep's shape: one pass at start and one on the timer. */
export const CODE_SWEEP_MS = 60_000;
/** Every docker call this module makes. A daemon that does not answer in 30 s is a daemon that is
 *  not going to, and the route above needs to answer the box with a sentence rather than hang. */
export const CODE_DOCKER_TIMEOUT_MS = 30_000;
/** The directory inside the container. /task is the mount, /run/code is the credential, and both
 *  are named here so the entrypoint and the planner cannot drift. */
export const CODE_WORKDIR = "/task";
export const CODE_CRED_DIR = "/run/code";
export const CODE_CRED_FILE = `${CODE_CRED_DIR}/env`;

// ---- the sentences ------------------------------------------------------------------------------
//
// Every refusal is one plain sentence a bot can read straight out to a person: no status code, no
// vendor name, no tool name, no jargon, no em dash. A refusal is never a throw, because a throw
// reaches the model as a stack and the person as nothing.

export const CODE_REFUSALS = {
  not_available: "This instance cannot run a coding task on its own computer yet.",
  no_relay: "Coding tasks are not set up on this instance.",
  no_image: "The coding computer has not been built on this machine yet, so the task did not start.",
  no_proxy: "The model service this task would use could not be found, so the task did not start.",
  no_pool: "Every coding computer on this machine is busy, so the task did not start. Try again in a few minutes.",
  no_record: "The record every coding task is written to could not be reached, so the task did not start. Try again in a minute.",
  concurrent: "This workspace already has as many coding tasks running as it may have at once, so the task did not start.",
  daily: "This workspace has started as many coding tasks today as it may, so the task did not start.",
  cap: "That task reached its spending limit and was stopped, so the work is unfinished.",
  // THE SAME SENTENCE UNDER THE STATE'S OWN NAME. `status` looks a finished task's state up in this
  // table, so without this key the one state that is about money fell through to the generic "stopped
  // before it finished" and the money was never named to the person who pays for it.
  spend_cap: "That task reached its spending limit and was stopped, so the work is unfinished.",
  timed_out: "That task ran longer than it is allowed to and was stopped, so the work may be unfinished.",
  bad_request: "That coding request was not readable, so nothing started.",
  no_title: "A coding task needs a short title, so nothing started.",
  no_instructions: "A coding task needs instructions saying what to do, so nothing started.",
  no_agent: "That coding request did not say which bot it is from, so nothing started.",
  unknown_task: "There is no coding task here with that number.",
  not_ready: "That task is still running, so there is no result to read yet.",
  bad_file: "One of those files cannot be copied into a coding task, so nothing started.",
  too_many_files: `A coding task takes at most ${CODE_FILES_MAX} files, so nothing started.`,
  too_much_file: "Those files are too large to copy into a coding task, so nothing started.",
  no_repo: "A coding task has no way out to the internet, so it cannot fetch a repository. Copy the files in instead.",
  no_e2b_key: "A cloud coding computer has no key stored yet, so the task did not start. The operator sets one.",
  e2b_failed: "The cloud coding computer could not take that task, so nothing started.",
  provider_unknown: "That is not a kind of computer a coding task can run on.",
  rate_limited: "That is more coding than this box may ask for right now, so nothing started. Try again in a minute.",
  stopped: "That task was stopped.",
  not_running: "That task is not running, so there was nothing to stop.",
};

/** The refusal body. One shape so a caller can tell a refusal from a failure without reading prose,
 *  and `message` is always first because it is the string the model reads out verbatim. */
export const refuse = (reason, extra = {}) => ({
  message: CODE_REFUSALS[reason] ?? CODE_REFUSALS.bad_request,
  started: false,
  error: reason,
  ...extra,
});

// ---- naming -------------------------------------------------------------------------------------

/** Short and opaque, and never a name a person typed: the id travels in a container name, a network
 *  name, a label and a directory name, so a title with a space or a slash in it would be four
 *  injection sites. Six bytes is twelve hex characters. */
export const newTaskId = (bytes = randomBytes(6)) => Buffer.from(bytes).toString("hex");
/** The shape a route will accept back, so a caller cannot make a path or an argv out of one. */
export const TASK_ID_RE = /^[0-9a-f]{8,32}$/;
export const isTaskId = (value) => TASK_ID_RE.test(String(value ?? ""));

export const containerName = (taskId) => `${CODE_NAME_PREFIX}${taskId}`;
export const networkName = (taskId) => `${CODE_NAME_PREFIX}${taskId}`;

// ---- the pool -----------------------------------------------------------------------------------

/** Every /24 in the pool that something already holds, read off docker's own networks.
 *
 *  `existing` is a list of subnet strings, in any shape docker prints them. Anything outside the
 *  pool is ignored: the machine has sixty other networks on it and none of them are ours. */
export function usedPoolSlots(existing = []) {
  const used = new Set();
  for (const raw of existing) {
    const text = String(raw ?? "").trim();
    if (!text.startsWith(CODE_POOL_PREFIX)) continue;
    const octet = Number(text.slice(CODE_POOL_PREFIX.length).split(/[./]/)[0]);
    if (Number.isInteger(octet) && octet >= 0 && octet < CODE_POOL_SLOTS) used.add(octet);
  }
  return used;
}

/** The LOWEST FREE /24, and never a counter. A counter in this process's memory is wrong by
 *  construction: the relay is restarted as the last step of every ship, so the counter resets while
 *  the networks it already handed out are still there. Discovery is one `docker network ls` and it
 *  is right across a restart, a crash and two relays on one machine.
 *
 *  Returns "" when the pool is full, which is a plain refusal rather than a throw. */
export function allocateSubnet(existing = []) {
  const used = usedPoolSlots(existing);
  for (let octet = 0; octet < CODE_POOL_SLOTS; octet += 1) {
    if (!used.has(octet)) return `${CODE_POOL_PREFIX}${octet}.0/24`;
  }
  return "";
}

/** `docker network ls` prints no subnet, so the pool is read from an inspect of every network at
 *  once. This parses that output: one line per network, `name<TAB>subnet[,subnet]`. */
export function parseNetworkSubnets(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const text = line.trim();
    if (text.length === 0) continue;
    const [name, subnets = ""] = text.split("\t");
    for (const subnet of subnets.split(",")) {
      const value = subnet.trim();
      if (value.length > 0) out.push({ name: String(name ?? "").trim(), subnet: value });
    }
  }
  return out;
}

// ---- labels and argv ----------------------------------------------------------------------------

/** Everything the sweep needs to act on a container it has never heard of, on a relay that has just
 *  started, with no file to read. The deadline in particular: it is the wall clock, and it lives on
 *  the container because that is the only place that survives this process. */
export function codeLabels({ slug, taskId, agentId, deadlineAt, image }) {
  return {
    "com.titanbot.role": CODE_ROLE,
    "com.titanbot.tenant": String(slug ?? ""),
    "com.titanbot.task": String(taskId ?? ""),
    "com.titanbot.agent": String(agentId ?? ""),
    "com.titanbot.deadline": String(Number(deadlineAt ?? 0)),
    "com.titanbot.image": String(image ?? ""),
  };
}

export const labelArgs = (labels) => Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);

/** The exact argv for `docker network create`. `--internal` is the boundary (fact 1) and the subnet
 *  is from the pool, so box-isolation.sh's one static rule covers it. */
export function networkCreateArgs({ taskId, subnet, slug }) {
  return [
    "network", "create",
    "--internal",
    "--subnet", String(subnet),
    "--label", `com.titanbot.role=${CODE_ROLE}`,
    "--label", `com.titanbot.tenant=${String(slug ?? "")}`,
    "--label", `com.titanbot.task=${String(taskId ?? "")}`,
    networkName(taskId),
  ];
}

/** The exact argv for `docker create`. Every one of these is load-bearing and a test asserts the
 *  whole list, because the dangerous failures here are all omissions:
 *
 *    --network <task net>        the per-task internal network and nothing else. Never `host`,
 *                               never the shared network, and the resolved id is checked against
 *                               the shared network's before this runs.
 *    -v <root>:/task             EXACTLY ONE mount, and it is the agent's own directory. No socket,
 *                               nothing from /home/sem, nothing read from the host.
 *    --cpus / --memory /         measured on cgroup v2, and the R750 is cgroup systemd/v2.
 *      --memory-swap / --pids-limit
 *    --cap-drop ALL             a coding agent needs no capability at all.
 *    --security-opt no-new-privileges
 *    --user <uid>:<gid>         the box's own user, so an artifact is one the box can open. A
 *                               root-owned file in the agent's /workspace is a file it can never
 *                               read, which reads to a person as the task having produced nothing.
 *    --tmpfs /tmp               somewhere to write that is not the mount and not the image.
 *    --workdir /task
 *    NO --rm                    the exit code, the logs and the summary are all read AFTER it
 *                               exits. With --rm there is nothing left to read them from.
 *
 *  And the env: four non-secret values only. The key is piped in after this and before start.
 *
 *  `credFile` is the NAMED FALLBACK and nothing else: when a daemon will not take a tar on stdin,
 *  the key goes into a 0600 file OUTSIDE the tenant's workspace mount (so the box can never read it)
 *  and is bind-mounted read only. That is the one case where a task has two mounts, and it is a key
 *  on a disk for the length of a task, which is why it is second. */
export function createArgs({ taskId, slug, agentId, taskRoot, uid, gid, deadlineAt, image, model, cpus, memory, pids, maxTurns, credFile = "", name = "" }) {
  const labels = codeLabels({ slug, taskId, agentId, deadlineAt, image });
  return [
    "create",
    "--name", String(name || containerName(taskId)),
    "--network", networkName(taskId),
    "-v", `${taskRoot}:${CODE_WORKDIR}`,
    ...(String(credFile).length > 0 ? ["-v", `${credFile}:${CODE_CRED_FILE}:ro`] : []),
    "--cpus", String(cpus ?? CODE_DEFAULTS.cpus),
    "--memory", String(memory ?? CODE_DEFAULTS.memory),
    "--memory-swap", String(memory ?? CODE_DEFAULTS.memory),
    "--pids-limit", String(pids ?? CODE_DEFAULTS.pids),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", `${Number(uid ?? 1000)}:${Number(gid ?? uid ?? 1000)}`,
    "--tmpfs", "/tmp",
    "--workdir", CODE_WORKDIR,
    ...labelArgs(labels),
    // Non-secret, every one of them. ANTHROPIC_BASE_URL names the proxy by its alias on the task
    // network; the model is the hidden deployment cp/code.mjs declares; the third switch keeps the
    // agent from making the side calls it makes on a workstation, which have nowhere to go here.
    "-e", `ANTHROPIC_BASE_URL=http://${PROXY_ALIAS}:${PROXY_PORT}`,
    "-e", `ANTHROPIC_MODEL=${String(model ?? "")}`,
    "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "-e", `CODE_MAX_TURNS=${Number(maxTurns ?? 120)}`,
    String(image ?? CODE_DEFAULTS.image),
  ];
}

/** No credential may ever appear in an argv or a label. This is the assertion, written as a
 *  function so the route can run it before it execs and a test can run it on the plan. */
export function argvCarriesSecret(argv, secret) {
  const needle = String(secret ?? "");
  if (needle.length < 8) return false;
  return argv.some((part) => String(part).includes(needle));
}

// ---- deadlines ----------------------------------------------------------------------------------

export const deadlineFor = (startedAtMs, minutes) =>
  Number(startedAtMs) + Math.max(1, Math.round(Number(minutes ?? CODE_DEFAULTS.minutes))) * 60_000;

export const elapsedSeconds = (startedAtMs, nowMs) =>
  Math.max(0, Math.round((Number(nowMs) - Number(startedAtMs)) / 1000));

// ---- what may be copied in ----------------------------------------------------------------------
//
// A caller names paths in its OWN box. Those paths are handed to `docker exec <box> cat`, so the
// guard is not about tidiness: a path that escapes is a read of another file in the box, and the two
// directories that matter are the agent's own home and its workspace. sand-data is refused outright
// because that is where the host keeps its stores, its settings and its secrets.

export const CODE_FILE_ROOTS = ["/home/box", "/workspace"];

/** A path the copy-in may read, or "" with a reason. Checked on the POSIX path, resolved, so `..`,
 *  a relative path and a path that merely starts with an allowed root all meet the same rule. */
export function safeCopyPath(raw) {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return { ok: false, why: "empty" };
  if (text.includes("\0") || /[\r\n]/.test(text)) return { ok: false, why: "control character" };
  if (!text.startsWith("/")) return { ok: false, why: "not an absolute path" };
  const resolved = path.posix.resolve(text);
  // sand-data first, so a path that is under /home/box AND under sand-data is refused rather than
  // accepted by the root test below. /home/box/sand-data is exactly that path.
  if (resolved === "/home/box/sand-data" || resolved.startsWith("/home/box/sand-data/")) {
    return { ok: false, why: "the host's own store" };
  }
  const inRoot = CODE_FILE_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`));
  if (!inRoot) return { ok: false, why: "outside the bot's own files" };
  return { ok: true, path: resolved, name: path.posix.basename(resolved) };
}

/** The whole list, with the count cap and a refusal naming which one. Duplicated basenames are
 *  numbered rather than overwriting each other. */
export function copyInPlan(paths = []) {
  const list = Array.isArray(paths) ? paths : [];
  if (list.length > CODE_FILES_MAX) return { ok: false, error: "too_many_files" };
  const seen = new Map();
  const files = [];
  for (const raw of list) {
    const checked = safeCopyPath(raw);
    if (!checked.ok) return { ok: false, error: "bad_file", detail: `${String(raw ?? "")}: ${checked.why}` };
    let name = checked.name;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) {
      const ext = path.posix.extname(name);
      name = `${path.posix.basename(name, ext)}-${count}${ext}`;
    }
    files.push({ from: checked.path, name });
  }
  return { ok: true, files };
}

// ---- the log redactor ---------------------------------------------------------------------------
//
// The last lines of a task's log go to the model and onto a person's screen. The agent inside does
// not print its key, but it prints the URLs it called and whatever a failing command printed, and a
// task's own instructions can contain anything the person typed. So everything that looks like a
// credential is replaced before it leaves this process. Over-redacting a log is a cosmetic cost;
// under-redacting it once is a key on a screen.

const SECRET_PATTERNS = [
  // Bearer tokens and Authorization headers, however they are spelled.
  [/\b(authorization|x-api-key|api[-_ ]?key|auth[-_ ]?token)\b(\s*[:=]\s*)(\S+)/gi, "$1$2(hidden)"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer (hidden)"],
  // The shapes the keys in this product actually have: sk-…, and the proxy's own virtual keys.
  [/\bsk-[A-Za-z0-9._-]{8,}/g, "(hidden)"],
  [/\be2b_[A-Za-z0-9._-]{8,}/gi, "(hidden)"],
  // ANTHROPIC_AUTH_TOKEN=… however it reaches a line.
  [/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD))\s*=\s*\S+/g, "$1=(hidden)"],
];

export function redactLog(text, extraSecrets = []) {
  let out = String(text ?? "");
  // The values we KNOW, first and exactly. A per-task key is a literal this process is holding, so
  // it does not need a pattern to match it.
  for (const secret of extraSecrets) {
    const value = String(secret ?? "");
    if (value.length >= 8) out = out.split(value).join("(hidden)");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** The last lines of a log, redacted, bounded both ways. Claude Code's ordinary
 *  `[claude-code:unrecognized_model]` notice on stderr is dropped here rather than handed to a model
 *  that would narrate it as a failure: it is what the agent always prints against a proxy whose
 *  model name it does not have in its own table, and the turn completes. CODE-8. */
export function logTail(text, { lines = CODE_LOG_LINES, chars = CODE_LOG_CHARS, secrets = [] } = {}) {
  const redacted = redactLog(text, secrets);
  const kept = redacted.split("\n")
    .filter((line) => !/\[claude-code:unrecognized_model\]/.test(line))
    .filter((line) => line.trim().length > 0);
  const tail = kept.slice(-lines);
  let out = tail;
  while (out.join("\n").length > chars && out.length > 1) out = out.slice(1);
  return out;
}

// ---- the sweep's decisions ----------------------------------------------------------------------

/** Given what docker holds right now and what this relay knows is live, what has to go.
 *
 *  Listing is BY LABEL ONLY and never by name shape. The local Mac's box carries no role label at
 *  all, so nothing here may assume one is present, and a container somebody else named tbcode-
 *  something is not ours to touch.
 *
 *  `containers`: [{id, name, labels:{...}, running}] from a label-filtered ps.
 *  `networks`:   [{id, name, labels:{...}, members:[...]}] from a label-filtered network ls + inspect.
 *  `live`:       the set of task ids this relay believes are still running.
 */
export function sweepDecisions({ containers = [], networks = [], live = new Set(), nowMs = Date.now() } = {}) {
  const remove = [];
  const keep = [];
  for (const container of containers) {
    const labels = container.labels ?? {};
    if (labels["com.titanbot.role"] !== CODE_ROLE) { continue; }
    const taskId = String(labels["com.titanbot.task"] ?? "");
    const deadline = Number(labels["com.titanbot.deadline"] ?? 0);
    const past = Number.isFinite(deadline) && deadline > 0 && nowMs >= deadline;
    // Orphaned: labelled ours, and this relay has no live task by that id. That is the crash case
    // and the restart case at once, and it is the whole reason the label carries the task id.
    const orphan = taskId.length === 0 || !live.has(taskId);
    if (past || orphan) {
      remove.push({
        ...container,
        taskId,
        slug: String(labels["com.titanbot.tenant"] ?? ""),
        agentId: String(labels["com.titanbot.agent"] ?? ""),
        reason: past ? "timed_out" : "orphan",
      });
    } else keep.push(container);
  }
  // A network goes when it is ours and nothing is in it but the proxy. Never the shared network and
  // never the proxy's own Coolify network: both are matched out by the label, and the name test is
  // the second belt.
  const removeNetworks = [];
  for (const network of networks) {
    const labels = network.labels ?? {};
    if (labels["com.titanbot.role"] !== CODE_ROLE) continue;
    if (network.name === SHARED_NETWORK) continue;
    const taskId = String(labels["com.titanbot.task"] ?? "");
    // A LIVE TASK KEEPS ITS NETWORK, full stop. This used to also require a sandbox container to be
    // an active endpoint on it, and an endpoint is exactly what a container is not between `docker
    // create` and `docker start` -- a sweep tick landing in that window pulled the network out from
    // under a task that was about to run. It also fired for a task whose container had merely
    // stopped, tearing the network down before anything had read the exit code. Removing a live
    // task's network is never this loop's job: `finish` -> `teardown` does it, and the settle leg
    // below is what turns a stopped container into a finished task.
    if (live.has(taskId) && !remove.some((c) => c.taskId === taskId)) continue;
    removeNetworks.push({ ...network, taskId });
  }
  return { remove, keep, removeNetworks };
}

// ---- the task record ----------------------------------------------------------------------------
//
// One jsonl file per workspace, in the workspace's own state directory, beside its mail ledgers. A
// state change appends a row and the last row for a task id wins: crash-safe with no locking, the
// same shape the mail inbox ledger already has.
//
// THIS is where the customer's own words live -- the title and the instructions -- and it is read
// only by this workspace's own console. The control plane's ledger row carries neither, the same
// rule mail_send_log holds about subjects.

export const CODE_STATES = new Set(["running", "done", "failed", "timed_out", "stopped", "spend_cap"]);
export const isFinished = (state) => state !== "running";

/** `at` arrives as epoch ms when a route writes a row and as the ISO string it was written as when a
 *  row is read back and rewritten. Both have to work, and an unreadable one is now and not a throw: a
 *  RangeError out of here would take a whole turn down over a timestamp. */
const stamp = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const parsed = Date.parse(String(value ?? ""));
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
};

export function taskRow(row) {
  return {
    at: stamp(row.at ?? Date.now()),
    taskId: String(row.taskId ?? ""),
    agentId: String(row.agentId ?? ""),
    title: String(row.title ?? "").slice(0, 200),
    provider: String(row.provider ?? CODE_DEFAULTS.provider),
    state: CODE_STATES.has(row.state) ? row.state : "failed",
    startedAt: Number(row.startedAt ?? 0),
    endedAt: Number(row.endedAt ?? 0),
    deadlineAt: Number(row.deadlineAt ?? 0),
    capUsd: Number(row.capUsd ?? 0),
    claimId: Number(row.claimId ?? 0),
    keyAlias: String(row.keyAlias ?? ""),
    model: String(row.model ?? ""),
    sandboxId: String(row.sandboxId ?? ""),
    detail: String(row.detail ?? "").slice(0, 500),
  };
}

/** Last row wins, newest first. */
export function foldTasks(text) {
  const byId = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const taskId = String(parsed?.taskId ?? "");
    if (taskId.length === 0) continue;
    byId.set(taskId, parsed);
  }
  return [...byId.values()].sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0));
}

/** The shape a box-facing list answers with. No instructions, and the title only: a list goes into
 *  a model's context on every poll. */
export const listShape = (rows) => rows.map((row) => ({
  taskId: String(row.taskId ?? ""),
  title: String(row.title ?? ""),
  state: String(row.state ?? ""),
  startedAt: Number(row.startedAt ?? 0),
  endedAt: Number(row.endedAt ?? 0),
  provider: String(row.provider ?? ""),
}));

/** The caps, counted off the workspace's own rows. The concurrency cap is the one that matters:
 *  without it an agent in a loop starts a container a second. */
export function capCheck(rows, { concurrent = CODE_DEFAULTS.concurrent, daily = CODE_DEFAULTS.daily, nowMs = Date.now() } = {}) {
  const running = rows.filter((row) => String(row.state) === "running").length;
  if (running >= concurrent) return { ok: false, error: "concurrent" };
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  const today = rows.filter((row) => Number(row.startedAt ?? 0) >= dayAgo).length;
  if (today >= daily) return { ok: false, error: "daily" };
  return { ok: true, running, today };
}

/** The tail of a workspace's tasks file, folded. The tail and not the whole file, the same way the
 *  mail ledger is read: the cost is fixed whatever the file grew to. */
export async function readTaskRows(file, { maxBytes = CODE_TASKS_TAIL_BYTES } = {}) {
  let raw = "";
  let handle = null;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
    raw = buffer.toString("utf8");
    // A tail starts mid-line, and half a JSON object is not one. Drop to the first newline.
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
  } catch { return []; }
  finally { await handle?.close().catch(() => {}); }
  return foldTasks(raw);
}

/** The last bytes of any file, with the same fixed cost the tasks tail has. The console reads a
 *  FINISHED task's log this way: `docker logs` is gone with the container, and a finished task's log
 *  is the file the entrypoint wrote beside its artifacts. A file that is not there is "" and not a
 *  throw, because a task that died before it opened one is a normal outcome. */
export async function readFileTail(file, { maxBytes = CODE_LOG_CHARS * 2 } = {}) {
  let handle = null;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } catch { return ""; }
  finally { await handle?.close().catch(() => {}); }
}

/** One row, appended. 0600 and owned like its directory, because it holds a customer's own words. */
export async function appendTaskRow(file, row, { ownLikeParent = null } = {}) {
  await appendFile(file, `${JSON.stringify(taskRow(row))}\n`, { mode: 0o600 });
  if (typeof ownLikeParent === "function") await ownLikeParent(file).catch(() => {});
}

// ---- a tar, by hand -----------------------------------------------------------------------------
//
// `docker cp - <container>:/run/code` reads a tar from stdin, and the relay image has no node
// modules, so the tar is written here. One ustar header, the content padded to 512, two zero blocks.
// It exists for exactly one file of about a hundred bytes, so none of tar's harder corners apply.

export function tarOneFile(name, content, { mode = 0o600, uid = 0, gid = 0 } = {}) {
  const body = Buffer.from(String(content), "utf8");
  const header = Buffer.alloc(512, 0);
  const put = (text, offset, length) => header.write(String(text).slice(0, length - 1), offset, length - 1, "utf8");
  const octal = (value, offset, length) =>
    header.write(Number(value).toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  put(name, 0, 100);
  octal(mode & 0o7777, 100, 8);
  octal(uid, 108, 8);
  octal(gid, 116, 8);
  octal(body.length, 124, 12);
  octal(Math.floor(Date.now() / 1000), 136, 12);
  header.write("        ", 148, 8, "ascii"); // checksum field is spaces while it is computed
  header.write("0", 156, 1, "ascii"); // a regular file
  header.write("ustar\0" + "00", 257, 8, "binary");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024, 0)]);
}

/** The credential file the entrypoint sources. One variable, quoted, and a trailing newline so
 *  `.` on it cannot swallow the next thing in the file. */
export const credentialEnv = (key) => `ANTHROPIC_AUTH_TOKEN='${String(key).replace(/'/g, "'\\''")}'\n`;

// ---- the default way to pipe a buffer into a process -------------------------------------------

/** execFile has no stdin, and execFileSync blocks the event loop, so the one call that needs stdin
 *  gets its own helper. Injected in tests; the relay passes nothing and gets this. */
export function spawnWithInput(file, args, input, { timeoutMs = CODE_DOCKER_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(file, args, { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { return resolve({ code: -1, stdout: "", stderr: String(error?.message ?? error) }); }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } finish({ code: -1, stdout, stderr: "timed out" }); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); finish({ code: -1, stdout, stderr: String(error?.message ?? error) }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ code: Number(code ?? -1), stdout, stderr }); });
    try { child.stdin?.end(input); } catch { /* the close handler answers */ }
  });
}

// ---- the E2B driver -----------------------------------------------------------------------------
//
// Same task shape, run on somebody else's machine. Off by default and thin on purpose: the live leg
// is CODE-3 and is not measured in this wave, which is said out loud here, in docs/CODE.md and on
// the panel rather than drawn as a zero.
//
// THE STRUCTURAL LIMIT, because it decides the default: an E2B microVM cannot reach titanbot-proxy,
// so the model credential for an E2B task is not a per-task virtual key and its model spend is NOT
// attributable. The row records minutes and `spend: null` with a reason. That is why local is the
// default and why a public ingress for the proxy is a question for the operator rather than a design
// detail somebody settles in a driver.
//
// The key arrives in the control plane's open response, lives in a local for the length of the call,
// and is never written down, never logged and never read from any file.

export const E2B_API_BASE = "https://api.e2b.dev";
export const e2bApiBase = (env = process.env) => String(env?.CODE_E2B_API_BASE ?? "").trim() || E2B_API_BASE;

export function createE2bDriver({ fetchImpl = fetch, env = process.env, log = () => {} } = {}) {
  const base = e2bApiBase(env);
  const call = async (route, { method = "GET", key = "", body = null, timeoutMs = 30_000 } = {}) => {
    const response = await fetchImpl(`${base}${route}`, {
      method,
      headers: {
        "X-API-KEY": String(key),
        accept: "application/json",
        ...(body == null ? {} : { "content-type": "application/json" }),
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, body: parsed };
  };

  return {
    provider: "e2b",
    /** One sandbox from the operator's template, with egress narrowed and the task's own metadata on
     *  it so a sweep can find one this relay forgot. */
    async start({ key, template, taskId, slug, minutes, instructions }) {
      if (String(key ?? "").length === 0) return { ok: false, error: "no_e2b_key" };
      if (String(template ?? "").length === 0) return { ok: false, error: "no_e2b_key" };
      const made = await call("/sandboxes", {
        method: "POST",
        key,
        body: {
          templateID: String(template),
          timeout: Math.max(60, Math.round(Number(minutes ?? CODE_DEFAULTS.minutes) * 60)),
          allowInternetAccess: false,
          metadata: { titanbotTask: String(taskId), titanbotTenant: String(slug) },
        },
      });
      const sandboxId = String(made.body?.sandboxID ?? made.body?.sandboxId ?? "");
      if (made.status >= 300 || sandboxId.length === 0) return { ok: false, error: "e2b_failed" };
      // The instructions go in as a file, never on a command line, exactly as they do locally.
      await call(`/sandboxes/${encodeURIComponent(sandboxId)}/files`, {
        method: "POST", key,
        body: { path: `${CODE_WORKDIR}/task.json`, data: JSON.stringify({ taskId, instructions }) },
      }).catch(() => null);
      log(`code  ${taskId} started on a cloud computer (${sandboxId})`);
      return { ok: true, sandboxId };
    },
    async status({ key, sandboxId }) {
      const got = await call(`/sandboxes/${encodeURIComponent(String(sandboxId))}`, { key });
      if (got.status === 404) return { ok: true, state: "done", lines: [] };
      if (got.status >= 300) return { ok: false, error: "e2b_failed" };
      const running = got.body?.state === "running" || got.body?.running === true;
      return { ok: true, state: running ? "running" : "done", lines: [] };
    },
    async stop({ key, sandboxId }) {
      const killed = await call(`/sandboxes/${encodeURIComponent(String(sandboxId))}`, { method: "DELETE", key });
      return { ok: killed.status < 300 || killed.status === 404 };
    },
    /** Files out. No model spend: see the note above this driver. */
    async collect({ key, sandboxId }) {
      const got = await call(`/sandboxes/${encodeURIComponent(String(sandboxId))}/files?path=${encodeURIComponent(CODE_WORKDIR)}`, { key });
      if (got.status >= 300) return { ok: false, error: "e2b_failed" };
      const files = Array.isArray(got.body?.entries ?? got.body) ? (got.body.entries ?? got.body) : [];
      return {
        ok: true,
        files: files.map((entry) => ({ path: String(entry?.name ?? entry?.path ?? ""), bytes: Number(entry?.size ?? 0) })),
        spend: null,
        spendReason: "a cloud coding computer cannot reach the model service this instance meters through, so its model spend is not attributed",
      };
    },
  };
}

// ---- the edge -----------------------------------------------------------------------------------

const asString = (value) => (typeof value === "string" ? value.trim() : "");
const oneLine = (value) => String(value ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Every route, with every moving part injected. That is what makes the create path testable without
 * a daemon: a test answers for `execFile` and asserts the exact argv, and the same code runs on the
 * R750 against the real one.
 */
export function createCodeEdge({
  // (file, args, opts, cb) -- node:child_process's own, or a test's.
  execFile,
  readBody,
  drainThenEnd,
  // (bearer) -> {slug, name} | null. registry.matchToken, compared with no early break.
  workspaceOf,
  // (slug, taskId) -> the absolute HOST path of the task directory, which is also the path the box
  // already mounts as /workspace/code/<taskId>. "" when this workspace has no such directory.
  taskRootFor,
  // (slug) -> the box's container name, for `docker exec <box> id -u` and the copy-in. "" if none.
  boxOf = () => "",
  // (slug) -> a directory on the HOST, outside every box's mounts, for the fallback credential file.
  // "" means there is no fallback, and a daemon that will not take a tar on stdin is then a plain
  // refusal rather than a key written somewhere a box can read.
  credRootFor = () => "",
  // async (slug) -> the E2B key, asked for again when a cloud task has to be stopped or read. It is
  // never held between calls. "" means the sandbox is left to its own timeout, which is set on
  // create, and the row says so.
  e2bKeyFor = async () => "",
  // (file) -> void. The relay's own chown-like-the-parent, so an artifact directory is owned the
  // way everything else under the tenant's volume is.
  ownLikeParent = async () => {},
  // async (slug) -> the rows, newest first. async (slug, row) -> append one.
  readTasks = async () => [],
  writeTask = async () => {},
  // async ({slug, agentId, taskId, provider}) -> {ok,id,key,alias,model,capUsd,minutesCap,e2bKey?}
  openTask,
  // async ({id, outcome, minutes, detail}) -> void
  closeTask,
  // () -> Promise<boolean>
  dockerAvailable = async () => false,
  // (slug) -> the settings for this workspace, merged over CODE_DEFAULTS.
  settingsFor = () => ({ ...CODE_DEFAULTS }),
  pipeInto = spawnWithInput,
  e2b = null,
  log = (line) => console.log(line),
  now = () => Date.now(),
} = {}) {
  if (typeof execFile !== "function") throw new Error("createCodeEdge needs an execFile");
  const driver = e2b ?? createE2bDriver({ log });
  // Task ids this process believes are running, so the sweep can tell an orphan from a live task
  // with no file read. Rebuilt from the rows at start, which is what makes a restart safe.
  const live = new Map();

  const sendJson = (res, status, value, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    return res.end(JSON.stringify(value));
  };
  const deny = (res, status, reason, extra = {}) => sendJson(res, status, refuse(reason, extra));

  const docker = (args, { timeoutMs = CODE_DOCKER_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    try {
      execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout, stderr) => resolve({
        ok: error == null,
        code: Number(error?.code ?? 0),
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? error?.message ?? ""),
      }));
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: "", stderr: String(error?.message ?? error) });
    }
  });

  const settings = (slug) => ({ ...CODE_DEFAULTS, ...(settingsFor(slug) ?? {}) });

  // ---- the pieces of the create path, each reversible ------------------------------------------

  /** The run uid, read once per task from the box itself, and it is the ONE number that owns both
   *  the task directory and `--user`. The tenant root is uid 1001 while volumes/workspace is uid
   *  1000, so guessing either one produces an artifact the box cannot open half the time.
   *
   *  ROOT MAPS TO THE IMAGE'S OWN USER, and that is the whole subtlety. Both halves of this were
   *  measured on the R750 on 2026-09-10, one after the other:
   *
   *  - An earlier `uid > 0` guard read a root box's `id -u` of 0 as "no answer" and fell back to
   *    1000 while the directory stayed root-owned, and the agent failed on its first write:
   *    `cannot create /task/SUMMARY.md: Permission denied`.
   *  - Taking 0 at face value fixed the directory and broke the agent instead:
   *    `--dangerously-skip-permissions cannot be used with root/sudo privileges for security
   *    reasons`, so the task wrote a summary saying it had stopped and nothing else.
   *
   *  The constraint is one-way. The artifacts have to be READABLE BY THE BOX, and a box running as
   *  root can read a file owned by anyone; the container, on the other hand, must not be root at
   *  all. So a non-root box keeps its own uid, and a root box gets the image's own unprivileged
   *  user -- which is what `USER 1000:1000` in the Dockerfile already is. */
  async function runUidOf(slug) {
    const box = asString(boxOf(slug));
    if (box.length === 0) return CODE_IMAGE_UID;
    const got = await docker(["exec", box, "id", "-u"], { timeoutMs: 10_000 });
    const uid = Number(String(got.stdout ?? "").trim());
    if (!Number.isInteger(uid) || uid < 0) return CODE_IMAGE_UID;
    return uid === 0 ? CODE_IMAGE_UID : uid;
  }

  /** Every subnet docker already holds, in one call. */
  async function poolInUse() {
    const listed = await docker(["network", "ls", "--format", "{{.Name}}"]);
    const names = String(listed.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (names.length === 0) return [];
    const inspected = await docker([
      "network", "inspect", "--format",
      "{{.Name}}\t{{range .IPAM.Config}}{{.Subnet}},{{end}}",
      ...names,
    ]);
    return parseNetworkSubnets(inspected.stdout).map((row) => row.subnet);
  }

  /** The proxy, by label and never by name. */
  async function proxyContainer() {
    const found = await docker(["ps", "--filter", `label=${PROXY_ROLE_LABEL}`, "--format", "{{.Names}}"]);
    const names = String(found.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    return names[0] ?? "";
  }

  /** Attach the proxy to a task network, once. A repeat connect exits 1, and an already-connected
   *  proxy is a success and not a failure, so the inspect comes first and the error text is read. */
  async function connectProxy(taskId, proxy) {
    const net = networkName(taskId);
    const already = await docker(["network", "inspect", "--format", "{{range .Containers}}{{.Name}} {{end}}", net]);
    if (String(already.stdout ?? "").includes(proxy)) return { ok: true, already: true };
    // The ALIAS is required. Aliases are not copied from another network, so without this the
    // sandbox can reach the proxy only by the name Coolify happened to give the container.
    const joined = await docker(["network", "connect", "--alias", PROXY_ALIAS, net, proxy]);
    if (joined.ok) return { ok: true, already: false };
    if (/endpoint with name .* already exists/i.test(joined.stderr)) return { ok: true, already: true };
    return { ok: false, why: joined.stderr };
  }

  async function teardown(taskId, { proxy = "" } = {}) {
    const name = containerName(taskId);
    const net = networkName(taskId);
    await docker(["rm", "-f", name]);
    if (proxy.length > 0) await docker(["network", "disconnect", "-f", net, proxy]);
    await docker(["network", "rm", net]);
  }

  // ---- start ------------------------------------------------------------------------------------

  async function handleStart(req, res) {
    if (req.method !== "POST") return deny(res, 405, "bad_request");
    const workspace = workspaceFrom(req);
    if (workspace == null) return sendJson(res, 401, { message: "This box is not one this relay knows, so nothing started.", started: false, error: "unauthorized" });
    const slug = String(workspace.slug ?? "");

    let body;
    try { body = JSON.parse(await readBody(req, CODE_BODY_LIMIT) || "{}"); }
    catch (error) {
      if (error?.code === "BODY_TOO_LARGE") {
        return drainThenEnd(req, res, 400, { "content-type": "application/json", "cache-control": "no-store" },
          JSON.stringify(refuse("bad_request")));
      }
      body = null;
    }
    if (body == null || typeof body !== "object" || Array.isArray(body)) return deny(res, 400, "bad_request");

    const agentId = asString(body.agentId);
    if (agentId.length === 0) return deny(res, 400, "no_agent");
    const title = oneLine(body.title).slice(0, 200);
    if (title.length === 0) return deny(res, 400, "no_title");
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    if (instructions.trim().length === 0) return deny(res, 400, "no_instructions");
    // Refused BY NAME rather than ignored. There is no repo parameter in this release because a task
    // has no egress, so a clone cannot run; a parameter that always refuses teaches the model a
    // capability it does not have, and silence teaches it the clone happened. CODE-2.
    if (body.repo != null) return deny(res, 400, "no_repo");

    const copy = copyInPlan(body.files);
    if (!copy.ok) return deny(res, 400, copy.error, copy.detail == null ? {} : { detail: copy.detail });

    const conf = settings(slug);
    const provider = asString(body.provider) || conf.provider;
    if (provider !== "local" && provider !== "e2b") return deny(res, 400, "provider_unknown");
    // The local provider needs this relay to hold the socket. A customer's own instance does not, so
    // it is told so and offered the other road rather than left with a control that does nothing.
    if (provider === "local" && !await dockerAvailable()) {
      return sendJson(res, 409, {
        message: `${CODE_REFUSALS.not_available} A cloud coding computer can run it instead once the operator sets one up.`,
        started: false,
        error: "not_available",
      });
    }

    const rows = await readTasks(slug);
    const caps = capCheck(rows, { concurrent: conf.concurrent, daily: conf.daily, nowMs: now() });
    if (!caps.ok) return deny(res, 429, caps.error);

    const taskId = newTaskId();
    const startedAt = now();
    const deadlineAt = deadlineFor(startedAt, conf.minutes);

    // THE TASK DIRECTORY IS THE AGENT'S OWN DIRECTORY, so there is no copy-back at the end. The
    // bind source is the host side of what the box already mounts as /workspace, which means the
    // sandbox writes straight where the bot can read it with the tools it already has. A symlink the
    // sandbox writes can only ever dereference inside its own mount namespace, so binding once and
    // never copying is strictly safer than a copy and is one fewer moving part.
    const taskRoot = asString(taskRootFor(slug, taskId));
    if (taskRoot.length === 0) return deny(res, 409, "not_available");

    const uid = await runUidOf(slug);
    // ONE VALUE OWNS BOTH HALVES. The directory the task writes into and the user the container runs
    // as have to be the same number, or the agent's very first write fails inside its own mount.
    // They used to come from two places -- `ownLikeParent` for the directory and `runUidOf` for
    // --user -- and on the R750 2026-09-10 they disagreed: the directory came out 0:0 (the relay's
    // own uid, because its parent was made the same way) while the container was given 1000:1000.
    // `ownTo` chowns to the resolved run uid, so the two can no longer drift apart.
    const ownTo = (file) => chown(file, uid, uid).catch(() => {});
    try {
      await mkdir(taskRoot, { recursive: true, mode: 0o700 });
      await chmod(taskRoot, 0o700).catch(() => {});
      await ownTo(taskRoot);
    } catch (error) {
      log(`code  ${slug} could not make a task directory: ${error?.message ?? error}`);
      return deny(res, 503, "no_record");
    }

    // The named files, copied in from the box with the count and the byte caps already applied by
    // copyInPlan. A file that cannot be read is a refusal, not a silent omission: a task missing the
    // file it was told to edit produces confident nonsense.
    let copied = 0;
    let copiedBytes = 0;
    const box = asString(boxOf(slug));
    for (const file of copy.files) {
      if (box.length === 0) break;
      const got = await docker(["exec", box, "sh", "-c", `head -c ${CODE_FILE_BYTES_MAX + 1} -- '${file.from.replace(/'/g, "'\\''")}'`], { timeoutMs: 15_000 });
      if (!got.ok) {
        await rm(taskRoot, { recursive: true, force: true }).catch(() => {});
        return deny(res, 400, "bad_file", { detail: `${file.from} could not be read` });
      }
      if (got.stdout.length > CODE_FILE_BYTES_MAX || copiedBytes + got.stdout.length > CODE_FILES_BYTES_MAX) {
        await rm(taskRoot, { recursive: true, force: true }).catch(() => {});
        return deny(res, 400, "too_much_file");
      }
      await writeFile(path.join(taskRoot, file.name), got.stdout, { mode: 0o600 });
      await ownTo(path.join(taskRoot, file.name));
      copied += 1;
      copiedBytes += got.stdout.length;
    }

    // The instructions travel in a FILE in the task directory, never in argv (any agent's shell can
    // read a root process's arguments, MARKET-17) and never in the outline.
    await writeFile(path.join(taskRoot, "task.json"), `${JSON.stringify({
      taskId, title, instructions, files: copy.files.map((f) => f.name), createdAt: new Date(startedAt).toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    await ownTo(path.join(taskRoot, "task.json"));

    // CLAIM BEFORE THE CONTAINER EXISTS. An unstarted task is recoverable; an unbilled container
    // hour is not, and "every task is on the record" is the whole justification for this route.
    const claim = await Promise.resolve()
      .then(() => openTask({ slug, agentId, taskId, provider }))
      .catch((error) => ({ ok: false, error: "unreachable", message: String(error?.message ?? error) }));
    if (claim?.ok !== true) {
      await rm(taskRoot, { recursive: true, force: true }).catch(() => {});
      if (claim?.error === "rate_limited") return deny(res, 429, "daily", { detail: String(claim.message ?? "") });
      log(`code  a task for ${slug} could not be recorded, so it did not start: ${claim?.message ?? "no answer"}`);
      return deny(res, 503, "no_record");
    }

    const capUsd = Number(claim.capUsd ?? conf.capUsd);
    const minutes = Number(claim.minutesCap ?? conf.minutes);
    const record = {
      at: startedAt, taskId, agentId, title, provider, state: "running",
      startedAt, endedAt: 0, deadlineAt: deadlineFor(startedAt, minutes), capUsd,
      claimId: Number(claim.id ?? 0), keyAlias: String(claim.alias ?? ""), model: String(claim.model ?? ""),
    };

    const fail = async (reason, detail) => {
      await Promise.resolve().then(() => closeTask({ id: record.claimId, outcome: "failed", minutes: 0, detail })).catch(() => {});
      await writeTask(slug, taskRow({ ...record, state: "failed", endedAt: now(), detail }));
      return deny(res, 503, reason);
    };

    if (provider === "e2b") {
      const started = await driver.start({
        key: String(claim.e2bKey ?? ""), template: conf.e2bTemplate,
        taskId, slug, minutes, instructions,
      });
      if (started.ok !== true) return fail(started.error === "no_e2b_key" ? "no_e2b_key" : "e2b_failed", String(started.error ?? "e2b refused"));
      record.sandboxId = started.sandboxId;
      live.set(taskId, { slug, provider, deadlineAt: record.deadlineAt, seenAt: startedAt });
      await writeTask(slug, taskRow(record));
      return sendJson(res, 200, { started: true, taskId, provider, deadlineAt: record.deadlineAt, capUsd });
    }

    // ---- local: network, then proxy, then create, then the credential, then start ---------------

    const subnet = allocateSubnet(await poolInUse());
    if (subnet.length === 0) return fail("no_pool", "the task subnet pool is full");

    const made = await docker(networkCreateArgs({ taskId, subnet, slug }));
    if (!made.ok) return fail("no_pool", `the task network could not be made: ${made.stderr.slice(0, 200)}`);
    // REFUSE IF THE RESOLVED ID IS THE SHARED NETWORK. A name comparison is not enough: the whole
    // point of this check is that a mistake somewhere above handed us a network that is not ours,
    // and the only thing that settles it is the id docker itself resolves the two names to.
    const mine = await docker(["network", "inspect", "--format", "{{.Id}}", networkName(taskId)]);
    const shared = await docker(["network", "inspect", "--format", "{{.Id}}", SHARED_NETWORK]);
    const mineId = String(mine.stdout ?? "").trim();
    const sharedId = String(shared.stdout ?? "").trim();
    if (mineId.length > 0 && sharedId.length > 0 && mineId === sharedId) {
      log(`code  REFUSED: the task network resolved to ${SHARED_NETWORK}; nothing was started`);
      return fail("no_pool", "the task network resolved to the shared network");
    }

    const proxy = await proxyContainer();
    if (proxy.length === 0) {
      await docker(["network", "rm", networkName(taskId)]);
      return fail("no_proxy", "no container carries the proxy label");
    }
    const joined = await connectProxy(taskId, proxy);
    if (joined.ok !== true) {
      await docker(["network", "rm", networkName(taskId)]);
      return fail("no_proxy", `the proxy would not join the task network: ${String(joined.why ?? "").slice(0, 200)}`);
    }

    const argv = createArgs({
      taskId, slug, agentId, taskRoot, uid, gid: uid,
      deadlineAt: record.deadlineAt, image: conf.image, model: record.model,
      cpus: conf.cpus, memory: conf.memory, pids: conf.pids,
    });
    // The assertion, run on the real plan and not only in a test: if the key ever reached an argv
    // this is where it stops, before the daemon sees it.
    if (argvCarriesSecret(argv, claim.key)) {
      await teardown(taskId, { proxy });
      return fail("no_record", "the plan carried the credential, so nothing was started");
    }
    const created = await docker(argv);
    if (!created.ok) {
      await teardown(taskId, { proxy });
      const missing = /no such image|manifest unknown|pull access denied/i.test(created.stderr);
      return fail(missing ? "no_image" : "no_record", created.stderr.slice(0, 300));
    }

    // THE CREDENTIAL, between create and start, as a tar on stdin. Nothing is written to the host
    // filesystem and nothing appears in `docker inspect`.
    const piped = await pipeInto("docker", ["cp", "-", `${containerName(taskId)}:${CODE_CRED_DIR}`],
      tarOneFile("env", credentialEnv(String(claim.key ?? "")), { mode: 0o600, uid, gid: uid }));
    let delivery = "stdin-tar";
    if (piped.code !== 0) {
      // THE NAMED FALLBACK, chosen here rather than invented at the time: a 0600 file owned by the
      // run uid, OUTSIDE every box's mount so the box can never read it, bind-mounted read only, and
      // deleted by the end path and by the sweep. Second because it is a key on a disk for the length
      // of a task, which the tar is not.
      const credRoot = asString(credRootFor(slug));
      if (credRoot.length === 0) {
        await teardown(taskId, { proxy });
        return fail("no_record", `the credential could not be delivered: ${String(piped.stderr ?? "").slice(0, 200)}`);
      }
      log(`code  ${taskId} could not take the credential on stdin (${String(piped.stderr ?? "").slice(0, 120)}), using the file fallback`);
      const credFile = path.join(credRoot, `${taskId}.env`);
      await mkdir(credRoot, { recursive: true, mode: 0o700 });
      await writeFile(credFile, credentialEnv(String(claim.key ?? "")), { mode: 0o600 });
      // The same one value again: a 0600 file the run uid does not own is a credential the task
      // cannot read, which reads on screen as the model refusing rather than as a mount that failed.
      await chown(credFile, uid, uid).catch(() => {});
      // The whole plan again with the read-only credential mount on it, under a second name, and the
      // first container removed. Rebuilt through createArgs rather than spliced out of the argv above,
      // because an argv edited by index is the kind of thing that silently drops --cap-drop.
      const again = await docker(createArgs({
        taskId, slug, agentId, taskRoot, uid, gid: uid,
        deadlineAt: record.deadlineAt, image: conf.image, model: record.model,
        cpus: conf.cpus, memory: conf.memory, pids: conf.pids,
        credFile, name: `${containerName(taskId)}f`,
      }));
      if (!again.ok) {
        await rm(credFile, { force: true }).catch(() => {});
        await teardown(taskId, { proxy });
        return fail("no_record", `the credential could not be delivered: ${again.stderr.slice(0, 200)}`);
      }
      await docker(["rm", "-f", containerName(taskId)]);
      await docker(["rename", `${containerName(taskId)}f`, containerName(taskId)]);
      delivery = "cred-file";
    }

    const begun = await docker(["start", containerName(taskId)]);
    if (!begun.ok) {
      await teardown(taskId, { proxy });
      return fail("no_record", begun.stderr.slice(0, 300));
    }

    // `seenAt` is the last moment this relay knows the container existed. It starts at the start and
    // the sweep stamps it on every pass; it is what a task whose container vanishes is billed to.
    live.set(taskId, { slug, provider, deadlineAt: record.deadlineAt, proxy, delivery, seenAt: startedAt });
    await writeTask(slug, taskRow(record));
    log(`code  ${slug}/${taskId} started on this machine (${subnet}, ${copied} file(s) in, ${delivery})`);
    return sendJson(res, 200, { started: true, taskId, provider, deadlineAt: record.deadlineAt, capUsd });
  }

  // ---- status, stop, result, list ---------------------------------------------------------------

  function workspaceFrom(req) {
    const header = String(req.headers?.authorization ?? "");
    const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
    return presented.length === 0 ? null : workspaceOf(presented);
  }

  const askedTask = async (req, res) => {
    const workspace = workspaceFrom(req);
    if (workspace == null) { sendJson(res, 401, { message: "This box is not one this relay knows.", error: "unauthorized" }); return null; }
    let body = null;
    try { body = JSON.parse(await readBody(req, CODE_BODY_LIMIT) || "{}"); } catch { body = null; }
    const taskId = asString(body?.taskId);
    // `found` and not `started`: this is the shape status promises, and the same shape answers stop
    // and result so a caller never has to tell three refusals apart.
    const missing = { found: false, message: CODE_REFUSALS.unknown_task, error: "unknown_task" };
    if (!isTaskId(taskId)) { sendJson(res, 400, missing); return null; }
    const slug = String(workspace.slug ?? "");
    const rows = await readTasks(slug);
    const row = rows.find((r) => String(r.taskId) === taskId);
    if (row == null) { sendJson(res, 404, missing); return null; }
    return { slug, taskId, row, agentId: asString(body?.agentId) };
  };

  /** The one place a running task's real state is established, so status, result and the sweep all
   *  agree. A local task is read off the container; the file is the fallback and the history. */
  async function settleLocal(slug, row) {
    const taskId = String(row.taskId);
    // FinishedAt comes back too, because the minutes on the ledger row are what the operator bills
    // from. A task that died in its first second and was closed by the next sweep was billed from its
    // start to the moment somebody noticed: measured on the R750 2026-09-10, a container that exited
    // after about a second went onto the ledger as 16.78 minutes. The clock stops when the container
    // stopped, not when this process found out.
    const got = await docker(["inspect", "--format",
      "{{.State.Status}}\t{{.State.ExitCode}}\t{{.State.OOMKilled}}\t{{.State.FinishedAt}}", containerName(taskId)]);
    if (!got.ok) {
      // GONE FROM UNDER US. The container this row points at is not on the machine any more: somebody
      // removed it, a daemon restart took it, or the image's own cleanup did. MEASURED ON THE R750
      // 2026-09-10: a task whose container was removed by hand stayed `running` for ever -- the sweep
      // only ever looked at the containers docker returned, so a row with no container was in none of
      // its legs, and adopt() made it live again on every restart. It held one of the workspace's two
      // slots, its network stayed on the machine and the bot was never told anything.
      //
      // AND THE CLOCK STOPS WHERE IT WAS LAST SEEN, not now. There is no FinishedAt to read, so
      // billing to now is the same error the other path already fixed: the same measurement closed an
      // 8 second container for 3.13 minutes. The sweep stamps `seenAt` every time it finds the
      // container alive, so the last honest moment is that one, bounded by the task's own deadline.
      const held = live.get(taskId);
      const seen = Number(held?.seenAt ?? 0) || Number(row.startedAt ?? 0);
      const deadline = Number(row.deadlineAt ?? 0);
      const endedAt = deadline > 0 ? Math.min(seen, deadline) : seen;
      return {
        state: row.state === "running" ? "failed" : String(row.state),
        exit: -1,
        gone: true,
        endedAt: endedAt > 0 ? endedAt : undefined,
        detail: row.state === "running" ? "the machine it was running on is gone" : "",
      };
    }
    const [status, exit, oom, finishedAt] = String(got.stdout ?? "").trim().split("\t");
    if (status === "running" || status === "created") return { state: "running", exit: 0 };
    // A zero time is docker's "never finished"; anything before the task started is not a clock this
    // row can use either, so both fall back to now and the minutes are no worse than they were.
    const stopped = Date.parse(String(finishedAt ?? ""));
    const endedAt = Number.isFinite(stopped) && stopped > Number(row.startedAt ?? 0) ? stopped : undefined;
    if (oom === "true") return { state: "failed", exit: Number(exit ?? 0), endedAt, detail: "the task ran out of memory" };
    // A --max-turns exit is a NORMAL outcome and not a failure: the agent stopped because it was
    // told how many turns it may take. CODE-8.
    return { state: Number(exit ?? 0) === 0 ? "done" : "failed", exit: Number(exit ?? 0), endedAt };
  }

  /** THE CLOSED ROW IS WRITTEN BEFORE THE CONTROL PLANE IS TOLD, and the whole task closes once.
   *
   *  MEASURED ON THE R750 2026-09-10. The close used to await the control plane first, and that await
   *  waits up to twenty seconds on a spend the proxy books late -- so for twenty seconds after this
   *  relay had decided a task was finished the row still said `running`, and any status, result or
   *  sweep landing in that window settled the same task a second time. Two byte-identical `done` rows
   *  for one task id were in /data/titanbot/demo/state/code-tasks.jsonl, and the first status after a
   *  task ended answered `state:"done"` beside `endedAt:0, elapsedS:0` because it read the row from
   *  before the settle. The row goes down first, and `closing` makes a second caller wait for the
   *  first answer instead of producing its own.
   *
   *  WHAT THE NEW ORDER COSTS, named rather than discovered: if this process dies between the row and
   *  the control plane's close, the ledger claim stays open. That case already has an owner -- the
   *  control plane's own key sweep closes a claim nothing came back about once its deadline has passed,
   *  as `lost` -- whereas a row left saying `running` had no owner at all and was the measured failure. */
  const closing = new Map();

  async function finish(slug, row, state, detail = "", options = {}) {
    const taskId = String(row.taskId);
    const already = closing.get(taskId);
    if (already != null) return already;
    const run = closeOnce(slug, row, state, detail, options);
    closing.set(taskId, run);
    try { return await run; } finally { closing.delete(taskId); }
  }

  async function closeOnce(slug, row, askedState, detail, { endedAt: when = 0 } = {}) {
    const taskId = String(row.taskId);
    const held = live.get(taskId);
    // THE SPENDING LIMIT, RECOGNISED BEFORE ANYTHING IS WRITTEN DOWN. The cap is a max_budget on the
    // task's own key, so a task that reaches it gets no cap signal at all: the proxy refuses the
    // agent's next call, the agent's turn dies and the container exits non-zero, which read to
    // everyone downstream as "did not finish" with the money never named. `spend_cap` was in the state
    // set, in the wire vocabulary, in the strip's words and in the refusal sentence, and NOTHING in the
    // product ever wrote it; this is the only thing that does. The proxy's own budget refusal is in the
    // agent's log, which is read here -- before the row and before the ledger, so the customer's row
    // and the operator's row agree. The spend the close reads is the second signal, below.
    const state = askedState === "failed" && await logSaysBudget(slug, taskId) ? "spend_cap" : askedState;
    // The container's own stop time when there is one, so the billed minutes are the minutes the
    // container really ran and not the minutes until something asked about it.
    let endedAt = Number(when) > 0 ? Number(when) : now();
    // A TASK KILLED FOR TIME IS BILLED TO ITS OWN LIMIT. The sweep is the only enforcement and it
    // runs once a minute, so the kill lands up to a minute late: measured on the R750 2026-09-10, a
    // one minute task was swept 58 s past its deadline and the operator's row read 1.96 minutes
    // against a one minute cap. The overshoot is the product's, not the customer's.
    const deadlineAt = Number(row.deadlineAt ?? 0);
    if (state === "timed_out" && deadlineAt > 0) endedAt = Math.min(endedAt, deadlineAt);
    const minutes = Math.max(0, Math.round(((endedAt - Number(row.startedAt ?? endedAt)) / 60_000) * 100) / 100);
    live.delete(taskId);
    // THE ROW FIRST. Nothing after this line may leave the row saying `running`, however long the
    // control plane takes or whether it answers at all.
    await writeTask(slug, taskRow({ ...row, state, endedAt, detail }));
    if (String(row.provider) === "e2b") {
      // The key is asked for again rather than held. With none the sandbox stops on the timeout set
      // when it was created, which is why that timeout is set at all.
      const key = await Promise.resolve().then(() => e2bKeyFor(slug)).catch(() => "");
      if (String(key).length > 0) await driver.stop({ key, sandboxId: String(row.sandboxId ?? "") }).catch(() => {});
      else log(`code  ${taskId} is left to its own time limit: no cloud key to stop it with`);
    } else {
      await teardown(taskId, { proxy: String(held?.proxy ?? await proxyContainer()) });
      // The fallback credential file, if that leg was used. The artifacts stay exactly where they
      // are: the mount is already the bot's own directory, so there is no copy-back at all.
      const credRoot = asString(credRootFor(slug));
      if (credRoot.length > 0) await rm(path.join(credRoot, `${taskId}.env`), { force: true }).catch(() => {});
    }
    // The model spend, read from the per-task key at the control plane's close. /key/info was
    // immediate and correct in measurement; /spend/logs is batch written every 10 s and produced
    // zero rows for priced /v1/messages calls over three minutes of polling. CODE-11.
    const closed = await Promise.resolve()
      .then(() => closeTask({ id: Number(row.claimId ?? 0), outcome: state, minutes, detail }))
      .catch((error) => { log(`code  could not close task row ${row.claimId}: ${error?.message ?? error}`); return null; });
    // AND THE SECOND SIGNAL: the spend the close just read reached the cap. This one is only knowable
    // AFTER the control plane has answered, so it rewrites the workspace's row -- the ledger row keeps
    // the outcome it was closed with, and the log line says what happened. CODE-13 is why neither
    // signal can fire on the R750 today: an unpriced deployment books every turn at nothing, so the
    // budget is never reached and the proxy never refuses for it.
    let settledState = state;
    if (state === "failed") {
      const cap = Number(row.capUsd ?? 0);
      const spend = Number(closed?.spendUsd);
      if (cap > 0 && Number.isFinite(spend) && spend >= cap) {
        settledState = "spend_cap";
        await writeTask(slug, taskRow({ ...row, state: settledState, endedAt, detail }));
        log(`code  ${slug}/${taskId} reached its spending limit: ${spend} of ${cap}`);
      }
    } else if (state !== askedState) {
      log(`code  ${slug}/${taskId} was stopped by its spending limit, which the proxy said in its log`);
    }
    return { state: settledState, endedAt, minutes };
  }

  /** The proxy's own budget refusal, in the agent's log. A key over its max_budget is refused with
   *  LiteLLM's budget sentence, which the agent prints and then dies on; the words are the only
   *  evidence left once the container is gone, and they are read off the file rather than the
   *  container so this works after the teardown above. */
  async function logSaysBudget(slug, taskId) {
    const root = asString(taskRootFor(slug, taskId));
    if (root.length === 0) return false;
    const text = await readFileTail(path.join(root, "agent.log"));
    if (text.length === 0) return false;
    return /budget[^\n]{0,80}exceed|exceed[^\n]{0,80}budget|max_budget/i.test(text);
  }

  async function handleStatus(req, res) {
    const asked = await askedTask(req, res);
    if (asked == null) return undefined;
    const { slug, row } = asked;
    let state = String(row.state);
    let lines = [];
    // THE STOP TIME THE SETTLE JUST DECIDED, not the one on the row that was read before it. The row
    // in hand was loaded before this call settled anything, so on the first status after a task ends
    // its `endedAt` is still 0 -- measured twice on the R750 2026-09-10, both answering
    // `state:"done", endedAt:0, elapsedS:0` where a later call on the same task read 52 s and 230 s.
    let endedAt = Number(row.endedAt ?? 0);
    if (state === "running" && String(row.provider) === "local") {
      const settled = await settleLocal(slug, row);
      // A container that is gone has no log to read, and asking for one is a docker call whose only
      // possible answer is the same error the inspect just gave.
      if (settled.gone !== true) {
        const got = await docker(["logs", "--tail", String(CODE_LOG_LINES * 2), containerName(String(row.taskId))]);
        lines = logTail(`${got.stdout}\n${got.stderr}`, { secrets: [] });
      }
      if (settled.state !== "running") {
        const closed = await finish(slug, row, settled.state, String(settled.detail ?? ""), { endedAt: Number(settled.endedAt ?? 0) });
        state = String(closed?.state ?? settled.state);
        endedAt = Number(closed?.endedAt ?? 0);
      }
    } else if (state === "running") {
      const key = await Promise.resolve().then(() => e2bKeyFor(slug)).catch(() => "");
      const settled = await driver.status({ key: String(key), sandboxId: String(row.sandboxId ?? "") });
      if (settled.ok === true && settled.state !== "running") {
        const closed = await finish(slug, row, "done");
        state = String(closed?.state ?? "done");
        endedAt = Number(closed?.endedAt ?? 0);
      }
    }
    if (state !== "running" && !(endedAt > 0)) endedAt = now();
    return sendJson(res, 200, {
      found: true,
      state,
      startedAt: Number(row.startedAt ?? 0),
      endedAt: state === "running" ? 0 : endedAt,
      elapsedS: elapsedSeconds(Number(row.startedAt ?? now()), state === "running" ? now() : endedAt),
      provider: String(row.provider),
      lines,
      message: state === "running"
        ? "That task is still working."
        : (state === "done" ? "That task has finished." : CODE_REFUSALS[state] ?? "That task stopped before it finished."),
    });
  }

  async function handleStop(req, res) {
    const asked = await askedTask(req, res);
    if (asked == null) return undefined;
    const { slug, row } = asked;
    if (String(row.state) !== "running") return sendJson(res, 200, { stopped: false, message: CODE_REFUSALS.not_running });
    await finish(slug, row, "stopped", "stopped on request");
    return sendJson(res, 200, { stopped: true, message: CODE_REFUSALS.stopped });
  }

  /** What a task left on disk, in name order. One reader for the bot's `result` and for the console's
   *  strip, so the two can never show a person and a model different file lists. */
  async function artifactsIn(root) {
    const files = [];
    if (asString(root).length === 0) return files;
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(".code-cred")) continue;
        if (files.length >= CODE_FILES_LISTED) break;
        const size = await stat(path.join(root, entry.name)).then((s) => s.size).catch(() => 0);
        files.push({ path: entry.name, bytes: size });
      }
    } catch { /* the list is empty, which is an honest answer */ }
    return files;
  }

  /** The last lines of a task's log, for a person's screen. A RUNNING local task is read off the
   *  container; a finished one is read off the file the entrypoint wrote, because `docker logs` goes
   *  with the container the moment the task ends. Both are redacted by logTail. */
  async function logLinesFor(slug, row) {
    const taskId = String(row.taskId ?? "");
    if (String(row.provider) === "e2b") return [];
    if (String(row.state) === "running") {
      const got = await docker(["logs", "--tail", String(CODE_LOG_LINES * 2), containerName(taskId)], { timeoutMs: 10_000 });
      if (got.ok) return logTail(`${got.stdout}\n${got.stderr}`, { secrets: [] });
      // A container that is gone still has its file, which is the whole reason the entrypoint keeps one.
    }
    const root = asString(taskRootFor(slug, taskId));
    if (root.length === 0) return [];
    return logTail(await readFileTail(path.join(root, "agent.log")), { secrets: [] });
  }

  /** The artifacts, where they already are, plus the summary the sandbox agent wrote. */
  async function handleResult(req, res) {
    const asked = await askedTask(req, res);
    if (asked == null) return undefined;
    const { slug, row } = asked;
    if (String(row.state) === "running") {
      // One settle first, so a task that finished a second ago is not reported as running.
      if (String(row.provider) === "local") {
        const settled = await settleLocal(slug, row);
        if (settled.state === "running") return sendJson(res, 200, { ready: false, message: CODE_REFUSALS.not_ready });
        const closed = await finish(slug, row, settled.state, String(settled.detail ?? ""), { endedAt: Number(settled.endedAt ?? 0) });
        // The state the close settled on, which is not always the state the settle proposed: a task
        // that died because its key was over budget goes out as `spend_cap` rather than `failed`.
        row.state = String(closed?.state ?? settled.state);
        row.endedAt = Number(closed?.endedAt ?? row.endedAt ?? 0);
      } else return sendJson(res, 200, { ready: false, message: CODE_REFUSALS.not_ready });
    }
    // A cloud task's files are on somebody else's machine, so they are read back over the API rather
    // than off a mount. No model spend comes with them: see the note above the driver. CODE-3.
    if (String(row.provider) === "e2b") {
      const key = await Promise.resolve().then(() => e2bKeyFor(slug)).catch(() => "");
      const got = await driver.collect({ key: String(key), sandboxId: String(row.sandboxId ?? "") }).catch(() => ({ ok: false }));
      const files = got.ok === true ? got.files : [];
      return sendJson(res, 200, {
        ready: true, state: String(row.state), summary: "", files, path: "",
        message: files.length === 0
          ? "That task ran on a cloud computer and left no files this console could read back."
          : `That task left ${files.length} file${files.length === 1 ? "" : "s"} on a cloud computer.`,
      });
    }
    const root = asString(taskRootFor(slug, String(row.taskId)));
    const files = await artifactsIn(root);
    const summary = root.length === 0 ? "" : await readFile(path.join(root, "SUMMARY.md"), "utf8").catch(() => "");
    // The path the BOT reads, which is its own /workspace and not the host's /data path. A host path
    // in a model's context is a path it will try and fail to open, and then report as missing.
    const own = `/workspace/code/${String(row.taskId)}`;
    return sendJson(res, 200, {
      ready: true,
      state: String(row.state),
      summary: redactLog(summary).slice(0, 20_000),
      files,
      path: own,
      message: files.length === 0
        ? `That task left no files in ${own}.`
        : `That task left ${files.length} file${files.length === 1 ? "" : "s"} in ${own}.`,
    });
  }

  async function handleList(req, res) {
    const workspace = workspaceFrom(req);
    if (workspace == null) return sendJson(res, 401, { message: "This box is not one this relay knows.", error: "unauthorized" });
    const rows = await readTasks(String(workspace.slug ?? ""));
    return sendJson(res, 200, { tasks: listShape(rows) });
  }

  // ---- the console's own read -------------------------------------------------------------------

  /** Behind the console session, per tenant, and it is the SAME data the box route reads. One
   *  source, so the strip in the Computer card and the bot never disagree about what is running. */
  async function handleConsoleTasks(slug) {
    const rows = (await readTasks(slug)).slice(0, CODE_CONSOLE_ROWS);
    // THE LOG AND THE FILES ARE THE STRIP, and they were missing. The strip renders a log block and a
    // file list and this route sent neither, so the one sentence and a Stop button were the whole of
    // it -- and "the log strip is enough" is the stated reason no terminal was built. Only the rows
    // the strip actually draws carry them: a log read and a directory listing apiece is a fixed cost
    // for four rows and an unbounded one for twenty.
    const tasks = [];
    for (const [at, row] of rows.entries()) {
      const taskId = String(row.taskId ?? "");
      const detailed = at < CODE_CONSOLE_SHOWN;
      tasks.push({
        taskId,
        title: String(row.title ?? ""),
        state: String(row.state ?? ""),
        provider: String(row.provider ?? ""),
        startedAt: Number(row.startedAt ?? 0),
        endedAt: Number(row.endedAt ?? 0),
        elapsedS: elapsedSeconds(Number(row.startedAt ?? 0), Number(row.endedAt ?? 0) > 0 ? Number(row.endedAt) : now()),
        // In plain words, because this is a person's screen. No provider name, no vendor.
        where: String(row.provider) === "e2b" ? "a cloud computer" : "this computer",
        path: `/workspace/code/${taskId}`,
        lines: detailed ? await logLinesFor(slug, row) : [],
        files: detailed && isFinished(String(row.state)) ? await artifactsIn(asString(taskRootFor(slug, taskId))) : [],
      });
    }
    // CAN THIS INSTALLATION RUN ONE AT ALL. The strip has a line for the answer being no -- a customer's
    // own instance with no container engine in front of the relay -- and could never draw it, because
    // nothing ever sent the field. CODE-5.
    const conf = settings(slug);
    const available = conf.provider === "e2b" ? true : await dockerAvailable();
    return {
      tasks,
      available,
      message: available
        ? ""
        : `${CODE_REFUSALS.not_available} A cloud coding computer can run it instead once the operator sets one up.`,
    };
  }

  async function handleConsoleStop(slug, taskId) {
    if (!isTaskId(taskId)) return { stopped: false, message: CODE_REFUSALS.unknown_task };
    const rows = await readTasks(slug);
    const row = rows.find((r) => String(r.taskId) === String(taskId));
    if (row == null) return { stopped: false, message: CODE_REFUSALS.unknown_task };
    if (String(row.state) !== "running") return { stopped: false, message: CODE_REFUSALS.not_running };
    await finish(slug, row, "stopped", "stopped from the console");
    return { stopped: true, message: CODE_REFUSALS.stopped };
  }

  const handleConsoleSettings = (slug) => {
    const conf = settings(slug);
    return {
      // Said in plain words and in the units a person thinks in.
      minutes: conf.minutes,
      capUsd: conf.capUsd,
      concurrent: conf.concurrent,
      where: conf.provider === "e2b" ? "a cloud computer" : "this computer",
      internet: false,
    };
  };

  // ---- the sweep --------------------------------------------------------------------------------

  /** One pass. Mounted exactly where mailSweepStart is: one at relay start and one every 60 s, never
   *  awaited into the listen. It is the ONLY thing enforcing the wall clock, because a timer in this
   *  process's memory does not survive the restart that ends every ship. */
  async function sweep(why = "the timer") {
    if (!await dockerAvailable()) return { ok: true, containers: 0, networks: 0, why: "no docker on this relay" };
    await noteImage();
    const ps = await docker(["ps", "-a", "--filter", `label=${CODE_ROLE_LABEL}`, "--format", "{{.ID}}\t{{.Names}}\t{{.Labels}}"]);
    const containers = [];
    for (const line of String(ps.stdout ?? "").split("\n")) {
      const text = line.trim();
      if (text.length === 0) continue;
      const [id, name, labelText = ""] = text.split("\t");
      const labels = {};
      for (const pair of labelText.split(",")) {
        const at = pair.indexOf("=");
        if (at > 0) labels[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
      containers.push({ id, name, labels });
    }
    const nets = await docker(["network", "ls", "--filter", `label=${CODE_ROLE_LABEL}`, "--format", "{{.Name}}"]);
    const networks = [];
    for (const line of String(nets.stdout ?? "").split("\n")) {
      const name = line.trim();
      if (name.length === 0) continue;
      if (name === SHARED_NETWORK) continue;
      const inspected = await docker(["network", "inspect", "--format",
        "{{.Id}}\t{{range $k, $v := .Labels}}{{$k}}={{$v}},{{end}}\t{{range .Containers}}{{.Name}} {{end}}", name]);
      const [id = "", labelText = "", memberText = ""] = String(inspected.stdout ?? "").trim().split("\t");
      const labels = {};
      for (const pair of labelText.split(",")) {
        const at = pair.indexOf("=");
        if (at > 0) labels[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
      networks.push({ id, name, labels, members: memberText.split(" ").filter((m) => m.length > 0) });
    }
    const decided = sweepDecisions({ containers, networks, live: new Set(live.keys()), nowMs: now() });
    // Asked for at most once, and only if something really has to be detached from a network. A
    // sweep on a quiet machine must cost nothing, and the legs below can each be the first one to
    // need it.
    let proxyAsked = false;
    let proxyName = "";
    const proxyOnce = async () => {
      if (!proxyAsked) { proxyAsked = true; proxyName = await proxyContainer(); }
      return proxyName;
    };
    const removedNetworks = new Set();
    for (const container of decided.remove) {
      log(`code  sweeping ${container.name} (${container.reason})`);
      // The claim is closed FIRST, because a container removed with its row left open is an hour
      // nobody is billed for and a task the bot is still waiting on.
      const rows = container.slug.length > 0 ? await readTasks(container.slug) : [];
      const row = rows.find((r) => String(r.taskId) === container.taskId);
      if (row != null) await finish(container.slug, row, container.reason === "timed_out" ? "timed_out" : "failed",
        container.reason === "timed_out" ? "past its time limit" : "this relay restarted while it was running");
      else await docker(["rm", "-f", container.name]);
    }
    // A TASK WHOSE CONTAINER HAS ALREADY STOPPED. This is the case a deadline never catches and an
    // orphan check never sees: the row still says running, this relay still has it live, and the
    // container exited minutes ago. Nothing else closes it -- /code/list, which is what the bot's
    // watcher polls, reads the rows as they are -- so before this leg existed a task that died in
    // its first second sat on the Coding strip saying "running" until its half hour was up and the
    // bot was never told anything at all. Measured on the R750 2026-09-10: a task exited 2 in its
    // first second and the strip still read "running, 9m 38s" ten minutes later. This is the only
    // real wall clock, so settling here is its job.
    //
    // AND THIS LEG IS DRIVEN BY THE ROWS, NOT BY DOCKER, which is the second half of the same lesson.
    // Everything above iterates the containers docker returned, so a task whose container has been
    // REMOVED is in none of them: not the deadline branch, not the orphan branch, and not a `keep`.
    // MEASURED ON THE R750 2026-09-10: a task's container was removed eight seconds after it started
    // and three sweeps later -- each one logging "removed 0 code container(s)" -- /code/list still
    // read `state:"running", endedAt:0`, its network was still on the machine, and one of the
    // workspace's two slots was gone for good, because adopt() re-adds a running row as live on every
    // restart so it never ages out either. Walking `live` finds both cases with one inspect apiece.
    let settled = 0;
    let lost = 0;
    for (const [taskId, held] of [...live.entries()]) {
      const slug = String(held?.slug ?? "");
      if (slug.length === 0 || String(held?.provider ?? "local") !== "local") continue;
      const rows = await readTasks(slug);
      const row = rows.find((r) => String(r.taskId) === taskId);
      // A row that is no longer running, or is not there at all, is nothing this map should still be
      // holding: it is a slot the workspace cannot use and an orphan the next pass would misread.
      if (row == null || String(row.state) !== "running") { live.delete(taskId); continue; }
      const got = await settleLocal(slug, row);
      if (got.state === "running") { live.set(taskId, { ...held, seenAt: now() }); continue; }
      log(got.gone === true
        ? `code  ${slug}/${taskId} has no container on this machine any more; closing its row`
        : `code  ${slug}/${taskId} stopped on its own (${got.state}, exit ${got.exit}); closing its row`);
      await finish(slug, row, got.state, String(got.detail ?? ""), { endedAt: Number(got.endedAt ?? 0) });
      if (got.gone === true) lost += 1; else settled += 1;
    }
    // THE NETWORKS LAST, and decided twice: once against the live set this pass started with, and
    // once against what the legs above left, so a network whose task was closed a moment ago goes now
    // rather than in a minute. `finish` -> `teardown` has usually taken it already, which is why a
    // "no such network" answer is not worth a line.
    const after = sweepDecisions({ containers: [], networks, live: new Set(live.keys()), nowMs: now() });
    for (const network of [...decided.removeNetworks, ...after.removeNetworks]) {
      if (removedNetworks.has(network.name)) continue;
      removedNetworks.add(network.name);
      const proxy = await proxyOnce();
      if (proxy.length > 0) await docker(["network", "disconnect", "-f", network.name, proxy]);
      const gone = await docker(["network", "rm", network.name]);
      if (!gone.ok && !/not found|no such network/i.test(gone.stderr)) {
        log(`code  could not remove ${network.name}: ${gone.stderr.slice(0, 120)}`);
      }
    }
    log(`code  sweep (${why}) removed ${decided.remove.length} code container(s) and ${removedNetworks.size} code network(s)`
      + (settled > 0 ? ` and closed ${settled} finished task(s)` : "")
      + (lost > 0 ? ` and closed ${lost} task(s) whose container was gone` : ""));
    return { ok: true, containers: decided.remove.length, networks: removedNetworks.size, settled, lost };
  }

  /** IS THE SANDBOX IMAGE STILL ON THIS MACHINE, said once each time the answer changes.
   *
   *  MEASURED ON THE R750 2026-09-10: the image was simply GONE -- `docker image inspect` answered
   *  "No such image" twenty minutes after a task had run on it. Coolify's own docker cleanup runs on
   *  this server four times a night with force_docker_cleanup on, and its image prune keeps only the
   *  repos Coolify itself deploys; a tag used by no container between tasks is exactly what a prune
   *  takes. The install script now leaves one never-started keeper container so the prune skips the
   *  image, and deploy/r750/install.sh builds it on every ship -- but a sweep that says the image is
   *  absent is what makes the next surprise visible in the relay's own log before a customer finds it
   *  as "The coding computer has not been built on this machine yet". */
  let imageKnownMissing = null;
  async function noteImage() {
    const image = String(CODE_DEFAULTS.image);
    const got = await docker(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 10_000 });
    const missing = !got.ok;
    if (missing === imageKnownMissing) return;
    imageKnownMissing = missing;
    log(missing
      ? `code  ${image} is NOT on this machine, so every coding task will be refused. Build it: bash deploy/code-sandbox/install.sh`
      : `code  ${image} is on this machine`);
  }

  /** What this process believes is running, so a restart's first sweep can tell an orphan from a
   *  live task. Called once at start with every workspace's rows. */
  function adopt(slug, rows) {
    for (const row of rows) {
      if (String(row.state) !== "running") continue;
      // NO `seenAt` HERE ON PURPOSE. After a restart this process has never seen the container, so the
      // last honest moment it can bill a vanished task to is the task's own start.
      live.set(String(row.taskId), { slug, provider: String(row.provider), deadlineAt: Number(row.deadlineAt ?? 0) });
    }
  }

  return {
    handleStart, handleStatus, handleStop, handleResult, handleList,
    handleConsoleTasks, handleConsoleStop, handleConsoleSettings,
    sweep, adopt,
    // For the tests and the gate, which assert on the plan rather than on a daemon.
    liveCount: () => live.size,
  };
}
