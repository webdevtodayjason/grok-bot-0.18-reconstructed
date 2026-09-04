// The Machine Room's teach path, driven against a stub gateway. The operator's complaint was that
// the Learn flow could not be stopped: the dialog opened on the click rather than on the host's
// answer, and closing it left ffmpeg running on the box. Both halves are decisions the adapter
// makes, and neither is visible from the DOM, so they are pinned here.
//
// Host shapes, as scripts/verify-teach.mjs measured them on the box:
//   startTeachRecording {agentId}          -> { state:"recording", agentId, startedAtMs, maxDurationMs }
//                                          or 500 { error:"teach-recording: the feature gate is off" }
//                                          or 500 { error:"Teach recording requires a private desktop monitor." }
//   stopTeachRecording {agentId,save}      -> { state:"idle", maxDurationMs }
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAdapter(answers = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter };\n  global.__bootMachineRoom =",
  );
  const calls = [];
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
    open: () => {},
  };
  const defaults = { listAgents: [], getTrays: [], getAgentAutomations: [], getAgentWorkflows: [], getConversationOutline: [] };
  const fetchStub = async (url, init) => {
    const method = String(url).startsWith("/api/") ? String(url).slice(5) : null;
    if (method == null) return { ok: true, text: async () => "{}", json: async () => ({}) };
    const args = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, args });
    const answer = answers[method] ?? defaults[method] ?? {};
    const value = await (typeof answer === "function" ? answer(args, calls) : answer);
    if (value instanceof Error) return { ok: false, status: 500, text: async () => JSON.stringify({ error: value.message }) };
    return { ok: true, text: async () => JSON.stringify(value) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return { ...fn(window, fetchStub), calls };
}

const seed = () => ({
  activeContext: { kind: "worker", id: "w1" },
  openContexts: [{ kind: "worker", id: "w1" }],
  workers: [{ id: "w1", name: "Probe", status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null }],
  rooms: [], routines: [], plugins: [], models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
});

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const only = (calls, method) => calls.filter((c) => c.method === method);

test("teach: a start the host refuses resolves to a reason the page can show, and leaves no dialog state", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    startTeachRecording: new Error("teach-recording: the feature gate is off"),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const events = [];
  adapter.subscribe((event) => events.push(event.type));

  const result = await adapter.startTeaching("w1");
  assert.equal(result.ok, false);
  // The gate-off refusal is the one an operator can act on, so it carries its own code; the host's
  // sentence rides along for anything that wants to print it verbatim.
  assert.equal(result.reason, "gate-off");
  assert.match(result.message, /feature gate is off/);
  // Nothing may say a recording is running: the dialog is drawn off exactly this.
  assert.deepEqual(state.teaching, { active: false, workerId: null, startedAt: null });
  assert.equal(events.includes("teaching:started"), false, "no started event for a start that was refused");
  assert.ok(events.includes("teaching:failed"));
  assert.equal(only(calls, "startTeachRecording").length, 1);
  adapter.destroy();
});

test("teach: an agent with no desktop window is its own reason, not the host's raw sentence", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: new Error("Teach recording requires a private desktop monitor."),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const result = await adapter.startTeaching("w1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-monitor");
  assert.equal(state.teaching.active, false);
  adapter.destroy();
});

test("teach: any other refusal keeps the host's own words", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: new Error("teach-recording: box shell accessor is unavailable"),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const result = await adapter.startTeaching("w1");
  assert.equal(result.reason, "host");
  assert.equal(result.message, "teach-recording: box shell accessor is unavailable");
  adapter.destroy();
});

test("teach: a state the host did not call recording is a failure, not a dialog", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: { state: "idle", maxDurationMs: 600_000 },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const result = await adapter.startTeaching("w1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-recording");
  assert.equal(state.teaching.active, false);
  adapter.destroy();
});

test("teach: a confirmed start carries the host's clock and cap, not the browser's", async () => {
  const startedAtMs = Date.now() - 42_000;
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs, maxDurationMs: 600_000 },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const events = [];
  adapter.subscribe((event) => events.push(event.type));
  const result = await adapter.startTeaching("w1");
  assert.deepEqual(
    { ok: result.ok, workerId: result.workerId, startedAt: result.startedAt, maxDurationMs: result.maxDurationMs },
    { ok: true, workerId: "w1", startedAt: startedAtMs, maxDurationMs: 600_000 },
  );
  assert.equal(state.teaching.active, true);
  assert.equal(state.teaching.startedAt, startedAtMs);
  assert.ok(events.includes("teaching:started"));
  adapter.destroy();
});

test("teach: Discard stops the recording on the host with save:false and sends no note", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now(), maxDurationMs: 600_000 },
    stopTeachRecording: { state: "idle", maxDurationMs: 600_000 },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.startTeaching("w1");
  const result = await adapter.finishTeaching(false, "a note the operator typed before changing their mind");
  assert.deepEqual({ ok: result.ok, saved: result.saved }, { ok: true, saved: false });
  const stops = only(calls, "stopTeachRecording");
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].args, { agentId: "w1", save: false });
  await settle(40);
  assert.equal(only(calls, "sendPrompt").length, 0, "a discarded recording sends the agent nothing");
  assert.deepEqual(state.teaching, { active: false, workerId: null, startedAt: null });
  adapter.destroy();
});

test("teach: Finish saves, then the operator's note follows as a normal message", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now(), maxDurationMs: 600_000 },
    stopTeachRecording: { state: "idle", maxDurationMs: 600_000 },
    sendPrompt: { accepted: true },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.startTeaching("w1");
  const result = await adapter.finishTeaching(true, "filter to unassigned tickets");
  assert.deepEqual({ ok: result.ok, saved: result.saved }, { ok: true, saved: true });
  assert.deepEqual(only(calls, "stopTeachRecording")[0].args, { agentId: "w1", save: true });
  await settle(40);
  const sent = only(calls, "sendPrompt");
  assert.equal(sent.length, 1);
  assert.match(sent[0].args.prompt, /filter to unassigned tickets/);
  adapter.destroy();
});

test("teach: a stop the host refuses keeps the recording state, so the dialog and its timer stay up", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now(), maxDurationMs: 600_000 },
    stopTeachRecording: new Error("teach-recording: failed to finalize recording"),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.startTeaching("w1");
  const result = await adapter.finishTeaching(true, "");
  assert.equal(result.ok, false);
  assert.match(result.message, /failed to finalize recording/);
  // The box is still recording, and the page has to keep saying so.
  assert.equal(state.teaching.active, true);
  assert.equal(state.teaching.workerId, "w1");
  adapter.destroy();
});

test("teach: a stop the host answers with a state other than idle is not a success", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now(), maxDurationMs: 600_000 },
    stopTeachRecording: { state: "recording", agentId: "w1", maxDurationMs: 600_000 },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.startTeaching("w1");
  const result = await adapter.finishTeaching(false, "");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-idle");
  assert.equal(state.teaching.active, true);
  adapter.destroy();
});

test("teach: a start answered with another agent's recording is a refusal, not a dialog", async () => {
  // The host's start() short-circuits on any recording already running and answers with THAT
  // recording, measured: startTeachRecording {agentId:"w2"} came back
  // {state:"recording", agentId:"w1"} 18ms later. Taken as a success it would title a dialog for
  // w2 over w1's screen, on a clock that started before the click.
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now() - 90_000, maxDurationMs: 600_000 },
  });
  const state = seed();
  state.workers.push({ ...state.workers[0], id: "w2", name: "Second probe" });
  const adapter = createGatewayAdapter(state);
  const events = [];
  adapter.subscribe((event) => events.push(event.type));
  const result = await adapter.startTeaching("w2");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "busy");
  assert.match(result.message, /Probe is already recording/);
  assert.deepEqual(state.teaching, { active: false, workerId: null, startedAt: null });
  assert.equal(events.includes("teaching:started"), false);
  assert.ok(events.includes("teaching:failed"));
  adapter.destroy();
});

test("teach: the dialog's copy matches what saving actually does with the recording", async () => {
  // The footer said "It never leaves the machine" while the hint beside it advertised the save
  // path. The recipe the host seeds on save extracts two frames and delegates the video to the
  // watchVideo subagent, and the box's model is a remote provider, so both leave the box. The
  // privacy sentence is the one an operator relies on before demonstrating with a customer
  // console on screen, so it is pinned here rather than left to a reviewer's eye.
  const html = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
  const start = html.indexOf('id="teach-dialog"');
  // Comments out: one of them quotes the sentence this test exists to keep off the screen.
  const dialog = html.slice(start, html.indexOf("</dialog>", start)).replace(/<!--[\s\S]*?-->/g, "");
  assert.ok(start > 0, "the teach dialog is in index.html");
  assert.equal(/never leaves the machine/i.test(dialog), false, "no claim that the recording stays on the box");
  assert.match(dialog, /Finish recording hands frames and the video to the model/);
  assert.match(dialog, /Discard deletes it and sends nothing/);
  // The two exits, said where the operator is looking: Escape is the one that stops the box, and
  // a click outside the frame is the one that does nothing. Both were the other way around.
  assert.match(dialog, /Escape discards this recording\. Clicking outside the dialog does not stop it\./);
});

test("teach: the recording dialog mounts the screen client only while the operator has asked for the screen", async () => {
  // Measured in a real browser: the live screen is served from :6081 while the page is on :7777,
  // so its iframe is an out-of-process frame. Once it focuses itself, Chromium delivers every key
  // to it; the page can blur the element, which moves document.activeElement back and moves no
  // keys. A dialog in that state reports a focused textarea, swallows the operator's whole note,
  // and passes the typing through to the recorded desktop as real X input. The only signal that
  // cannot lie about it is whether the frame is in the document, so the invariant pinned here is
  // structural: no client exists while the cover is up, and the guard that trusted activeElement
  // is gone rather than merely improved.
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const slice = (from, to) => {
    const start = app.indexOf(from);
    assert.ok(start > 0, `${from} is in app.js`);
    const end = app.indexOf(to, start);
    assert.ok(end > start, `${to} follows ${from} in app.js`);
    return app.slice(start, end);
  };
  const cover = slice("function renderTeachCover(", "function setTeachKeyboardHint(");
  assert.equal(/<iframe/i.test(cover), false, "the cover the dialog opens on carries no screen client");
  const control = slice("function setTeachScreenControl(", "function closeTeachScreen(");
  assert.match(control, /<iframe data-teach-vnc/, "the client is written only when control is handed over");
  // Handing the keyboard back has to remove the frame. Hiding or blurring it leaves the keys with
  // the box, which is the bug this test exists for.
  assert.match(control, /if \(!on\) \{[\s\S]*renderTeachCover\(\)/, "asking for the keyboard back re-renders the cover, so the frame goes away");
  const iframes = app.match(/<iframe data-teach-vnc/g) ?? [];
  assert.equal(iframes.length, 1, "one place in the page can mount the recorded screen");
  // The old guard: a 200ms poll that blurred whatever iframe held activeElement. It restored the
  // value the gate read and none of the behaviour the operator needed.
  assert.equal(/tagName !== "IFRAME"/.test(app), false, "no keyboard guard decides anything from activeElement");
  // Closing the dialog takes the client down with it.
  const close = slice("function closeTeachScreen(", "const TEACH_REFUSALS");
  assert.match(close, /innerHTML = ""/);
});

test("teach: the dialog opens with the note focused, so the first thing typed is the note", async () => {
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = app.indexOf("function showTeachDialog(");
  const body = app.slice(start, app.indexOf("function renderTeachCover(", start));
  assert.match(body, /getElementById\("teach-note"\)\?\.focus\(\)/);
  // And it opens covered: the screen is asked for after the modal is up, never mounted with it.
  assert.match(body, /renderTeachCover\(/);
  assert.equal(/<iframe/i.test(body), false);
});

test("teach: a stop against a host that already finished the recording is not called a save or a discard", async () => {
  // The cap fires on the box at ten minutes, saves the recording and dispatches the learning turn.
  // stop() then answers a bare {state:"idle"} for a recording it no longer holds -- the same shape
  // a real stop returns -- so Discard used to toast "Recording discarded" over a recording that had
  // been saved, queued and handed to the model.
  const { createGatewayAdapter, calls } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now(), maxDurationMs: 600_000 },
    getTeachRecordingStatus: { state: "idle", maxDurationMs: 600_000 },
    stopTeachRecording: { state: "idle", maxDurationMs: 600_000 },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.startTeaching("w1");
  const result = await adapter.finishTeaching(false, "");
  assert.equal(result.ok, true);
  assert.equal(result.alreadyStopped, true);
  assert.equal(result.saved, null, "neither saved nor discarded: this click stopped nothing");
  assert.match(result.message, /no longer recording/);
  assert.equal(only(calls, "stopTeachRecording").length, 0, "nothing to stop means no stop is sent");
  assert.deepEqual(state.teaching, { active: false, workerId: null, startedAt: null });
  adapter.destroy();
});

test("teach: a status the page cannot read still lets the stop through", async () => {
  // Refusing to stop on a failed read is the worse mistake: it leaves ffmpeg rolling with the
  // operator holding a button that does nothing.
  const { createGatewayAdapter, calls } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now(), maxDurationMs: 600_000 },
    getTeachRecordingStatus: new Error("gateway unreachable"),
    stopTeachRecording: { state: "idle", maxDurationMs: 600_000 },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.startTeaching("w1");
  const result = await adapter.finishTeaching(false, "");
  assert.deepEqual({ ok: result.ok, saved: result.saved }, { ok: true, saved: false });
  assert.equal(only(calls, "stopTeachRecording").length, 1);
  adapter.destroy();
});

test("teach: teachStatus answers the host's own state, and null when it cannot be asked", async () => {
  const started = Date.now() - 30_000;
  const { createGatewayAdapter } = await loadAdapter({
    getTeachRecordingStatus: { state: "recording", agentId: "w1", startedAtMs: started, maxDurationMs: 600_000 },
  });
  const adapter = createGatewayAdapter(seed());
  assert.deepEqual(await adapter.teachStatus(), { active: true, workerId: "w1", startedAt: started, maxDurationMs: 600_000 });
  adapter.destroy();

  const offline = await loadAdapter({ getTeachRecordingStatus: new Error("gateway unreachable") });
  const second = offline.createGatewayAdapter(seed());
  assert.equal(await second.teachStatus(), null, "a failed read is not the same answer as idle");
  second.destroy();

  const idle = await loadAdapter({ getTeachRecordingStatus: { state: "idle", maxDurationMs: 600_000 } });
  const third = idle.createGatewayAdapter(seed());
  assert.equal((await third.teachStatus()).active, false);
  third.destroy();
});

test("teach: the operator's note is only cleared once the request carrying it has landed", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    startTeachRecording: { state: "recording", agentId: "w1", startedAtMs: Date.now(), maxDurationMs: 600_000 },
    stopTeachRecording: { state: "idle", maxDurationMs: 600_000 },
    sendPrompt: new Error("gateway unreachable"),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.startTeaching("w1");
  const result = await adapter.finishTeaching(true, "filter to unassigned tickets");
  assert.equal(result.ok, true, "the recording was saved; only the note failed");
  assert.equal(result.noteSent, false, "the answer says so, so the view can keep the text");
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  assert.match(app, /if \(note && result\.noteSent !== false\) note\.value = "";/);
  adapter.destroy();
});

test("teach: the dialog polls the host, because only the box knows the cap has fired", async () => {
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = app.indexOf("function pollTeachHost(");
  assert.ok(start > 0, "the dialog has a poller");
  const body = app.slice(start, app.indexOf("\n  }", start));
  assert.match(body, /adapter\.teachStatus/);
  // A failed read must not close the dialog: that would take the operator's way out away over a
  // dropped request.
  assert.match(body, /status == null \|\| status\.active !== false\) return;/);
  assert.match(app, /teachPoll = window\.setInterval\(pollTeachHost/);
});

test("teach: the note's hint does not claim the recipe reads it", async () => {
  // learn-from-demonstration never mentions an operator note, and the host dispatches the learning
  // turn from inside stopTeachRecording before the page sends the note at all.
  const html = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
  const start = html.indexOf('id="teach-dialog"');
  const dialog = html.slice(start, html.indexOf("</dialog>", start)).replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(/read next to those frames/i.test(dialog), false);
  assert.match(dialog, /The recipe does not read this note/);
  const recipe = await readFile(path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills/learn-from-demonstration/SKILL.md"), "utf8");
  assert.equal(/operator.s note|the note you typed|user.s note/i.test(recipe), false,
    "if the recipe ever does read the note, this test and that hint both have to change");
});

test("teach: the refusal and the progress line are drawn beside the button that was clicked", async () => {
  const html = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
  const start = html.indexOf('class="desktop-header-actions"');
  const actions = html.slice(start, html.indexOf("</div>", start));
  assert.match(actions, /id="teach-refusal"/);
  assert.match(actions, /id="teach-progress"/);
  assert.match(actions, /id="teach-button"/);
  const footer = html.slice(html.indexOf('class="desktop-footer"'), html.indexOf("</footer>", html.indexOf('class="desktop-footer"')));
  assert.equal(/id="teach-refusal"|id="teach-progress"/.test(footer), false,
    "measured: in the footer they sat 719px below the button, at the other end of the dialog");
});

test("teach: the recording dialog takes what the frame has left rather than subtracting a constant", async () => {
  // The frame is a fixed height and it clips. Subtracting header + footer ignored the note field
  // between them, so the footer -- both stop buttons, the Escape hint, the stop-error line and the
  // sentence saying a saved demonstration leaves the machine -- was laid out 49px below the
  // clipped bottom edge and never painted.
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  const canvas = css.slice(css.indexOf(".teach-canvas {"), css.indexOf("}", css.indexOf(".teach-canvas {")));
  assert.equal(/height: calc\(100% -/.test(canvas), false, "no constant subtraction");
  assert.match(canvas, /flex: 1 1 auto/);
  assert.match(canvas, /min-height: 0/);
  const frame = css.slice(css.indexOf(".teach-frame {\n  display"), css.indexOf("}", css.indexOf(".teach-frame {\n  display")));
  assert.match(frame, /flex-direction: column/);
  // Same shape for the desktop dialog, which had the same constant and the same clipping risk.
  const workspace = css.slice(css.indexOf(".desktop-workspace {"), css.indexOf("}", css.indexOf(".desktop-workspace {")));
  assert.equal(/height: calc\(100% -/.test(workspace), false);
});
