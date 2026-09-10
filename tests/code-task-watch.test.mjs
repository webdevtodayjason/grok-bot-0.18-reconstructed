// CODE-1. The watcher: the part that makes a long coding task not block the conversation.
//
// A coding job runs for minutes. `start` comes back at once, and the agent is told when the job is
// done -- not by a new user message, which would read to the person like the bot talking to itself,
// but as one hidden bracketed entry in its own conversation, the way a box hand-off, an MCP
// authorization and a listener connect already wake an agent.
//
// Every case here is a failure mode that would be invisible in production until somebody complained:
//
//   - POLLING WHEN NOTHING IS OPEN. A 15 s timer on every box in the fleet, forever, for a feature
//     nobody is using, and a relay answering it a hundred times a minute on the other side.
//   - ANNOUNCING TWICE. `updateHostNow` restarts this process mid-task -- it is the normal way a box
//     gets a new bundle -- so a fresh watcher re-discovers a finished job it has no memory of. The
//     agent would be told its job finished a second time and would report it twice.
//   - ORPHANING A WATCH. The other half of the same restart: a job open when the host went away, with
//     nobody left polling for it, so the agent is never told at all and sits waiting.
//   - AWAITING THE RESUME. HANDBACK-1 measured that awaiting a revived turn made the call that
//     triggered it answer 58,917 ms late, because the resume takes the session's exclusive run lane.
//   - SHOUTING ON A RESTART. The relay is restarted as the LAST step of every ship, so a failed poll
//     is a normal event, and an agent must never be told a job failed because of one.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".code-watch-test-"));
const roots = [];
after(() => {
  rmSync(stage, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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

const watchModule = await load("source/host/extensions/code-sandbox/task-watch.ts", "task-watch");
const { CodeTaskWatch, CODE_WATCH_FILE, CODE_WATCH_MAX_MS, codeFinishedPrompt } = watchModule;

const freshRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "code-watch-"));
  roots.push(root);
  return root;
};

const TARGET = { base: "http://titanbot-relay:7777", token: "tok-r750-64" };
const AGENT = "agent-one";

/**
 * A watcher wired to a stub relay and a fake clock, with its timer handed over rather than real: a
 * 15 s interval is no place to pin behaviour, and a test that slept for one would take four minutes.
 */
function harness(options = {}) {
  const root = options.root ?? freshRoot();
  const announced = [];
  const polls = [];
  const timers = [];
  let now = options.now ?? 1_757_000_000_000;
  const watcher = new CodeTaskWatch({
    resolveRelay: options.resolveRelay ?? (() => TARGET),
    post: async (target, route, body, timeoutMs) => {
      polls.push({ target, route, body, timeoutMs });
      return (options.reply ?? (() => ({ ok: true, status: 200, body: { tasks: [] }, message: "", notAvailable: false })))(body);
    },
    rootDir: () => root,
    announce: options.announce ?? ((agentId, prompt) => { announced.push({ agentId, prompt }); }),
    now: () => now,
    setInterval: (handler, ms) => { const handle = { handler, ms }; timers.push(handle); return handle; },
    clearInterval: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
  });
  return {
    watcher, announced, polls, timers, root,
    advance: (ms) => { now += ms; },
    get store() {
      try { return JSON.parse(readFileSync(path.join(root, CODE_WATCH_FILE), "utf8")); } catch { return null; }
    },
  };
}

const listing = (tasks) => () => ({
  ok: true, status: 200, body: { tasks }, message: "", notAvailable: false,
});

// ---- the beat ------------------------------------------------------------------------------

test("CODE-1 watch: nothing is polled while nothing is open, and the timer arms on the first task", async () => {
  const h = harness();
  h.watcher.resume();
  assert.equal(h.timers.length, 0, "a box with no coding task must not hold a timer");
  assert.equal(h.watcher.polling, false);
  await h.watcher.tick();
  assert.equal(h.polls.length, 0, "and a tick with nothing open must not ask the relay anything");

  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  assert.equal(h.timers.length, 1, "the first open task arms the one timer");
  assert.equal(h.timers[0].ms, 15_000, "at the beat the console's own rail runs at");
  assert.equal(h.watcher.polling, true);
  assert.equal(h.watcher.openCount, 1);
});

test("CODE-1 watch: the timer is disarmed by the last task finishing, not left running forever", async () => {
  const h = harness({ reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "done" }]) });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  assert.equal(h.watcher.polling, true);
  await h.watcher.tick();
  assert.equal(h.announced.length, 1);
  assert.equal(h.watcher.openCount, 0);
  assert.equal(h.watcher.polling, false, "the last task going means the box stops polling");
});

test("CODE-1 watch: a task still running is left alone, and the agent is told nothing", async () => {
  const h = harness({ reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "running" }]) });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  await h.watcher.tick();
  await h.watcher.tick();
  assert.equal(h.polls.length, 2);
  assert.deepEqual(h.polls[0].body, { agentId: AGENT }, "it asks only about its own agent's tasks");
  assert.equal(h.polls[0].route, "/code/list");
  assert.equal(h.announced.length, 0, "a running job is not news");
  assert.equal(h.watcher.polling, true);
});

// ---- announcing exactly once --------------------------------------------------------------

test("CODE-1 watch: a finish is announced exactly once, however many ticks see it", async () => {
  const h = harness({ reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "done" }]) });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  await h.watcher.tick();
  await h.watcher.tick();
  await h.watcher.tick();
  assert.equal(h.announced.length, 1);
  assert.equal(h.announced[0].agentId, AGENT);
  assert.match(h.announced[0].prompt, /^\[/, "a hidden prompt is bracketed, like every other resume");
  assert.match(h.announced[0].prompt, /prime sieve/);
  assert.match(h.announced[0].prompt, /tk-1/, "the agent needs the id to read the result with");
  assert.match(h.announced[0].prompt, /Read its result now/);
  assert.match(h.announced[0].prompt, /SendMessage/, "nothing reaches the person outside one");
});

test("CODE-1 watch: a host swap mid-task re-arms the watch rather than orphaning it", async () => {
  const root = freshRoot();
  const before = harness({ root, reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "running" }]) });
  before.watcher.watch(AGENT, "tk-1", "prime sieve");
  await before.watcher.tick();
  assert.equal(before.announced.length, 0);
  // updateHostNow: this process goes away mid-task. The store is what survives it.
  before.watcher.stop();
  assert.equal(before.store.open[AGENT]["tk-1"].title, "prime sieve");

  const after_ = harness({ root, reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "done" }]) });
  after_.watcher.resume();
  assert.equal(after_.watcher.polling, true, "the new process picks the open task back up");
  assert.equal(after_.watcher.openCount, 1);
  await after_.watcher.tick();
  assert.equal(after_.announced.length, 1, "and the agent is told, which it otherwise never would be");
});

test("CODE-1 watch: a host swap AFTER the announce does not announce the same task again", async () => {
  const root = freshRoot();
  const first = harness({ root, reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "done" }]) });
  first.watcher.watch(AGENT, "tk-1", "prime sieve");
  await first.watcher.tick();
  assert.equal(first.announced.length, 1);
  first.watcher.stop();
  assert.deepEqual(first.store.announced, ["tk-1"]);

  // The relay still lists the finished task -- it keeps a tenant's tasks file -- and a watcher with no
  // memory would announce it again, so the agent would report the same job twice.
  const second = harness({ root, reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "done" }]) });
  second.watcher.resume();
  assert.equal(second.watcher.polling, false, "nothing is open, so nothing is polled");
  second.watcher.watch(AGENT, "tk-1", "prime sieve");
  assert.equal(second.watcher.openCount, 0, "an already-announced task is never re-watched");
  await second.watcher.tick();
  assert.equal(second.announced.length, 0);
});

test("CODE-1 watch: every terminal state is announced, each in words rather than in its own name", async () => {
  for (const [state, words] of [
    ["done", /has finished/],
    ["failed", /did not finish/],
    ["timed_out", /ran out of time/],
    ["stopped", /was stopped/],
    ["spend_cap", /spending limit/],
  ]) {
    const h = harness({ reply: listing([{ taskId: "tk-1", title: "prime sieve", state }]) });
    h.watcher.watch(AGENT, "tk-1", "prime sieve");
    await h.watcher.tick();
    assert.equal(h.announced.length, 1, `${state} must wake the agent`);
    assert.match(h.announced[0].prompt, words, `${state} must be said in words`);
    assert.doesNotMatch(h.announced[0].prompt, /timed_out|spend_cap/,
      "a state name with an underscore in it is a machine's word, not a sentence");
  }
});

// ---- never awaiting, never throwing ------------------------------------------------------

test("CODE-1 watch: the resume is never awaited, so a slow turn cannot stall the poll loop", async () => {
  let released = null;
  const h = harness({
    reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "done" }]),
    announce: () => new Promise((resolve) => { released = resolve; }),
  });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  // If the tick awaited the resume this would never settle: nothing resolves the promise above.
  await h.watcher.tick();
  assert.equal(h.watcher.openCount, 0, "the tick finished while the revived turn is still running");
  assert.equal(typeof released, "function", "and the turn really is still in flight");
  released();
});

test("CODE-1 watch: an announce that throws is swallowed, because the resume reports its own errors", async () => {
  const h = harness({
    reply: listing([{ taskId: "tk-1", title: "prime sieve", state: "done" }]),
    announce: () => { throw new Error("no session for that agent"); },
  });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  await h.watcher.tick();
  assert.equal(h.watcher.openCount, 0, "the task is still retired: a failed wake is not a reason to loop");
});

test("CODE-1 watch: an unreachable relay is silent, and the watch survives it", async () => {
  const h = harness({
    reply: () => ({ ok: false, status: 0, body: {}, message: "could not be reached", notAvailable: false }),
  });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  await h.watcher.tick();
  await h.watcher.tick();
  assert.equal(h.announced.length, 0, "a relay being restarted is not a job that failed");
  assert.equal(h.watcher.openCount, 1, "and the task is still being watched for");
  assert.equal(h.watcher.polling, true);
});

test("CODE-1 watch: a box with no relay resolves nothing, polls nothing and says nothing", async () => {
  const h = harness({ resolveRelay: () => undefined });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  await h.watcher.tick();
  assert.equal(h.polls.length, 0);
  assert.equal(h.announced.length, 0);
});

test("CODE-1 watch: a task the relay never lists is retired by the ceiling, not announced", async () => {
  const h = harness({ reply: listing([]) });
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  await h.watcher.tick();
  assert.equal(h.watcher.openCount, 1, "a task missing from one listing is not a finished task");
  h.advance(CODE_WATCH_MAX_MS + 1000);
  await h.watcher.tick();
  assert.equal(h.watcher.openCount, 0, "but a task this host has watched for two hours is let go");
  assert.equal(h.announced.length, 0, "and the agent is never told a job failed on this host's say-so");
  assert.equal(h.watcher.polling, false);
});

test("CODE-1 watch: two agents on one box share one timer and are asked about separately", async () => {
  const seen = [];
  const h = harness({
    reply: (body) => {
      seen.push(body.agentId);
      return {
        ok: true, status: 200, notAvailable: false, message: "",
        body: { tasks: [{ taskId: body.agentId === AGENT ? "tk-1" : "tk-2", state: "done", title: "t" }] },
      };
    },
  });
  h.watcher.watch(AGENT, "tk-1", "one");
  h.watcher.watch("agent-two", "tk-2", "two");
  assert.equal(h.timers.length, 1, "one box, one timer, whatever the roster does");
  await h.watcher.tick();
  assert.deepEqual(seen.sort(), [AGENT, "agent-two"]);
  assert.equal(h.announced.length, 2);
  assert.deepEqual(h.announced.map((row) => row.agentId).sort(), [AGENT, "agent-two"]);
});

test("CODE-1 watch: a store file this version cannot read is an empty store, never a throw", () => {
  const root = freshRoot();
  writeFileSync(path.join(root, CODE_WATCH_FILE), "{ not json", "utf8");
  const h = harness({ root });
  h.watcher.resume();
  assert.equal(h.watcher.openCount, 0);
  assert.equal(h.watcher.polling, false);
  h.watcher.watch(AGENT, "tk-1", "prime sieve");
  assert.equal(h.watcher.openCount, 1, "and it is usable afterwards");
});

test("CODE-1 watch: the sentence the agent reads names no tool and no vendor", () => {
  const prompt = codeFinishedPrompt({ taskId: "tk-1", title: "prime sieve", state: "done" });
  for (const leak of ["docker", "container", "e2b", "claude code", "litellm", "sandbox image", "code_task"]) {
    assert.doesNotMatch(prompt, new RegExp(leak, "i"), `${leak} must not be in the agent's own cue`);
  }
  // An untitled job still gets a readable sentence rather than an empty pair of quotes.
  const untitled = codeFinishedPrompt({ taskId: "tk-1", title: "", state: "done" });
  assert.doesNotMatch(untitled, /\(""\)/);
  assert.match(untitled, /The coding task you started has finished/);
});
