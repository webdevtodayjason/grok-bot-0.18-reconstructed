// AUTOMATION-3. A scheduled routine that fails raises no tray error -- that is deliberate
// (automation-runtime.ts runLocalScheduledAutomation: "a background failure is reported through the
// run record rather than an alert about a run the operator did not start"). The run record was
// therefore the whole report, and nothing read it: the host writes status "error", the console's
// vocabulary is "failed", and an unmapped status fell through to "Last run outcome not reported" --
// in the same success green as a run that went fine. So a routine that had been failing every
// minute for an hour looked, on its card, like a routine nobody had heard from.
//
// Both halves are pinned here against the shipped files rather than copies: the adapter's shaping
// of the host's run row, and the card the panel actually renders from it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The adapter is a browser IIFE; take the shipped block and expose the two functions under test.
async function loadRoutineShaping() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { routinesOf, lastRunOf };\n  global.__bootMachineRoom =",
  );
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
    open: () => {},
  };
  return new Function("window", "fetch", `${exposed}\nreturn window.__test;`)(window, async () => ({ ok: true, text: async () => "{}" }));
}

// The shipped card, evaluated. Everything routinesPanel reaches for outside itself is stubbed, so
// what is under test is the template and nothing else.
async function renderCard(routine) {
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = app.indexOf("  function routinesPanel() {");
  assert.ok(start > 0, "routinesPanel is in app.js");
  const end = app.indexOf("  function resetRoutineForm(", start);
  assert.ok(end > start, "resetRoutineForm follows routinesPanel in app.js");
  const block = `${app.slice(start, end)}\nreturn routinesPanel();`;
  return new Function(
    "routinesForContext", "activeContext", "contextName", "workerById",
    "escapeHtml", "formatCountdown", "routineScopeLabel", "editingRoutineId", "triggerStackMarkup",
    block,
  )(
    () => [routine],
    () => ({ kind: "worker", id: "w1" }),
    () => "Probe",
    () => null,
    (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    () => "1m",
    () => "Probe",
    null,
    () => "",
  );
}

// The run rows below are the host's own shape: automation.ts AutomationRunStatus is
// "running" | "ok" | "error", and finishRunDefinition puts the reason on `detail`.
const failedScheduleRun = {
  id: "run-error",
  trigger: "schedule",
  status: "error",
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_004_100,
  detail: "Lost the connection repeatedly and gave up after retrying: upstream 503",
};

const automation = (runs) => ({
  id: "sweep", name: "Morning sweep", prompt: "Sweep the queue", isEnabled: true,
  triggerDescription: "Every day at 9am", trigger: { type: "cron", schedule: "0 9 * * *" },
  nextRunAt: 1_700_000_600_000, lastRunAt: 1_700_000_000_000, runs,
});

test("AUTOMATION-3: the host's \"error\" run reaches the console as a failed run, with its reason", async () => {
  const { routinesOf } = await loadRoutineShaping();
  const [routine] = routinesOf([automation([failedScheduleRun])], { kind: "worker", id: "w1" });
  assert.equal(routine.lastRun.status, "failed", "the card's word for the host's \"error\" is \"failed\"");
  assert.equal(routine.lastRun.trigger, "schedule", "and the console can say the run was one nobody pressed");
  assert.equal(routine.lastRun.detail, failedScheduleRun.detail, "the reason the host stored survives the shaping");
  assert.equal(routine.lastRun.duration, "4.1s");
});

test("AUTOMATION-3: a successful run is still a successful run, and an unrecognised status is still not called one", async () => {
  const { routinesOf } = await loadRoutineShaping();
  const ok = routinesOf([automation([{ ...failedScheduleRun, status: "ok", detail: undefined }])], { kind: "worker", id: "w1" });
  assert.equal(ok[0].lastRun.status, "passed");
  assert.equal(ok[0].lastRun.detail, null, "a run with no detail carries none rather than an empty line");
  const odd = routinesOf([automation([{ ...failedScheduleRun, status: "dispatched" }])], { kind: "worker", id: "w1" });
  assert.equal(odd[0].lastRun.status, "dispatched", "an unknown outcome is reported in the host's own word");
});

test("AUTOMATION-3: the routine card shows the failed scheduled run, out of the success green", async () => {
  const { routinesOf } = await loadRoutineShaping();
  const [routine] = routinesOf([automation([failedScheduleRun])], { kind: "worker", id: "w1" });
  const card = await renderCard(routine);
  assert.match(card, /Last run failed/, "the card says the last run failed");
  assert.match(card, /on its schedule/, "and that it was a run nobody pressed");
  assert.match(card, /class="run-result failed"/, "styled as a failure rather than in the success green");
  assert.match(card, /class="run-detail">Lost the connection repeatedly/, "the reason is on the card, because nowhere else reports it");
  assert.match(card, /class="status-pill attention">last run failed</, "and the pill stops claiming the routine is fine");
  assert.equal(/Last run outcome not reported/.test(card), false, "the failure is not reported as an outcome nobody reported");
});

// Pausing a routine is what an operator does the moment it starts failing, so this is the common
// pair, not a corner. The pill's class already put paused first; its text did not, and a disabled
// routine read on its card as a live one that keeps failing, with the word "paused" nowhere on it.
test("AUTOMATION-3: a paused routine whose last run failed still says it is paused", async () => {
  const { routinesOf } = await loadRoutineShaping();
  const [routine] = routinesOf([{ ...automation([failedScheduleRun]), isEnabled: false }], { kind: "worker", id: "w1" });
  assert.equal(routine.status, "paused", "a disabled routine is a paused one");
  const card = await renderCard(routine);
  assert.match(card, /class="status-pill ">paused</, "the pill says what the routine is, not what its last run did");
  assert.match(card, /class="run-result failed"/, "and the failure is still on the card, on the run line");
  assert.match(card, /class="run-detail">Lost the connection repeatedly/, "with the reason the host stored");
  assert.equal(/Last run outcome not reported/.test(card), false);
});

test("AUTOMATION-3: a routine whose last run succeeded is unchanged", async () => {
  const { routinesOf } = await loadRoutineShaping();
  const [routine] = routinesOf([automation([{ ...failedScheduleRun, status: "ok", detail: undefined }])], { kind: "worker", id: "w1" });
  const card = await renderCard(routine);
  assert.match(card, /Last run succeeded/);
  assert.match(card, /class="status-pill success">ready</);
  assert.equal(/run-result failed|run-detail/.test(card), false);
});

test("AUTOMATION-3: the failure colour is a real rule, not a class nothing styles", async () => {
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  assert.match(css, /\.run-result\.failed \{[^}]*color:/, "a failed run has its own colour");
  assert.match(css, /\.status-pill\.attention \{[^}]*color:/, "and so does the pill that carries it");
  assert.match(css, /\.run-detail \{/, "the reason line is styled rather than inheriting the run line");
});
