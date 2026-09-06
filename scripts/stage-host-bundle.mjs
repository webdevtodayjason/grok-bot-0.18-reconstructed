#!/usr/bin/env node
// stage-host-bundle.mjs -- write the S3 layout the box's self-upgrade reads into a ship's runtime
// directory (docs/GAP-ANALYSIS.md SHIP-2).
//
//   node scripts/stage-host-bundle.mjs --dir <runtime dir> [--host-main <built bundle>] [--version <sha>]
//
// It writes exactly one file, `sand-host-bundle-latest.version`, beside the host-main.cjs the ship
// already places there. The tarball is NOT written here: the relay composes it inside the box at
// request time, because the archive has to carry the whole of /home/box/sand-host and the parts of
// that tree this repo does not build come from the box image. ui/host-bundle.mjs says why in full.
//
// The version identifies the tree that was shipped. On a clean tree that is the short git sha, which
// is what an operator can look up. On a DIRTY tree there is no such sha -- the commit no longer
// describes the bytes -- so the version is the first 12 hex of the bundle's own sha256 instead, and
// the run says so. Both are inside upstream's SHORT_GIT_SHA_REGEX, which is the only shape the host
// will accept.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LATEST_VERSION_FILE, formatLatestVersionFile } from "../ui/host-bundle.mjs";

export const VERSION_LENGTH = 12;

export function bundleDigestVersion(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, VERSION_LENGTH);
}

// Exported for the unit test: the decision, with no filesystem and no git in it.
export function chooseHostBundleVersion({ requested, gitSha, dirty, bundleBytes }) {
  if (requested != null && requested.length > 0) return { version: requested, source: "requested" };
  if (!dirty && gitSha != null && gitSha.length > 0) return { version: gitSha, source: "git" };
  return { version: bundleDigestVersion(bundleBytes), source: "bundle-digest" };
}

function git(repo, args) {
  // stderr ignored: outside a checkout git says "not a git repository" on every call, and an empty
  // answer already carries that. Printing it would be noise in every unit run.
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

export async function stageHostBundle({ dir, hostMain, version, repo = process.cwd(), log = () => {} }) {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "host-main.cjs");
  if (hostMain != null && path.resolve(hostMain) !== path.resolve(target)) {
    await copyFile(hostMain, target);
    log(`copied ${hostMain} -> ${target}`);
  }
  const bytes = await readFile(target);
  const chosen = chooseHostBundleVersion({
    requested: version,
    gitSha: git(repo, ["rev-parse", `--short=${VERSION_LENGTH}`, "HEAD"]),
    // --untracked-files=no: an untracked scratch file is not part of the bundle and must not
    // demote a commit that does describe it.
    dirty: git(repo, ["status", "--porcelain", "--untracked-files=no"]).length > 0,
    bundleBytes: bytes,
  });
  const versionPath = path.join(dir, LATEST_VERSION_FILE);
  await writeFile(versionPath, formatLatestVersionFile(chosen.version));
  log(`${versionPath} = ${chosen.version} (${chosen.source}), host-main.cjs ${bytes.length} bytes sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}...`);
  return { version: chosen.version, source: chosen.source, versionPath, bundlePath: target, bytes: bytes.length };
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = (name) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  const dir = arg("--dir");
  if (dir == null) { console.error("usage: stage-host-bundle.mjs --dir <runtime dir> [--host-main <file>] [--version <sha>]"); process.exit(2); }
  await stageHostBundle({ dir, hostMain: arg("--host-main"), version: arg("--version"), log: (line) => console.log(`  ${line}`) });
}
