// HANDBACK-1, the console half. A request_box_help hand-off is one durable transcript entry
// (boxRequestId / boxInstruction / boxResolution) plus the host's live pending record, which
// reaches this page as the open agent's `handoff`. The card's state is f(resolution, live), and
// what is pinned here is every way those two can disagree -- because they DO disagree in the two
// cases that matter: a host restart loses the live record while the entry is unresolved, and a
// second request silently resolves the first entry as dismissed.
//
// Everything below is evaluated out of the shipped files. app.js has no build step, so a function
// deleted out from under a call site parses fine and dies on the first click; slicing the real
// source is the only thing here that would notice.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A "this string is not in there" assertion has to run on the code, not on the prose around it:
// every one of these functions carries a comment naming the thing it must not do.
const codeOnly = (text) => text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

// handoffCardMarkup and the state function it leans on, sliced out of app.js and evaluated on
// their own. Both are declared at two-space indent and close with a lone two-space brace, which is
// what makes this possible at all.
async function loadCard() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const stateStart = source.indexOf("  function boxHandoffState(");
  assert.notEqual(stateStart, -1, "app.js no longer decides the hand-off state");
  const stateBody = source.slice(stateStart, source.indexOf("\n  }\n", stateStart) + 4);
  const cardStart = source.indexOf("  function handoffCardMarkup(");
  assert.notEqual(cardStart, -1, "app.js no longer draws the hand-off card");
  const cardBody = source.slice(cardStart, source.indexOf("\n  }\n", cardStart) + 4);
  // CONSOLE-ATTR-1's helper, sliced in the same way, because the card now calls it. It is the real
  // one rather than a stub: what a shell reads off a pending hand-off is part of this card's contract.
  const hookStart = source.indexOf("  function needsYouCardAttrs(");
  assert.notEqual(hookStart, -1, "app.js no longer carries the needs-you card hook");
  const hookBody = source.slice(hookStart, source.indexOf("\n  }\n", hookStart) + 4);
  const dims = source.slice(source.indexOf("  const BOX_HANDOFF_THUMB_W"), source.indexOf("  const BOX_HANDOFF_THUMB_H") + 60);
  const fn = new Function(
    "escapeHtml", "message", "skipSupported", "view",
    `${dims}\n${stateBody}\n${hookBody}\n${cardBody}\nreturn handoffCardMarkup(message, escapeHtml, skipSupported, view);`,
  );
  return (message, skipSupported = true, view = {}) => fn(escapeHtml, message, skipSupported, view);
}

const card = await loadCard();
const entry = (resolution) => ({
  id: "e-1", type: "handoff",
  handoff: { requestId: "req-7", instruction: "Sign in to clientsync.dev as super_admin, then hand back", resolution },
});
const live = { requestId: "req-7", instruction: "Sign in to clientsync.dev as super_admin, then hand back" };

// -- the four states ---------------------------------------------------------------------------

test("a live hand-off for this entry is Action needed, with all three controls", async () => {
  const html = card(entry(null), true, { live, agentId: "a-1" });
  assert.match(html, /data-state="pending"/);
  assert.match(html, /data-handoff-pill[^>]*>.*Action needed/s);
  assert.match(html, /data-handoff-action="take-over"/);
  assert.match(html, /data-handoff-action="done"/);
  assert.match(html, /data-handoff-action="skip"/);
  assert.doesNotMatch(html, /data-handoff-action="open"/);
  // Every control carries both ids, so a click knows whose screen and which request it is about
  // without reading anything off the page around it.
  for (const action of ["take-over", "done", "skip"]) {
    const button = new RegExp(`data-handoff-action="${action}"[^>]*data-agent-id="a-1"[^>]*data-request-id="req-7"`);
    assert.match(html, button, `${action} lost its ids`);
  }
});

test("handed_back with no live record is Done, and the only control is Open computer", async () => {
  const html = card(entry("handed_back"), true, { live: null, agentId: "a-1" });
  assert.match(html, /data-state="done"/);
  assert.match(html, /data-handoff-pill[^>]*>Done</);
  assert.match(html, /data-handoff-action="open"[^>]*>.*Open computer/s);
  assert.doesNotMatch(html, /data-handoff-action="(take-over|done|skip)"/);
});

test("dismissed with no live record is Skipped, never Done", async () => {
  const html = card(entry("dismissed"), true, { live: null, agentId: "a-1" });
  assert.match(html, /data-state="skipped"/);
  assert.match(html, /data-handoff-pill[^>]*>Skipped</);
  assert.match(html, /data-handoff-action="open"/);
});

// The words the OLD path wrote, when a skip and a done were indistinguishable on disk:
// handBackForeverBox {trigger:"cancel"} stamped "cancelled" and resumed the agent with the
// handed-back prompt. Those rows are on Richard's box and the demo tenant already, so they are
// aliased read-side rather than migrated.
test("the rows already on disk are aliased, not misread", async () => {
  assert.match(card(entry("completed"), true, { live: null }), /data-state="done"/);
  assert.match(card(entry("cancelled"), true, { live: null }), /data-state="skipped"/);
});

// The escape hatch, and the reason it is not decoration. box-request-entries.ts resolves a prior
// entry as dismissed when a second request lands, a sidecar can be lost, and old rows carry words
// nobody set through this path. Without this state the card shows Action needed forever with
// buttons aimed at a host that has forgotten the request.
test("an unresolved entry the host no longer knows about says so in plain words", async () => {
  const html = card(entry(null), true, { live: null, agentId: "a-1" });
  assert.match(html, /data-state="closed"/);
  assert.match(html, /data-handoff-pill[^>]*>No longer waiting</);
  assert.match(html, /data-handoff-action="open"/);
  assert.doesNotMatch(html, /data-handoff-action="done"/);
  // Not "Status unavailable", and nothing that reads like a fault: the operator reads a status
  // line like that as an error under a reply that was in fact delivered.
  assert.doesNotMatch(html, /unavailable|error|failed/i);
});

test("a live hand-off for a DIFFERENT request does not make this entry pending", async () => {
  const html = card(entry("handed_back"), true, { live: { requestId: "req-9" }, agentId: "a-1" });
  assert.match(html, /data-state="done"/);
});

// -- the thumbnail plate -----------------------------------------------------------------------

test("the thumbnail is a fixed 390x244 plate whether or not a frame has landed", async () => {
  const empty = card(entry(null), true, { live, agentId: "a-1" });
  assert.match(empty, /class="handoff-thumb-frame" style="width:390px;height:244px"/);
  assert.match(empty, /Bringing the screen up/);
  const framed = card(entry(null), true, { live, agentId: "a-1", frame: "data:image/webp;base64,AAAA" });
  assert.match(framed, /class="handoff-thumb-frame" style="width:390px;height:244px"/);
  assert.match(framed, /<img class="handoff-thumb" data-handoff-thumb data-agent-id="a-1" data-request-id="req-7" width="390" height="244" src="data:image\/webp;base64,AAAA"/);
  assert.doesNotMatch(framed, /Bringing the screen up[^<]*<\/span>\s*<img[^>]*hidden/);
});

// The reader writes a frame INTO the img; drawing only a plate until the first one arrives left it
// with nowhere to put it, and the card stayed empty until an unrelated redraw rebuilt it. Measured
// on grok-bot-local-vm: the picture reached the rail tile in seconds and the card not at all inside
// a minute. So the img is in the markup from the first draw, hidden, with the plate behind it.
test("the card carries its image from the first draw, hidden, so a frame has somewhere to land", async () => {
  const empty = card(entry(null), true, { live, agentId: "a-1" });
  assert.match(empty, /<img class="handoff-thumb" data-handoff-thumb data-agent-id="a-1" data-request-id="req-7"[^>]*hidden/);
  assert.match(empty, /data-handoff-thumb-plate(?![^>]*hidden)/);
  const framed = card(entry(null), true, { live, agentId: "a-1", frame: "data:image/webp;base64,AAAA" });
  assert.match(framed, /data-handoff-thumb-plate hidden/);
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const paint = source.slice(source.indexOf("  function paintBoxHandoffFrame("), source.indexOf("\n  }\n", source.indexOf("  function paintBoxHandoffFrame(")));
  assert.match(paint, /img\.hidden = false/);
  assert.match(paint, /data-handoff-thumb-plate/);
  // [hidden] loses to a display rule, so the stylesheet has to say so for the img too.
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  assert.match(css, /\.handoff-thumb\[hidden\] \{\s*display: none;/);
});

test("a host that cannot say which screen this agent is on says so, and promises nothing", async () => {
  const html = card(entry(null), true, { live, agentId: "a-1", hasScreen: false });
  assert.match(html, /This computer did not say which screen this agent is on/);
  assert.doesNotMatch(html, /Bringing the screen up/);
});

// A finished step is not waiting for anything. The plate used to be chosen from hasScreen alone, so
// a done card in a browser that never captured a frame -- a reload, or an I'm done pressed inside
// the first three seconds -- read "Bringing the screen up" for ever under a pill saying Done.
// Measured in a fresh Chrome profile on 2026-09-08: both resolved cards on the R750 conversation
// said it, with no reader mounted and nothing coming.
test("a resolved card with no kept frame says so rather than promising a picture", async () => {
  for (const resolution of ["handed_back", "dismissed"]) {
    const html = card(entry(resolution), true, { live: null, agentId: "a-1" });
    assert.doesNotMatch(html, /Bringing the screen up/, `${resolution} still promises a picture`);
    assert.match(html, /No picture of this step was kept/);
  }
  // An entry nobody resolved and no live record is the fourth state, and it is finished too.
  const closed = card(entry(null), true, { live: null, agentId: "a-1" });
  assert.match(closed, /data-state="closed"/);
  assert.doesNotMatch(closed, /Bringing the screen up/);
});

test("a resolved card that DID keep a frame shows the frame, not a plate", async () => {
  const html = card(entry("handed_back"), true, { live: null, agentId: "a-1", frame: "data:image/webp;base64,AAAA" });
  assert.match(html, /data-handoff-thumb-plate hidden/);
  assert.match(html, /src="data:image\/webp;base64,AAAA"/);
});

// -- which screen the picture is of --------------------------------------------------------------
// The blocker this section exists for: the card and the rail tile drew display :1 for an agent that
// was working on display :5, under a caption naming that agent. Measured live on
// console.titanium.bot 2026-09-08 -- the thumbnail reader's src was /vnc/1/ while the desktop view
// Take over opened was /vnc/5/ and the box's own assignment file said 5. A person decided on the
// wrong screen, and the agent's next message disagreed with the picture.

async function loadSeat() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  const BOX_HANDOFF_SHARED_DISPLAY = 1;");
  assert.notEqual(start, -1, "app.js no longer resolves which screen a hand-off is about");
  const end = source.indexOf("  // What only the live page can answer", start);
  assert.ok(end > start, "the seat block moved; this slice needs re-reading rather than deleting");
  const body = source.slice(start, end).replace(/renderBoxHandoffSurfaces\(\);/g, "/* render */;");
  const fn = new Function(`${body}\nreturn { boxHandoffSeatOf, noteBoxHandoffSeat, boxHandoffScreenCaption, boxHandoffSeats };`);
  return fn();
}

test("an agent with a seat of its own is drawn on that seat, not on the shared one", async () => {
  const { boxHandoffSeatOf } = await loadSeat();
  assert.deepEqual(boxHandoffSeatOf({ id: "a-1", boxDisplay: null, boxSeat: 5 }), { display: 5, shared: false });
  // The live vncUrl answers it too, and agrees.
  assert.deepEqual(boxHandoffSeatOf({ id: "a-2", boxDisplay: 5, boxSeat: 5 }), { display: 5, shared: false });
});

test("no seat of its own is the shared screen, and it is captioned as the shared screen", async () => {
  const { boxHandoffSeatOf, boxHandoffScreenCaption } = await loadSeat();
  const seat = boxHandoffSeatOf({ id: "a-1", boxDisplay: null, boxSeat: null });
  assert.deepEqual(seat, { display: 1, shared: true });
  const caption = boxHandoffScreenCaption({ id: "a-1", name: "Tester" }, seat);
  assert.match(caption, /shared screen/);
  assert.doesNotMatch(caption, /Tester's screen/, "the shared screen is not this agent's screen");
});

test("a host that does not answer the question gets no picture at all", async () => {
  const { boxHandoffSeatOf, boxHandoffScreenCaption } = await loadSeat();
  assert.equal(boxHandoffSeatOf({ id: "a-1", boxDisplay: null, boxSeat: undefined }), null);
  assert.equal(boxHandoffScreenCaption({ id: "a-1", name: "Tester" }, null), "No screen to show");
});

test("the last answer for an agent survives a record that is briefly a placeholder", async () => {
  const { boxHandoffSeatOf } = await loadSeat();
  assert.deepEqual(boxHandoffSeatOf({ id: "a-9", boxSeat: 4 }), { display: 4, shared: false });
  // listAgents rebuilds the roster before loadContext refills it; the caption must not flicker
  // through three wordings in the gap.
  assert.deepEqual(boxHandoffSeatOf({ id: "a-9" }), { display: 4, shared: false });
});

test("the desktop view's own mount is what the picture follows", async () => {
  const { boxHandoffSeatOf, noteBoxHandoffSeat } = await loadSeat();
  noteBoxHandoffSeat("a-3", 6, false);
  assert.deepEqual(boxHandoffSeatOf({ id: "a-3" }), { display: 6, shared: false });
  // A view that fell back to the shared screen says shared, whatever number it was given.
  noteBoxHandoffSeat("a-4", 1, true);
  assert.deepEqual(boxHandoffSeatOf({ id: "a-4" }), { display: 1, shared: true });
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const paint = source.slice(source.indexOf("    const paint = (frameUrl, display, shared) => {"));
  assert.match(paint.slice(0, 400), /noteBoxHandoffSeat\(agentId, display, shared\)/,
    "every desktop mount goes through paint; if it stops telling the picture which screen it opened the two can disagree again");
});

test("the rail tile says Connecting only while a reader is running", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function renderScreenTile() {");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /const reading = boxHandoffThumb != null && boxHandoffThumb\.agentId === lead\.id/);
  assert.match(body, /reading \? "Connecting"/);
  // The old rule was lead.boxDisplay != null, which is true for ever once the box has handed the
  // agent a seat -- so an idle agent sat on "Connecting" with nothing connecting.
  assert.doesNotMatch(codeOnly(body), /lead\.boxDisplay/);
  assert.match(body, /boxHandoffScreenCaption\(lead, seat\)/);
});

// -- skip, on a host that cannot do it -----------------------------------------------------------

test("Skip is simply absent when the host does not know the command", async () => {
  const html = card(entry(null), false, { live, agentId: "a-1" });
  assert.doesNotMatch(html, /data-handoff-action="skip"/);
  assert.doesNotMatch(html, /Skip/);
  // The other two still work: a host too old to skip can still be handed back to.
  assert.match(html, /data-handoff-action="take-over"/);
  assert.match(html, /data-handoff-action="done"/);
});

// -- the instruction is model-written text, in four new places -----------------------------------

test("an instruction carrying markup comes out escaped in the card", async () => {
  const payload = `<img src=x onerror="alert(1)"> & "quoted" 'single'`;
  const html = card(
    { id: "e-2", type: "handoff", handoff: { requestId: "r<1>", instruction: payload, resolution: null } },
    true,
    { live: { requestId: "r<1>" }, agentId: `a"1` },
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  // The ids go into attributes, so a quote in either would break out of the attribute itself.
  assert.doesNotMatch(html, /data-request-id="r<1>"/);
  assert.match(html, /data-request-id="r&lt;1&gt;"/);
  assert.doesNotMatch(html, /data-agent-id="a"1"/);
});

test("the rail card and the banner note escape the same text", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const railStart = source.indexOf("  function renderHandoffRail() {");
  assert.notEqual(railStart, -1, "app.js no longer draws the rail card");
  const rail = source.slice(railStart, source.indexOf("\n  }\n", railStart));
  // Every slot the instruction reaches in the rail goes through escapeHtml, and so do the ids.
  assert.match(rail, /escapeHtml\(live\.instruction/);
  assert.match(rail, /data-agent-id="\$\{escapeHtml\(lead\.id\)\}"/);
  // The banner writes the instruction with textContent, which cannot introduce a tag at all, and
  // the full text rides in a title for the case the two-line clamp cuts.
  const handStart = source.indexOf("  function renderHandBack() {");
  const hand = source.slice(handStart, source.indexOf("\n  }\n", handStart));
  assert.match(hand, /note\.textContent = handoff/);
  assert.doesNotMatch(hand, /note\.innerHTML/);
  assert.match(hand, /note\.title = handoff/);
});

// -- the contract renderHandBack has to keep -----------------------------------------------------

test("renderHandBack keeps the ids and the shape verify-dashboard's GW-10 leg looks for", async () => {
  const html = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
  // Both ids exist exactly once, and both are inside the banner rather than the footer now.
  assert.equal(html.match(/id="hand-back"/g)?.length, 1);
  assert.equal(html.match(/id="hand-back-note"/g)?.length, 1);
  const banner = html.slice(html.indexOf('id="handoff-banner"'), html.indexOf('<div class="desktop-workspace">'));
  assert.match(banner, /id="hand-back-note"/);
  assert.match(banner, /id="hand-back"/);
  assert.match(banner, /id="handoff-skip"/);
  const footer = html.slice(html.indexOf('<footer class="desktop-footer">'), html.indexOf("</footer>", html.indexOf('<footer class="desktop-footer">')));
  assert.doesNotMatch(footer, /id="hand-back"/, "the footer pair moved into the banner; leaving a copy would give two controls for one thing");

  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function renderHandBack() {");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /button\.hidden = !canHandBack/);
  assert.match(body, /button\.dataset\.handBack = canHandBack \? lead\.id : ""/);
  assert.match(body, /banner\.hidden = !handoff/);
});

// Seen in a real browser, not in an assertion: the card's `hidden` was true and it still painted,
// as an empty amber-bordered box at the top of the rail, because [hidden] loses to the display rule
// .context-island sets. The same trap the .icon-button[hidden] rule in this stylesheet exists for.
test("the rail's amber card really disappears when it is hidden", async () => {
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  assert.match(css, /\.handoff-island\[hidden\] \{\s*display: none;/);
  const island = css.slice(css.indexOf(".handoff-island {"));
  assert.match(island.slice(0, island.indexOf("}")), /display: grid/, "if it stops setting a display, this pairing needs re-reading rather than deleting");
});

test("the rail's two sections sit above the context card, in that order", async () => {
  const html = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
  const handoff = html.indexOf('id="rail-handoff"');
  const screen = html.indexOf('id="rail-screen"');
  const context = html.indexOf('id="context-card"');
  assert.ok(handoff > 0 && screen > handoff && context > screen, "rail-handoff, then rail-screen, then the context card");
  // The Now island keeps its order below, and no Routines list is added. The desktop capsule that
  // used to sit at the foot of the rail is gone (Jason, 2026-09-08 22:42): the screen tile above
  // is the one way into the desktop, so its absence is asserted rather than its order.
  assert.ok(html.indexOf('class="context-island now-island') > context);
  assert.equal(html.indexOf('id="open-desktop"'), -1, "the desktop capsule must not come back");
});

test("Take over is the only route that goes full window", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function openDesktop(");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /takeover = false/);
  assert.match(body, /dataset\.takeover = "1"/);
  assert.match(body, /delete elements\.desktopDialog\.dataset\.takeover/);
  const funnel = source.slice(source.indexOf("  function handleBoxHandoffAction("));
  assert.match(funnel, /"take-over"[\s\S]{0,80}openDesktop\("browser", true\)/);
  assert.match(funnel, /"open"[\s\S]{0,80}openDesktop\("browser", false\)/);
  // The css only goes full window under the flag, so the rail capsule's centred dialog is
  // untouched for every other route into it.
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  assert.match(css, /\.desktop-dialog\[data-takeover="1"\]/);
  assert.match(css, /\.desktop-dialog\[data-takeover="1"\] \.desktop-frame/);
});

// MR-33 was exactly this overflow: an unbounded row inside the desktop frame pushed the grid out
// of it and put the footer in the middle of the desktop. The banner is a third fixed row.
test("the banner is a fixed row and the workspace still takes what is left", async () => {
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  const banner = css.slice(css.indexOf(".handoff-banner {"), css.indexOf("}", css.indexOf(".handoff-banner {")));
  assert.match(banner, /flex: 0 0 auto/);
  const note = css.slice(css.indexOf(".handoff-banner .hand-back-note {"), css.indexOf("}", css.indexOf(".handoff-banner .hand-back-note {")));
  assert.match(note, /-webkit-line-clamp: 2/);
  assert.match(note, /min-width: 0/);
  const workspace = css.slice(css.indexOf(".desktop-workspace {"), css.indexOf("}", css.indexOf(".desktop-workspace {")));
  assert.match(workspace, /flex: 1 1 auto/);
  assert.match(workspace, /min-height: 0/);
});

// -- the thumbnail engine, asserted on the source: it is all side effects on a live document ------

test("the thumbnail reader is never mounted inside the transcript, and never allocates a seat", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function boxHandoffEnsureThumb(");
  assert.notEqual(start, -1, "app.js no longer runs a thumbnail reader");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  // Appended to the body, off screen. transcriptMarkup rebuilds the whole list, and noVNC re-runs
  // its handshake whenever its element is replaced.
  assert.match(body, /document\.body\.appendChild\(frame\)/);
  assert.doesNotMatch(codeOnly(body), /elements\.transcript/);
  assert.match(body, /view_only=1/, "the reader must never be able to take a keystroke");
  // Built on the page's own origin. The host's answer names 127.0.0.1, which through the relay is
  // the VIEWER's machine -- the bug VNC-2 closed.
  assert.match(body, /\$\{window\.location\.origin\}\/vnc\/\$\{display\}\/vnc\.html/);
  assert.doesNotMatch(codeOnly(body), /127\.0\.0\.1/);
  // Its own timer, and 3 s: not the render path, not the 15 s heartbeat, not the SSE debounce.
  assert.match(body, /setInterval\(boxHandoffTick, 3000\)/);
  // Nothing in the engine may call the command that hands out a display: measured 16,277 ms cold.
  const engine = source.slice(source.indexOf("  let boxHandoffThumb = null;"), source.indexOf("  function boxHandoffDone("));
  assert.doesNotMatch(codeOnly(engine), /ensureDesktop|ensureForeverBox/);
});

test("a tick with the desktop open, or with no painted framebuffer, writes nothing", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function boxHandoffTick() {");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /if \(elements\.desktopDialog\.open\) return;/);
  assert.match(body, /if \(!source \|\| !source\.width \|\| !source\.height\) return;/);
  assert.match(body, /toDataURL\("image\/webp", 0\.6\)/);
  // A cross-origin frame throws on contentDocument; that is a reason to skip a tick, not to take
  // the whole console down.
  assert.match(body, /try \{ source = held\.frame\.contentDocument/);
});

test("the frozen frame survives a reload and is pruned to the newest eight", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function rememberBoxHandoffFrame(");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /localStorage/);
  assert.match(body, /BOX_HANDOFF_FRAME_KEEP/);
  assert.match(body, /removeItem/);
  // Every storage touch is wrapped: a private window and a browser with site data blocked both
  // throw on the accessor itself, and a thumbnail is never worth a broken page.
  assert.match(body, /catch \{/);
  const read = source.slice(source.indexOf("  function boxHandoffFrame("), source.indexOf("  function rememberBoxHandoffFrame("));
  assert.match(read, /try \{[\s\S]*localStorage\.getItem[\s\S]*\} catch/);
});

test("a frame is written into the elements, never through a render", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function paintBoxHandoffFrame(");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /img\.src = dataUrl/);
  // renderAll here would rebuild the transcript every three seconds and throw the reader to the
  // bottom of it each time.
  assert.doesNotMatch(codeOnly(body), /renderAll|renderTranscript/);
});

test("the surfaces are painted in the same pass as the context card, and the engine follows them", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function renderAll(");
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /renderContextCard\(\);\n\s*renderBoxHandoffSurfaces\(\);/);
  const sync = source.slice(source.indexOf("  function renderBoxHandoffSurfaces() {"));
  assert.match(sync, /boxHandoffEnsureThumb\(openId, live\.requestId, seat\.display\)/);
  // No seat resolved means no reader and no picture: a wrong screen is worse than no screen.
  assert.match(sync, /if \(live && seat\)/);
  // The reader stops when the hand-off ends or the conversation moves, and NOT on a render that
  // happens to carry no display: the roster and the box status are two reads, and tearing it down
  // in the gap between them restarted noVNC's handshake on every heartbeat.
  assert.match(sync, /else if \(!live \|\| \(boxHandoffThumb && boxHandoffThumb\.agentId !== openId\)\) boxHandoffTeardown\(\);/);
  assert.match(sync, /renderHandoffRail\(\);/);
  assert.match(sync, /renderScreenTile\(\);/);
});

// The roster pill, the header pill and the count are cross-agent; record.handoff is null for every
// agent but the open one, so building them on it would empty the roster of the very signal that
// tells a person to open a conversation at all.
test("the roster pill and the count still run off awaitingUserResponse, not the hand-off", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const needsYou = source.slice(source.indexOf("  function needsYou(record) {"), source.indexOf("  function needsYouCount()"));
  assert.match(needsYou, /record\.needsYou === true/);
  assert.doesNotMatch(codeOnly(needsYou), /handoff/);
  const count = source.slice(source.indexOf("  function needsYouCount() {"), source.indexOf("\n  }\n", source.indexOf("  function needsYouCount() {")));
  assert.doesNotMatch(codeOnly(count), /handoff/);
});

test("done and skip close the view on the click, never on the answer", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  for (const name of ["boxHandoffDone", "boxHandoffSkip"]) {
    const start = source.indexOf(`  function ${name}(`);
    const body = source.slice(start, source.indexOf("\n  }\n", start));
    const close = body.indexOf("elements.desktopDialog.close()");
    const call = body.indexOf("Promise.resolve(adapter.");
    assert.ok(close !== -1 && close < call, `${name} must close the view before the call, not after it`);
    // handBackForeverBox ends the hand-off on the host BEFORE it answers, so a rejection is not
    // evidence anything failed. Saying it did would be UX-ERR-1 in a new place.
    assert.doesNotMatch(codeOnly(body), /Could not|failed|error\.message/);
  }
  const skip = source.slice(source.indexOf("  function boxHandoffSkip("));
  assert.match(skip, /supported === false/);
  assert.match(skip, /boxHandoffSkipMissing = true/);
  // The fallback that would stamp "completed" on a skipped step is not here and must not come back.
  assert.doesNotMatch(codeOnly(skip.slice(0, skip.indexOf("\n  }\n"))), /handBack/);
});
