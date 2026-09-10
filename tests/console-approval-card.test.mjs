// COMMAND-CARD-1. The auto-review approval card, in the shape Jason kept a screenshot of.
//
// WHAT THE CARD USED TO BE, measured on grok-bot-local-vm in a real browser on 2026-09-10 at 16:05
// UTC against a genuinely forced shell approval: a 498x132 box reading "Echo hello-from-rac in shell
// on Grok Bot's computer | Violates the instruction to ask the user before running any shell
// command. — echo hello-from-rac | Approve | Deny". No pill, no line saying whose computer it runs
// on, no disclosure, no elision, no always-allow, and the dead upstream's name on a customer's
// screen. Once answered it collapsed to the title plus "You approved this", so a person had no way
// to see afterwards what it was they had allowed.
//
// Everything below is evaluated out of the SHIPPED file. app.js has no build step, so a helper
// deleted out from under a call site parses fine and dies on the first render; slicing the real
// source is the only thing here that would notice. The slicing shape is the one
// tests/console-needs-you-attributes.test.mjs established: a function declared at two-space indent
// and closed by a lone two-space brace, and the run of helpers between DECISION_ACTIONS and
// decisionMarkup taken whole.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
const styles = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
const adapterSource = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");

// The page's own escaper, character for character (app.js). A markup check against a different
// escaper proves nothing about what the browser is handed.
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

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

const markup = (() => {
  // DECISION_ACTIONS, the secret custody helpers, every approval helper and needsYouCardAttrs, in
  // one run of real source. The conversation and the page's failure sink come in as stubs, because
  // they are wiring; everything that decides a WORD on the card is the shipped code.
  const helpers = span("  const DECISION_ACTIONS = {", "  function decisionMarkup(", "the decision helpers");
  const built = new Function(
    "escapeHtml", "adapter", "activeContext", "contextName",
    [helpers, grab("decisionMarkup"), "return { decisionMarkup, approvalCardMarkup, approvalCommandShown, approvalRequestSentence, cardPushTitle, DECISION_ACTIONS };"].join("\n"),
  );
  return built(escapeHtml, { dismissCard: () => {}, submitSecretRequest: () => {} }, () => ({ kind: "worker", id: "w-3" }), () => "Titan");
})();

const { decisionMarkup, approvalCommandShown, approvalRequestSentence, DECISION_ACTIONS } = markup;

// One approval entry in the shape gateway-adapter.js's cardOf builds it, defaults taken from the
// approval really forced on grok-bot-local-vm.
const approval = (over = {}) => ({
  id: "e-42",
  type: "decision",
  authorId: "w-3",
  authorName: "Titan",
  card: {
    kind: "auto-review",
    requestId: "e35bcac5-8f10-4c22-8137-cc4480d1b1ed",
    status: "pending",
    title: "Echo hello-from-rac in shell on Grok Bot's computer",
    detail: "",
    command: "echo hello-from-rac",
    reason: "Violates the instruction to ask the user before running any shell command.",
    surface: "box_shell",
    rule: null,
    options: [],
    ...over,
  },
});
const draw = (over = {}, allow = []) => decisionMarkup(approval(over), allow);
const attrOf = (name, text) => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(text);
  return match ? match[1] : null;
};
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// ---- the four pill states -------------------------------------------------------------------

test("a pending card asks in the person's words and carries the amber pill", () => {
  const out = draw();
  assert.match(out, /<span class="status-pill attention" data-approval-pill>Needs your yes<\/span>/);
  assert.equal(attrOf("data-approval-state", out), "pending");
  assert.match(out, /--card-accent:var\(--amber-500\)/);
});

test("approved by hand is Allowed once; approved under a saved rule is Always allowed", () => {
  const rule = "Allow echo commands in the box shell";
  // No rule proposed at all: the person said yes to this one thing.
  assert.match(draw({ status: "approved" }), /status-pill success" data-approval-pill>Allowed once</);
  // A rule was proposed but is NOT in the settings, so nothing standing decided this.
  assert.match(draw({ status: "approved", rule }), /data-approval-pill>Allowed once</);
  // The same rule, now saved in the person's Auto-review settings.
  assert.match(draw({ status: "approved", rule }, [rule]), /data-approval-pill>Always allowed</);
  // Whitespace either side is the same rule; a saved list is written by a person and by us.
  assert.match(draw({ status: "approved", rule }, ["  " + rule + "  "]), /data-approval-pill>Always allowed</);
  // A different rule on the list is not this rule.
  assert.match(draw({ status: "approved", rule }, ["Allow anything at all"]), /data-approval-pill>Allowed once</);
});

test("only a refusal reads Refused; a card the host closed says the host closed it", () => {
  // "expired" is the HOST's own word and the host writes it in bulk:
  // expireAllPendingAutoReviewApprovalCards() runs at host start, so a bundle swap, a restart, a
  // session end, a settings change or a cancel turns every unanswered card in a transcript into one.
  // Reading that back as "Refused" tells a person they did something they never did -- and this
  // wave's own ship, updateHostNow inside two boxes, would have rewritten their pending cards.
  const denied = draw({ status: "denied" });
  assert.match(denied, /status-pill muted" data-approval-pill>Refused</);
  assert.doesNotMatch(denied, /approval-closed/, "a refusal was answered, by them");
  for (const status of ["expired", "error", "cancelled", "timeout"]) {
    const out = draw({ status });
    assert.match(out, /status-pill muted" data-approval-pill>No longer waiting</, `${status} does not claim a refusal`);
    assert.doesNotMatch(out, />Refused</, `${status} is not a refusal`);
    assert.match(out, /<p class="approval-closed">The host closed this without an answer\.<\/p>/,
      `${status} says in words what happened, the way the sibling card kinds do`);
  }
  for (const status of ["denied", "expired"]) {
    assert.match(draw({ status }), /--card-accent:var\(--stone-500\)/, `${status} is not painted as an approval`);
  }
  // An answered card claims nothing of the sort, and neither does a pending one.
  assert.doesNotMatch(draw({ status: "approved" }), /approval-closed/);
  assert.doesNotMatch(draw(), /approval-closed/);
});

test("the answer in flight drops the host's location clause too", () => {
  // card.status "sending" is held for a whole round trip on Allow and Refuse and for three
  // sequential gateway calls on Always allow, so it is a screen a person reads. It used to print
  // card.title raw, which is the one string the rest of this card exists to clean up.
  const out = draw({ status: "sending" });
  assert.match(out, /<strong>Echo hello-from-rac in shell<\/strong>/);
  assert.match(out, /Sending your answer/);
  assert.doesNotMatch(out, /Grok Bot/, "the dead upstream's name is on no state of this card");
});

test("the dead upstream's name is on none of the states, drawn or in flight", () => {
  for (const status of ["pending", "approved", "denied", "expired", "sending"]) {
    assert.doesNotMatch(draw({ status }), /Grok Bot/, `${status} keeps the old product's name off the screen`);
  }
  // The subagent summary, which writes the location mid-sentence rather than at the end.
  assert.doesNotMatch(
    draw({ surface: "subagent", title: "Run a task on Grok Bot's computer: “check the mail”" }),
    /Grok Bot/,
    "including the one summary whose location clause is not at the end",
  );
});

// ---- the title, and the dead vendor's name --------------------------------------------------

test("the title says what the agent wants in plain words, never a surface token", () => {
  const titleOf = (surface) => text(/<strong>([\s\S]*?)<\/strong>/.exec(draw({ surface }))[1]);
  assert.equal(titleOf("box_shell"), "Titan wants to run a command");
  assert.equal(titleOf("host_shell"), "Titan wants to run a command");
  assert.equal(titleOf("mcp"), "Titan wants to use a connector");
  assert.equal(titleOf("computer"), "Titan wants to use the computer");
  assert.equal(titleOf("browser"), "Titan wants to use the browser");
  assert.equal(titleOf("automation_write"), "Titan wants to change a routine");
  assert.equal(titleOf("cloud_agent"), "Titan wants to run a cloud agent");
  assert.equal(titleOf("subagent"), "Titan wants to start a task");
  // A surface this console has never heard of still gets a sentence rather than a raw token.
  assert.equal(titleOf("something_new"), "Titan wants your review");
  assert.equal(titleOf(null), "Titan wants your review");
  // And an entry with no author name says something rather than nothing.
  const nameless = decisionMarkup({ ...approval(), authorName: "" }, []);
  assert.match(nameless, /<strong>your agent wants to run a command<\/strong>/);
});

test("the host's 'on X's computer' clause never reaches the title, the request or a lock screen", () => {
  // The host hardcodes the old product's name into approval.summary in five places
  // (source/host/runner/sand-auto-review-summaries.ts) and that summary is what a push notification
  // puts on a lock screen. The clause is the grey line's job on this card, so it comes off here.
  const out = draw();
  assert.doesNotMatch(out, /Grok Bot/, "the dead upstream's name is not on a customer's screen");
  assert.match(out, /<p class="approval-request">Echo hello-from-rac in shell<\/p>/);
  assert.equal(attrOf("data-title", out), "Echo hello-from-rac in shell");
  // Both wordings the host writes, wherever it writes them, because it is always a location.
  assert.equal(approvalRequestSentence({ title: "Run a command on your local computer" }), "Run a command");
  assert.equal(approvalRequestSentence({ title: "Post an alert to Jason on Titan's computer." }), "Post an alert to Jason");
  // Mid-sentence too, because the subagent surface writes it there:
  // sand-auto-review-summaries.ts line 249 writes `Run a task on Grok Bot's computer: “<instruction>”`,
  // so an end-anchored strip left the vendor's name in the request line of that one card kind.
  assert.equal(
    approvalRequestSentence({ title: "Run a task on Grok Bot's computer: “check the mail”" }),
    "Run a task: “check the mail”",
  );
  assert.equal(
    approvalRequestSentence({ title: "Run a task on Titan's computer: “tidy the inbox”" }),
    "Run a task: “tidy the inbox”",
  );
  // And the working directory, which the host writes AFTER the clause on the commonest card there is:
  // describeSandShellAutoReviewAction builds `<what> <location> from <cwd>` whenever the agent passed
  // a cwd, so a strip that only looked at the end of the sentence, or only for a colon or a comma,
  // left the vendor's name on every shell approval that ran somewhere in particular.
  assert.equal(
    approvalRequestSentence({ title: "Echo hello-from-rac in shell on Grok Bot's computer from /home/sem/work" }),
    "Echo hello-from-rac in shell from /home/sem/work",
  );
  assert.equal(
    approvalRequestSentence({ title: "Run a command on Grok Bot's computer from /workspace" }),
    "Run a command from /workspace",
  );
  assert.equal(
    approvalRequestSentence({ title: "Run a command on your local computer from /Users/sem" }),
    "Run a command from /Users/sem",
  );
  // A comma is the same shape. Anything else keeps its words, since only a location comes off.
  assert.equal(approvalRequestSentence({ title: "Do a thing on Titan's computer, quietly" }), "Do a thing, quietly");
  assert.equal(approvalRequestSentence({ title: "Walk on Titan's computer floor" }), "Walk on Titan's computer floor");
  // And a summary that is only the clause still leaves a sentence behind.
  assert.equal(approvalRequestSentence({ title: "" }), "This action needs your review");
});

test("the grey line names the person's own computer for a host shell and the agent's for the rest", () => {
  assert.match(draw({ surface: "host_shell" }), /<p class="approval-where">Runs on your computer<\/p>/);
  assert.match(draw({ surface: "box_shell" }), /<p class="approval-where">Runs on Titan&#039;s computer<\/p>/);
  assert.match(draw({ surface: "computer" }), /<p class="approval-where">Runs on Titan&#039;s computer<\/p>/);
});

// ---- the disclosure -------------------------------------------------------------------------

test("the command sits behind a Show the command disclosure, in every state", () => {
  for (const status of ["pending", "approved", "denied", "expired"]) {
    const out = draw({ status });
    assert.match(out, /<details class="tool-receipt approval-command">/, `${status} keeps the command`);
    assert.match(out, /Show the command/);
    assert.match(out, /Hide the command/);
    assert.match(out, /<pre>echo hello-from-rac<\/pre>/, `${status} shows the command itself`);
  }
});

test("a card with no command draws no disclosure at all", () => {
  for (const command of [null, "", undefined]) {
    const out = draw({ command });
    assert.doesNotMatch(out, /approval-command/, "nothing to disclose, so no control that opens onto nothing");
    assert.doesNotMatch(out, /Show the command/);
  }
});

test("the disclosure elides at 400 characters and counts the real remainder", () => {
  const command = "x".repeat(753);
  const shown = approvalCommandShown(command);
  assert.match(shown, /\.\.\.\[353 chars omitted\]\.\.\./, "the original's own words and the true count");
  // What is SHOWN is the cap; the count is everything else, so the two add back up to the command.
  const kept = shown.replace(/\n\.\.\.\[\d+ chars omitted\]\.\.\.\n/, "");
  assert.equal(kept.length, 400);
  assert.equal(kept.length + 353, command.length);
  // Head and tail, not a truncation: the end of a long command is where the interesting argument is.
  assert.equal(shown.slice(0, 200), command.slice(0, 200));
  assert.equal(shown.slice(-200), command.slice(-200));
  assert.ok(draw({ command }).includes("[353 chars omitted]"));
});

test("a command at or under the cap is shown whole, with nothing counted", () => {
  for (const length of [1, 399, 400]) {
    const command = "y".repeat(length);
    assert.equal(approvalCommandShown(command), command, `${length} characters is under the cap`);
    assert.doesNotMatch(draw({ command }), /chars omitted/);
  }
});

test("a command carrying markup cannot break out of the block", () => {
  const out = draw({ command: `curl "https://x/?a=1&b=2" && echo "<script>alert(1)</script>"` });
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&amp;&amp; echo/);
});

// ---- the rule, and the button that writes it -------------------------------------------------

test("no proposed rule means no rule paragraph and no Always allow button", () => {
  // The approval really forced on grok-bot-local-vm had no proposedRule, and most do not. A button
  // that would have nothing to save is worse than a button that is not there.
  const out = draw({ rule: null });
  assert.doesNotMatch(out, /approval-rule/);
  assert.doesNotMatch(out, /Always allow/);
  assert.match(out, /data-decide="approved"[^>]*>✓ Allow</);
  assert.match(out, /data-decide="denied"[^>]*>✕ Refuse</);
});

test("a proposed rule offers Always allow, and says what pressing it would do", () => {
  const out = draw({ rule: "Allow echo commands in the box shell" });
  assert.match(out, /data-decide="always"[^>]*>↗ Always allow</);
  assert.match(out, /<p class="approval-rule">Always allow adds this rule to your Auto-review settings: “Allow echo commands in the box shell”<\/p>/);
  assert.doesNotMatch(out, /was added to your Auto-review settings/, "not past tense until it is true");
});

test("once the rule is saved the card names it back in the original's words", () => {
  const rule = "Allow echo commands in the box shell";
  const out = draw({ status: "approved", rule }, [rule]);
  assert.match(out, /<p class="approval-rule">A rule always allowing this was added to your Auto-review settings: “Allow echo commands in the box shell”<\/p>/);
});

test("a settled card whose rule was never saved claims no standing rule", () => {
  const out = draw({ status: "denied", rule: "Allow echo commands in the box shell" }, []);
  assert.doesNotMatch(out, /approval-rule/, "a refused card did not add anything to anybody's settings");
  assert.match(out, /<pre>echo hello-from-rac<\/pre>/, "but the command it refused is still readable");
});

test("the settled branches keep the request, the command and the rule", () => {
  const rule = "Allow echo commands in the box shell";
  const out = draw({ status: "approved", rule }, [rule]);
  assert.match(out, /Echo hello-from-rac in shell/, "what was allowed");
  assert.match(out, /echo hello-from-rac/, "the command that ran");
  assert.match(out, /A rule always allowing this/, "the standing rule it granted");
  assert.doesNotMatch(out, /You approved this/, "the line that replaced all three is gone");
});

// ---- the reason, the controls and the needs-you contract --------------------------------------

test("the reason is shown while it is still a question and not afterwards", () => {
  assert.match(draw(), /<p class="approval-why">Violates the instruction to ask the user before running any shell command.<\/p>/);
  for (const status of ["approved", "denied", "expired"]) {
    assert.doesNotMatch(draw({ status }), /approval-why/, `a ${status} card does not re-litigate the answer`);
  }
});

test("the controls exist only while the card is pending", () => {
  assert.match(draw(), /<div class="inline-card-actions">/);
  for (const status of ["approved", "denied", "expired"]) {
    assert.doesNotMatch(draw({ status }), /data-decide=/, `a ${status} card offers no buttons`);
  }
});

test("every button carries the entry id the transcript's one click handler reads", () => {
  const out = draw({ rule: "Allow echo commands in the box shell" });
  const buttons = [...out.matchAll(/data-decide="([^"]+)" data-message-id="([^"]+)"/g)];
  assert.deepEqual(buttons.map((m) => m[1]), ["approved", "always", "denied"]);
  for (const match of buttons) assert.equal(match[2], "e-42");
});

test("the needs-you attributes stay on the pending card and nowhere else", () => {
  const out = draw();
  assert.equal(attrOf("data-needs-you-card", out), "w-3:e-42");
  assert.equal(attrOf("data-card-kind", out), "auto-review");
  assert.equal(attrOf("data-agent", out), "Titan");
  assert.equal(attrOf("data-href", out), "/?agent=w-3&amp;entry=e-42");
  for (const status of ["approved", "denied", "expired", "sending"]) {
    assert.doesNotMatch(draw({ status }), /data-needs-you-card/, `a ${status} card is not waiting on anyone`);
  }
});

// ---- the wiring behind the card ----------------------------------------------------------------

test("the adapter carries the command, the reason and the surface as their own fields", () => {
  // They used to be joined into one `detail` string, which is why the card could draw neither the
  // reason as its own line nor the command inside a disclosure.
  const branch = adapterSource.slice(adapterSource.indexOf('m.type === "auto-review-approval"'));
  const card = branch.slice(0, branch.indexOf("};"));
  assert.match(card, /command: m\.approval\.command \?\? null/);
  assert.match(card, /reason: m\.approval\.reason \?\? null/);
  assert.match(card, /surface: m\.approval\.surface \?\? null/);
  assert.match(card, /detail: \[m\.approval\.reason, m\.approval\.command\]/, "the joined string stays for anything still reading it");
});

test("Always allow is a settings write and only then an approve, and never the other way round", () => {
  // The host's vocabulary is approved|denied and nothing else, so always-allow cannot be a
  // resolution. The order matters: approving first and failing to save would grant the action while
  // quietly dropping the standing permission the person actually asked for.
  const start = adapterSource.indexOf('if (card.kind === "auto-review" && decision === "always")');
  assert.notEqual(start, -1, "the adapter no longer has an always branch");
  const branch = adapterSource.slice(start, adapterSource.indexOf('if (card.kind === "auto-review") return sent(', start));
  assert.ok(branch.indexOf('call("getHostSettings")') < branch.indexOf('call("setHostSettings"'), "read the live instructions first");
  assert.ok(branch.indexOf('call("setHostSettings"') < branch.indexOf('call("resolveAutoReviewApproval"'), "save the rule before approving");
  assert.match(branch, /resolution: "approved"/);
  assert.match(branch, /card\.status = "pending"/, "a failure leaves the card answerable");
  assert.match(branch, /if \(rule\.length === 0\)/, "no rule, nothing to save, no silent approve");
});

test("the stylesheet toggles the disclosure's two words without a script", () => {
  // The transcript wipes its own innerHTML on every render, so a handler bound to this element would
  // not survive one poll. <details> and two rules do the whole job.
  assert.match(styles, /\.approval-command \.approval-more-hide,\s*\n\.approval-command\[open\] \.approval-more-show \{ display: none; \}/);
  assert.match(styles, /\.approval-command\[open\] \.approval-more-hide \{ display: inline; \}/);
});

test("nothing on this card is painted in the error colour", () => {
  // host-notes-read-as-errors: a red line under a reply is read as a failure, and an approval that
  // is merely waiting is not one. The card's states are the amber, green and grey the console
  // already uses for exactly these three meanings.
  const block = styles.slice(styles.indexOf("/* -- COMMAND-CARD-1"), styles.indexOf(".message-status {"));
  assert.doesNotMatch(block, /--danger|--red|#f0a6a8|status-pill bad/);
  assert.ok(block.includes(".approval-request"), "the block really is the card's own rules");
});

test("the auto-review row is Allow, Always allow and Refuse, and the local-tool row is untouched", () => {
  assert.deepEqual(DECISION_ACTIONS["auto-review"].map(([value, label]) => [value, label]), [
    ["approved", "✓ Allow"], ["always", "↗ Always allow"], ["denied", "✕ Refuse"],
  ]);
  assert.deepEqual(DECISION_ACTIONS["local-tool"].map(([value]) => value), ["allow-once", "always", "deny"]);
});
