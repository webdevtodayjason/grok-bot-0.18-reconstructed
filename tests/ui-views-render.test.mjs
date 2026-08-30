// ui/index.html ships as one file with no build, so nothing type-checks it and `node --check`
// only proves it parses. A function deleted while its call site stayed behind parses fine and
// dies the moment a reader clicks -- which is exactly how renderStage reached a live page.
// This renders every view and every desk tab against fixture state, so a dangling reference
// fails here instead of in the browser console.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Just enough page for the module to evaluate: it wires listeners and an EventSource at load.
function stubDom() {
  const node = new Proxy({}, {
    get: (target, key) =>
      key === "value" ? "" :
      key === "textContent" ? "" :
      key === "innerHTML" ? "" :
      key === "dataset" ? {} :
      key === "classList" ? { add() {}, remove() {}, toggle() {} } :
      key === "style" ? {} :
      key === "scrollTop" ? 0 :
      typeof key === "string" ? () => node : undefined,
    set: () => true,
  });
  const document = {
    querySelector: () => node, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => node, addEventListener() {}, body: node, documentElement: node,
  };
  class EventSource { addEventListener() {} close() {} }
  return { document, EventSource };
}

async function loadUi() {
  const html = await readFile(path.join(repoRoot, "ui/index.html"), "utf8");
  const js = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const { document, EventSource } = stubDom();
  const win = { addEventListener() {}, location: { origin: "http://127.0.0.1:7777" } };
  const exports = "return { views, state, renderRoutines, renderChannels, renderKnows, renderStage, editorHtml, SECTIONS, sectionBody, sectionCount, renderPersona, renderDesktop };";
  return new Function("window", "document", "EventSource", "fetch", "setInterval", "setTimeout", "self",
    `${js}\n${exports}`)(win, document, EventSource, async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
      () => 0, () => 0, win);
}

const AGENT = { id: "a1", name: "Atera Triage", isRunning: false, isGroup: false, unreadCount: 0,
  createdAt: 1, updatedAt: 2, lastActivityAt: 2, origin: "user", path: "/tmp/a1" };

function seed(state, over = {}) {
  Object.assign(state, {
    agents: [AGENT], trays: [], tasks: [], host: { version: "x" }, box: null, store: null,
    settings: { inferenceProvider: "openai-compatible" }, selected: null, creating: false,
    transcript: [], channels: null, integrations: null, routines: [], memories: [], subagents: [],
    picked: new Set(), seen: new Set(), editor: null, section: null, model: null, ...over,
  });
}

test("every top-level view renders with an empty host", async () => {
  const ui = await loadUi();
  for (const name of Object.keys(ui.views)) {
    seed(ui.state);
    assert.equal(typeof ui.views[name](), "string", `${name} did not render`);
  }
});

test("every rail section renders for the open worker", async () => {
  const ui = await loadUi();
  for (const [id] of ui.SECTIONS) {
    seed(ui.state, { selected: "a1", section: id });
    assert.equal(typeof ui.sectionBody(id, AGENT), "string", `${id} section did not render`);
    assert.equal(typeof ui.sectionCount(id, AGENT), "string", `${id} count did not render`);
  }
});

test("the stage is only ever the conversation, composer included", async () => {
  const ui = await loadUi();
  seed(ui.state, { selected: "a1", section: "routines" });
  const html = ui.views.agents();
  // The composer used to hide on three of four tabs. With the surfaces in the rail there is
  // no tab it can be wrong on -- the stage is the conversation, always.
  assert.match(html, /class="composer"/);
  assert.doesNotMatch(html, /desktabs/, "the desk tabs were retired into the rail");
});

test("Return sends and Shift+Return does not", async () => {
  const ui = await loadUi();
  seed(ui.state, { selected: "a1" });
  const html = ui.views.agents();
  assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
  assert.match(html, /event\.preventDefault\(\); sendPrompt\('a1'\)/);
});

test("the conversation renders prompts and replies, and a failed run", async () => {
  const ui = await loadUi();
  seed(ui.state, { selected: "a1",
    transcript: [
      { id: "m1", kind: "message", role: "user", content: "status?", timestampMs: 1 },
      { id: "m2", kind: "send-message", message: { content: "all clear" }, timestampMs: 2 },
    ],
    trays: [{ id: "t1", agentId: "a1", kind: "error", title: "Turn failed", detail: "no reply" }] });
  const html = ui.views.agents();
  assert.match(html, /status\?/);
  assert.match(html, /all clear/, "an agent speaks through SendMessage; that entry must render");
  assert.match(html, /Turn failed/, "a failed run must not look like a message that vanished");
});

test("the routine editor renders for a new routine and for an existing one", async () => {
  const ui = await loadUi();
  seed(ui.state, { selected: "a1", section: "routines",
    editor: { agentId: "a1", automationId: null, name: "", prompt: "", isEnabled: true,
      triggers: [], menu: "schedule", problems: null, error: null } });
  assert.match(ui.sectionBody("routines", AGENT), /Add trigger/);
  ui.state.editor.triggers = [{ type: "cron", schedule: "30 3 * * 1-5" },
    { type: "github", repo: "titanium/clientsync", events: ["ci-failed"], ciBranch: "main" },
    { type: "slack", channel: "#alerts", match: { kind: "keyword", keyword: "outage" } }];
  ui.state.editor.menu = null;
  const html = ui.sectionBody("routines", AGENT);
  assert.match(html, /Add another/);
  assert.match(html, /titanium\/clientsync/);
  assert.match(html, /outage/);
});

test("a background repaint does not rebuild the rail under a half-typed routine", async () => {
  const ui = await loadUi();
  // The editor moved into the rail, so the rail is now what a poll must not redraw. Reading
  // the guard directly beats asserting on a DOM this stub does not really have.
  const html = await readFile(path.join(repoRoot, "ui/index.html"), "utf8");
  assert.match(html, /if \(state\.editor == null \|\| force \|\| \$\("#editor"\) == null\) renderRail\(\);/);
});
