// QOL-LOGOS. The Marketplace draws a real logo where one exists, and every one of them is a FILE
// IN THIS REPO.
//
// The claim this file exists to hold is the one that goes wrong silently: a catalog entry names
// `marketplace/logos/<something>` that nobody committed, the browser 404s it, and the card quietly
// falls back to its letter tile -- which looks exactly like a plugin that was never given a logo.
// Nothing about that failure is visible without opening the page, so it is pinned here:
//
//  1. Every path the catalog names -- `icon.file` on a plugin, `tile.file` on a bot template --
//     resolves to a file under ui/machine-room/, is not empty, and is really a PNG or an SVG.
//  2. The catalog names no URL. The console fetches nothing from the internet; a logo that is not
//     in the repo is a card that goes blank on a box with no outbound network.
//  3. NOTICE.md names every one of those files, with where it came from -- and every file in the
//     logos directory is named by NOTICE.md, so a logo cannot be dropped in unattributed.
//
// It runs against the catalog module itself, bundled the way tests/marketplace-catalog.test.mjs
// bundles it, so a rename in either the catalog or the directory fails here rather than on the box.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".marketplace-logos-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const result = await build({
  entryPoints: [path.join(repoRoot, "source/shared/marketplace/catalog.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const bundled = path.join(stage, "marketplace-catalog.cjs");
writeFileSync(bundled, result.outputFiles[0].text, "utf8");
const catalog = createRequire(import.meta.url)(bundled);

const CONSOLE_ROOT = path.join(repoRoot, "ui/machine-room");
const LOGO_DIR = path.join(CONSOLE_ROOT, "marketplace/logos");
const NOTICE = path.join(LOGO_DIR, "NOTICE.md");

// [what it is, the path the catalog names], for every image in the whole catalog.
const named = [
  ...catalog.MARKETPLACE_PLUGINS.map((plugin) => [`plugin "${plugin.id}"`, plugin.icon?.file]),
  ...catalog.MARKETPLACE_BOTS.map((bot) => [`bot "${bot.id}"`, bot.tile?.file]),
].filter(([, file]) => file != null);

test("every logo the catalog names is a file in this repo", () => {
  assert.ok(named.length > 0, "the catalog names no logo at all; this wave gave it some");
  for (const [who, file] of named) {
    assert.equal(catalog.marketplaceLogoProblem(who, file), null, `${who}: ${file}`);
    const resolved = path.resolve(CONSOLE_ROOT, file);
    assert.ok(resolved.startsWith(`${CONSOLE_ROOT}${path.sep}`), `${who} names a path outside the console: ${file}`);
    assert.ok(existsSync(resolved), `${who} names ${file}, which is not in the repo`);
    assert.ok(statSync(resolved).size > 0, `${who} names ${file}, which is empty`);
    // The bytes, not the extension: an error page saved as .png would pass every check above.
    const head = readFileSync(resolved).subarray(0, 8);
    if (file.endsWith(".png")) {
      assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
    } else {
      assert.match(readFileSync(resolved, "utf8").slice(0, 400), /<svg[\s>]/, `${file} is not an SVG`);
    }
  }
});

test("the catalog fetches nothing: no logo is a URL, and no path climbs out of the console", () => {
  for (const [who, file] of named) {
    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(file) && !file.startsWith("//"), `${who} names a URL: ${file}`);
    assert.ok(file.startsWith("marketplace/logos/"), `${who} names a path outside the logos directory: ${file}`);
  }
  // And the rule itself, so a future entry cannot slip a URL past validateMarketplaceCatalog.
  for (const bad of ["https://example.com/logo.svg", "//example.com/logo.svg", "/etc/passwd",
    "marketplace/logos/../../server.mjs", "elsewhere/logo.svg", "marketplace/logos/logo.gif"]) {
    assert.notEqual(catalog.marketplaceLogoProblem("probe", bad), null, `${bad} should be refused`);
  }
  assert.equal(catalog.marketplaceLogoProblem("probe", undefined), null, "no logo at all is not a problem");
  assert.deepEqual(catalog.validateMarketplaceCatalog(), [], "the catalog's own invariants");
});

test("NOTICE.md names every logo file, and the directory holds nothing it does not name", () => {
  assert.ok(existsSync(NOTICE), "ui/machine-room/marketplace/logos/NOTICE.md is missing");
  const notice = readFileSync(NOTICE, "utf8");
  const onDisk = readdirSync(LOGO_DIR).filter((entry) => entry !== "NOTICE.md").sort();
  for (const file of onDisk) {
    assert.ok(notice.includes(file), `NOTICE.md does not name ${file}: every image here needs its source and licence`);
  }
  for (const [who, file] of named) {
    assert.ok(notice.includes(path.basename(file)), `NOTICE.md does not name ${path.basename(file)}, which ${who} draws`);
  }
  // A file nobody draws is dead weight in the bundle's neighbour directory; the catalog is the
  // only reason to carry one.
  const drawn = new Set(named.map(([, file]) => path.basename(file)));
  const orphans = onDisk.filter((file) => !drawn.has(file));
  assert.deepEqual(orphans, [], "logo files in the directory that no catalog entry draws");
});
