// CODE-1, the console half: the Coding strip in the Computer card, and the quiet chip in the
// conversation.
//
// This file exists because of one measured miss, recorded in tests/machine-room-cloud-browser.test.mjs:
// ui/machine-room/cloud-browser.js shipped whole -- 290 lines, self-mounting -- and index.html never
// loaded it, so the module never ran on any box while two documents said it did. The tag is pinned
// here for the same reason, and so is the part a real browser is a slow place to pin: that the strip
// goes back after app.js assigns innerHTML on #rail-screen, which it does on every repaint.
//
// The chip block is SLICED OUT of gateway-adapter.js and run, not copied. A copy would go on passing
// after the console changed, which on a promise about what a customer sees is worse than no test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");

// ---- the tag -------------------------------------------------------------------------------

test("CODE-1: the console loads the coding module, beside its siblings and before app.js", async () => {
  const index = await read("ui/machine-room/index.html");
  assert.match(index, /<script src="code-tasks\.js"><\/script>/,
    "the module the whole console side lives in must be loaded");
  const at = index.indexOf('<script src="code-tasks.js">');
  const app = index.search(/<script src="app\.js"/);
  const cloud = index.indexOf('<script src="cloud-browser.js">');
  assert.ok(cloud >= 0 && at > cloud, "it loads with the other window-global modules");
  if (app >= 0) assert.ok(at < app, "and before app.js paints, so the strip is not added a tick late");
});

test("CODE-1: the module publishes its global and mounts itself, which is what makes one tag enough", async () => {
  const text = await read("ui/machine-room/code-tasks.js");
  assert.match(text, /global\.__codeTasks = \{/, "app.js does not call this module; it has to publish itself");
  assert.match(text, /addEventListener\("DOMContentLoaded"/, "and mount itself whichever way the page loaded");
  assert.match(text, /querySelector\("#rail-screen"\)/, "the strip goes in the Computer card");
  assert.match(text, /MutationObserver/, "app.js rewrites that node on every repaint");
  assert.match(text, /requestAnimationFrame/, "debounced, or a repaint re-adds the strip per mutation");
  // Nothing here may write a node app.js owns: three waves paint this console at once.
  assert.ok(!/innerHTML\s*=/.test(text), "it may add siblings of its own, never rewrite somebody else's node");
  // And no CSS file is touched by this wave, so the geometry has to be inline.
  assert.match(text, /style="\$\{STRIP_STYLE\}"/);
});

// ---- the strip's own words -----------------------------------------------------------------

/**
 * Load the module against a stand-in window, the way tests/machine-room-bots-tab.test.mjs loads its
 * own. The module's tail reads `window`, so handing it one as the function's parameter is enough, and
 * it mounts nothing at all without a document.
 */
async function loadStrip(win = {}) {
  const text = await read("ui/machine-room/code-tasks.js");
  const window_ = {
    fetch: async () => { throw new Error("no relay in this test"); },
    setInterval: () => 1,
    ...win,
  };
  const module = new Function("window", `${text}\nreturn window.__codeTasks;`)(window_);
  if (module == null) throw new Error("code-tasks.js did not publish its global");
  return module;
}

const task = (extra = {}) => ({
  taskId: "tk-7f3a",
  title: "prime sieve script and its test",
  state: "running",
  provider: "local",
  startedAt: Date.now() - 185_000,
  elapsedS: 185,
  lines: ["writing primes.py", "writing test_primes.py", "running the test"],
  ...extra,
});

test("CODE-1: a running job draws its title, its clock, which computer and a Stop button", async () => {
  const strip = await loadStrip();
  strip._state.asked = true;
  strip._state.available = true;
  strip._state.tasks = [task()];
  const markup = strip._stripMarkup();
  assert.match(markup, /prime sieve script and its test/);
  assert.match(markup, /running/);
  assert.match(markup, /a machine beside this box/, "which computer, in plain words");
  assert.match(markup, /3m 5s/, "the clock, as minutes and seconds and not an epoch");
  assert.match(markup, /data-code-task-stop="tk-7f3a"/, "a running job has a working Stop");
  assert.match(markup, /running the test/, "the last lines of the log");
});

test("CODE-1: a finished job drops the Stop button and lists what it wrote", async () => {
  const strip = await loadStrip();
  strip._state.asked = true;
  strip._state.tasks = [task({
    state: "done",
    endedAt: Date.now(),
    files: [{ path: "primes.py", bytes: 412 }, { path: "test_primes.py", bytes: 286 }],
    path: "/workspace/code/tk-7f3a",
  })];
  const markup = strip._stripMarkup();
  assert.match(markup, /finished/);
  assert.doesNotMatch(markup, /data-code-task-stop/, "a finished job must not offer a control that does nothing");
  assert.match(markup, /primes\.py/);
  assert.match(markup, /test_primes\.py/);
  assert.match(markup, /\/workspace\/code\/tk-7f3a/);
});

test("CODE-1: every end state is drawn in words, never as its own machine name", async () => {
  const strip = await loadStrip();
  strip._state.asked = true;
  for (const [state, words] of [
    ["done", "finished"],
    ["failed", "did not finish"],
    ["timed_out", "ran out of time"],
    ["stopped", "stopped"],
    ["spend_cap", "reached its spending limit"],
  ]) {
    strip._state.tasks = [task({ state, endedAt: Date.now() })];
    const markup = strip._stripMarkup();
    assert.match(markup, new RegExp(words), `${state} must be drawn as "${words}"`);
    assert.doesNotMatch(markup, /timed_out|spend_cap/, "an underscore is a machine's spelling");
  }
});

test("CODE-1: an install with no container engine draws the refusal line and offers the other road", async () => {
  const strip = await loadStrip();
  strip._state.asked = true;
  strip._state.available = false;
  strip._state.tasks = [];
  const markup = strip._stripMarkup();
  assert.match(markup, /cannot run on this installation/);
  assert.match(markup, /cloud sandbox/, "a refusal that offers nothing is a dead end");
  assert.doesNotMatch(markup, /data-code-task-stop/, "and it never leaves a control that cannot work");
  // Never a zero. A "0 jobs" line on an install that can never run one reads as a working feature.
  assert.doesNotMatch(markup, /\b0 /);
});

test("CODE-1: a workspace with no jobs draws nothing at all, rather than an empty heading", async () => {
  const strip = await loadStrip();
  strip._state.asked = true;
  strip._state.available = true;
  strip._state.tasks = [];
  assert.equal(strip._stripMarkup(), "");
  assert.equal(strip.computerStrip(), "");
  // A relay older than this wave is asked once and then left alone.
  strip._state.supported = false;
  assert.equal(strip.computerStrip(), "");
});

test("CODE-1: no vendor, product or tool name reaches anything the person reads on the strip", async () => {
  const text = await read("ui/machine-room/code-tasks.js");
  const strings = [...text.matchAll(/`([^`]*)`/g)].map((m) => m[1])
    .concat([...text.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]));
  const banned = /e2b|claude code|anthropic|litellm|z\.ai|codex/i;
  const named = strings.filter((value) => banned.test(value));
  assert.deepEqual(named, [], `a vendor or agent name reached the console's own words: ${named.join(" | ")}`);
  // "docker" and "container" are operator words. They may appear in a comment; not in a string the
  // strip draws. The two strings that talk about the absence say "container engine" only in the
  // comment above them, so nothing in the drawn markup may carry either.
  const drawn = strings.filter((value) => /\bdocker\b/i.test(value));
  assert.deepEqual(drawn, [], `an operator's word reached a customer's screen: ${drawn.join(" | ")}`);
});

test("CODE-1: the strip goes back after app.js rewrites the Computer card", async () => {
  // A tiny DOM, only as much as paint() touches. The real thing is pinned in a browser by the gate;
  // this pins the one behaviour a browser is slow to exercise: survival of an innerHTML assignment.
  const nodes = new Map();
  const makeNode = (id) => {
    const node = {
      id,
      html: "",
      children: [],
      insertAdjacentHTML(_where, markup) {
        this.html += markup;
        const found = /id="([^"]+)"/.exec(markup);
        if (found) nodes.set(found[1], { id: found[1], remove: () => { this.html = ""; nodes.delete(found[1]); }, set outerHTML(value) { /* replaced in place */ } });
      },
      remove() { this.html = ""; },
    };
    return node;
  };
  const rail = makeNode("rail-screen");
  const document_ = {
    readyState: "complete",
    body: {},
    addEventListener() {},
    querySelector: (selector) => (selector === "#rail-screen" ? rail : null),
    getElementById: (id) => nodes.get(id) ?? null,
  };
  const strip = await loadStrip({
    document: document_,
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (fn) => fn(),
  });
  strip._state.asked = true;
  strip._state.available = true;
  strip._state.tasks = [task()];
  strip._paint();
  assert.match(rail.html, /prime sieve/, "the strip is in the card");
  // app.js's renderScreenTile assigns innerHTML on this very node, which takes our sibling with it.
  rail.html = "";
  nodes.clear();
  strip._paint();
  assert.match(rail.html, /prime sieve/, "and one repaint later it is back");
});

// ---- the chip in the conversation ----------------------------------------------------------

const between = (text, startMark, endMark, what) => {
  const start = text.indexOf(startMark);
  const end = text.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error(`could not slice ${what} out of the console source`);
  return text.slice(start, end);
};

async function loadToolRow() {
  const text = await read("ui/machine-room/gateway-adapter.js");
  const body = between(text, "  const PROBLEM_REPORT_TOOL_CALL =", "  const messageKey =", "the tool-row block");
  return new Function(
    `${body}\nreturn { toolRowText, TOOL_LABELS, CODE_TASK_TOOL_CALL, CODE_TASK_FAILED_PREFIX };`,
  )();
}

// What the outline actually hands the page for this tool: the args, serialized whole, as JSON.
const row = (finalSummary, status = "done") => ({
  id: "t1",
  name: "sendFinalSummaryToolCall",
  status,
  summary: JSON.stringify({ finalSummary }),
});

test("CODE-1: the four chips are the four pinned sentences, with the title as the detail", async () => {
  const { toolRowText, CODE_TASK_TOOL_CALL } = await loadToolRow();
  assert.equal(CODE_TASK_TOOL_CALL, "sendFinalSummaryToolCall");
  const title = "prime sieve script and its test";
  assert.deepEqual(toolRowText(row(`start · ${title}`)), { text: "Started a coding task", detail: title, kind: "Coding" });
  assert.deepEqual(toolRowText(row(`result · ${title}`)), { text: "Coding task finished", detail: title, kind: "Coding" });
  assert.deepEqual(toolRowText(row(`stop · ${title}`)), { text: "Stopped the coding task", detail: title, kind: "Coding" });
  assert.deepEqual(toolRowText(row(`status · ${title}`)), { text: "Checked on the coding task", detail: title, kind: "Coding" });
});

test("CODE-1: a coding task that did not start never reads as one that did", async () => {
  const { toolRowText, CODE_TASK_FAILED_PREFIX } = await loadToolRow();
  assert.equal(CODE_TASK_FAILED_PREFIX, "not done: ");
  const drawn = toolRowText(row(`${CODE_TASK_FAILED_PREFIX}start · prime sieve`));
  assert.equal(drawn.text, "A coding task did not start");
  assert.doesNotMatch(drawn.text, /^Started/, "the one sentence a refusal may never begin with");
  // The marker itself is a machine's word and must not survive into the line a person reads.
  assert.doesNotMatch(drawn.text, /not done:/);
  assert.equal(drawn.detail, "prime sieve", "the title still reaches the page; the marker does not");
});

test("CODE-1: a row still in flight says so, and a thrown row falls back to no title", async () => {
  const { toolRowText } = await loadToolRow();
  assert.equal(toolRowText(row("start · prime sieve", "pending")).text, "Starting a coding task");
  assert.equal(toolRowText(row("status · prime sieve", "pending")).text, "Checking on the coding task");
  // serializeError mints the marker with nothing after it. Without a branch for that the row would
  // have been headlined "Started a coding task" over a tool call that never ran.
  const thrown = toolRowText(row("not done: ", "done"));
  assert.equal(thrown.text, "A coding task did not start");
  assert.equal(thrown.detail, "");
  // And an unparseable row, which is what a protocol change would produce.
  const garbage = { id: "t1", name: "sendFinalSummaryToolCall", status: "done", summary: "not json" };
  assert.equal(toolRowText(garbage).text, "Started a coding task");
  assert.equal(toolRowText(garbage).detail, "");
});

test("CODE-1: no tool name, proto name or vendor reaches the chip, and the row survives the filter", async () => {
  const { toolRowText, TOOL_LABELS, CODE_TASK_TOOL_CALL } = await loadToolRow();
  assert.equal(TOOL_LABELS[CODE_TASK_TOOL_CALL], "Coding",
    "a name that is not in this table is headlined with the raw proto name");
  const drawn = toolRowText(row("start · prime sieve"));
  for (const leak of ["code_task", "sendFinalSummary", "ToolCall", "CODE_TASK", "docker", "e2b", "claude code"]) {
    assert.doesNotMatch(drawn.text + drawn.detail + drawn.kind, new RegExp(leak, "i"),
      `${leak} must not reach the page`);
  }
  // The row exists at all only because its name misses this filter.
  const NOT_A_RECEIPT = /communicate|update_state|todo|send.?to.?agent|react.?to.?message|sleep|wait|getmcptools/i;
  assert.equal(NOT_A_RECEIPT.test(CODE_TASK_TOOL_CALL), false,
    "sendFinalSummaryToolCall must miss it or a coding job leaves no chip at all");
});

// ---- the seed skill ------------------------------------------------------------------------

test("CODE-1: the coding skill is in the generated seed file, with frontmatter that parses", async () => {
  const gen = await read("source/host/extensions/managed-setup/seed-skills.gen.ts");
  assert.match(gen, /GENERATED by scripts\/gen-seed-skills\.mjs/, "the gen file is generated, never hand-edited");
  assert.match(gen, /\{ id: "code", description: "", enabled: true, content: `---\nname: code\n/,
    "the seed is there and its frontmatter starts the file, which is what the normalizer reads");
  const skill = await read("source/host/extensions/managed-setup/seed-skills/code/SKILL.md");
  assert.ok(skill.startsWith("---\n"), "the generator refuses a file with no frontmatter");
  assert.match(skill, /^description: >-$/m);
  // The three things the skill has to say, because each of them is a way a job comes back useless.
  assert.match(skill, /no internet/i, "a job cannot clone or install, and the agent must know before it tries");
  assert.match(skill, /how to check it/i, "a job with no check comes back with code nobody has run");
  assert.match(skill, /read its result/i, "and it must read the result before reporting");
  assert.match(skill, /does not block the conversation/i);
  for (const leak of ["docker", "e2b", "claude code", "litellm", "code_task"]) {
    assert.doesNotMatch(skill, new RegExp(leak, "i"), `${leak} must not be in what the agent is taught to say`);
  }
});
