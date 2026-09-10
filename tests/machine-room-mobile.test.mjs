// MOBILE-1, the half a browser cannot prove: that the phone pass stayed inside its breakpoint.
//
// scripts/verify-mobile.mjs measures what a person sees at 390x844 and 430x932, and its --desktop
// leg fingerprints every rect at 1440x900 to show the one base rule changes nothing it should not.
// What it cannot show is that a LATER edit did not quietly put a phone rule in the base sheet, where
// the next desktop ship would inherit it. These cases read the three files and hold that line.
//
// The rule, written once and pinned here: everything the phone pass changes lives inside
// `@media (max-width: 690px)`, or in the `@media (max-height: 500px)` block for a phone turned
// sideways, EXCEPT ONE base rule, named below and nowhere else:
//
//   .icon-button.drawer-toggle, .drawer-scrim { display: none }   nodes that only exist on a phone
//
// The shell's column track -- the cause of the whole report -- used to be the second one, on the
// reading that `minmax(0, 1fr)` is a no-op at a width where the implicit column already computes to
// the viewport. The --desktop leg measured that reading wrong: at 1440x900 the room capsule came out
// 227 px wide with the rule and 268 px without it, because an `auto` column lets a child's intrinsic
// width feed back into the window bar's `1fr` track. It is inside the breakpoint now, and these
// cases are what stop it drifting back out.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = path.join(repoRoot, "ui/machine-room/styles.css");
const htmlPath = path.join(repoRoot, "ui/machine-room/index.html");
const appPath = path.join(repoRoot, "ui/machine-room/app.js");

// The sheet, split into what is inside a media query and what is not. Comments go first, because a
// selector quoted in a comment is not a rule and the whole point of these cases is what the browser
// applies.
function splitSheet(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let base = "";
  for (let i = 0; i < clean.length; i += 1) {
    if (!clean.startsWith("@media", i)) { base += clean[i]; continue; }
    const open = clean.indexOf("{", i);
    const query = clean.slice(i, open).replace(/\s+/g, " ").trim();
    let depth = 0;
    let end = open;
    for (let j = open; j < clean.length; j += 1) {
      if (clean[j] === "{") depth += 1;
      else if (clean[j] === "}") { depth -= 1; if (depth === 0) { end = j; break; } }
    }
    blocks.push({ query, body: clean.slice(open + 1, end) });
    i = end;
  }
  return { base, blocks };
}

const phoneBody = (blocks) => blocks.filter((b) => /max-width:\s*690px/.test(b.query)).map((b) => b.body).join("\n");
const landscapeBody = (blocks) => blocks.filter((b) => /max-height:\s*500px/.test(b.query)).map((b) => b.body).join("\n");

// One declaration block, by selector, out of a chunk of CSS.
function ruleFor(body, selector) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const selectors = m[1].split(",").map((one) => one.replace(/\s+/g, " ").trim());
    if (selectors.includes(selector)) rules.push(m[2]);
  }
  return rules;
}

test("MOBILE-1: the cause is fixed by the shell's column track, inside the breakpoint and not outside it", async () => {
  const source = await readFile(cssPath, "utf8");
  const { base, blocks } = splitSheet(source);
  const shell = ruleFor(base, ".app-shell");
  assert.equal(shell.length, 1, "there is one base .app-shell rule");
  assert.ok(!/grid-template-columns/.test(shell[0]),
    "the base rule must NOT set the column: at 1440x900 minmax(0,1fr) moved the room capsule 227 -> 268 px wide, measured by the gate's --desktop leg");
  const phoneShell = ruleFor(phoneBody(blocks), ".app-shell").join("\n");
  assert.match(phoneShell, /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    "the shell's implicit column sized to the window bar's min-content -- 515.406px, measured on grok-bot-local-vm at 390 and at 430");
  // And exactly one breakpoint sets it, so there is no second copy to drift from this one.
  const elsewhere = blocks.filter((b) => ruleFor(b.body, ".app-shell").some((body) => /grid-template-columns/.test(body)));
  assert.deepEqual(elsewhere.map((b) => b.query), ["@media (max-width: 690px)"], "the shell's column is decided once, in the phone block");
  assert.equal(ruleFor(landscapeBody(blocks), ".app-shell").length, 1, "and the sideways case has its own rule");
  assert.match(ruleFor(landscapeBody(blocks), ".app-shell")[0], /min-height:\s*0/,
    "at 844x390 the width breakpoint is missed and min-height: 650px put the composer 4 px below the viewport");
});

test("MOBILE-1: nothing else the phone pass added is outside its breakpoint", async () => {
  const source = await readFile(cssPath, "utf8");
  const { base, blocks } = splitSheet(source);
  // Every rule in the base sheet that mentions anything the phone pass introduced. The only two
  // allowed are the shell's column (above) and the hide on nodes that exist only on a phone.
  const PHONE_ONLY = /drawer-toggle|drawer-scrim|data-drawer|safe-area-inset|var\(--kb/;
  const offenders = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(base); m; m = re.exec(base)) {
    const selector = m[1].replace(/\s+/g, " ").trim();
    const body = m[2];
    if (!PHONE_ONLY.test(selector) && !PHONE_ONLY.test(body)) continue;
    if (selector === ".icon-button.drawer-toggle, .drawer-scrim" && /display:\s*none/.test(body)) continue;
    offenders.push(`${selector} { ${body.replace(/\s+/g, " ").trim()} }`);
  }
  assert.deepEqual(offenders, [], "a phone rule in the base sheet is a desktop change nobody asked for");
  // And the drawers really are built down there.
  const phone = phoneBody(blocks);
  assert.match(phone, /body\[data-drawer="roster"\]/);
  assert.match(phone, /body\[data-drawer="context"\]/);
  assert.match(phone, /env\(safe-area-inset-bottom\)/, "there was not one safe-area inset in this console before this ship");
  assert.match(phone, /var\(--kb/, "and the shelf reads the visual viewport for the keyboard");
});

test("MOBILE-1: the dock is actually shrinkable, which min-width alone does not make it", async () => {
  const source = await readFile(cssPath, "utf8");
  const phone = phoneBody(splitSheet(source).blocks);
  const dock = ruleFor(phone, ".capability-dock").join("\n");
  assert.ok(dock.length > 0, "the phone block sets the dock");
  assert.match(dock, /min-width:\s*0/);
  assert.doesNotMatch(dock, /justify-self:\s*center/,
    "a centred grid item sizes to its content: with justify-self: center the dock measured 273 px inside a 112 px track and its buttons landed on the window actions");
  assert.match(dock, /overflow-x:\s*auto/, "so a longer set of capabilities scrolls rather than losing a word");
  const bar = ruleFor(phone, ".window-bar").join("\n");
  assert.match(bar, /grid-template-columns:\s*auto minmax\(0,\s*1fr\)/,
    "`1fr` carries an automatic minimum of min-content, which is the six buttons");
});

test("MOBILE-1: the composer's font and its eight-line cap move together", async () => {
  const source = await readFile(cssPath, "utf8");
  const { base, blocks } = splitSheet(source);
  const phone = phoneBody(blocks);
  const phoneComposer = ruleFor(phone, ".composer textarea").join("\n");
  const size = Number(/font-size:\s*(\d+)px/.exec(phoneComposer)?.[1]);
  const line = Number(/line-height:\s*(\d+)px/.exec(phoneComposer)?.[1]);
  const cap = Number(/max-height:\s*(\d+)px/.exec(phoneComposer)?.[1]);
  assert.ok(size >= 16, `iOS Safari zooms the layout viewport for anything under 16px on focus; this is ${size}px`);
  assert.ok(line > size, "the line box has to be taller than the glyphs");
  assert.equal(cap, line * 8, "the same eight lines as COMPOSER_MAX_LINES, or the box clips its last line");
  // The desktop pair is untouched and still agrees with itself.
  const baseComposer = ruleFor(base, ".composer textarea").join("\n");
  const baseLine = Number(/line-height:\s*(\d+)px/.exec(baseComposer)?.[1]);
  const baseCap = Number(/max-height:\s*(\d+)px/.exec(baseComposer)?.[1]);
  assert.equal(baseCap, baseLine * 8, "and so does the desktop pair");
  // Every text box the person types into, not only the composer.
  assert.match(phone, /\.problem-report-card textarea/, "the report card's own box was 11px");
});

test("MOBILE-1: the viewport meta is what makes the safe-area insets resolve to anything", async () => {
  const html = await readFile(htmlPath, "utf8");
  const meta = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.match(meta, /width=device-width/);
  assert.match(meta, /viewport-fit=cover/, "without this every env(safe-area-inset-*) is 0 and the composer sits under the home indicator");
  assert.match(meta, /interactive-widget=resizes-content/, "Chrome honours this; iOS Safari does not, which is why app.js also watches the visual viewport");
  // The two handles and the scrim, with the wiring the stylesheet and app.js both read.
  assert.match(html, /id="roster-drawer"[^>]*data-drawer-toggle="roster"/);
  assert.match(html, /id="context-drawer"[^>]*data-drawer-toggle="context"/);
  assert.match(html, /id="context-space"/, "the handle names the rail it opens");
  assert.match(html, /class="drawer-scrim" id="drawer-scrim" hidden/);
  // The scrim has to be INSIDE the stage: .stage is position: relative, z-index: 2, so a drawer in
  // it cannot be raised above a sibling of the stage. The first cut opened the drawer under its
  // own scrim, measured on grok-bot-local-vm in real Chrome.
  const stage = /<main class="stage"[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";
  assert.match(stage, /id="drawer-scrim"/, "the scrim lives in the stage's stacking context, with the drawers");
  for (const control of ["roster-drawer", "context-drawer"]) {
    assert.match(html, new RegExp(`id="${control}"[^>]*aria-expanded="false"`), `${control} says whether it is open`);
  }
});

// ---- MOBILE-1b: what the review measured -------------------------------------------------------

test("MOBILE-1b: the shelf's two always-present controls are out of flow at desktop and a row on the phone", async () => {
  const source = await readFile(cssPath, "utf8");
  const { base, blocks } = splitSheet(source);
  const baseAside = ruleFor(base, ".composer-aside").join("\n");
  assert.match(baseAside, /position:\s*absolute/,
    "in the shelf's grid it adds a PERMANENT row -- unlike the status and the tray it never collapses -- and measured on this Mac that made .control-shelf 31.94 px taller and .transcript 31.94 px shorter at 1440x900");
  assert.doesNotMatch(baseAside, /grid-column/, "a full-width grid item is a row, and a row at desktop is the regression");
  const phoneAside = ruleFor(phoneBody(blocks), ".composer-aside").join("\n");
  assert.match(phoneAside, /position:\s*static/, "the phone has one column and no room beside the composer, so down there it is a row");
  assert.match(phoneAside, /grid-column:\s*1 \/ -1/);
});

test("MOBILE-1b: the phone's 44px floor covers what a sweep found, not what a list remembered", async () => {
  const source = await readFile(cssPath, "utf8");
  const phone = phoneBody(splitSheet(source).blocks);
  // The five capability buttons are the phone's whole navigation and measured 32-40 px wide: the
  // old rule gave them min-height with min-width: 0, so they were tall enough and too narrow.
  const capability = ruleFor(phone, ".capability-button").join("\n");
  assert.match(capability, /min-width:\s*44px/, "39x44, 40x44, 32x44, 39x44 and 36x44 measured at both device sizes");
  assert.match(capability, /min-height:\s*44px/);
  // The chip in Jason's own 2026-09-09 screenshot, measured 200x25.
  const chip = ruleFor(phone, "button.evidence-chip").join("\n");
  assert.match(chip, /min-height:\s*44px/);
  assert.match(chip, /display:\s*inline-flex/, "or its one line of text sits at the top of a taller box");
  // The only two controls that answer a hand-off from a phone, measured 103x33 and 130x33.
  assert.match(phone, /\.handoff-banner-actions button/);
  assert.match(phone, /\.dialog-close/, "the desktop view's close button measured 37x37");
});

test("MOBILE-1b: the demo caption is a caption and not a control", async () => {
  const bg = await readFile(path.join(repoRoot, "ui/machine-room/backgrounds.css"), "utf8");
  const rule = /html\[data-demo="true"\] body::before \{([\s\S]*?)\}/.exec(bg)?.[1] ?? "";
  assert.ok(rule.length > 0, "the caption rule is findable");
  assert.match(rule, /pointer-events:\s*none/,
    "it is fixed across the top at z 9999 and computed 47.6 px tall, so on a phone it covered both drawer handles: three taps left body.dataset.drawer empty and page.click timed out on \"<body> intercepts pointer events\"");
  // And the bar is moved out from under it rather than merely made clickable through it.
  const phone = phoneBody(splitSheet(await readFile(cssPath, "utf8")).blocks);
  assert.match(phone, /html\[data-demo="true"\] \.window-bar/, "the handles have to be visible, not only pressable");
});

test("MOBILE-1b: the gate's own hit test cannot be passed by an overlay", async () => {
  const gate = await readFile(path.join(repoRoot, "scripts/verify-mobile.mjs"), "utf8");
  const reach = /const REACH = \(sel\) => \{([\s\S]*?)\n\};/.exec(gate)?.[1] ?? "";
  assert.ok(reach.length > 0, "the hit test is findable");
  assert.doesNotMatch(reach.replace(/\/\/[^\n]*/g, ""), /at\.contains\(el\)/,
    "body and html are ancestors of everything, so that clause reported hit true for a control under a full-screen overlay");
  assert.match(reach, /el\.contains\(at\)/, "a wrapper whose centre lands on its own child is still a hit");
  assert.match(gate, /const SWEEP =/, "the reach leg sweeps every visible control rather than checking a list of eight");
});

test("MOBILE-1: app.js's share of the drawers is small enough to name", async () => {
  const source = await readFile(appPath, "utf8");
  const start = source.indexOf("  // ---- MOBILE-1: the two drawers");
  const end = source.indexOf("  // ---- end MOBILE-1");
  assert.ok(start >= 0 && end > start, "the block is findable");
  const block = source.slice(start, end);
  const code = block.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//")).length;
  // CSS does the sliding, the scrim and the visibility. What is left is which drawer is open,
  // Escape and a scrim tap, and giving the keyboard back. A ceiling makes "the smallest addition"
  // a measured claim rather than an intention.
  assert.ok(code <= 34, `the drawer wiring is ${code} lines of code; anything past 34 means layout has leaked into the script`);
  assert.match(block, /data-drawer-toggle/);
  assert.match(block, /"Escape"/, "Escape closes an open drawer");
  assert.match(block, /drawerOpener\.focus\(\)/, "and the keyboard goes back to the handle that opened it");
  assert.match(block, /visualViewport/);
  assert.doesNotMatch(block, /style\.(width|height|left|top|transform)\s*=/, "no layout is written from the script");
});
