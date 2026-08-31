#!/usr/bin/env node
/*
 * Remove third-party test suites from the vendored runtime deps.
 * --------------------------------------------------------------
 * src/app/dist/deps holds packages copied whole, test directories and all. Those suites are
 * written for tape and jest, so a bare `node --test` at the repo root discovers 36 of them and
 * reports 36 failures that have nothing to do with this codebase -- which is exactly the kind of
 * noise that trains everyone to ignore a red suite.
 *
 * They are also dead weight at runtime: nothing imports a dependency's own tests.
 *
 * The tree is gitignored build output, so this is safe to re-run and safe to skip.
 *
 *   node scripts/prune-vendored-tests.mjs [--dry-run]
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["src/app/dist/deps", ".build/app/dist/deps"];
const TEST_DIR = /^(test|tests|jest-tests|__tests__)$/;
// Some packages keep their suite as a loose file at the package root instead of in a directory --
// expand-template/test.js and node-gyp-build/build-test.js are both discovered this way.
const TEST_FILE = /^(test|build-test)\.js$|\.test\.js$/;
const dry = process.argv.includes("--dry-run");

let removed = 0;
let bytes = 0;

function sizeOf(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else { try { total += statSync(full).size; } catch { /* raced */ } }
  }
  return total;
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (!TEST_FILE.test(entry.name)) continue;
      try { bytes += statSync(full).size; } catch { /* raced */ }
      removed += 1;
      console.log(`${dry ? "would remove" : "removed"}  ${full}`);
      if (!dry) rmSync(full, { force: true });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (TEST_DIR.test(entry.name)) {
      bytes += sizeOf(full);
      removed += 1;
      console.log(`${dry ? "would remove" : "removed"}  ${full}`);
      if (!dry) rmSync(full, { recursive: true, force: true });
      continue;
    }
    walk(full);
  }
}

for (const root of ROOTS) walk(root);
console.log(`\n${removed} vendored test path${removed === 1 ? "" : "s"}, ${(bytes / 1024).toFixed(0)}KB`);
