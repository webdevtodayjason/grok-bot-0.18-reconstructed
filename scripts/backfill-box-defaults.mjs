#!/usr/bin/env node
// backfill-box-defaults.mjs -- TENANT-8, for the tenants that were provisioned before the step existed.
//
// cp/provision.mjs now writes deploy/box-defaults/ into a new tenant's data directory. The tenants
// already on the R750 were built before that, and measured 2026-09-08 gates.json was missing from
// every one of /data/titanbot/{demo,richard-avery,north-bay-roofing}/volumes/data. That file is
// where sand_auto_review:false and the rest of the CURSOR-1 pins live, so without it a tenant's box
// falls through to whatever the bundled gate table happens to be -- which is what made three boxes
// on one bundle behave three ways.
//
// IT ONLY ADDS. A file already in a tenant's directory is left exactly as it is and reported as
// skipped: an operator may have changed a switch, and a default is what a box starts with rather
// than what it is held to. It recreates nothing and restarts nothing (BOX-6: a recreate of a live
// instance is the thing that corrupts an agent store). A box picks the file up on its next ordinary
// restart, and until then it behaves exactly as it did before this ran.
//
// It prints NAMES ONLY -- never a value, never a token -- because two of the neighbours in that
// directory are box-secrets.json and connector-env-secrets.json.
//
//   node scripts/backfill-box-defaults.mjs --dry-run     say what it would add, change nothing
//   node scripts/backfill-box-defaults.mjs               add what is missing
//   node scripts/backfill-box-defaults.mjs --root /data/titanbot --tenant demo
import { accessSync, chownSync, constants, existsSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const DRY = args.includes("--dry-run");
const ROOT = arg("--root", "/data/titanbot");
const ONLY = arg("--tenant", null);
const DEFAULTS = arg("--defaults", path.join(repoRoot, "deploy", "box-defaults"));

const say = (m) => console.log(`  ${m}`);
const step = (m) => console.log(`\n== ${m}`);

if (!existsSync(DEFAULTS)) { console.error(`FAILED: ${DEFAULTS} does not exist`); process.exit(1); }
if (!existsSync(ROOT)) { console.error(`FAILED: ${ROOT} does not exist; run this on the host that holds the tenant trees`); process.exit(1); }

const defaults = readdirSync(DEFAULTS).filter((n) => n.endsWith(".json")).sort();
step(`defaults: ${defaults.join(", ")}`);

// A tenant tree is a directory under the root with volumes/data in it. Deliberately the directory
// listing rather than the control plane's table: TENANT-8's other half is a tenant tree the control
// plane has never heard of, and a backfill that reads the table would skip exactly that one.
const tenants = readdirSync(ROOT)
  .filter((name) => (ONLY == null || name === ONLY))
  .filter((name) => { try { return statSync(path.join(ROOT, name)).isDirectory(); } catch { return false; } })
  .filter((name) => existsSync(path.join(ROOT, name, "volumes", "data")))
  .sort();

if (tenants.length === 0) { console.error(`FAILED: no tenant tree with volumes/data under ${ROOT}`); process.exit(1); }

// AN UNREADABLE DIRECTORY IS NOT AN EMPTY ONE, and this check exists because the first run of this
// script said otherwise. The tenant data directories on the R750 are mode 700 owned by the box's
// user; run as anybody else, `existsSync` answers false for every file in them, so a dry run
// reported it would add two files to three tenants that between them already had four of the six.
// A backfill that cannot see what is there must refuse, not guess.
let blocked = 0;
let added = 0;
for (const tenant of tenants) {
  const data = path.join(ROOT, tenant, "volumes", "data");
  step(`${tenant}`);
  try {
    accessSync(data, constants.R_OK | constants.X_OK | (DRY ? 0 : constants.W_OK));
  } catch {
    let owner = "?";
    try { const info = statSync(data); owner = `mode ${(info.mode & 0o777).toString(8)}, uid ${info.uid}`; } catch {}
    say(`BLOCKED cannot read ${data} (${owner}); every file in it would read as missing, so nothing is reported for this tenant`);
    say(`        re-run this with the user that owns it, or with sudo`);
    blocked += 1;
    continue;
  }
  for (const name of defaults) {
    const target = path.join(data, name);
    if (existsSync(target)) {
      let mode = "?";
      try { mode = (statSync(target).mode & 0o777).toString(8); } catch {}
      say(`skipped ${name} (already there, mode ${mode})`);
      continue;
    }
    if (DRY) { say(`would add ${name}`); added += 1; continue; }
    writeFileSync(target, readFileSync(path.join(DEFAULTS, name), "utf8"), { mode: 0o600 });
    chmodSync(target, 0o600);
    // Match the directory's owner. This is normally run with sudo (the tenant data directories are
    // mode 700 owned by the box's user), and a root-owned file in a tree the box's own user owns is
    // a file the box may not be able to rewrite when the console next changes a switch.
    let ownership = "";
    try {
      const dir = statSync(data);
      chownSync(target, dir.uid, dir.gid);
      ownership = `, uid ${dir.uid}`;
    } catch {
      ownership = ", owner unchanged";
    }
    say(`added ${name} at 0600${ownership}`);
    added += 1;
  }
}

step("result");
const reached = tenants.length - blocked;
say(DRY ? `${added} file(s) would be added across ${reached} tenant(s); nothing was changed`
        : `${added} file(s) added across ${reached} tenant(s)`);
if (!DRY && added > 0) say("each box picks these up on its next ordinary restart; nothing here restarts or recreates one");
if (blocked > 0) {
  say(`${blocked} tenant(s) could not be read at all, so this run says nothing about them`);
  process.exit(1);
}
