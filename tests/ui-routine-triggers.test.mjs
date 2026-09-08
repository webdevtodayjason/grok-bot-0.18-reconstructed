// The routine editor turns a cron string into friendly controls and back. That parser is the
// one piece of the dashboard with real logic in it -- if it drifts, a routine saves with a
// schedule the manager did not pick, and nothing says so. Evaluate the shipped block itself
// rather than a copy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadEditor(stateStub = { editor: { menu: null, triggers: [] } }) {
  const html = await readFile(path.join(repoRoot, "ui/index.html"), "utf8");
  const start = html.indexOf("/* ---- routine editor");
  const end = html.indexOf("/* ---- actions ---", start);
  assert.ok(start > 0 && end > start, "routine editor block not found in ui/index.html");
  const block = html.slice(start, end);
  const exports = "return { readSchedule, buildSchedule, triggerProblem, blankTrigger, applyTrig, TRIGGER_KINDS, triggerUnavailable, trigMenu };";
  // The block assigns handlers onto window and reaches for page globals; stub what it touches.
  return new Function("window", "state", "esc", "$", "guard", "call", "render",
    `${block}\n${exports}`)({}, stateStub, String, () => null, () => {}, () => {}, () => {});
}

test("every schedule shape round-trips through the cron string", async () => {
  const { readSchedule, buildSchedule } = await loadEditor();
  const base = readSchedule("0 9 * * *");
  for (const shape of ["hourly", "daily", "weekdays", "weekly", "monthly", "interval"]) {
    const schedule = buildSchedule({ ...base, shape });
    assert.equal(readSchedule(schedule).shape, shape, `${shape} -> ${schedule}`);
  }
});

test("known schedules read back as the control the manager picked", async () => {
  const { readSchedule } = await loadEditor();
  assert.deepEqual(pick(readSchedule("30 3 * * 1-5")), { shape: "weekdays", hour: 3, min: 30 });
  assert.deepEqual(pick(readSchedule("15 0 * * *")), { shape: "daily", hour: 0, min: 15 });
  assert.deepEqual(pick(readSchedule("0 * * * *")), { shape: "hourly", hour: 9, min: 0 });
  assert.equal(readSchedule("0 9 5 * *").shape, "monthly");
  assert.equal(readSchedule("0 9 * * 3").shape, "weekly");
  assert.equal(readSchedule("@every 30m").shape, "interval");
  const odd = readSchedule("*/7 1-4 * * *");
  assert.equal(odd.shape, "advanced");
  assert.equal(odd.raw, "*/7 1-4 * * *", "an expression we cannot draw is preserved, not rewritten");
  function pick(v) { return { shape: v.shape, hour: v.hour, min: v.min }; }
});

test("a fresh trigger of every kind is valid except the ones needing an address", async () => {
  const { blankTrigger, triggerProblem, TRIGGER_KINDS } = await loadEditor();
  const needsInput = new Set(["github", "microsoftTeams"]);
  for (const [kind] of TRIGGER_KINDS) {
    const problem = triggerProblem(blankTrigger(kind));
    assert.equal(problem == null, !needsInput.has(kind), `${kind}: ${problem}`);
  }
});

test("the checks catch what the host would silently drop", async () => {
  const { blankTrigger, triggerProblem, applyTrig } = await loadEditor();
  const gh = blankTrigger("github");
  applyTrig(gh, "repo", "not-a-repo");
  assert.match(triggerProblem(gh), /owner\/repo/);
  applyTrig(gh, "repo", "titanium/clientsync");
  assert.equal(triggerProblem(gh), null);
  // A CI event without a branch parses to a listener the host throws away.
  applyTrig(gh, "events", "ci-failed");
  assert.match(triggerProblem(gh), /branch/);
  applyTrig(gh, "ciBranch", "main");
  assert.equal(triggerProblem(gh), null);

  const slack = blankTrigger("slack");
  applyTrig(slack, "match", "keyword");
  assert.match(triggerProblem(slack), /keyword/);
  applyTrig(slack, "keyword", "outage");
  assert.equal(triggerProblem(slack), null);
  assert.deepEqual(slack.match, { kind: "keyword", keyword: "outage" });

  const cron = blankTrigger("cron");
  applyTrig(cron, "cron.shape", "advanced");
  applyTrig(cron, "cron.raw", "every tuesday");
  assert.match(triggerProblem(cron), /cron expression/);
});

test("editing a control rewrites only its own field of the schedule", async () => {
  const { blankTrigger, applyTrig, readSchedule } = await loadEditor();
  const cron = blankTrigger("cron");
  applyTrig(cron, "cron.shape", "weekly");
  applyTrig(cron, "cron.dow", "5");
  applyTrig(cron, "cron.time", "17:45");
  assert.equal(cron.schedule, "45 17 * * 5");
  assert.deepEqual(readSchedule(cron.schedule).dow, 5);
});

// This host can deliver none of the event triggers this menu lists: it builds one Slack event
// source and one GitHub one (createBackendRelaySources), hands its trigger hub those two and
// nothing else, and both were polled out of a relay this product no longer has, so no box
// does not have. A menu that offers them anyway sells a routine that saves and never fires.
test("an event trigger with no source on this box cannot be picked, and the menu says why", async () => {
  const { triggerUnavailable, trigMenu, TRIGGER_KINDS } = await loadEditor({ editor: { menu: null, triggers: [] }, integrations: { integrations: [{ platform: "slack", isConnected: false }, { platform: "github", isConnected: false }] } });
  assert.equal(triggerUnavailable("cron"), null);
  for (const [kind] of TRIGGER_KINDS.slice(1)) assert.equal(typeof triggerUnavailable(kind), "string", `${kind} was offered with nothing to deliver it`);
  assert.match(triggerUnavailable("slack"), /not wired into this workspace yet/);
  assert.match(triggerUnavailable("linear"), /Nothing delivers Linear events to this workspace yet/);
  const menu = trigMenu();
  assert.equal((menu.match(/<button disabled/g) ?? []).length, TRIGGER_KINDS.length - 1);
  assert.ok(!/onclick="addTrigger/.test(menu), "no unserved kind may still be clickable");
  assert.match(menu, /need a listener this box has not connected/);
});

test("a connected listener is offered again, and only that one", async () => {
  const { triggerUnavailable, trigMenu } = await loadEditor({ editor: { menu: null, triggers: [] }, integrations: { integrations: [{ platform: "slack", isConnected: true }, { platform: "github", isConnected: false }] } });
  assert.equal(triggerUnavailable("slack"), null);
  assert.match(trigMenu(), /onclick="addTrigger\('slack'\)"/);
  assert.equal(typeof triggerUnavailable("github"), "string");
});
