// The host-only ship's two artifacts: the version file and the tarball layout (SHIP-2).
//
// Both shapes are dictated by code this repo does not own -- upstream's host-bundle-source.ts on the
// fetching side, and the box image's /usr/local/bin/sand-supervisor.mjs on the receiving side -- so
// these cases pin what was read out of them rather than what would have been convenient:
//
//   the version is a short git sha and nothing else. SHORT_GIT_SHA_REGEX rejects anything longer,
//   shorter or non-hex before a tarball is ever requested, so a version file the host silently
//   ignores is the failure this shape prevents.
//
//   the archive's top level is `sand-host`, its version marker must equal the requested version, and
//   the supervisor PRUNES every entry of /home/box/sand-host the archive does not carry. That last
//   rule is why the compose script copies the box's own tree in first: a tarball holding only
//   host-main.cjs would delete box-scripts, extensions, node_modules and the workers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  HOST_BUNDLE_VERSION_RE, LATEST_VERSION_FILE, composeHostBundleScript, formatLatestVersionFile,
  parseLatestVersionFile, parseRuntimeRequest,
} from "../ui/host-bundle.mjs";
import { chooseHostBundleVersion, stageHostBundle } from "../scripts/stage-host-bundle.mjs";

const root = mkdtempSync(path.join(tmpdir(), "host-bundle-ship-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("the runtime route only answers the two files the host asks for", () => {
  const token = "a".repeat(64);
  assert.deepEqual(parseRuntimeRequest(`/runtime/${token}/${LATEST_VERSION_FILE}`), { token, kind: "version" });
  assert.deepEqual(parseRuntimeRequest(`/runtime/${token}/sand-host-bundle-abc1234.tgz`), { token, kind: "tarball", version: "abc1234" });
  // Anything else is not a bundle request at all: no directory listing, no arbitrary file out of the
  // runtime directory, and no deeper path to walk with.
  assert.equal(parseRuntimeRequest(`/runtime/${token}/host-main.cjs`), null);
  assert.equal(parseRuntimeRequest(`/runtime/${token}/../../etc/passwd`), null);
  assert.equal(parseRuntimeRequest(`/runtime/${token}/nested/sand-host-bundle-abc1234.tgz`), null);
  assert.equal(parseRuntimeRequest(`/runtime/${token}`), null);
  assert.equal(parseRuntimeRequest("/api/getHostStatus"), null);
  // A version outside upstream's regex is not a tarball name here either, because the host would
  // refuse it on arrival and the relay would have composed 25 MB for nothing.
  assert.equal(parseRuntimeRequest(`/runtime/${token}/sand-host-bundle-XYZ.tgz`), null);
  assert.equal(parseRuntimeRequest(`/runtime/${token}/sand-host-bundle-abc12.tgz`), null);
});

test("the version file is one short git sha, trailing newline and all", () => {
  assert.equal(formatLatestVersionFile("be467fd57272"), "be467fd57272\n");
  assert.equal(parseLatestVersionFile("be467fd57272\n"), "be467fd57272");
  assert.equal(parseLatestVersionFile("  be467fd57272  "), "be467fd57272");
  // The failure this catches: a staging step that wrote a message, a path or an empty file, which
  // the host would answer by simply never updating and never saying why.
  assert.equal(parseLatestVersionFile(""), null);
  assert.equal(parseLatestVersionFile("latest"), null);
  assert.equal(parseLatestVersionFile("be467fd57272 (dirty)"), null);
  assert.equal(parseLatestVersionFile(null), null);
  assert.throws(() => formatLatestVersionFile("not-a-sha"), /not a short git sha/);
  assert.ok(HOST_BUNDLE_VERSION_RE.test("abc1234") && !HOST_BUNDLE_VERSION_RE.test("abc123"));
});

test("the compose script builds sand-host/, replaces the bundle, and writes the asked-for version", () => {
  const script = composeHostBundleScript({ version: "abc1234def5" });
  // The whole tree, from the box's own /home/box, is the base. Without this line the supervisor's
  // prune deletes everything the archive does not carry.
  assert.match(script, /tar -cf - -C \/home\/box .*sand-host \| tar -xf - -C/);
  // ...except the two entries that must come from the ship rather than from the box.
  assert.match(script, /--exclude=sand-host\/host-main\.cjs/);
  assert.match(script, /--exclude=sand-host\/version/);
  assert.match(script, /cp \/tmp\/sand-host-bundle-incoming\.cjs \S+\/sand-host\/host-main\.cjs/);
  assert.match(script, /printf '%s\\n' 'abc1234def5' > \S+\/sand-host\/version/);
  assert.match(script, /tar -czf \S+ -C \S+ sand-host$/m);
  // set -e first: a stage that half-built must not be tarred up and served as a bundle.
  assert.equal(script.split("\n")[0], "set -e");
  assert.throws(() => composeHostBundleScript({ version: "; rm -rf /" }), /not a short git sha/);
  assert.throws(() => composeHostBundleScript({ version: "" }), /not a short git sha/);
});

test("a clean tree ships its git sha; a dirty one ships the bundle's own digest", () => {
  const bytes = Buffer.from("bundle");
  assert.deepEqual(chooseHostBundleVersion({ gitSha: "1234abcd9999", dirty: false, bundleBytes: bytes }),
    { version: "1234abcd9999", source: "git" });
  // A dirty tree's commit does not describe the bytes, so naming it would be a lie an operator
  // would later use to decide what is running.
  assert.equal(chooseHostBundleVersion({ gitSha: "1234abcd9999", dirty: true, bundleBytes: bytes }).source, "bundle-digest");
  assert.match(chooseHostBundleVersion({ gitSha: "", dirty: false, bundleBytes: bytes }).version, HOST_BUNDLE_VERSION_RE);
  assert.deepEqual(chooseHostBundleVersion({ requested: "feedface", gitSha: "1234abcd9999", dirty: false, bundleBytes: bytes }),
    { version: "feedface", source: "requested" });
  // Different bytes, different version: this is what makes a re-ship of a changed bundle visible to
  // the box at all.
  assert.notEqual(chooseHostBundleVersion({ dirty: true, bundleBytes: Buffer.from("a") }).version,
    chooseHostBundleVersion({ dirty: true, bundleBytes: Buffer.from("b") }).version);
});

test("staging writes the version beside the bundle it describes", async () => {
  const dir = path.join(root, "runtime");
  const source = path.join(root, "host-main.cjs");
  writeFileSync(source, "console.log('host')\n");
  const first = await stageHostBundle({ dir, hostMain: source, repo: root });
  assert.equal(readFileSync(path.join(dir, LATEST_VERSION_FILE), "utf8"), `${first.version}\n`);
  assert.equal(readFileSync(path.join(dir, "host-main.cjs"), "utf8"), "console.log('host')\n");
  // Restaging in place, with no source, re-reads the bundle that is there. That is how the ship's
  // version follows the bytes rather than the call.
  writeFileSync(path.join(dir, "host-main.cjs"), "console.log('host')\n// changed\n");
  const second = await stageHostBundle({ dir, repo: root });
  assert.notEqual(second.version, first.version);
  assert.equal(readFileSync(path.join(dir, LATEST_VERSION_FILE), "utf8"), `${second.version}\n`);
});
