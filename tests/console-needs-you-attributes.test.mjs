// CONSOLE-ATTR-1. The three attributes a shell reads off this console when it has no bearer yet.
//
// WHY THERE ARE THREE AND WHY THEY MATTER. The desktop shell loads console.titanium.bot in its window
// and, until a device is signed in, has no token and no route -- so a script injected into the page
// reads the DOM and raises a Tauri event with what it found. Its reader tries, for each selector, the
// attribute's value, then a number anywhere in the element's text, and failing both **the number of
// elements the selector matched**.
//
// THE DEFECT THAT LAST RULE CAUSED. `data-needs-you-count` was already on the roster pill with NO
// value, and the pill is always in the markup and matches the selector even while it is hidden and
// empty. So with ZERO agents waiting the reader fell through both readings and answered `nodes.length`
// -- **1** -- which is indistinguishable from a real count of 1. Measured on this Mac 2026-09-10 by
// running that reader verbatim against the shipped markup: 0 -> 1, 3 -> 3. A quiet console put a
// phantom 1 on the tray for ever.
//
// Everything below is evaluated out of the shipped files. app.js has no build step, so a function
// deleted out from under a call site parses fine and dies on the first click; slicing the real source
// is the only thing here that would notice. The same convention tests/machine-room-handoff.test.mjs
// established: a helper declared at two-space indent and closed by a lone two-space brace.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appJs = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
const indexHtml = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
const contract = await readFile(path.join(repoRoot, "docs/APPS.md"), "utf8");

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

/** One two-space-indented function, sliced out of app.js and evaluated on its own. */
function slice(name) {
  const start = appJs.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer carries ${name}`);
  return appJs.slice(start, appJs.indexOf("\n  }\n", start) + 4);
}

const attrs = new Function("escapeHtml", "arg", `${slice("needsYouCardAttrs")}\nreturn needsYouCardAttrs(escapeHtml, arg);`);
// Every call here names a kind, because the kind is the first gate: only the six the relay pushes are
// markable, and a call with no kind would pass the checks below for the wrong reason.
const hook = (arg) => attrs(escapeHtml, { kind: "widget", ...arg });

// ---- the count, which is the one that was actively wrong -----------------------------------------

test("the count slot is in the static markup, so the reader's selector always has something to match", () => {
  // It has to STAY in the markup: tests/awaiting-operator.test.mjs asserts the same thing, and a slot
  // that only appeared once the count was non-zero would be a shell that never sees a zero.
  assert.match(indexHtml, /<span class="roster-needs-you" data-needs-you-count hidden><\/span>/);
});

test("renderNeedsYouCount writes the NUMBER as the attribute's value, including zero", () => {
  const source = slice("renderNeedsYouCount");
  assert.match(source, /dataset\.needsYouCount\s*=\s*String\(count\)/,
    "the value is the count itself, not a truthy marker");
  // And it is written unconditionally rather than inside the `count === 0` branch that empties the
  // text, because zero is the answer the reader was getting wrong.
  const written = source.slice(source.indexOf("dataset.needsYouCount"));
  assert.ok(!/^\s*if\s*\(/.test(written), "nothing guards the write");

  // Driven, with the shipped function over a stand-in slot, at both the counts that were measured.
  for (const count of [0, 1, 3]) {
    const slot = { hidden: false, textContent: "", title: "", dataset: {} };
    new Function("document", "needsYouCount", `${source}\nreturn renderNeedsYouCount();`)(
      { querySelector: () => slot },
      () => count,
    );
    assert.equal(slot.dataset.needsYouCount, String(count), `a count of ${count} is written as "${count}"`);
    assert.equal(slot.hidden, count === 0, "and the pill is still hidden at zero, which is why the value has to be there");
  }
});

test("renderNeedsYouCount is called from renderRoster, so the value is fresh on every paint", () => {
  assert.match(slice("renderRoster"), /renderNeedsYouCount\(\)/);
});

// ---- the card hook -------------------------------------------------------------------------------

test("a pending card carries every attribute the desktop reader asks for", () => {
  const out = hook({ kind: "box-handoff", agentId: "agent_7c1", entryId: "t14s0", agentName: "Books", title: "Take the keyboard for Books" });
  // The marker and the id carry the same string -- the agent and the entry, joined -- so neither side
  // parses anything, and the brief's "the agent id and entry id" is on the marker itself.
  assert.match(out, /\sdata-needs-you-card="agent_7c1:t14s0"/);
  assert.match(out, /\sdata-card-id="agent_7c1:t14s0"/);
  assert.match(out, /\sdata-card-kind="box-handoff"/);
  assert.match(out, /\sdata-agent="Books"/);
  assert.match(out, /\sdata-title="Take the keyboard for Books"/);
  // A console path, which is the only href shape their reader accepts; anything else it drops.
  assert.match(out, /\sdata-href="\/\?agent=agent_7c1&amp;entry=t14s0"/);
  // data-card-id is REQUIRED by the reader, which drops any card without one. Emitting the marker
  // alone would be a node a shell counts and cannot open.
  assert.ok(out.includes("data-card-id"), "the marker never travels without an id");
});

test("a card with no durable id carries nothing at all, rather than a dead deep link", () => {
  // The shell opens /?agent=&entry=. gateway-adapter.js falls back to the literal "agent" when the
  // host sent no author and to `entry-<n>` when it sent no entry id -- an index that is not stable
  // across a re-read and is not an id the relay knows. Either one would open the console on nothing.
  assert.equal(hook({ agentId: "agent", entryId: "t14s0", title: "x" }), "", "the author fallback");
  assert.equal(hook({ agentId: "you", entryId: "t14s0", title: "x" }), "", "a card of the person's own");
  assert.equal(hook({ agentId: "agent_7c1", entryId: "entry-4", title: "x" }), "", "the index fallback");
  assert.equal(hook({ agentId: "", entryId: "t14s0", title: "x" }), "");
  assert.equal(hook({ agentId: "agent_7c1", entryId: "", title: "x" }), "");
  assert.equal(hook({ agentId: "agent_7c1", entryId: null, title: "x" }), "", "a report offer with no pendingId");
  assert.equal(hook({}), "");
  // The whole set goes or none of it does: a partial set is what makes a reader guess.
  for (const bad of [{ agentId: "agent", entryId: "t14s0" }, { agentId: "a1", entryId: "entry-0" }]) {
    assert.ok(!hook(bad).includes("data-"), "no half a hook");
  }
});

test("a title with markup in it cannot break out of the attribute", () => {
  const out = hook({ agentId: "a1", entryId: "e1", agentName: '"><b>', title: '"><script>alert(1)</script>' });
  assert.ok(!out.includes("<script>"));
  assert.match(out, /data-title="&quot;&gt;&lt;script&gt;/);
  assert.match(out, /data-agent="&quot;&gt;&lt;b&gt;"/);
});

// ---- where the hook is used, and where it deliberately is not -------------------------------------

test("the hook is on the pending branch of all three card drawers and nowhere else", () => {
  // Three functions draw a card a person still has to act on: decisionMarkup (four of the six push
  // kinds), handoffCardMarkup and reportCardMarkup. Each has settled and in-flight branches that must
  // NOT carry it, or a tray shows work nobody has to do.
  const calls = [...appJs.matchAll(/(?<!function )needsYouCardAttrs\(escapeHtml,/g)];
  assert.equal(calls.length, 3, "exactly three call sites: the three pending branches");

  for (const [name, expected] of [["decisionMarkup", 1], ["handoffCardMarkup", 1], ["reportCardMarkup", 1]]) {
    const body = slice(name);
    assert.equal([...body.matchAll(/needsYouCardAttrs\(/g)].length, expected, `${name} calls it once`);
  }

  // The rail's copy of the hand-off is the SAME hand-off drawn a second time. Attributing it would
  // make every open hand-off count twice on a tray.
  assert.ok(!slice("renderHandoffRail").includes("needsYouCardAttrs"), "the rail card carries nothing");
});

test("the hand-off card carries the relay's fixed title and never the agent's own instruction", () => {
  // ui/push-edge.mjs sends `Take the keyboard for <agent>` and comments that entry.boxInstruction is
  // never sent because the agent wrote it. This card SHOWS that instruction. Copying the visible
  // string into data-title would put model-written text on a lock screen, which is the exact thing
  // rule 5 exists to stop.
  const body = slice("handoffCardMarkup");
  const call = /needsYouCardAttrs\(escapeHtml, \{[\s\S]*?\}\)/.exec(body)[0];
  assert.match(call, /Take the keyboard for/);
  assert.ok(!call.includes("instruction"), "the instruction is not what goes on the wire");
  // And it is on the pending state alone.
  assert.match(body, /state === "pending"\s*\?\s*needsYouCardAttrs/);
});

test("the report card keys on pendingId, the durable row id, and never the page-local offer id", () => {
  const body = slice("reportCardMarkup");
  const call = /needsYouCardAttrs\(escapeHtml, \{[^}]*\}\)/.exec(body)[0];
  assert.match(call, /entryId: offer\.pendingId/);
  assert.ok(!/entryId: offer\.id/.test(call), "offer-<seq> dies with the page and is never pushed");
  assert.match(call, /title: offer\.title/, "the relay's own title, not the agent-name-prefixed copy");
});

test("the decision card names the conversation it is drawn in, not the entry's author", () => {
  const call = /needsYouCardAttrs\(escapeHtml, \{[^}]*\}\)/.exec(slice("decisionMarkup"))[0];
  // The link has to open the card where the person can answer it. In a room the author is the member
  // agent that raised it and `attachmentAgentId()` is whichever member happens to be first, so both
  // of those mint a link to somewhere the card is not; the conversation opens the room.
  assert.match(call, /agentId: activeContext\(\)\.id/);
  assert.ok(!call.includes("message.authorId"), "the author is not where the card is drawn");
  assert.ok(!call.includes("attachmentAgentId"), "and neither is the first member of a room");
  assert.match(call, /entryId: message\.id/, "the host's own entry id, which is what the relay keys on");
  assert.match(call, /kind: card\.kind/, "the adapter's card kinds are push-edge's own four");
});

// ---- the talk button -----------------------------------------------------------------------------

test("the talk button carries data-talk-button in the static markup", () => {
  // NOT set by voice.js. The button is markup and voice.js only queries it, so a JS-applied attribute
  // would be absent whenever that module fails to load -- and probe() can disable the button while
  // leaving it on the page, which is a state the hotkey still has to find.
  const line = indexHtml.split("\n").find((row) => row.includes('id="voice-talk"'));
  assert.ok(line != null, "the talk button is still in index.html");
  assert.match(line, /\sdata-talk-button\b/);
  assert.match(line, /\sdata-voice-talk\b/, "and the console's own hook is untouched");

  // The shell's other selectors do not match this button, which is why the attribute is needed at all:
  // its list has `button[aria-label="Talk" i]`, and this label is "Talk to your agent".
  assert.match(line, /aria-label="Talk to your agent"/);
});

// ---- the contract, written down where a shell author will read it ---------------------------------

test("docs/APPS.md names all three attributes as the page-read contract", () => {
  const section = contract.slice(contract.indexOf("### The three attributes on the console's own page"));
  assert.ok(section.length > 0, "docs/APPS.md carries the section");
  for (const name of ["data-needs-you-count", "data-needs-you-card", "data-card-id", "data-agent", "data-title", "data-talk-button"]) {
    assert.ok(section.includes(name), `the contract names ${name}`);
  }
  // The two sentences a shell author has to read or they will get it wrong: the node list is partial,
  // and GET /push/pending is the authority.
  assert.match(section, /partial list/);
  assert.match(section, /GET \/push\/pending` is the\s+authority\*\*/s);
  assert.match(section, /never the agent-written instruction/);
});
