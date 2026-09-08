// The suite's own index, pinned against the directory it claims to cover.
//
// `node --test tests/` is what docs/OPERATOR-RUNBOOK.md tells an operator to run, and this Node
// build cannot take a directory directly: it resolves tests/ as a module and loads tests/index.js,
// which is a hand-written list of imports. A hand-written list of files drifts. This one did.
//
// Measured on this Mac 2026-09-07, before the list was completed: 79 files listed, 101 files on
// disk, `node --test tests/` reporting 891 tests where `node --test tests/*.test.mjs` reported
// 1101. That is the shape of the failure, and it is the worst shape a test failure can take: not
// red, not skipped, absent. Twenty-two files' worth of coverage read as green because nothing ran
// it, including the relay's sign-in ledger, the whole control-plane group, onboarding, and the
// browser tools that were added the same day.
//
// The list cannot be replaced by a readdir. A dynamic `await import` registers its tests after the
// runner has already begun, so the run ends after the first file or two; static imports are
// hoisted and resolve before the module body runs. So the list stays hand-written, and this test
// is the thing that makes hand-written safe: add a file to tests/ without adding it to the index
// and the suite goes red, here, with the file named.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const onDisk = () => readdirSync(here).filter((name) => name.endsWith(".test.mjs")).sort();

// A suite may be left out of the index ON PURPOSE, and exactly one is. The point of this file is
// that an omission is DECLARED rather than discovered, so the exception has to be written down
// here, with the reason, and the file has to still exist. An accidental omission is still red.
const DELIBERATELY_NOT_INDEXED = {
  "cursor-loops-off.test.mjs":
    "it moves SAND_DATA_ROOT to prove a live box picks a new backend out of the settings file, and "
    + "this index loads every suite into ONE process. It runs on the `npm test` glob, where each "
    + "file gets a process to itself.",
};

// Only real import statements, so the explanation in the file's own comments cannot satisfy it.
const listed = () => {
  const body = readFileSync(path.join(here, "index.js"), "utf8");
  return [...body.matchAll(/^\s*import\s+"\.\/([^"]+\.test\.mjs)";/gm)].map((match) => match[1]).sort();
};

test("tests/index.js imports every suite in tests/, so `node --test tests/` runs all of them", () => {
  const files = onDisk();
  const imports = listed();
  assert.ok(files.length > 50, `only ${files.length} suites found in ${here}; the reader is wrong, not the tree`);

  const missing = files.filter((name) => !imports.includes(name) && DELIBERATELY_NOT_INDEXED[name] === undefined);
  assert.deepEqual(missing, [],
    "these suites are in tests/ but not in tests/index.js, so `node --test tests/` skips them "
    + "silently. Add a line for each to tests/index.js: "
    + missing.map((name) => `import "./${name}";`).join(" "));
});

test("and every deliberate omission names a file that is really there, with a reason", () => {
  const files = onDisk();
  for (const [name, reason] of Object.entries(DELIBERATELY_NOT_INDEXED)) {
    assert.ok(files.includes(name), `${name} is excused from the index but no longer exists; delete the excuse`);
    assert.ok(reason.length > 40, `${name} is excused with no real reason written down`);
    assert.ok(!listed().includes(name), `${name} is both excused and imported; pick one`);
  }
});

test("and imports nothing that is not there, so a rename fails loudly instead of at import time", () => {
  const files = onDisk();
  const stale = listed().filter((name) => !files.includes(name));
  assert.deepEqual(stale, [], `tests/index.js imports files that no longer exist: ${stale.join(", ")}`);
});

test("and names each suite once, because a duplicate import is a merge that went wrong", () => {
  const imports = listed();
  const seen = new Set();
  const twice = imports.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
  assert.deepEqual(twice, [], `listed more than once in tests/index.js: ${twice.join(", ")}`);
});
