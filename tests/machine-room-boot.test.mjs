// CONSOLE-4 item A. Four things Jason sees when console.titanium.bot comes up, and the seams the
// rest of the wave plugs into.
//
// Every leg here fails on the tree as it stood at be06f03 and passes after. They are grouped the
// way the defects are: the plate before the first pixel, the cover, the scroll, the adapter's data
// shapes, and the four seams -- each of which has to render today's markup with its module absent,
// because item A merges before items B, C and D exist.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFile(path.join(repoRoot, rel), "utf8");

// bg-boot.js is a classic browser script, not a module: it hangs one object on the window it is
// handed. Evaluating it against a stub is how the browser loads it, so these tests exercise the
// same file the page does rather than a module build of it.
function loadBrowserScript(relativePath, stub = {}) {
  const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
  new Function("window", source)(stub);
  return stub;
}

/** The narrowest document bg-boot needs: a root element with a dataset and a style. */
function fakeDocument() {
  const root = {
    dataset: {},
    style: {
      _props: {},
      setProperty(name, value) { this._props[name] = value; },
      removeProperty(name) { delete this._props[name]; },
      getPropertyValue(name) { return this._props[name] ?? ""; },
    },
    removeAttribute(name) { if (name === "data-bg") delete root.dataset.bg; },
  };
  return { documentElement: root };
}

/** A localStorage stub. `throws` models a browser with site data blocked, which throws on access. */
function fakeStorage(entries = {}, { throws = false } = {}) {
  return {
    reads: [],
    getItem(key) {
      this.reads.push(key);
      if (throws) throw new Error("site data is blocked in this browser");
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
    },
    setItem() {},
  };
}

function bootWith(entries, options) {
  const storage = fakeStorage(entries, options);
  const doc = fakeDocument();
  const stub = loadBrowserScript("ui/machine-room/bg-boot.js", { document: doc, localStorage: storage });
  return { stub, doc, storage, bg: stub.__mrBg };
}

// ---- A1: the plate, before the first pixel --------------------------------------------------

test("a browser with nothing stored opens on the nebula, not the mountains", () => {
  const { doc, bg } = bootWith({});
  assert.equal(bg.DEFAULT_CHOICE, "titan-nebula");
  assert.equal(doc.documentElement.dataset.bg, "titan-nebula");
  assert.equal(doc.documentElement.style.getPropertyValue("--machine-room-bg"), 'url("assets/backgrounds/titan-nebula.webp")');
});

test("a stored choice is the one stamped on the root", () => {
  const { doc } = bootWith({ "machineRoom.background": JSON.stringify("habitat-3") });
  assert.equal(doc.documentElement.dataset.bg, "habitat-3");
  assert.equal(doc.documentElement.style.getPropertyValue("--machine-room-bg"), 'url("assets/backgrounds/habitat-3.webp")');
});

test("Original is a plate like any other -- data-bg is SET for it, not removed", () => {
  // The whole bug. Removing the attribute let styles.css's own mountains stand in as the default,
  // which is what a browser with no stored choice opened on.
  const { doc } = bootWith({ "machineRoom.background": JSON.stringify("original") });
  assert.equal(doc.documentElement.dataset.bg, "original");
  assert.equal(doc.documentElement.style.getPropertyValue("--machine-room-bg"), 'url("assets/warmwind-landscape.svg")');
});

test("a storage read that throws still gets a plate, and it is the default", () => {
  const { doc } = bootWith({}, { throws: true });
  assert.equal(doc.documentElement.dataset.bg, "titan-nebula");
  assert.ok(doc.documentElement.style.getPropertyValue("--machine-room-bg").includes("titan-nebula"));
});

test("an id that is not in the list falls back to the default rather than to no plate", () => {
  const { doc } = bootWith({ "machineRoom.background": JSON.stringify("deleted-plate") });
  assert.equal(doc.documentElement.dataset.bg, "titan-nebula");
});

test("the custom key is not read at all for a built-in id", () => {
  // That array holds data URLs up to 4,000,000 bytes. JSON.parsing it in <head> for every load
  // would cost exactly what this file exists to save.
  const { storage } = bootWith({ "machineRoom.background": JSON.stringify("habitat-3") });
  assert.ok(!storage.reads.includes("machineRoom.backgrounds.custom"), `read ${storage.reads.join(", ")}`);
});

test("a custom id does read the custom key, and takes its data URL", () => {
  const { doc, storage } = bootWith({
    "machineRoom.background": JSON.stringify("custom-42"),
    "machineRoom.backgrounds.custom": JSON.stringify([{ id: "custom-42", full: "data:image/jpeg;base64,AAAA" }]),
  });
  assert.ok(storage.reads.includes("machineRoom.backgrounds.custom"));
  assert.equal(doc.documentElement.dataset.bg, "custom-42");
  assert.equal(doc.documentElement.style.getPropertyValue("--machine-room-bg"), 'url("data:image/jpeg;base64,AAAA")');
});

test("the default is written once across the two background files", async () => {
  // Two copies of the default or of the path rule means a plate added to one of them flashes
  // twice, which is worse than the flash being fixed.
  const [boot, picker] = await Promise.all([read("ui/machine-room/bg-boot.js"), read("ui/machine-room/backgrounds.js")]);
  const hits = (text) => (text.match(/titan-nebula/g) ?? []).length;
  assert.equal(hits(boot) + hits(picker), 1, "the literal `titan-nebula` belongs in exactly one place");
  assert.equal(hits(picker), 0, "backgrounds.js reads the default from bg-boot.js");
  assert.doesNotMatch(picker, /assets\/backgrounds\/\$\{/, "the id-to-file rule belongs in bg-boot.js too");
});

test("backgrounds.js still publishes the list the console knows it by", () => {
  const stub = { document: undefined, localStorage: fakeStorage({}) };
  loadBrowserScript("ui/machine-room/bg-boot.js", stub);
  loadBrowserScript("ui/machine-room/backgrounds.js", stub);
  assert.equal(stub.__machineRoomBackgrounds.DEFAULT_CHOICE, "titan-nebula");
  const ids = stub.__machineRoomBackgrounds.BUILT_IN.map((b) => b.id);
  assert.ok(ids.includes("titan-nebula"));
  assert.ok(ids.includes("original"), "the handoff's own plate is still offered");
});

// bg-boot.js is a blocking <head> script, so it not loading is a deploy fault -- but before the
// guard, the destructure at the top of backgrounds.js threw and took the WHOLE picker with it.
// Measured on console.titanium.bot 2026-09-08 with only bg-boot.js blocked in the browser: pageerror
// "Cannot destructure property 'CHOICE_KEY' of 'boot' as it is undefined", and Operator settings
// opened with no .bg-grid at all and nothing saying why.
test("backgrounds.js survives bg-boot.js not loading, and says so where the tiles would be", () => {
  const stub = { document: undefined, localStorage: fakeStorage({}) };
  assert.doesNotThrow(() => loadBrowserScript("ui/machine-room/backgrounds.js", stub), "a missing bg-boot.js must cost the pre-paint plate and nothing else");
  assert.deepEqual(stub.__machineRoomBackgrounds, { DEFAULT_CHOICE: "", BUILT_IN: [] }, "published under the name the console reads, and deliberately not a second copy of the list");

  const clicks = [];
  const button = () => ({ addEventListener: (type, fn) => clicks.push(fn) });
  const buttons = { "settings-button": button(), "shelf-settings": button() };
  const withPage = {
    localStorage: fakeStorage({}),
    setTimeout: (fn) => fn(),
    document: { readyState: "complete", getElementById: (id) => buttons[id] ?? null, addEventListener() {} },
  };
  loadBrowserScript("ui/machine-room/backgrounds.js", withPage);
  assert.equal(clicks.length, 2, "both settings buttons still open something that explains itself");
  assert.doesNotThrow(() => clicks[0](), "and a click with no panel on screen is not an error either");
});

test("bg-boot.js loads before the first stylesheet, and the modules load with the page", async () => {
  const html = await read("ui/machine-room/index.html");
  const bootAt = html.indexOf('src="bg-boot.js"');
  const firstSheet = html.indexOf('<link rel="stylesheet"');
  assert.notEqual(bootAt, -1, "index.html no longer loads bg-boot.js");
  assert.ok(bootAt < firstSheet, "a classic script placed after a stylesheet waits for it to load");
  for (const module of ["gap-badge.js", "screen-tile.js", "files-viewer.js"]) {
    assert.ok(html.includes(`src="${module}"`), `index.html no longer loads ${module}`);
  }
  for (const sheet of ["boot.css", "gap-badge.css", "screen-tile.css", "files-viewer.css"]) {
    assert.ok(html.includes(`href="${sheet}"`), `index.html no longer loads ${sheet}`);
  }
});

// ---- A2: the CSS floor ------------------------------------------------------------------------

test("no stylesheet paints the mountains as a floor any more", async () => {
  const styles = await read("ui/machine-room/styles.css");
  assert.ok(!styles.includes("warmwind-landscape"), "styles.css still has the mountains as its default plate");
  const backgrounds = await read("ui/machine-room/backgrounds.css");
  assert.match(backgrounds, /html\[data-bg="original"\]/, "picking Original has to give you the mountains back");
});

// ---- A3: the picker's series headings ---------------------------------------------------------

test("a series heading spans the grid instead of taking a tile's cell", async () => {
  const picker = await read("ui/machine-room/backgrounds.js");
  assert.match(picker, /class="field-hint bg-series"/);
  assert.doesNotMatch(picker, /bg-series"\s+style=/, "the inline flex-basis did nothing in a display:grid container");
  const css = await read("ui/machine-room/backgrounds.css");
  assert.match(css, /\.bg-series\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

// ---- A4: the cover ----------------------------------------------------------------------------

/** The lift decision, sliced out of index.html and run on its own. */
async function liftDecision() {
  const html = await read("ui/machine-room/index.html");
  const start = html.indexOf("        function shouldLiftCover(");
  assert.notEqual(start, -1, "index.html no longer defines shouldLiftCover");
  const end = html.indexOf("\n        }\n", start);
  const body = html.slice(start, end + 10);
  return new Function(`var CEILING_MS = 8000;\n${body}\nreturn shouldLiftCover;`)();
}

test("the cover lifts when the roster and the first rows are both on screen", async () => {
  const shouldLift = await liftDecision();
  assert.equal(shouldLift({ roster: true, rows: true, demo: false, elapsed: 1200 }), true);
});

test("the cover stays while either half is still missing", async () => {
  const shouldLift = await liftDecision();
  assert.equal(shouldLift({ roster: true, rows: false, demo: false, elapsed: 1200 }), false);
  assert.equal(shouldLift({ roster: false, rows: true, demo: false, elapsed: 1200 }), false);
  assert.equal(shouldLift({ roster: false, rows: false, demo: false, elapsed: 7999 }), false);
});

test("the ceiling lifts it regardless, at eight seconds", async () => {
  const shouldLift = await liftDecision();
  assert.equal(shouldLift({ roster: false, rows: false, demo: false, elapsed: 8000 }), true);
  assert.equal(shouldLift({ roster: false, rows: false, demo: false, elapsed: 46_318 }), true);
});

test("an unreachable box lifts it at once rather than sitting over the DEMO DATA bar", async () => {
  const shouldLift = await liftDecision();
  assert.equal(shouldLift({ roster: false, rows: false, demo: true, elapsed: 40 }), true);
});

test("the ceiling is armed at parse time and never chained to hydrate's promise", async () => {
  const html = await read("ui/machine-room/index.html");
  assert.match(html, /setTimeout\(settle, CEILING_MS\)/);
  assert.ok(!/bootCover[\s\S]*__bootMachineRoom\(\)\.then/.test(html), "the cover must not wait on the boot promise");
  assert.match(html, /id="boot-cover" data-boot-state="showing"/, "the cover is static markup so it paints with the first paint");
  assert.match(html, /Setting up your console/);
  assert.match(html, /data-boot-step/);
});

/** lift(), sliced out of index.html and run against a fake page. quiet:true takes the no-animation
 *  path, which is the same decision tree without a transitionend to wait on. */
async function runLift(seen) {
  const html = await read("ui/machine-room/index.html");
  const start = html.indexOf("        function lift() {");
  assert.notEqual(start, -1, "index.html no longer defines lift");
  const end = html.indexOf("\n        }\n", start);
  const body = html.slice(start, end + 10);
  const nodes = {
    transcript: { innerHTML: "", querySelector: () => null },
    "room-title": { textContent: "" },
    "room-subtitle": { textContent: "" },
  };
  const doc = { getElementById: (id) => nodes[id] ?? null };
  const cover = { dataset: {}, parentNode: null, addEventListener() {}, querySelector: () => null };
  new Function("document", "window", "seen", "cover", "quiet", `var lifted = false; var observers = []; var removeCover = function () {};\n${body}\nlift();`)(
    doc, { setTimeout() {} }, seen, cover, true,
  );
  return nodes;
}

test("the ceiling with nothing on screen says the box has not been reached, and does not uncover a shell that names one", async () => {
  const stalled = await runLift({ roster: false, rows: false, demo: false });
  assert.match(stalled.transcript.innerHTML, /Still reaching this box/);
  assert.equal(stalled["room-title"].textContent, "Still connecting");
  assert.match(stalled["room-subtitle"].textContent, /has not reached your box/);

  // The roster drew but the conversation has not: the page is real, one column is still opening.
  const opening = await runLift({ roster: true, rows: false, demo: false });
  assert.match(opening.transcript.innerHTML, /Still opening this conversation/);
  assert.equal(opening["room-title"].textContent, "", "app.js owns this field on a page that reached the box");

  // The demo factory is behind the cover: the red DEMO DATA bar already says the box was not
  // reached, so the cover's own copy does not say it a second time.
  const demo = await runLift({ roster: false, rows: false, demo: true });
  assert.match(demo.transcript.innerHTML, /Still opening this conversation/);
  assert.equal(demo["room-title"].textContent, "");
});

// The cover is opaque because index.html used to ship design copy in every field a person reads --
// "MSP Team", "3 members · ready", "2h 14m", "Atera Triage's desktop". Measured on
// console.titanium.bot 2026-09-08 with /api stalled in the browser only: the cover came off at
// 8,675 ms and at 14 s the page still named that team, that agent and that routine, with nothing
// saying anything was wrong. The fields ship empty now, so the ceiling uncovers a blank shell and
// the line above rather than a fiction.
test("no field in the shell ships copy that would read as this box", async () => {
  const html = await read("ui/machine-room/index.html");
  for (const id of ["room-title", "room-subtitle", "capability-scope", "next-routine-countdown", "next-routine-label"]) {
    const match = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html);
    assert.ok(match, `index.html no longer has #${id}`);
    assert.equal(match[1].trim(), "", `#${id} ships copy; app.js fills it, and when app.js never loads that copy is what a person reads`);
  }
  assert.match(html, /<textarea id="message-input"[^>]*placeholder=""/, "the composer no longer offers to message a room that does not exist");
  // The comments in this file quote the old copy on purpose, so the check is on the markup only.
  const markup = html.replaceAll(/<!--[\s\S]*?-->/g, "").replaceAll(/\/\/[^\n]*/g, "");
  assert.ok(!markup.includes("MSP Team"), "the seed room name is fiction on a real box");
  assert.ok(!markup.includes("Atera Triage"), "and it is another company's product name in a paying customer's markup");
  assert.ok(!markup.includes("2h 14m"), "the seed countdown is a routine nobody scheduled");
});

// ---- A5: the scroll ---------------------------------------------------------------------------

/**
 * renderTranscript's scroll rule, sliced out of app.js and run against a fake transcript box. The
 * table is (wasNearBottom x pin x keepScroll) against whether a scrollTop write happens.
 */
async function scrollRule() {
  const source = await read("ui/machine-room/app.js");
  const start = source.indexOf("  function renderTranscript(");
  assert.notEqual(start, -1, "app.js no longer defines renderTranscript");
  const end = source.indexOf("\n  }\n", start);
  const body = source.slice(start, end + 4);
  return new Function(`
    let holdScrollUntil = 0;
    let pinToBottomOnce = false;
    let frames = [];
    const requestAnimationFrame = (fn) => frames.push(fn);
    const elements = { transcript: null };
    const transcriptMarkup = () => "<article class=\\"message-row\\"></article>";
    const fillAttachments = () => {};
    ${body}
    return {
      run({ scrollTop, scrollHeight, clientHeight, pin, keepScroll, pinToRevealed, hold }) {
        frames = [];
        holdScrollUntil = hold ? Date.now() + 3000 : 0;
        pinToBottomOnce = Boolean(pin);
        const box = { scrollTop, scrollHeight, clientHeight, innerHTML: "" };
        elements.transcript = box;
        renderTranscript(keepScroll, pinToRevealed);
        frames.forEach((fn) => fn());
        return { scrollTop: box.scrollTop, moved: box.scrollTop !== scrollTop, pinLeft: pinToBottomOnce };
      },
    };
  `)();
}

test("a reader parked mid-transcript is not moved, whatever keepScroll says", async () => {
  const rule = await scrollRule();
  for (const keepScroll of [true, false]) {
    const out = rule.run({ scrollTop: 4003, scrollHeight: 15_240, clientHeight: 668, pin: false, keepScroll });
    assert.equal(out.moved, false, `keepScroll=${keepScroll} still dragged the reader`);
    assert.equal(out.scrollTop, 4003);
  }
});

test("a reader already at the bottom is still followed by a new row", async () => {
  const rule = await scrollRule();
  for (const keepScroll of [true, false]) {
    const out = rule.run({ scrollTop: 14_540, scrollHeight: 15_240, clientHeight: 668, pin: false, keepScroll });
    assert.equal(out.scrollTop, 15_240, `keepScroll=${keepScroll} stopped the transcript following a reply`);
  }
});

test("the pin takes a parked reader to the bottom exactly once", async () => {
  const rule = await scrollRule();
  const first = rule.run({ scrollTop: 4003, scrollHeight: 15_240, clientHeight: 668, pin: true, keepScroll: false });
  assert.equal(first.scrollTop, 15_240);
  assert.equal(first.pinLeft, false, "the pin is spent by the render it fired on");
  const second = rule.run({ scrollTop: 4003, scrollHeight: 15_240, clientHeight: 668, pin: false, keepScroll: false });
  assert.equal(second.moved, false);
});

test("a revealed row, or a flash still holding, spends the pin without firing it", async () => {
  const rule = await scrollRule();
  assert.equal(rule.run({ scrollTop: 4003, scrollHeight: 15_240, clientHeight: 668, pin: true, keepScroll: true, pinToRevealed: true }).moved, false);
  assert.equal(rule.run({ scrollTop: 4003, scrollHeight: 15_240, clientHeight: 668, pin: true, keepScroll: true, hold: true }).moved, false);
});

test("the transcript container no longer animates every scroll it is given", async () => {
  const styles = await read("ui/machine-room/styles.css");
  const block = styles.slice(styles.indexOf("\n.transcript {"), styles.indexOf("\n.transcript::before"));
  // A declaration, not the word: the comment in place says why it is gone and names it.
  assert.ok(!/^\s*scroll-behavior\s*:/m.test(block), ".transcript still carries scroll-behavior");
  const app = await read("ui/machine-room/app.js");
  assert.match(app, /scrollIntoView\(\{ block: "center", \.\.\.\(gently \? \{ behavior: "smooth" \} : \{\}\) \}\)/, "flashEntry opts into smooth at its own call site");
});

test("the pin is set at the three moments a person expects to be taken to the newest line", async () => {
  const app = await read("ui/machine-room/app.js");
  assert.match(app, /let pinToBottomOnce = true;/, "first paint");
  assert.match(app, /pinTranscriptToBottom\(\);\n\s*adapter\.selectContext/, "a conversation change");
  assert.match(app, /pinTranscriptToBottom\(\);\n\s*adapter\.sendMessage/, "the reader's own send");
  assert.match(app, /if \(event\.type === "context:selected"\) pinTranscriptToBottom\(\)/, "every other route into a conversation");
});

// ---- A6: the seams, each exercised with its module absent -------------------------------------

test("every seam is optional, so item A can merge before B, C and D exist", async () => {
  const app = await read("ui/machine-room/app.js");
  assert.match(app, /window\.__mrUi = \{ openPanel, paragraphMarkup, maskSecrets, escapeHtml, renderAll \}/);
  // Each of the four reads through an optional call or a truth test, never a bare invocation.
  assert.match(app, /const gaps = window\.__gapBadge;[\s\S]{0,400}gaps && typeof gaps\.render === "function"/);
  assert.match(app, /rows\.map\(messageMarkup\)\.join\(""\)/, "with no badge module the transcript is today's rows");
  assert.match(app, /window\.__screenTile\?\.frameFor === "function" \? window\.__screenTile\.frameFor/);
  assert.match(app, /window\.__screenTile\?\.sync\?\.\(/);
  assert.match(app, /window\.__gapBadge\?\.toggle\?\.\(/);
  assert.match(app, /window\.__filesViewer\?\.open\?\.\(/);
});

test("the transcript gap seam still folds repeated rows before anything sees them", async () => {
  const app = await read("ui/machine-room/app.js");
  assert.match(app, /const rows = foldRepeatedRows\(contextMessages\(\)\);/, "DASH-FOLD-1 runs first and stays inside the expanded view");
});

test("the rail tile emits no img it has nothing to put in", async () => {
  const app = await read("ui/machine-room/app.js");
  const start = app.indexOf("  function renderScreenTile(");
  const body = app.slice(start, app.indexOf("\n  }\n", start));
  assert.match(body, /frame\n\s*\? `<img data-rail-screen/, "the img is drawn only where there is a frame");
  assert.ok(!/hidden \/>/.test(body), "a hidden img is what painted Chrome's broken-image glyph");
  assert.match(body, /data-rail-screen-plate>\$\{escapeHtml\(plate\)\}/, "with no frame the tile is a real plate");
  const styles = await read("ui/machine-room/styles.css");
  assert.match(styles, /\.rail-screen-button img\[hidden\]\s*\{\s*display: none;/, "the same guard .handoff-island[hidden] exists for");
});

test("a file row is a control, in both lists, routed to one viewer", async () => {
  const app = await read("ui/machine-room/app.js");
  assert.match(app, /<button class="file-tile" type="button" data-file-open=/, "the desktop's Files list was a div with no handler");
  assert.match(app, /data-attachment-open=/);
  assert.match(app, /data-attachment-download=/);
  // One funnel: a file cannot open one way from one list and another way from the other.
  const opens = app.match(/window\.__filesViewer\?\.open\?\.\(/g) ?? [];
  assert.equal(opens.length, 3, "the desktop tile, Open and Download all go through the same call");
});

// ---- A7: the adapter's data shapes ------------------------------------------------------------

/** The adapter's pure half, sliced out and run with no gateway. */
async function adapterHelpers() {
  const source = await read("ui/machine-room/gateway-adapter.js");
  // `kind` says how the declaration ends: a function body at `\n  }\n`, a multi-line arrow at
  // `\n  };\n`, a one-liner at its own newline.
  const grab = (name, kind = "function") => {
    const needle = kind === "function" ? `  function ${name}(` : `  const ${name} = `;
    const start = source.indexOf(needle);
    assert.notEqual(start, -1, `gateway-adapter.js no longer defines ${name}`);
    const end = kind === "function" ? source.indexOf("\n  }\n", start) + 4
      : kind === "arrow-block" ? source.indexOf("\n  };\n", start) + 5
      : source.indexOf("\n", start) + 1;
    return source.slice(start, end);
  };
  const TOOL_LABELS = source.slice(source.indexOf("  const TOOL_LABELS = "), source.indexOf("\n", source.indexOf("  const TOOL_LABELS = ")));
  return new Function(`
    ${grab("PROBLEM_REPORT_TOOL_CALL", "const")}
    ${grab("PROBLEM_REPORT_ROW_TEXT", "const")}
    ${grab("MAIL_SEND_TOOL_CALL", "const")}
    ${grab("MAIL_SEND_FAILED_PREFIX", "const")}
    ${TOOL_LABELS}
    ${grab("oneLine", "arrow-block")}
    ${grab("baseName", "const")}
    ${grab("shellHeadline")}
    ${grab("readHeadline")}
    ${grab("mailSendRowText")}
    ${grab("toolRowText")}
    ${grab("localPathOf")}
    ${grab("imagesOf", "const")}
    ${grab("IMAGE_EXT", "const")}
    ${grab("attachmentOf")}
    ${grab("isAttachmentEntry", "const")}
    ${grab("filesOf")}
    return { toolRowText, filesOf, isAttachmentEntry, imagesOf, localPathOf, TOOL_LABELS };
  `)();
}

test("toolRowText names the step's kind, from the label table and not from its own headline", async () => {
  const { toolRowText, TOOL_LABELS } = await adapterHelpers();
  for (const [name, label] of Object.entries(TOOL_LABELS)) {
    assert.equal(toolRowText({ name, summary: "", output: "" }).kind, label, `${name} lost its kind`);
  }
  // A shell row whose headline rewrites the text entirely still reports Shell.
  const wrote = toolRowText({ name: "shellToolCall", summary: "cat > notes.md << 'EOF'\nhi\nEOF", output: "" });
  assert.match(wrote.text, /^Wrote notes\.md/);
  assert.equal(wrote.kind, "Shell");
  assert.equal(toolRowText({ name: "somethingElseToolCall" }).kind, "somethingElse");
});

test("a file the agent sent as an images carrier is a file", async () => {
  const { isAttachmentEntry, imagesOf } = await adapterHelpers();
  const carrier = { kind: "send-message", message: { type: "text", content: "Here are the notes.", images: [{ url: "file:///data/notes.md" }] } };
  assert.equal(isAttachmentEntry(carrier), true, "ten of eleven of Titan's files arrive this way");
  assert.equal(imagesOf(carrier).length, 1);
  assert.equal(isAttachmentEntry({ kind: "send-message", message: { type: "text", content: "no files here" } }), false);
  assert.equal(isAttachmentEntry({ kind: "send-message", message: { type: "attachment", url: "file:///data/a.png" } }), true);
  assert.equal(isAttachmentEntry({ kind: "user-attachment", file_path: "/data/up.txt" }), true);
});

test("filesOf lists both carriers, and every path it returns is bare", async () => {
  const { filesOf } = await adapterHelpers();
  const files = filesOf([
    { kind: "user-attachment", file_path: "/data/up.txt", file_name: "up.txt", timestampMs: 10, byteSize: 12 },
    { kind: "send-message", message: { type: "attachment", url: "file:///data/shot.png" }, timestampMs: 20 },
    { kind: "send-message", message: { type: "text", content: "notes", images: [{ url: "file:///data/rsi-vs-agi-notes.md" }, { url: "file:///data/second.md" }] }, timestampMs: 30 },
    { kind: "send-message", message: { type: "text", content: "just words" }, timestampMs: 40 },
  ]);
  assert.equal(files.length, 4, "one upload, one attachment, two images");
  for (const file of files) {
    assert.ok(!file.path.startsWith("file://"), `${file.path} is still a URL -- the host answers null for that form`);
  }
  const names = files.map((f) => f.name);
  assert.ok(names.includes("rsi-vs-agi-notes.md"));
  assert.ok(names.includes("second.md"));
  assert.ok(names.includes("shot.png"));
  assert.ok(names.includes("up.txt"));
});

test("filesOf still shows each path once", async () => {
  const { filesOf } = await adapterHelpers();
  const twice = filesOf([
    { kind: "send-message", message: { type: "text", images: [{ url: "file:///data/one.md" }] }, timestampMs: 10 },
    { kind: "send-message", message: { type: "attachment", url: "/data/one.md" }, timestampMs: 20 },
  ]);
  assert.equal(twice.length, 1);
});

test("messagesOf stamps timestampMs on chat rows and kind on tool rows", async () => {
  const source = await read("ui/machine-room/gateway-adapter.js");
  assert.match(source, /timestampMs: Number\(e\.timestampMs \?\? e\.createdAt\) \|\| 0,/, "the badge needs raw ms; `time` is already formatted for a person");
  assert.match(source, /type: "system", text: e\.text, detail: e\.detail \?\? "", kind: e\.toolKind \?\? ""/);
  assert.match(source, /detail: row\.detail, toolKind: row\.kind/);
  assert.match(source, /\.\.\.\(attachment \? \{ attachment, attachments \} : \{\}\)/, "a message can carry more than one file");
});

test("the outline is refetched while the agent works, and cached otherwise", async () => {
  const source = await read("ui/machine-room/gateway-adapter.js");
  assert.match(source, /const OUTLINE_WORKING_MAX_AGE_MS = 5000;/);
  assert.match(source, /const stale = status === "working" && Date\.now\(\) - \(cached\?\.at \?\? 0\) > OUTLINE_WORKING_MAX_AGE_MS;/);
  assert.match(source, /cached\?\.sig === sig && !stale \? cached\.outline : null/, "the cache is kept, not dropped");
  assert.match(source, /outlineCache\.set\(context\.id, \{ sig, outline, at: Date\.now\(\) \}\)/);
  // Every call site has to pass the status, or the refetch never happens where it matters.
  const calls = source.match(/loadContext\([^)]*\)/g).filter((c) => !c.startsWith("loadContext(context, name"));
  for (const call of calls) assert.match(call, /,\s*(r|activeRecord)\.status\)/, `${call} does not carry the status`);
});

/** The cache decision on its own, so the 5 s edge is measured rather than asserted from source. */
function outlineIsStale(status, ageMs) {
  return status === "working" && ageMs > 5000;
}

test("the refetch happens at working plus five seconds, and not otherwise", () => {
  assert.equal(outlineIsStale("working", 5001), true);
  assert.equal(outlineIsStale("working", 4999), false);
  assert.equal(outlineIsStale("ready", 60_000), false);
  assert.equal(outlineIsStale(undefined, 60_000), false);
});
