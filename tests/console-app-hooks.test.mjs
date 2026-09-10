// CONSOLE-ATTR-1, the console half. A shell that is signed in should ask GET /push/pending, which
// is the authority on what is waiting. These three attributes are the FALLBACK for a shell that has
// only the page: the desktop app reads the DOM through an injected script, and until now it had
// nothing stable to hold on to at any of the three sites.
//
//   data-needs-you-count   the roster pill, carrying the number, including zero
//   data-needs-you-card    one pending card, carrying the agent and the entry
//   data-talk-button       the talk button
//
// Everything below is evaluated out of the SHIPPED files. app.js has no build step, so a helper
// deleted out from under a call site parses fine and dies on the first render; slicing the real
// source is the only thing here that would notice. The slicing shape is the one
// tests/machine-room-handoff.test.mjs established: declared at two-space indent, closed by a lone
// two-space brace.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PUSH_CARD_KINDS, CARD_BODY } from "../ui/push-edge.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(repoRoot, "ui/machine-room/app.js");
const htmlPath = path.join(repoRoot, "ui/machine-room/index.html");

// A "this string is not in there" assertion has to run on the code, not on the prose around it:
// every function here carries a comment naming the thing it must not do.
const codeOnly = (text) => text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");

// The page's own escaper, character for character (app.js:510). A markup check against a different
// escaper proves nothing about what the browser is handed.
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const source = await readFile(appPath, "utf8");
const html = await readFile(htmlPath, "utf8");

const grab = (name) => {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer defines ${name}`);
  return source.slice(start, source.indexOf("\n  }\n", start) + 4);
};
const span = (from, to, what) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `${what} must be findable in app.js`);
  return source.slice(start, end);
};

// The four sliced markup paths, each with its real dependencies out of app.js and the rest injected
// as arguments. `adapter`, `offerHasNoHome`, `tierLabel` and `REPORT_CUSTODY` are the page's live
// wiring rather than markup, so they come in as stubs; everything that decides an ATTRIBUTE is real
// source.
const markup = (() => {
  const hooks = grab("needsYouCardAttrs");
  const decisions = span("  const DECISION_ACTIONS = {", "  function decisionMarkup(", "DECISION_ACTIONS and the secret custody helpers");
  const reportTitle = span("  const reportCardTitle = (offer)", "  function reportCardMarkup(", "reportCardTitle");
  const dims = span("  const BOX_HANDOFF_THUMB_W", "  // escapeHtml and the flags come in", "the hand-off thumbnail size");
  const built = new Function(
    "escapeHtml", "adapter", "offerHasNoHome", "tierLabel", "REPORT_CUSTODY",
    "activeContext", "contextName",
    [
      hooks,
      decisions, grab("decisionMarkup"),
      reportTitle, grab("reportCardMarkup"),
      dims, grab("boxHandoffState"), grab("handoffCardMarkup"),
      "return { needsYouCardAttrs, decisionMarkup, reportCardMarkup, handoffCardMarkup };",
    ].join("\n"),
  );
  return built(
    escapeHtml,
    { dismissCard: () => {}, submitSecretRequest: () => {} },
    () => false,
    () => "Slowed me down",
    "What is sent.",
    // THE CONVERSATION, injected and movable. A pending decision card names the conversation it is
    // drawn in rather than the entry's author: the deep link's job is to open the card where the
    // person can answer it, and in a room the author is a member agent while the card is on the
    // room. So these two are what decide the attribute, and a test can move them.
    () => open_,
    () => openName,
  );
})();

let open_ = { kind: "worker", id: "w-3" };
let openName = "Titan";

const { decisionMarkup, reportCardMarkup } = markup;
// The helper takes the page's escaper as its first argument, so it stays sliceable for the harnesses
// in tests/machine-room-handoff.test.mjs and tests/machine-room-feedback.test.mjs.
const needsYouCardAttrs = (options) => markup.needsYouCardAttrs(escapeHtml, options);
const handoffCardMarkup = (message, skipSupported = true, view = {}) =>
  markup.handoffCardMarkup(message, escapeHtml, skipSupported, view);

const attrOf = (name, text) => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(text);
  return match ? match[1] : null;
};

// ---- the helper itself ---------------------------------------------------------------------------

test("a real card carries all six attributes, spelled the way the shells read them", () => {
  const out = needsYouCardAttrs({
    kind: "widget", agentId: "w-3", entryId: "e-88", agentName: "Titan", title: "Which branch?",
  });
  assert.equal(attrOf("data-needs-you-card", out), "w-3:e-88");
  assert.equal(attrOf("data-card-id", out), "w-3:e-88", "the marker and the id carry the same string");
  assert.equal(attrOf("data-card-kind", out), "widget");
  assert.equal(attrOf("data-agent", out), "Titan");
  assert.equal(attrOf("data-title", out), "Which branch?");
  assert.equal(attrOf("data-href", out), "/?agent=w-3&amp;entry=e-88", "a console path, with the ampersand escaped for the attribute");
  assert.match(out, /^ data-needs-you-card=/, "it starts with a separator so it can sit between attributes");
});

test("all six push kinds are markable and nothing else is", () => {
  for (const kind of PUSH_CARD_KINDS) {
    assert.notEqual(
      needsYouCardAttrs({ kind, agentId: "w-1", entryId: "e-1", title: "t" }), "",
      `${kind} is one of the six the relay pushes`,
    );
  }
  // The skill draft is the seventh thing on this page that looks like a card, and it is not a
  // question. Neither is a made-up kind or a missing one.
  for (const kind of ["skill", "", null, undefined, "auto_review", "handoff"]) {
    assert.equal(needsYouCardAttrs({ kind, agentId: "w-1", entryId: "e-1", title: "t" }), "", `${kind} is not pushed`);
  }
  assert.equal(PUSH_CARD_KINDS.length, 6, "six kinds, and push-edge.mjs is the list");
});

test("an agent id the page invented carries nothing, because the deep link would name nobody", () => {
  const attrs = (agentId) => needsYouCardAttrs({ kind: "widget", agentId, entryId: "e-1", title: "t" });
  assert.equal(attrs(""), "", "no agent at all");
  assert.equal(attrs("   "), "", "whitespace is no agent");
  assert.equal(attrs(undefined), "");
  assert.equal(attrs("you"), "", "the person is not an agent");
  assert.equal(attrs("agent"), "", "the adapter's fallback when the host named nobody");
  assert.notEqual(attrs("agent-7"), "", "a real id that merely starts with the word is fine");
});

test("an entry id with no durable half carries nothing, so absence means not pushable", () => {
  const attrs = (entryId) => needsYouCardAttrs({ kind: "widget", agentId: "w-1", entryId, title: "t" });
  assert.equal(attrs(""), "");
  assert.equal(attrs(null), "");
  // gateway-adapter.js falls back to `entry-<i>` when the host sent no id. That index is not stable
  // across a re-read and is not an id the relay knows, so a link built on it goes nowhere.
  assert.equal(attrs("entry-3"), "");
  assert.equal(attrs("entry-0"), "");
  assert.notEqual(attrs("entryish-3"), "", "only the adapter's own prefix is refused");
});

test("the agent name falls back to the id rather than to nothing", () => {
  const named = needsYouCardAttrs({ kind: "widget", agentId: "w-3", entryId: "e-1", agentName: "Titan", title: "t" });
  const unnamed = needsYouCardAttrs({ kind: "widget", agentId: "w-3", entryId: "e-1", title: "t" });
  assert.equal(attrOf("data-agent", named), "Titan");
  assert.equal(attrOf("data-agent", unnamed), "w-3", "an id is a true identifier; an empty attribute is not");
});

test("every value is escaped, so a title with a quote cannot end the attribute", () => {
  const out = needsYouCardAttrs({
    kind: "widget", agentId: "w-1", entryId: "e-1", agentName: 'Ti"tan',
    title: '"><img src=x onerror=alert(1)>',
  });
  assert.doesNotMatch(out, /<img/, "no tag survives into the markup");
  assert.equal(attrOf("data-title", out), "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(attrOf("data-agent", out), "Ti&quot;tan");
});

// ---- the decision card ----------------------------------------------------------------------------

const decision = (over = {}) => ({
  id: "e-42", type: "decision", authorId: "w-3", authorName: "Titan",
  card: { kind: "widget", title: "Which branch?", detail: "", options: ["main", "gb"], ...over.card },
  ...over,
});

test("a pending decision card is marked with the entry the relay would key it on", () => {
  const out = decisionMarkup(decision());
  assert.equal(attrOf("data-needs-you-card", out), "w-3:e-42");
  assert.equal(attrOf("data-card-kind", out), "widget");
  assert.equal(attrOf("data-agent", out), "Titan");
  assert.equal(attrOf("data-title", out), "Which branch?");
  assert.equal(attrOf("data-href", out), "/?agent=w-3&amp;entry=e-42");
});

test("the other three decision kinds are marked too", () => {
  for (const kind of ["auto-review", "local-tool", "secret"]) {
    const out = decisionMarkup(decision({ card: { kind, title: `A ${kind}`, field: "apiKey", options: [] } }));
    assert.equal(attrOf("data-card-kind", out), kind);
    assert.equal(attrOf("data-needs-you-card", out), "w-3:e-42");
  }
});

test("a decision a person has already dealt with carries nothing", () => {
  const settled = ["approved", "denied", "answered", "dismissed", "provided", "closed_by_host"];
  for (const status of settled) {
    const out = decisionMarkup(decision({ card: { kind: "widget", title: "Which branch?", status, options: [] } }));
    assert.doesNotMatch(out, /data-needs-you-card/, `a ${status} card is not waiting on anyone`);
  }
  const sending = decisionMarkup(decision({ card: { kind: "widget", title: "Which branch?", status: "sending", options: [] } }));
  assert.doesNotMatch(sending, /data-needs-you-card/, "an answer in flight is not a question");
  const savedSecret = decisionMarkup(decision({ card: { kind: "secret", title: "A credential", status: "provided", field: "apiKey", options: [] } }));
  assert.doesNotMatch(savedSecret, /data-needs-you-card/, "the collapsed secret card is done");
});

test("a decision drawn in a conversation the page cannot name carries nothing", () => {
  const was = open_;
  try {
    for (const id of ["agent", "you", ""]) {
      open_ = { kind: "worker", id };
      assert.doesNotMatch(decisionMarkup(decision()), /data-needs-you-card/, `a card on "${id}" would link nowhere`);
    }
  } finally { open_ = was; }
  const noEntry = decisionMarkup(decision({ id: "entry-4" }));
  assert.doesNotMatch(noEntry, /data-needs-you-card/);
});

test("the decision card names the CONVERSATION, so a card raised in a room opens the room", () => {
  // The relay reads one transcript tail per row of listAgents, and a room is a row: the card it makes
  // out of an entry in a room's tail carries the ROOM's id. The page's own fallbacks are both wrong
  // here -- the entry's author is the member agent that raised it, and the first member is whoever
  // happens to be first -- so the conversation is the only value that opens the card where it is.
  const was = open_, wasName = openName;
  try {
    open_ = { kind: "room", id: "room-42" };
    openName = "The build room";
    const out = decisionMarkup(decision({ authorId: "w-9", authorName: "Books" }));
    assert.equal(attrOf("data-needs-you-card", out), "room-42:e-42", "the room, not the member that spoke");
    assert.equal(attrOf("data-agent", out), "The build room");
    assert.equal(attrOf("data-href", out), "/?agent=room-42&amp;entry=e-42");
  } finally { open_ = was; openName = wasName; }
});

// ---- the hand-off card ------------------------------------------------------------------------------

const handoffEntry = (resolution) => ({
  id: "e-9", type: "handoff",
  handoff: { requestId: "req-7", instruction: "Sign in to the vendor portal as super_admin, then hand back", resolution },
});
const live = { requestId: "req-7", instruction: "Sign in to the vendor portal as super_admin, then hand back" };
const handoffView = { live, agentId: "w-3", agentName: "Titan", contextId: "w-3" };

test("a pending hand-off is marked on the entry, not on the request id", () => {
  const out = handoffCardMarkup(handoffEntry(null), true, handoffView);
  assert.match(out, /data-state="pending"/);
  // The relay keys a hand-off card on the transcript entry it is stamped on and carries requestId
  // beside it, so an id built out of req-7 would collapse against nothing.
  assert.equal(attrOf("data-needs-you-card", out), "w-3:e-9");
  assert.equal(attrOf("data-card-kind", out), "box-handoff");
  assert.equal(attrOf("data-href", out), "/?agent=w-3&amp;entry=e-9");
});

test("the hand-off's title is the relay's fixed sentence and never the agent's instruction", () => {
  const out = handoffCardMarkup(handoffEntry(null), true, handoffView);
  assert.equal(attrOf("data-title", out), "Take the keyboard for Titan");
  // Rule 5. The card SHOWS the instruction, because a person reading the console asked for it. A
  // shell copying what it saw onto a lock screen is the exact thing push-edge refuses to do.
  assert.doesNotMatch(out, /data-title="[^"]*vendor portal/, "the instruction never lands in data-title");
  assert.match(out, /data-handoff-instruction[^>]*>[^<]*vendor portal/, "and it is still on screen where it belongs");
  const nameless = handoffCardMarkup(handoffEntry(null), true, { live, agentId: "w-3", contextId: "w-3" });
  assert.equal(attrOf("data-title", nameless), "Take the keyboard for your agent", "the relay's own fallback wording");
});

test("a hand-off that is over carries nothing", () => {
  // A resolution only decides the state once the LIVE record is gone: while the host still holds a
  // pending request for this entry the card is pending whatever the entry says, which is the whole
  // point of boxHandoffState taking both.
  const over = { live: null, agentId: "w-3", agentName: "Titan", contextId: "w-3" };
  for (const [resolution, state] of [["handed_back", "done"], ["completed", "done"], ["dismissed", "skipped"], ["cancelled", "skipped"]]) {
    const out = handoffCardMarkup(handoffEntry(resolution), true, over);
    assert.match(out, new RegExp(`data-state="${state}"`));
    assert.doesNotMatch(out, /data-needs-you-card/, `a ${state} hand-off is not waiting on anyone`);
  }
  // And a resolved entry whose live record is still standing IS pending, and is marked.
  const stillLive = handoffCardMarkup(handoffEntry("handed_back"), true, handoffView);
  assert.match(stillLive, /data-state="pending"/);
  assert.equal(attrOf("data-needs-you-card", stillLive), "w-3:e-9");
  // No live record and no resolution: the host forgot the request. The card says so and offers no
  // buttons, so it must not be in a shell's queue either.
  const closed = handoffCardMarkup(handoffEntry(null), true, { live: null, agentId: "w-3", agentName: "Titan", contextId: "w-3" });
  assert.match(closed, /data-state="closed"/);
  assert.doesNotMatch(closed, /data-needs-you-card/);
});

test("the page hands the agent name to the hand-off card, or the fixed sentence has no name in it", () => {
  const view = codeOnly(span("  function boxHandoffView(message) {", "  function boxHandoffTeardown(", "boxHandoffView"));
  assert.match(view, /agentName:\s*lead\?\.name/, "boxHandoffView carries the roster name through");
  // And the conversation, which is not `agentId`: in a room `agentId` is the lead member, which is who
  // the hand-off commands are addressed to and is not where this card is drawn.
  assert.match(view, /contextId:\s*activeContext\(\)\.id/, "boxHandoffView carries the conversation through");
});

// ---- the report card ---------------------------------------------------------------------------------

const offer = (over = {}) => ({
  id: "offer-1", agentId: "w-3", agentName: "Titan", pendingId: "rep-5",
  tier: "quality", category: "console", title: "A tool kept failing",
  body: "what happened", note: "", status: "pending", ...over,
});

test("a report the box already holds is marked on the row id the relay uses", () => {
  const out = reportCardMarkup(offer());
  assert.equal(attrOf("data-needs-you-card", out), "w-3:rep-5");
  assert.equal(attrOf("data-card-kind", out), "report");
  assert.equal(attrOf("data-title", out), "A tool kept failing");
  assert.equal(attrOf("data-href", out), "/?agent=w-3&amp;entry=rep-5");
});

test("a page-local report offer carries nothing, because the relay never pushes it", () => {
  const out = reportCardMarkup(offer({ pendingId: null }));
  assert.doesNotMatch(out, /data-needs-you-card/);
  assert.match(out, /problem-report-card/, "it is still the same card on screen");
});

test("a settled or sending report carries nothing", () => {
  for (const status of ["sending", "sent", "dropped"]) {
    const out = reportCardMarkup(offer({ status }));
    assert.doesNotMatch(out, /data-needs-you-card/, `a ${status} report is not a question`);
  }
});

// ---- the two static hooks, and the count ---------------------------------------------------------------

test("the talk button carries the hook in the markup, not from a script", () => {
  const line = html.split("\n").find((row) => row.includes("data-voice-talk"));
  assert.ok(line, "index.html no longer has a talk button");
  assert.match(line, /data-talk-button/, "the same element carries both");
  // Static, so the shell's hotkey finds it before voice.js boots and while probe() has it disabled.
  // Today none of the shell's other four selectors match: its aria-label check is an exact match
  // and this button's label is "Talk to your agent".
  // Counted on the markup with the comments taken out: the comment above the button names the
  // attribute, and a hook named in prose is not a second button.
  const markupOnly = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(markupOnly.split("data-talk-button").length - 1, 1, "exactly one talk button on the page");
});

test("the count slot is still in the static markup and the render writes the number into it", () => {
  assert.match(html, /data-needs-you-count/, "the slot stays where tests/awaiting-operator.test.mjs pins it");
  const render = codeOnly(grab("renderNeedsYouCount"));
  assert.match(render, /slot\.dataset\.needsYouCount = String\(count\)/, "the number goes into the attribute");
  // Unconditionally, INCLUDING zero. The shell reads the attribute first, the text second, and
  // falls through to "how many elements matched" third; a hidden pill with an empty attribute and
  // empty text made that fall-through return 1 on a quiet console.
  const line = render.split("\n").find((row) => row.includes("slot.dataset.needsYouCount"));
  assert.doesNotMatch(line, /[?]|count === 0|count > 0/, "the write is unconditional -- zero is a number a shell needs");
  // The only guard in front of it is the one that says the slot is not on the page at all.
  const before = render.slice(0, render.indexOf("slot.dataset.needsYouCount"));
  assert.deepEqual(
    before.split("\n").filter((row) => /\bif\s*\(/.test(row)).map((row) => row.trim()),
    ["if (!slot) return;"],
    "nothing else decides whether the number is written",
  );
  assert.ok(render.indexOf("slot.dataset.needsYouCount") < render.indexOf("slot.hidden"), "the number lands before the pill is hidden");
  assert.match(render, /slot\.hidden = count === 0/, "and the pill still says nothing at zero");
});

// ---- what must not happen -------------------------------------------------------------------------------

test("the rail hand-off and the skill card are never marked, so nothing is counted twice", () => {
  const rail = codeOnly(grab("renderHandoffRail"));
  assert.doesNotMatch(rail, /needsYouCardAttrs/, "the rail redraws the same hand-off; marking both doubles every open one");
  const special = codeOnly(span("  function specialMessageMarkup(message) {", "  // What the claim-provenance check is", "specialMessageMarkup"));
  assert.doesNotMatch(special, /needsYouCardAttrs/, "the skill draft is not one of the six kinds");
});

test("the helper is called from exactly the three card paths", () => {
  const calls = codeOnly(source).split("needsYouCardAttrs(").length - 1;
  // One declaration plus three call sites.
  assert.equal(calls, 4, "decisionMarkup, handoffCardMarkup and reportCardMarkup, and nowhere else");
});

test("the fixed sentence this page writes is the one push-edge sends", () => {
  // If push-edge ever rewords the hand-off title, this catches the doc and the card drifting apart.
  assert.equal(CARD_BODY["box-handoff"], "Open it to read what it needs done.", "the six bodies are still push-edge's");
  const card = codeOnly(grab("handoffCardMarkup"));
  assert.match(card, /Take the keyboard for \$\{String\(agentName\)\.trim\(\) \|\| "your agent"\}/, "word for word with push-edge.mjs");
  assert.doesNotMatch(card, /title:\s*instruction/, "the instruction is never the title");
});
