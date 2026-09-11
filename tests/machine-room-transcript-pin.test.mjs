// PHONE-CONSOLE-1, the half a browser cannot prove about the transcript's pin.
//
// scripts/verify-mobile.mjs --phone-app measures what a person gets: a reader at the newest line is
// still there after the composer has grown 44 to 176 px under him, the conversation keeps 180 px
// with a 336 px keyboard up, and a row arriving while he is parked up puts a button on the screen
// that takes him back. What a browser cannot show is WHY those hold, and the why is one rule that
// took two cuts to get right. These cases pin the rule so the next edit cannot quietly undo it.
//
// THE RULE, WRITTEN ONCE AND PINNED HERE: the pin is lost by scrolling UP and by nothing else.
// MEASURED in WebKit at 390x844 on grok-bot-local-vm: typing a long message fired 22 scroll events
// and 26 re-pins, every one of them landing 0 px from the bottom, and the reader still ended 132 px
// away. The box shrinks under him as the composer grows, which leaves his scrollTop where it was
// and moves the bottom further down; the scroll event that follows reports a gap, and the first cut
// read that gap as "he scrolled up" and skipped the 147 re-pins that came after it. A gap that
// opens while scrollTop stands still is the floor moving, not the reader.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFile(path.join(repoRoot, rel), "utf8");

async function block() {
  const source = await read("ui/machine-room/app.js");
  const start = source.indexOf("  // ---- PHONE-CONSOLE-1: the + menu");
  const end = source.indexOf("  // ---- end PHONE-CONSOLE-1");
  assert.ok(start >= 0 && end > start, "the PHONE-CONSOLE-1 block is findable");
  return { source, body: source.slice(start, end) };
}

test("PHONE-CONSOLE-1: the pin is lost by scrolling up and by nothing else", async () => {
  const { body } = await block();
  const handler = /addEventListener\("scroll", \(\) => \{([\s\S]*?)\n  \}, \{ passive: true \}\);/.exec(body)?.[1] ?? "";
  assert.ok(handler.length > 0, "the transcript's scroll handler is findable");
  assert.match(handler, /const draggedUp = top < lastScrollTop - 1;/,
    "the reader's own drag is the only thing that may clear the pin");
  assert.match(handler, /if \(draggedUp\) transcriptPinned = atNewest\(\);/);
  assert.match(handler, /else if \(atNewest\(\)\) transcriptPinned = true;/,
    "and reaching the bottom by hand takes it back");
  assert.match(handler, /else if \(transcriptPinned\) repinTranscript\(\);/,
    "a gap that opens under a pinned reader is answered by taking him back, not by dropping the pin");
  // The shape the first cut had. It is banned by name, because it reads correctly and is wrong.
  assert.doesNotMatch(handler, /^\s*transcriptPinned = atNewest\(\);/m,
    "an unconditional read of the gap is the 132 px failure this rule exists to stop");
});

test("PHONE-CONSOLE-1: the re-pin cannot feed itself, and cannot resize anything", async () => {
  const { body } = await block();
  const repin = /function repinTranscript\(\) \{([\s\S]*?)\n  \}/.exec(body)?.[1] ?? "";
  assert.ok(repin.length > 0, "repinTranscript is findable");
  assert.match(repin, /if \(!transcriptPinned \|\| repinFrame\) return;/, "one frame in flight at a time");
  assert.match(repin, /requestAnimationFrame/, "the write is a frame later, outside the observation that asked for it");
  assert.match(repin, /repinFrame = 0;/, "and the guard is released in the callback, or the second re-pin never runs");
  // scrollTop is the only thing this writes. WebKit throws "ResizeObserver loop completed with
  // undelivered notifications" at a callback that changes a box's size, and scrollTop changes none.
  assert.match(repin, /box\.scrollTop = box\.scrollHeight;/);
  const observer = /new ResizeObserver\(\(\) => ([\s\S]*?)\)\.observe\(elements\.transcript\);/.exec(body)?.[1] ?? "";
  assert.equal(observer.trim(), "repinTranscript()", "the observer does one thing and it is guarded");
});

test("PHONE-CONSOLE-1: the two files agree on what 'at the bottom' is", async () => {
  const { source, body } = await block();
  const near = Number(/const NEAR_NEWEST = (\d+);/.exec(body)?.[1]);
  assert.equal(near, 90, "CONSOLE-4's own number");
  // renderTranscript's rule, untouched by this wave and still the same 90.
  assert.match(source, /const wasNearBottom = box\.scrollHeight - box\.scrollTop - box\.clientHeight < 90;/,
    "renderTranscript decides whether a REBUILD follows the reader, and it uses the same 90 px");
});

test("PHONE-CONSOLE-1: the button back to the newest line is a button, in the one place it can be pressed", async () => {
  const { body } = await block();
  assert.match(body, /jumpNewest\.className = "jump-newest";/);
  assert.match(body, /jumpNewest\.type = "button";/);
  assert.match(body, /jumpNewest\.dataset\.jumpNewest = "";/);
  assert.match(body, /querySelector\("\.conversation-space"\)\?\.appendChild\(jumpNewest\)/,
    ".conversation-space is position: relative and renderTranscript never rebuilds it");
  // NOT in the overlay: .voice-overlay is pointer-events: none, so a button in it could not be
  // pressed at all. And NOT in the shelf's grid, which is what moves the footer (VOICE-6). Read off
  // the code and not the comments, which name both of them in order to say why neither is used.
  const code = body.replace(/\/\/[^\n]*/g, "");
  assert.ok(!code.includes("voice-overlay"), "a button in the speech overlay cannot be pressed");
  assert.ok(!code.includes('getElementById("composer")'), "and one in the composer's grid opens a row in the footer");
  // `hidden`, never style.display: [hidden] loses to an author display rule, which this console has
  // been bitten by three times, and the rest of the page is written the same way.
  assert.match(body, /jumpNewest\.hidden = !wanted;/);
  assert.doesNotMatch(body, /jumpNewest\.style\.display/);
  const paint = /function paintJumpNewest\(\) \{([\s\S]*?)\n  \}/.exec(body)?.[1] ?? "";
  assert.match(paint, /if \(jumpNewest\.hidden === !wanted\) return;/,
    "an unguarded write from inside an observer's callback is the 60 Hz loop console-flicker paid for");
  assert.match(paint, /!transcriptPinned && unseenWhileParked > 0/,
    "parked up AND something arrived: either alone is a button nobody asked for");
});

test("PHONE-CONSOLE-1: the keyboard may not take the conversation", async () => {
  const { source, body } = await block();
  const floor = Number(/const TRANSCRIPT_FLOOR = (\d+);/.exec(body)?.[1]);
  const lines = Number(/const KEYBOARD_COMPOSER_LINES = (\d+);/.exec(body)?.[1]);
  assert.equal(floor, 180, "the band the conversation keeps, and the number the gate asserts");
  assert.ok(lines >= 2 && lines < 8, `${lines} lines with a keyboard up is not a cap`);
  // The written value is clamped, not the CSS: .control-shelf still reads var(--kb, 0px) unchanged.
  assert.match(source, /setProperty\("--kb", `\$\{Math\.min\(kb, keyboardCeiling\(\)\)\}px`\)/,
    "--kb is written with a ceiling or the shelf pads by the whole keyboard");
  const ceiling = /function keyboardCeiling\(\) \{([\s\S]*?)\n  \}/.exec(body)?.[1] ?? "";
  assert.match(ceiling, /TRANSCRIPT_FLOOR/);
  assert.match(ceiling, /keyboardTaken\(\)/,
    "it adds back what it has already taken, or repeated calls ratchet the band down to nothing");
  // And the composer stops growing while the keyboard is up, or the cap above is spent on a box the
  // person cannot see past: 44 to 176 px took 132 px off the band on top of the keyboard's own 336.
  assert.match(source, /const lines = keyboardUp\(\) \? KEYBOARD_COMPOSER_LINES : COMPOSER_MAX_LINES;/);
  const css = await read("ui/machine-room/styles.css");
  assert.match(css, /var\(--kb, 0px\)/, "the stylesheet's own reader for it is unchanged");
});

test("PHONE-CONSOLE-1: the + menu owns no layout and no second set of buttons", async () => {
  const { source, body } = await block();
  // CSS draws the sheet; this decides whether it is open. The same trap as MOBILE-1's drawers.
  assert.doesNotMatch(body, /style\.(width|height|left|top|bottom|transform)\s*=/,
    "no layout is written from the script");
  assert.match(body, /document\.body\.dataset\.capabilityMenu = "open";/);
  assert.match(body, /delete document\.body\.dataset\.capabilityMenu;/);
  assert.match(body, /setAttribute\("aria-expanded", String\(Boolean\(open\)\)\)/,
    "the button says whether the menu is open");
  assert.match(body, /if \(event\.target\.closest\("\[data-capability\]"\)\) setCapabilityMenu\(false\)/,
    "a press acts and the sheet goes");
  assert.match(body, /"Escape"/, "Escape closes it, the way Escape closes a drawer");
  // The attach row goes through the same handler the rest of the dock does, and the same guard the
  // + button used to apply itself.
  assert.match(source, /else if \(capability === "attach"\) pickAttachment\(\);/);
  assert.match(source, /function pickAttachment\(\) \{[\s\S]*?a room has no attachment store/);
  assert.match(source, /if \(isPhoneWidth\(\)\) \{ setCapabilityMenu\(!document\.body\.dataset\.capabilityMenu\); return; \}/,
    "above the breakpoint the + button still picks a file itself");
});
