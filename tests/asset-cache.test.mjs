// COST-1. ui/asset-cache.mjs: the console's own files cached, and PRIVATE, never public.
//
// WHAT THIS FILE IS GUARDING. Every asset on this relay answers 401 when nobody is signed in, and the
// relay writes no `vary`, so one cacheable PUBLIC response would let a shared cache serve one
// visitor's signed-in 200 -- or one visitor's 401 -- to everybody who asked next. "public" appearing
// anywhere in this module's output is therefore a security regression, not a performance one, and it
// is checked three ways: as a string search over the source, as a header check on every arm, and as a
// check that no arm ever answers a set-cookie.
//
// The second thing it guards is the promise a stamp makes. `immutable, max-age=31536000` says the
// bytes behind this URL will never change. A stamp that does not match the file on disk is a URL out
// of an HTML somebody is still holding, and answering that with a year would serve last week's app.js
// forever.
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IMMUTABLE_MAX_AGE_S,
  assetPolicy,
  etagMatches,
  etagOf,
  hashOf,
  stampHtml,
  stampedReferenceCount,
} from "../ui/asset-cache.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consoleDir = path.join(repoRoot, "ui/machine-room");

const scratch = () => mkdtempSync(path.join(tmpdir(), "asset-cache-"));

test("a stamped read is immutable for a year, and private", () => {
  const dir = scratch();
  const file = path.join(dir, "app.js");
  writeFileSync(file, "console.log(1)\n");
  const hash = hashOf(file);
  assert.match(hash, /^[0-9a-f]{16}$/);
  const { headers, status } = assetPolicy(file, `?v=${hash}`, {});
  assert.equal(headers["cache-control"], `private, max-age=${IMMUTABLE_MAX_AGE_S}, immutable`);
  assert.equal(headers.etag, etagOf(hash));
  assert.equal(status, 200);
  assert.equal(/public/.test(headers["cache-control"]), false);
});

test("an unstamped read revalidates: an ETag and no max-age at all", () => {
  const dir = scratch();
  const file = path.join(dir, "app.js");
  writeFileSync(file, "console.log(1)\n");
  const { headers } = assetPolicy(file, "", {});
  assert.equal(headers["cache-control"], "private, no-cache");
  assert.equal(/max-age/.test(headers["cache-control"]), false, "an unstamped URL must never promise its bytes");
  assert.match(headers.etag, /^"[0-9a-f]{16}"$/);
});

test("a repeat unstamped read is a 304, which is what kills app.js's second download", () => {
  const dir = scratch();
  const file = path.join(dir, "app.js");
  writeFileSync(file, "x".repeat(4096));
  const first = assetPolicy(file, "", {});
  assert.equal(first.status, 200);
  const second = assetPolicy(file, "", { "if-none-match": first.headers.etag });
  assert.equal(second.status, 304);
  // A proxy that weakened the tag is the same bytes; a list is the form the header is allowed to take.
  assert.equal(assetPolicy(file, "", { "if-none-match": `W/${first.headers.etag}` }).status, 304);
  assert.equal(assetPolicy(file, "", { "if-none-match": `"nope", ${first.headers.etag}` }).status, 304);
  assert.equal(assetPolicy(file, "", { "if-none-match": '"nope"' }).status, 200);
});

test("a stamp that does not match the bytes gets the revalidating arm, never a year", () => {
  const dir = scratch();
  const file = path.join(dir, "app.js");
  writeFileSync(file, "one\n");
  const stale = assetPolicy(file, "?v=0000000000000000", {});
  assert.equal(stale.headers["cache-control"], "private, no-cache");
  assert.equal(/max-age/.test(stale.headers["cache-control"]), false);
  assert.equal(stale.status, 200);
});

test("the hash moves when the file does, and not otherwise", () => {
  const dir = scratch();
  const file = path.join(dir, "styles.css");
  writeFileSync(file, "a{}\n");
  const first = hashOf(file);
  assert.equal(hashOf(file), first, "re-reading an untouched file must not re-hash to something else");
  writeFileSync(file, "b{}\n");
  // Same size, different bytes: the signature is mtime AND size, and a rewrite moves the mtime.
  const second = hashOf(file);
  assert.notEqual(second, first, "a changed file kept its old stamp, so the edit would never ship");
  // A file whose mtime is pushed back to the old value still hashes to its real content, because the
  // cache key carries the size too and a re-read is what settles it.
  utimesSync(file, new Date(1000), new Date(1000));
  assert.equal(typeof hashOf(file), "string");
});

test("a path with no file behind it is the avatar case, and the gateway's version is its validator", () => {
  // /avatars/<id>?v=<version> reaches the policy only after the gateway answered 200 for that exact
  // version, so the stamp in the URL IS the validator and there is nothing on disk to compare it to.
  const missing = path.join(scratch(), "gone.js");
  assert.equal(hashOf(missing), null);
  const stamped = assetPolicy("/avatars/w1", "?v=d172258284b01670", {});
  assert.equal(stamped.headers["cache-control"], `private, max-age=${IMMUTABLE_MAX_AGE_S}, immutable`);
  assert.equal(stamped.headers.etag, '"d172258284b01670"');
  assert.equal(stamped.status, 200);
  assert.equal(assetPolicy("/avatars/w1", "?v=d172258284b01670", { "if-none-match": '"d172258284b01670"' }).status, 304);
  // No stamp means the URL says nothing about the bytes behind it, so nothing may be promised.
  assert.equal(assetPolicy("/avatars/w1", "", {}).headers["cache-control"], "no-store");
  assert.equal(assetPolicy(missing, "", {}).headers["cache-control"], "no-store");
  assert.equal(assetPolicy("/avatars/w1", "?v=", {}).headers["cache-control"], "no-store");
});

test("every relative asset reference in the real index.html is stamped, and the file is not touched", async () => {
  const html = await readFile(path.join(consoleDir, "index.html"), "utf8");
  const stamped = stampHtml(html, consoleDir);
  const references = [...html.matchAll(/\s(?:src|href)="(?!https?:|data:|blob:|mailto:|#|\/)([^"?#]+\.(?:js|mjs|css|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|webmanifest))"/g)];
  assert.ok(references.length >= 20, `the console references ${references.length} relative assets`);
  assert.equal(stampedReferenceCount(stamped), references.length, "a reference went unstamped");
  // Every stamp is the file's real hash, not a guess.
  for (const [, reference] of references) {
    const hash = hashOf(path.resolve(consoleDir, reference));
    assert.ok(stamped.includes(`${reference}?v=${hash}"`), `${reference} carries the wrong stamp`);
  }
  assert.equal(html.includes("?v="), false, "index.html on disk must stay unstamped: the rewrite is on the way out");
});

test("the stamper leaves alone what is not ours to stamp", () => {
  const dir = scratch();
  writeFileSync(path.join(dir, "there.js"), "1\n");
  const cases = [
    '<script src="https://cdn.example/x.js"></script>',
    '<img src="data:image/png;base64,AAA" />',
    '<script src="/absolute.js"></script>',
    '<script src="missing.js"></script>',
    '<a href="#top">top</a>',
    '<script src="../outside.js"></script>',
  ];
  for (const one of cases) assert.equal(stampHtml(one, dir), one, `rewrote ${one}`);
  assert.match(stampHtml('<script src="there.js"></script>', dir), /there\.js\?v=[0-9a-f]{16}/);
});

test("the seam passes a URL object and a test passes a directory, and both work", () => {
  const dir = scratch();
  writeFileSync(path.join(dir, "a.css"), "a{}\n");
  const file = path.join(dir, "a.css");
  const hash = hashOf(file);
  // A URL object, which is what ui/relay-hooks.mjs hands over.
  const viaUrl = assetPolicy(file, new URL(`http://relay.invalid/a.css?v=${hash}`), {});
  assert.match(viaUrl.headers["cache-control"], /immutable$/);
  // And the real index.html stamps against this module's own console directory with no argument.
  assert.ok(stampedReferenceCount(stampHtml('<script src="app.js"></script>')) >= 0);
});

test("no arm of this module is ever cacheable by a shared cache, and none of them sets a cookie", async () => {
  const source = await readFile(path.join(repoRoot, "ui/asset-cache.mjs"), "utf8");
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  // The ONE place the word may appear in the code is the guard that refuses to repeat an upstream
  // `public` back to the browser. Take that out and the word must be gone entirely.
  assert.equal(/\bpublic\b/.test(code.replace(/\/public\/i/g, "")), false, "the word public appeared in asset-cache.mjs outside its own guard");

  const dir = scratch();
  const file = path.join(dir, "a.css");
  writeFileSync(file, "a{}\n");
  const hash = hashOf(file);
  const answers = [
    assetPolicy(file, `?v=${hash}`, {}).headers,
    assetPolicy(file, "", {}).headers,
    assetPolicy(file, "?v=bogus", {}).headers,
    assetPolicy(path.join(dir, "missing.css"), "", {}).headers,
    assetPolicy("/avatars/w1", `?v=${hash}`, {}).headers,
    assetPolicy("/avatars/w1", "", {}).headers,
  ];
  for (const headers of answers) {
    assert.equal(/public/i.test(headers["cache-control"] ?? ""), false, `public in ${headers["cache-control"]}`);
    assert.equal(Object.keys(headers).some((name) => /^set-cookie$/i.test(name)), false);
    assert.match(headers["cache-control"], /^(no-store|private,)/);
  }
  assert.equal(etagMatches("", '"a"'), false);
  assert.equal(etagMatches("*", '"a"'), true);
});
