// The console's own side of the cloud browser.
//
// This file exists because of one measured miss. ui/machine-room/cloud-browser.js shipped whole --
// 290 lines, self-mounting, with a Computer-card strip, a live-view frame and a take-over row --
// and index.html never loaded it. Measured on the R750's relay container on 2026-09-09: the file
// was served and `grep -c cloud-browser.js index.html` was 0. So the module never ran on any box,
// a person could never take over a cloud session, and two documents said they could.
//
// The gate (scripts/verify-browser-tools.mjs) opens the console in a real browser and asserts the
// strip is on screen, which is the only thing that proves a person sees it. This pins the part a
// browser is a slow place to pin: the tag is there, it loads with its siblings rather than after
// app.js has painted, and the module keeps the contract that lets it be loaded that early.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");

test("the console loads the cloud browser module, beside its siblings and before app.js", async () => {
  const index = await read("ui/machine-room/index.html");
  assert.match(index, /<script src="cloud-browser\.js"><\/script>/, "the module the whole console side lives in must be loaded");
  const at = index.indexOf('<script src="cloud-browser.js">');
  const app = index.search(/<script src="app\.js"/);
  const bots = index.indexOf('<script src="marketplace-bots.js">');
  assert.ok(bots >= 0 && at > bots, "it loads after the other window-global modules, the way they load after the adapter");
  if (app >= 0) assert.ok(at < app, "and before app.js paints, so the strip is not added a tick late");
});

test("the module publishes its global and mounts itself, which is what makes one script tag enough", async () => {
  const source = await read("ui/machine-room/cloud-browser.js");
  assert.match(source, /global\.__cloudBrowser = \{/, "app.js does not call this module; it has to publish itself");
  assert.match(source, /addEventListener\("DOMContentLoaded"/, "and mount itself whichever way the page loaded");
  assert.match(source, /querySelector\("#rail-screen"\)/, "the strip goes in the Computer card, which is a static node in index.html");
  // Nothing here may write a node app.js owns: three waves paint this console at once.
  assert.ok(!/innerHTML\s*=/.test(source.replace(/held\.outerHTML = markup;/, "")), "it may add siblings of its own, never rewrite somebody else's node");
});

// CONSOLE-6. The module's observer watches the whole body, so an unguarded write is a loop: the write
// is a mutation, the mutation schedules a paint, the paint writes again, one per animation frame for
// the life of the page. Measured in real Chrome on grok-bot-local-vm 2026-09-11, before the guard:
// #rail-screen's children were replaced 603 times in 10 seconds on an idle console with nobody typing,
// the strip's words identical every time, and the whole page's mutation rate was 211 records a second
// against 6 afterwards. Jason's "the entire page flickers when I am typing in the bot" was this.
test("CONSOLE-6: every write this module makes is guarded on a change, so its own observer cannot loop", async () => {
  const source = await read("ui/machine-room/cloud-browser.js");
  assert.match(source, /let paintedStrip = ""/, "the markup last written has to be remembered, or there is nothing to compare against");
  assert.match(source, /else if \(markup !== paintedStrip\) \{\s*\n\s*held\.outerHTML = markup;/,
    "the rail strip may only be rewritten when its markup actually changed");
  assert.match(source, /__cloudBrowserMarkup === wanted\) continue;/,
    "a take-over card already carrying the markup this module wants is left alone: the session id it compared before is absent on a session with no live view, so that test read null against \"\" and rebuilt the card every frame");
  // Both branches have to set the memory or the next paint writes again regardless.
  assert.match(source, /rail\.insertAdjacentHTML\("beforeend", markup\);\s*\n\s*paintedStrip = markup;/,
    "the memory is set where the strip is first inserted too");
});

test("no vendor is named in anything the person reads on it", async () => {
  const source = await read("ui/machine-room/cloud-browser.js");
  // Comments explain which vendors exist; the strings a person is shown must not.
  const strings = [...source.matchAll(/`([^`]*)`/g)].map((match) => match[1])
    .concat([...source.matchAll(/"([^"\n]*)"/g)].map((match) => match[1]));
  const named = strings.filter((text) => /browserbase|browser use/i.test(text));
  assert.deepEqual(named, [], `a vendor name reached the console's own words: ${named.join(" | ")}`);
});
