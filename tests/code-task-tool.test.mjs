// CODE-1. The coding sandbox from Titan's side: the relay hop, the four verbs, and the two guards
// that decide whether the tool exists on a box at all.
//
// Jason, 2026-09-09 06:11: "coding is a good idea and should be first-class. Richard is going to want
// to code stuff." What makes that safe to ship is that the box holds none of the parts -- no docker
// socket, no model key, no spend cap, no way to name any of them -- and what makes it honest is that
// every refusal reaches the model as a sentence it may repeat rather than as a thrown turn.
//
// Each case here is a way this could have gone wrong in a way nobody would notice until a customer
// was told about work that never happened:
//
//   - the OUTLINE NAME. The console keys the chip off it, and the row survives only because that name
//     misses the NOT_A_RECEIPT filter. A communicate-wrapped tool would have been dropped one
//     function before the renderer, and a job that spent money would have left no mark on the screen.
//   - the ARGS. What rides the outline is serialized whole and drawn on a customer's screen. The verb
//     and the title may be there; the INSTRUCTIONS may not, whatever the model typed into them.
//   - the 409. An install whose relay holds no container engine must answer in plain words and offer
//     the other road, never a stack and never a dead control.
//   - the REFUSALS. A relay that says no, a 200 with no `started`, an accepted task with no id: each
//     reaches the model as its own sentence, and none of them may read as a running job.
//   - the WITHHOLD. A box with no relay never sees the tool, and a subagent never sees it either --
//     the second because the proto case it rides is the one task-client.ts scans a subagent's own
//     steps for, so the two uses may not share a conversation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".code-task-test-"));
after(() => { rmSync(stage, { recursive: true, force: true }); });

const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};

const client = await load("source/host/extensions/code-sandbox/relay-code-client.ts", "relay-code-client");
const tool = await load("source/host/runner/tools/code-task-tool.ts", "code-task-tool");
const outline = await load("source/host/runner/conversation-outline.ts", "conversation-outline");
const toolset = await load("source/host/runner/tools/turn-toolset.ts", "turn-toolset");
const contextModule = await load("source/packages/context/core.ts", "context-core");
const ctx = () => contextModule.createContext().withName("code-task-test");

// The two strings this product actually runs on. MAIL-3 measured both inside the runner process on
// grok-bot-local-vm: the variable is present there, its path is /runtime/<token>, and that token is
// byte-equal to SAND_GATEWAY_TOKEN.
const LOCAL_BASE = "http://host.docker.internal:7787/runtime/tok-local-64";
const R750_BASE = "http://titanbot-relay:7777/runtime/tok-r750-64";
const DEFAULT_S3_BASE =
  "https://public-asphr-vm-daemon-bucket.s3.us-east-1.amazonaws.com/sand-host-bundle";

const AGENT = "agent-under-test";
// A string that looks exactly like the thing that must never reach a customer's screen. It is put in
// the instructions of a real call below, and the outline's own serializer is then asked for the args.
const SECRET_LOOKING = "use the token sk-live-AAAABBBBCCCCDDDD1234 when you talk to the service";

/** The runner's contract, in the smallest shape the tool uses. Everything emitted is kept. */
function handler() {
  const seen = { initial: null, completed: null };
  return {
    seen,
    executeToolCall: async (context, initial, id, run, merge) => {
      seen.initial = initial;
      const result = await run(context);
      seen.completed = merge(result);
      return result;
    },
  };
}

const runTool = async (built, callArgs, toolCallId = "call-1") => {
  const stream = (async function* () { yield JSON.stringify(callArgs); })();
  const seat = handler();
  const result = await built.execute(ctx(), seat, stream, { toolCallId });
  return { result, seen: seat.seen };
};

const say = async (built, result) => {
  const rendered = await built.render(ctx(), result);
  const text = rendered?.text ?? rendered;
  return typeof text === "string" ? text : JSON.stringify(text);
};

/** A tool whose relay answers whatever `reply` says, recording everything that was posted. */
const deps = (reply, overrides = {}) => {
  const posted = [];
  const watched = [];
  return {
    posted,
    watched,
    dependencies: {
      getAgentId: () => AGENT,
      resolveRelay: () => client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: R750_BASE }),
      post: async (target, route, body, timeoutMs) => {
        posted.push({ target, route, body, timeoutMs });
        return reply(route, body);
      },
      watch: (agentId, taskId, title) => { watched.push({ agentId, taskId, title }); },
      ...overrides,
    },
  };
};

/**
 * A 200 from the relay, shaped the way `postCode` actually shapes one -- the sentence comes off the
 * body, because that is where the relay puts it. A stub that left `message` empty would have let the
 * tool pass a test it fails in production: a `ready:false` whose reason never reached the model.
 */
const ok = (body) => ({
  ok: true,
  status: 200,
  body,
  message: typeof body.message === "string" && body.message.trim().length > 0
    ? body.message.trim()
    : "the machine that runs coding tasks answered",
  notAvailable: false,
});

const STARTED = {
  started: true, taskId: "tk-7f3a", provider: "local",
  deadlineAt: Date.now() + 30 * 60_000, capUsd: 2,
};

// ---- the parse -----------------------------------------------------------------------------

test("CODE-1: the relay's address and the box's bearer come out of the one bundle base, mail's parse", () => {
  assert.deepEqual(client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: R750_BASE }), {
    base: "http://titanbot-relay:7777", token: "tok-r750-64",
  });
  assert.deepEqual(client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: LOCAL_BASE }), {
    base: "http://host.docker.internal:7787", token: "tok-local-64",
  });
  assert.deepEqual(client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: `${R750_BASE}/` }), {
    base: "http://titanbot-relay:7777", token: "tok-r750-64",
  });
});

test("CODE-1: a box with no relay resolves nothing, which is how the tool disappears rather than fails", () => {
  assert.equal(client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: DEFAULT_S3_BASE }), undefined,
    "the default bucket is not a relay: an ordinary install must not grow a coding route");
  assert.equal(client.resolveRelayCode({}), undefined);
  assert.equal(client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: "http://relay:7777/runtime/" }), undefined);
  assert.equal(client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: "http://relay:7777/runtime/a/b" }), undefined);
  assert.equal(client.resolveRelayCode({ SAND_HOST_BUNDLE_S3_BASE_URL: "file:///runtime/tok" }), undefined);
});

// ---- the hop -------------------------------------------------------------------------------

test("CODE-1: a start goes to the parsed base with the parsed bearer, and carries no key and no model", async () => {
  const calls = [];
  const answer = await client.postCode(
    { base: "http://titanbot-relay:7777", token: "tok-r750-64" },
    client.CODE_START_ROUTE,
    { agentId: AGENT, title: "prime sieve", instructions: "write it" },
    5000,
    async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(STARTED), { status: 200 });
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://titanbot-relay:7777/code/start");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok-r750-64");
  const body = JSON.parse(calls[0].init.body);
  for (const forbidden of ["key", "apiKey", "model", "capUsd", "socket", "image", "network"]) {
    assert.equal(forbidden in body, false, `${forbidden} must never be a field a box can set`);
  }
  assert.equal(answer.ok, true);
  assert.equal(answer.body.taskId, "tk-7f3a");
  assert.equal(answer.notAvailable, false);
});

test("CODE-1: a 409 not_available becomes the plain no-container sentence, never a stack", async () => {
  const answer = await client.postCode(
    { base: "http://r:1", token: "t" },
    client.CODE_START_ROUTE,
    { agentId: AGENT },
    5000,
    async () => new Response(JSON.stringify({
      error: "not_available",
      detail: "the relay has no /var/run/docker.sock bind mount on this deployment",
    }), { status: 409 }),
  );
  assert.equal(answer.ok, false);
  assert.equal(answer.notAvailable, true);
  assert.equal(answer.message, client.CODE_NO_DOCKER_SENTENCE);
  assert.match(answer.message, /cannot run on this installation/);
  assert.match(answer.message, /cloud sandbox/, "the refusal has to offer the road that does exist");
  // The operator's own sentence about a socket is not a sentence a bot repeats to a business owner.
  assert.doesNotMatch(answer.message, /docker|socket|sock|mount/i);
});

test("CODE-1: an unreachable relay and an unreadable body are both refusals with sentences", async () => {
  const dead = await client.postCode(
    { base: "http://r:1", token: "t" }, client.CODE_LIST_ROUTE, {}, 5000,
    async () => { throw new Error("connect ECONNREFUSED"); },
  );
  assert.equal(dead.ok, false);
  assert.equal(dead.status, 0);
  assert.match(dead.message, /could not be reached/);

  const html = await client.postCode(
    { base: "http://r:1", token: "t" }, client.CODE_LIST_ROUTE, {}, 5000,
    async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
  );
  assert.equal(html.ok, false);
  assert.match(html.message, /502/);
  assert.doesNotMatch(html.message, /</, "a page of HTML is not a sentence a bot may repeat");

  const said = await client.postCode(
    { base: "http://r:1", token: "t" }, client.CODE_START_ROUTE, {}, 5000,
    async () => new Response(JSON.stringify({
      message: "that is the second job running for this workspace, which is the limit; stop one first",
    }), { status: 429 }),
  );
  assert.equal(said.ok, false);
  assert.equal(said.message,
    "that is the second job running for this workspace, which is the limit; stop one first");
});

test("CODE-1: the terminal-state vocabulary is the one both halves agree on", () => {
  assert.deepEqual([...client.CODE_TERMINAL_STATES],
    ["done", "failed", "timed_out", "stopped", "spend_cap"]);
  assert.equal(client.isTerminalCodeState("running"), false, "running is the one state that is not an end");
  for (const state of client.CODE_TERMINAL_STATES) assert.equal(client.isTerminalCodeState(state), true);
  assert.equal(client.isTerminalCodeState("finished"), false, "a word nobody agreed on is not an end");
});

// ---- the row -------------------------------------------------------------------------------

test("CODE-1: the row's outline name is one the console can see and label", () => {
  const call = { tool: { case: tool.CODE_TASK_OUTLINE_NAME, value: { args: undefined } } };
  assert.equal(outline.getOutlineToolCallName(call), "sendFinalSummaryToolCall");
  const NOT_A_RECEIPT = /communicate|update_state|todo|send.?to.?agent|react.?to.?message|sleep|wait|getmcptools/i;
  assert.equal(NOT_A_RECEIPT.test(tool.CODE_TASK_OUTLINE_NAME), false,
    "sendFinalSummaryToolCall must miss this filter or a coding job leaves no chip at all");
  assert.equal(NOT_A_RECEIPT.test("communicateUpdateToolCall"), true,
    "which is what a defineCommunicateTool version would have produced");
});

test("CODE-1: the outline args hold the verb and the title and NOTHING else, on a real call", async () => {
  const d = deps(() => ok(STARTED));
  const built = tool.createCodeTaskTool(d.dependencies);
  const { seen } = await runTool(built, {
    verb: "start",
    title: "prime sieve script and its test",
    instructions: SECRET_LOOKING,
    files: ["/workspace/notes/primes.md"],
  });
  // The very serializer the console reads: JSON.stringify(tool.args.toJson()).
  const drawn = outline.getToolCallActivityArgs(seen.completed);
  assert.equal(drawn, JSON.stringify({ finalSummary: "start · prime sieve script and its test" }));
  for (const leak of ["sk-live", "AAAABBBB", "token", "/workspace/", "tk-7f3a", "instructions"]) {
    assert.doesNotMatch(drawn, new RegExp(leak, "i"), `${leak} must never reach a customer's screen`);
  }
  // The pending row too: it is drawn while the call is in flight and is the one a person sees first.
  const pending = outline.getToolCallActivityArgs(seen.initial);
  assert.equal(pending, JSON.stringify({ finalSummary: "start · prime sieve script and its test" }));
});

test("CODE-1: a refused start mints a row that can never read as a started one", async () => {
  const d = deps(() => ({
    ok: false, status: 429, body: {},
    message: "that is the second job running for this workspace, which is the limit; stop one first",
    notAvailable: false,
  }));
  const built = tool.createCodeTaskTool(d.dependencies);
  const { result, seen } = await runTool(built, {
    verb: "start", title: "prime sieve", instructions: "write it and test it",
  });
  assert.equal(result.result.case, "error");
  const drawn = outline.getToolCallActivityArgs(seen.completed);
  assert.equal(drawn, JSON.stringify({ finalSummary: `${tool.CODE_TASK_FAILED_PREFIX}start · prime sieve` }));
  assert.equal(tool.CODE_TASK_FAILED_PREFIX, "not done: ");
  assert.match(result.result.value.error, /second job running/);
});

test("CODE-1: a thrown turn still mints a row, carrying the marker and no title", () => {
  const built = tool.createCodeTaskTool(deps(() => ok({})).dependencies);
  const call = built.serializeError(new Error("socket hang up"));
  const drawn = outline.getToolCallActivityArgs(call);
  assert.equal(drawn, JSON.stringify({ finalSummary: tool.CODE_TASK_FAILED_PREFIX }));
  assert.equal(call.tool.case, "sendFinalSummaryToolCall");
  assert.match(call.tool.value.result.result.value.error, /socket hang up/);
});

// ---- the verbs -----------------------------------------------------------------------------

test("CODE-1: start returns at once, tells the model not to wait, and hands the task to the watcher", async () => {
  const d = deps(() => ok(STARTED));
  const built = tool.createCodeTaskTool(d.dependencies);
  const { result } = await runTool(built, {
    verb: "start", title: "prime sieve", instructions: "write a sieve and a test, run the test",
  });
  assert.equal(result.result.case, "success");
  assert.equal(d.posted.length, 1);
  assert.equal(d.posted[0].route, "/code/start");
  assert.equal(d.posted[0].body.agentId, AGENT);
  assert.equal(d.posted[0].body.title, "prime sieve");
  assert.equal(d.posted[0].body.instructions, "write a sieve and a test, run the test");
  assert.deepEqual(d.watched, [{ agentId: AGENT, taskId: "tk-7f3a", title: "prime sieve" }]);

  const sentence = await say(built, result);
  assert.match(sentence, /tk-7f3a/, "the model needs the id to ask about it later");
  assert.match(sentence, /2\.00 US dollars/, "and the cap, because the cap is what ends a runaway job");
  assert.match(sentence, /did not wait|carry on/i, "it must not be read as a finished job");
  assert.match(sentence, /told here when it is finished/i);
  assert.match(sentence, /until you have read the result/i, "reading before reporting is the whole rule");
  assert.match(sentence, /a machine beside this box/, "which computer, in plain words");
  for (const leak of ["docker", "container", "e2b", "claude code", "litellm", "proxy"]) {
    assert.doesNotMatch(sentence, new RegExp(leak, "i"), `${leak} must not be in words a bot repeats`);
  }
});

test("CODE-1: a start with no title and a start with no instructions are both refused before the relay", async () => {
  const built = tool.createCodeTaskTool(deps(() => ok(STARTED)).dependencies);
  const noTitle = await runTool(built, { verb: "start", instructions: "write it" });
  assert.equal(noTitle.result.result.case, "error");
  assert.match(noTitle.result.result.value.error, /needs a short title/);
  const noWork = await runTool(built, { verb: "start", title: "something" });
  assert.equal(noWork.result.result.case, "error");
  assert.match(noWork.result.result.value.error, /needs its instructions/);
});

test("CODE-1: a 200 that does not say `started`, and one with no id, are both refusals", async () => {
  const quiet = deps(() => ok({ ok: true }));
  const built = tool.createCodeTaskTool(quiet.dependencies);
  const half = await runTool(built, { verb: "start", title: "t", instructions: "i" });
  assert.equal(half.result.result.case, "error", "a half-written route's 200 is not a started job");
  assert.deepEqual(quiet.watched, [], "and nothing is watched for a job that never began");

  const idless = deps(() => ok({ started: true, provider: "local" }));
  const second = tool.createCodeTaskTool(idless.dependencies);
  const nameless = await runTool(second, { verb: "start", title: "t", instructions: "i" });
  assert.equal(nameless.result.result.case, "error");
  assert.match(nameless.result.result.value.error, /no id/);
  assert.deepEqual(idless.watched, []);
});

test("CODE-1: status says running or finished, shows the last of the log, and never invents a state", async () => {
  const running = deps(() => ok({
    found: true, state: "running", provider: "local", elapsedS: 185,
    lines: ["writing primes.py", "writing test_primes.py", "running the test"],
  }));
  const built = tool.createCodeTaskTool(running.dependencies);
  const live = await runTool(built, { verb: "status", task_id: "tk-7f3a" });
  assert.equal(live.result.result.case, "success");
  assert.equal(running.posted[0].route, "/code/status");
  assert.equal(running.posted[0].body.taskId, "tk-7f3a");
  const said = await say(built, live.result);
  assert.match(said, /still running/);
  assert.match(said, /3 minute/);
  assert.match(said, /running the test/, "the last of the log is what a status is for");
  assert.match(said, /do not keep checking/i);

  const gone = tool.createCodeTaskTool(deps(() => ok({ found: false })).dependencies);
  const missing = await runTool(gone, { verb: "status", task_id: "tk-nope" });
  assert.equal(missing.result.result.case, "error");
  assert.match(missing.result.result.value.error, /no coding task tk-nope/);
});

test("CODE-1: every verb but start insists on an id rather than guessing one", async () => {
  const d = deps(() => ok({ found: true, state: "running" }));
  const built = tool.createCodeTaskTool(d.dependencies);
  for (const verb of ["status", "stop", "result"]) {
    const { result } = await runTool(built, { verb });
    assert.equal(result.result.case, "error", `${verb} with no id must refuse`);
    assert.match(result.result.value.error, /task id/);
  }
  assert.deepEqual(d.posted, [], "and none of them reached the relay");
});

test("CODE-1: result gives the summary and the files, and tells the model to open them anyway", async () => {
  const d = deps(() => ok({
    ready: true,
    summary: "Wrote primes.py and test_primes.py. Ran the test: 3 passed.",
    path: "/workspace/code/tk-7f3a",
    files: [
      { path: "primes.py", bytes: 412 },
      { path: "test_primes.py", bytes: 286 },
      { path: "SUMMARY.md", bytes: 190 },
    ],
  }));
  const built = tool.createCodeTaskTool(d.dependencies);
  const { result } = await runTool(built, { verb: "result", task_id: "tk-7f3a" });
  assert.equal(result.result.case, "success");
  assert.equal(d.posted[0].route, "/code/result");
  const said = await say(built, result);
  assert.match(said, /3 passed/);
  assert.match(said, /primes\.py/);
  assert.match(said, /test_primes\.py/);
  assert.match(said, /\/workspace\/code\/tk-7f3a/, "the agent has to be told where to read");
  assert.match(said, /not proof the work is right/i, "a summary is not a receipt");

  const early = tool.createCodeTaskTool(deps(() => ok({
    ready: false, message: "that job is still running; there is nothing written down to read yet",
  })).dependencies);
  const waiting = await runTool(early, { verb: "result", task_id: "tk-7f3a" });
  assert.equal(waiting.result.result.case, "error");
  assert.match(waiting.result.result.value.error, /still running/);
});

test("CODE-1: stop says what it stopped and points at what the job had already written", async () => {
  const d = deps(() => ok({ stopped: true }));
  const built = tool.createCodeTaskTool(d.dependencies);
  const { result } = await runTool(built, { verb: "stop", task_id: "tk-7f3a" });
  assert.equal(result.result.case, "success");
  assert.equal(d.posted[0].route, "/code/stop");
  const said = await say(built, result);
  assert.match(said, /stopped/);
  assert.match(said, /code\/tk-7f3a/);

  const refused = tool.createCodeTaskTool(deps(() => ok({
    stopped: false, message: "that job had already finished, so there was nothing to stop",
  })).dependencies);
  const already = await runTool(refused, { verb: "stop", task_id: "tk-7f3a" });
  assert.equal(already.result.result.case, "error");
  assert.match(already.result.result.value.error, /already finished/);
});

test("CODE-1: a 409 reaching the tool becomes the plain sentence, and the tool never throws", async () => {
  const built = tool.createCodeTaskTool(deps(() => ({
    ok: false, status: 409, body: { error: "not_available" },
    message: client.CODE_NO_DOCKER_SENTENCE, notAvailable: true,
  })).dependencies);
  const { result } = await runTool(built, { verb: "start", title: "t", instructions: "i" });
  assert.equal(result.result.case, "error");
  assert.equal(result.result.value.error, client.CODE_NO_DOCKER_SENTENCE);
  const said = await say(built, result);
  assert.match(said, /cannot run on this installation/);
  assert.match(said, /cloud sandbox/);
});

test("CODE-1: a post that throws is still a sentence, never an unknown outcome", async () => {
  const built = tool.createCodeTaskTool(deps(() => { throw new Error("socket hang up"); }).dependencies);
  const { result } = await runTool(built, { verb: "status", task_id: "tk-7f3a" });
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /socket hang up/);
});

test("CODE-1: a relay that vanished between the offer and the call is a sentence, not a crash", async () => {
  const built = tool.createCodeTaskTool(deps(() => ok(STARTED), {
    resolveRelay: () => undefined,
  }).dependencies);
  const { result } = await runTool(built, { verb: "start", title: "t", instructions: "i" });
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /no machine in front of this box/);
});

test("CODE-1: there is no repo parameter, because a task has no egress to clone one with", () => {
  const shape = tool.codeTaskParameters.shape;
  assert.deepEqual(Object.keys(shape).sort(),
    ["files", "instructions", "provider", "task_id", "title", "verb"]);
  for (const absent of ["repo", "branch", "git_url", "url", "key", "model", "timeout", "cap"]) {
    assert.equal(absent in shape, false, `${absent} must not be a thing the model can ask for`);
  }
  assert.deepEqual([...tool.CODE_TASK_VERBS], ["start", "status", "stop", "result"]);
});

// ---- the withhold --------------------------------------------------------------------------

const tool_ = (name) => ({ name, toolIdentifier: name, execute: async () => ({}) });
const hostFor = (overrides = {}) => ({
  isSubagentRunner: false,
  isSharedRoomRunner: false,
  isBoxScopedSubagent: false,
  isComputerUseSubagent: false,
  isBrowserUseSubagent: false,
  isSystemPromptOverridden: false,
  remoteBoxHasDesktop: false,
  getConversationId: () => AGENT,
  getRemoteBoxAvailable: () => false,
  cloudAgentsDisabledByTeam: () => true,
  spotlightEnabled: () => false,
  localMachineConnected: () => false,
  factories: {
    sendMessage: () => tool_("SendMessage"),
    codeTask: () => tool_("code_task"),
  },
  ...overrides,
});
const turnInput = { autoReviewModes: { hostShell: "off", boxShell: "off", mcp: "off", computer: "off", automationWrite: "off", cloudAgent: "off", subagentLaunch: "off" } };

function offeredUnder(env, hostOverrides = {}) {
  const restore = {};
  for (const [key, value] of Object.entries({ ...env, SAND_TOOL_TRACE: "1" })) {
    restore[key] = process.env[key];
    process.env[key] = value;
  }
  const lines = [];
  const info = console.info;
  console.info = (line) => { lines.push(String(line)); };
  let names;
  try {
    names = toolset.buildTurnTools(hostFor(hostOverrides), turnInput, {})
      .getAllTools().map((entry) => entry.name);
  } finally {
    console.info = info;
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const traced = lines.map((line) => {
    const at = line.indexOf("[sand][toolset] ");
    if (at < 0) return null;
    try { return JSON.parse(line.slice(at + "[sand][toolset] ".length)); } catch { return null; }
  }).filter(Boolean).at(-1);
  return { names, withheld: traced?.withheld ?? [] };
}

test("CODE-1: a tenant box whose relay resolves is offered the tool", () => {
  const { names, withheld } = offeredUnder({ SAND_HOST_BUNDLE_S3_BASE_URL: R750_BASE });
  assert.ok(names.includes("code_task"), "a box behind a relay gets the coding tool");
  assert.equal(withheld.some((entry) => entry.tool === "CodeTask"), false,
    "an offered tool is not also on the withheld list");
});

test("CODE-1: a box with no relay is withheld with its own reason, not silently missing", () => {
  const { names, withheld } = offeredUnder({ SAND_HOST_BUNDLE_S3_BASE_URL: DEFAULT_S3_BASE });
  assert.equal(names.includes("code_task"), false,
    "a customer's own install must not grow a tool that can only refuse");
  assert.equal(withheld.find((entry) => entry.tool === "CodeTask")?.reason, "no_relay");
});

test("CODE-1: a box-scoped subagent never gets it, which is what keeps the proto case unambiguous", () => {
  // The one subagent shape that reaches the push sites at all: a plain Task subagent returns an empty
  // toolset several hundred lines earlier, a box-scoped one does not. The guard matters here for more
  // than the chip -- `sendFinalSummaryToolCall` is the case task-client.ts:62 scans a subagent's own
  // steps for, to pull out that subagent's final summary, so a code-task row inside a subagent run
  // could be read back as the summary of the whole subagent.
  const { names, withheld } = offeredUnder(
    { SAND_HOST_BUNDLE_S3_BASE_URL: R750_BASE },
    {
      isSubagentRunner: true,
      isBoxScopedSubagent: true,
      isComputerUseSubagent: true,
      remoteBoxHasDesktop: true,
      getRemoteBoxAvailable: () => true,
      factories: {
        boxShell: () => tool_("Shell"),
        boxRead: () => tool_("Read"),
        computer: () => tool_("Computer"),
        codeTask: () => tool_("code_task"),
      },
    },
  );
  assert.deepEqual(names, ["Shell", "Read", "Computer"], "the box tools, and no coding among them");
  assert.equal(withheld.find((entry) => entry.tool === "CodeTask")?.reason, "subagent_runner",
    "and it says which of the two reasons it was, so an operator is not told the box has no relay");
});

test("CODE-1: the hint table carries the tool, so the prompt and the toolset say the same thing", () => {
  const hint = toolset.SAND_DYNAMIC_TOOL_HINTS[tool.CODE_TASK_TOOL_ID];
  assert.equal(typeof hint, "string");
  assert.ok(hint.length > 0);
  for (const leak of ["docker", "container", "e2b", "claude code", "sandbox image"]) {
    assert.doesNotMatch(hint, new RegExp(leak, "i"), `${leak} must not be in the model's hint either`);
  }
});
