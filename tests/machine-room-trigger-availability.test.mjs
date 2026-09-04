// The routine editor offered seven trigger kinds. Six of them are event triggers, and this host
// can serve none of them: it builds exactly two event sources (createBackendRelaySources, a Slack
// one and a GitHub one), hands the trigger hub those two and nothing else, and both are polled out
// of Cursor's backend relay, which needs a login this box does not have. A routine saved on one
// took the form, showed the word "trigger" where its countdown goes, and never fired.
//
// This pins the shipped block itself rather than a copy: if a kind quietly becomes selectable
// again while nothing can deliver its events, that is the same silent lie coming back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The shipped block itself, run rather than pattern-matched: string assertions cannot tell a
// refusal that follows the box's own answer from one that is hardcoded prose.
async function loadEditor(plugins) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  const TRIGGER_KINDS = [");
  const end = source.indexOf("  function notificationsPanel()");
  assert.ok(start > 0 && end > start, "trigger editor block not found in app.js");
  return new Function("state", "escapeHtml",
    `${source.slice(start, end)}\nreturn { triggerUnavailable, EVENT_TRIGGER_PLATFORM, triggerStackMarkup };`,
  )({ plugins }, String);
}
const loadAvailability = loadEditor;

const listener = (id, connected) => ({ id, group: "Listeners", status: connected ? "connected" : "available", category: connected ? "Connected" : "Not connected" });

test("a schedule is always offered: the box runs its own clock", async () => {
  const { triggerUnavailable } = await loadAvailability([]);
  assert.equal(triggerUnavailable("cron"), null);
});

test("every event kind is refused on a box the host reports no listeners for", async () => {
  const { triggerUnavailable, EVENT_TRIGGER_PLATFORM } = await loadAvailability([]);
  for (const kind of Object.keys(EVENT_TRIGGER_PLATFORM)) {
    const why = triggerUnavailable(kind);
    assert.equal(typeof why, "string", `${kind} was offered with nothing to deliver it`);
    assert.match(why, /wait forever/);
  }
});

test("the reason separates a listener that is not connected from one the host cannot have at all", async () => {
  const { triggerUnavailable } = await loadAvailability([listener("slack", false), listener("github", false)]);
  assert.match(triggerUnavailable("slack"), /backend relay/);
  assert.match(triggerUnavailable("slack"), /not connected/);
  assert.match(triggerUnavailable("linear"), /Nothing on this box delivers Linear events/);
});

test("a connected listener is offered, and only that one", async () => {
  const { triggerUnavailable } = await loadAvailability([listener("slack", true), listener("github", false)]);
  assert.equal(triggerUnavailable("slack"), null);
  assert.equal(typeof triggerUnavailable("github"), "string");
});

test("the picker disables what it cannot serve and prints the reason under the trigger it has", async () => {
  const { triggerStackMarkup } = await loadEditor([]);
  const markup = triggerStackMarkup();
  assert.match(markup, /data-event-triggers-note/, "the form must say what it cannot offer");
  assert.match(markup, /backend relay/, "and must name the reason, not just refuse");
  // Six kinds blocked, and the one the draft already carries is cron, which stays selected.
  assert.equal((markup.match(/ disabled>/g) ?? []).length, 6);
  assert.match(markup, /<option value="cron" selected>/);
});

// The note used to be a fixed sentence saying the box had no listener, printed in the same block
// that would happily offer a connected one. What it says now follows what the box actually reports.
test("a listener the host reports connected drops out of the refusal as well as the picker", async () => {
  const { triggerStackMarkup } = await loadEditor([listener("slack", true), listener("github", false)]);
  const markup = triggerStackMarkup();
  const note = /data-event-triggers-note>([^<]*)</.exec(markup)?.[1] ?? "";
  assert.match(note, /^5 of the trigger kinds below need a listener/);
  assert.ok(!/Slack message/.test(note), `a connected listener must not be named as blocked: ${note}`);
  assert.match(note, /Git event would work only while the host reports that listener connected/);
  assert.equal((markup.match(/ disabled>/g) ?? []).length, 5);
  assert.match(markup, /<option value="slack" >Slack message<\/option>/);
});

test("with both listeners connected the note stops naming them and keeps only what has no source", async () => {
  const { triggerStackMarkup } = await loadEditor([listener("slack", true), listener("github", true)]);
  const markup = triggerStackMarkup();
  const note = /data-event-triggers-note>([^<]*)</.exec(markup)?.[1] ?? "";
  // Linear, Sentry, PagerDuty and Teams have no source on this box whatever a listener says.
  assert.match(note, /^4 of the trigger kinds below need a listener/);
  assert.ok(!/would work only while/.test(note), `nothing is merely unconnected now: ${note}`);
  assert.equal((markup.match(/ disabled>/g) ?? []).length, 4);
});
