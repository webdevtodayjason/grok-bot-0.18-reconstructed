// asset-cache.mjs -- COST-1. The console's own files, cached, and PRIVATE, never public.
//
// WHY PRIVATE IS NOT A PREFERENCE HERE. Every asset on this relay answers 401 when nobody is signed
// in: denyUnauthenticated runs well above the static branch in server.mjs, and the relay writes no
// `vary` at all. So a cacheable PUBLIC response lets a shared cache serve one visitor's signed-in
// 200 -- or one visitor's 401 -- to everybody who asks next. Nothing this file emits ever carries
// `public`, and the gate asserts that twice: as a string search over the source and as a header
// check on a real response.
//
// THE TWO ARMS, AND WHAT EACH ONE IS FOR.
//
//   A STAMPED READ (?v=<content hash>) answers `private, max-age=31536000, immutable`. The URL
//   names the bytes, so the browser never asks again and a file that changes gets a different URL.
//   This is what makes a second boot cost round trips instead of 1,852.9 KiB of page assets.
//
//   AN UNSTAMPED READ answers a strong ETag plus `private, no-cache`, so the repeat read is a 304
//   with no body. `no-cache` does not mean "do not store": it means "revalidate before reusing",
//   which is exactly right for a URL that does not name its own bytes. This arm is what kills
//   app.js's SECOND 490.9 KiB download -- loadConsoleBuild re-reads that file to sha256 it for the
//   build badge -- with no edit to app.js at all.
//
// THE STAMPING IS A REWRITE ON THE WAY OUT, NOT A RENAME ON DISK. index.html itself stays no-store
// and is never edited for this: the relay rewrites its relative asset references with ?v=<hash> as
// it serves them, which is the same thing sameOriginDesktop() already does to that HTML for the
// noVNC address. So there is no build step, no content-hashed filenames, and the vendored handoff's
// own files are never touched -- the rule from its README.
//
// CLOUDFLARE WILL KEEP ANSWERING cf-cache-status: BYPASS ON BOTH ARMS. That is the intended result
// of a private response on an authenticated origin, not a failure, and the gate prints it in those
// words so nobody reads it as one.
//
// HOW THE RELAY REACHES THIS FILE. ui/relay-hooks.mjs loads it once at boot and calls two hooks.
// When this file is ABSENT both are the identity the relay already had:
//
//   const assetPolicy = () => ({ headers: { "cache-control": "no-store" }, status: 200 });
//   const stampHtml = (html) => html;
//
//   assetPolicy(file, url, req) -> { headers, status }
//     `file` is the resolved path on disk for a console asset, and for /avatars/<id> it is the REQUEST
//     PATHNAME, because an avatar is not a file this relay has. `url` is a URL object (the request's
//     own for an asset, one built from the pathname for an avatar). `status` is 304 or 200, and the
//     304 is this module's to decide because only it knows the validator it wrote.
//
//   stampHtml(html, url) -> string
//     index.html on its way out. The directory to hash against is this module's own ui/machine-room,
//     derived from import.meta.url, because the seam passes a URL and not a path on disk; a string
//     second argument is taken as an explicit directory, which is what the unit tests use.
//
// THE TWO CALL SITES ARE IN server.mjs's static branch and in relayAvatar, and both are item A's.
// scripts/verify-cost.mjs calls the same two functions with the same shapes from a proxy in front of
// the relay, so they are measured rather than proposed.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The vendored console, beside this module. The seam hands over a URL rather than a path on disk, and
// this is the one directory whose HTML the relay ever stamps.
const CONSOLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "machine-room");

// A year, the longest max-age worth writing down, and the value only a URL that names its own bytes
// may carry.
export const IMMUTABLE_MAX_AGE_S = 31536000;

// The query parameter a stamped URL carries. Short on purpose: it is repeated once per asset
// reference in the HTML.
export const STAMP_PARAM = "v";

// Content hashes, keyed on the file's identity AND its mtime and size, so a rebuilt file gets a new
// stamp without anybody remembering to clear anything. Lazy: a file nobody asks for is never read.
const hashes = new Map();

export function hashOf(file, stat = null) {
  let info = stat;
  if (info == null) {
    try { info = statSync(file); } catch { return null; }
  }
  // mtimeMs at FULL precision, not rounded to the millisecond: a rewrite inside one millisecond that
  // happens to keep the file's length is invisible to a rounded key, and the stamp then promises a
  // year on bytes that have already changed. Measured on this Mac's APFS, two consecutive writes
  // differ by about a tenth of a millisecond, which a rounded key threw away.
  const signature = `${info.mtimeMs}:${info.size}`;
  const held = hashes.get(file);
  if (held != null && held.signature === signature) return held.hash;
  let hash;
  try { hash = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16); }
  catch { return null; }
  hashes.set(file, { signature, hash });
  return hash;
}

// A STRONG etag (no W/ prefix): these are bytes off disk, not a semantic equivalent, and a strong
// one is what lets a browser use the cached copy for a range request too.
export const etagOf = (hash) => `"${hash}"`;

// if-none-match may carry a list, and a proxy may have turned our strong tag into a weak one on the
// way back. Both are the same bytes; anything else is not.
export function etagMatches(ifNoneMatch, etag) {
  if (typeof ifNoneMatch !== "string" || ifNoneMatch.length === 0) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((one) => one.trim().replace(/^W\//, ""))
    .some((one) => one === etag);
}

/**
 * The cache headers for one asset read, and whether it may answer 304 instead of bytes.
 *
 * TWO KINDS OF THING COME THROUGH HERE AND THEY ARE VALIDATED DIFFERENTLY.
 *
 *   A FILE ON DISK. The stamp in the URL is compared against the file's own content hash. Equal, and
 *   the URL genuinely names those bytes and gets the immutable year. Not equal -- a stale URL out of
 *   an HTML somebody is still holding -- and it gets the revalidating arm, because promising a year on
 *   bytes we are not sending is how a console serves last week's app.js forever.
 *
 *   AN AVATAR. /avatars/<id>?v=<version> is not a file this relay has: the version is the GATEWAY's,
 *   and the gateway answers 404 for a version it no longer holds. So reaching this function at all
 *   means the gateway confirmed that version, and the stamp IS the validator. That is why an
 *   unhashable path with a stamp still gets the immutable year, and why one without a stamp gets
 *   no-store: then the URL says nothing about the bytes behind it.
 */
export function assetPolicy(file, url = null, reqHeaders = {}, stat = null) {
  const search = typeof url === "string" ? url : String(url?.search ?? "");
  const headers = reqHeaders ?? {};
  let stamped = null;
  try { stamped = new URLSearchParams(String(search).replace(/^\?/, "")).get(STAMP_PARAM); }
  catch { stamped = null; }

  const hash = hashOf(file, stat);
  if (hash == null) {
    // Not a file on disk. A stamped URL is the gateway's own version and is its own validator; an
    // unstamped one promises nothing, so it keeps the conservative header.
    if (stamped == null || stamped.length === 0) return { headers: { "cache-control": "no-store" }, status: 200 };
    const etag = etagOf(stamped);
    return {
      headers: { "cache-control": `private, max-age=${IMMUTABLE_MAX_AGE_S}, immutable`, etag },
      status: etagMatches(headers["if-none-match"], etag) ? 304 : 200,
    };
  }

  const etag = etagOf(hash);
  const matched = etagMatches(headers["if-none-match"], etag);
  if (stamped === hash) {
    return { headers: { "cache-control": `private, max-age=${IMMUTABLE_MAX_AGE_S}, immutable`, etag }, status: matched ? 304 : 200 };
  }
  return { headers: { "cache-control": "private, no-cache", etag }, status: matched ? 304 : 200 };
}

// Every relative asset reference in the console's HTML: src= and href= on a path with no scheme and
// no leading slash, which is how the vendored handoff references all of its own files. An absolute
// URL, a data: URI, a fragment and a query that already carries a stamp are all left alone.
const ASSET_REFERENCE = /(\s(?:src|href)=")(?!https?:|data:|blob:|mailto:|#|\/)([^"?#]+\.(?:js|mjs|css|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|webmanifest))(")/g;

/**
 * index.html with every relative asset reference stamped with that file's content hash.
 *
 * Synchronous and cheap on purpose: the hashes are memoised on mtime and size, so this is a regexp
 * pass plus a stat per distinct asset, and it runs on a request that is already reading a file off
 * disk. A reference whose file is missing is left unstamped rather than stamped with a guess.
 *
 * `where` is a directory when the caller has one (the unit tests do) and anything else -- the URL the
 * seam passes, or nothing at all -- means the console's own directory beside this module.
 */
export function stampHtml(html, where = null) {
  const dir = typeof where === "string" && where.length > 0 ? where : CONSOLE_DIR;
  return String(html).replace(ASSET_REFERENCE, (whole, before, reference, after) => {
    const file = path.resolve(dir, reference);
    // Resolve first, then check: a reference that escapes the directory is not ours to stamp.
    if (!file.startsWith(path.resolve(dir) + path.sep)) return whole;
    const hash = hashOf(file);
    if (hash == null) return whole;
    return `${before}${reference}?${STAMP_PARAM}=${hash}${after}`;
  });
}

// What the gate counts, and what a person reading the gate's output needs in order to believe it.
export const stampedReferenceCount = (html) => (String(html).match(new RegExp(`\\?${STAMP_PARAM}=[0-9a-f]{16}"`, "g")) ?? []).length;
