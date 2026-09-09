// cp/verification.mjs -- MARKET-26. The recurring re-read of the vendor documentation the
// marketplace's marketing rows depend on.
//
// WHY THIS IS A JOB AND NOT A GATE LEG. Meta, X and LinkedIn move app-review tiers, scope names,
// endpoint versions and rate tiers between our releases. A one-time audit is true on the day it is
// written and quietly wrong two months later, and the person it is wrong for is a customer
// following a dead sign-up path. So the facts are re-read on a cadence, and a fact that has moved
// turns its row to "under review" rather than waiting for somebody to notice.
//
// WHAT IT WILL NEVER DO. It never touches `verification`. That block is "we ran this on a box on
// this date"; a doc read is "the vendor still documents what this row assumes". They are different
// in kind, `validateMarketplaceCatalog` has always refused `proof: "documented"` precisely so a row
// nobody ran cannot reach a card, and a job that could raise a proof by reading a web page would
// walk straight through that refusal. Two dated facts, two blocks, and `stampCatalogSource` below
// rewrites `docs[].checkedOn` and `docs[].state` and nothing else in the file.
//
// IT DIFFS NAMED FACTS, NEVER PAGE TEXT. Every one of these vendors' pages carries boilerplate that
// changes without the facts changing. Measured 2026-09-09: every LinkedIn Marketing page still
// renders a deprecation banner for a sunset date three weeks in the past; every canva.dev page
// prepends an identical left nav; Meta's content-publishing page carries an "Updated:" date that
// moves on its own. A differ that hashed the page would fire on all three every week and be muted
// inside a month. So each fact names a literal the page has to keep saying and an anchor to find it
// under, the boilerplate is stripped before anything is compared, and what flips a row is that
// named literal going missing.
//
// FETCHING IS FREE OR IT DOES NOT HAPPEN. Plain HTTPS, or a configured document-fetch service --
// the same free fetch the rest of this product uses. A metered browser run for a documentation
// page is banned outright: this job runs weekly across seven vendors forever, and metering it would
// turn a safety net into a bill. Validators (etag, last-modified) are stored per URL and replayed,
// so a weekly run against an origin that publishes them extracts only what changed. Most of these
// origins publish none, measured on the same date, and the job says so rather than pretending.
//
// A PAGE WE COULD NOT READ IS NOT A CHANGED PAGE. Several of these vendors serve a JavaScript shell
// to a plain client. That is the TOOLS-FETCH-2 shape, and it gets its own outcome here for the same
// reason it got one there: telling an operator a vendor changed something, when what actually
// happened is that this container cannot render their page, sends them to read a diff that does not
// exist. `unreadable` is a state of its own and it is not a pass either.
//
// WHERE THE ANSWER GOES. Into the control plane's existing admin_settings table, one row per
// catalog row under `marketplace.verification.<id>`, plus one rollup and one feedback-shaped list
// that wave C's Feedback panel can read without this wave building their panel. cp/store.mjs is not
// touched and there is no migration: the table has been there since PROVIDERS-1.
//
// AND WHAT IT CANNOT DO. Nothing pushes control-plane state into a running box -- the tenant-key
// work already proved a control-plane rotate does not reach inside one -- so a flip lands in two
// tiers. Immediately for the operator, in the admin console. At the next release for the customer,
// through `marketplace verify --write` stamping the corrected dates back into catalog.ts. In
// between, the customer-facing half runs on AGE: the plugin page draws the checked date until the
// row's own dates are older than its recheckDays and "under review" after that. Honest, and it
// needs no delivery path that does not exist.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));

/** One row per catalog row. The prefix is what the admin console and the CLI list by. */
export const VERIFICATION_SETTING_PREFIX = "marketplace.verification.";
/** The rollup: when the whole thing last ran, from where, and what it found. */
export const VERIFICATION_RUN_SETTING = "marketplace.verification";
/**
 * FEEDBACK-1's table, not its panel. Wave C owns the Feedback panel and this wave does not build
 * it; what it does is leave the record where that panel will look, in the feedback namespace, in a
 * shape a panel can render without knowing anything about marketplace rows: an id, a time, a
 * title, a body and a state.
 */
export const VERIFICATION_FEEDBACK_SETTING = "feedback.marketplace-verification";

/** Where the rows live, relative to this file. Overridable so a test can point at a fixture. */
export const CATALOG_PATH = path.join(here, "..", "source", "shared", "marketplace", "catalog.ts");

/** A row with no recheckDays of its own is re-read weekly, which is also the timer's period. */
export const DEFAULT_RECHECK_DAYS = 7;
export const VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** One doc page, and a doc page only. Nothing here waits on a browser. */
export const DOC_FETCH_TIMEOUT_MS = 20_000;

// ---- reading the rows -------------------------------------------------------------------------

/**
 * The catalog's rows, read out of catalog.ts itself.
 *
 * The control plane runs plain Node with no build step and no npm dependency, by design -- it sits
 * in front of every customer's console and the smallest supply chain is the one with nothing in it.
 * So it cannot import a TypeScript module, and the two alternatives were a regex over the file or a
 * generated JSON sidecar. A regex is fragile and a sidecar is a second source of truth that goes
 * stale exactly the way this job exists to stop.
 *
 * This is the third: `DECLARED_PLUGINS` is a pure data literal -- `Object.freeze` around objects,
 * arrays, strings, numbers and booleans, nothing else, asserted by the test -- so it is evaluated
 * verbatim in a vm context that has `Object` and nothing at all besides. No require, no process, no
 * filesystem. It is an exact parse rather than a guess, and it stays exact because the moment
 * somebody puts an expression in that literal this throws with the line rather than reading a row
 * wrong.
 */
export function readCatalogPlugins(source) {
  const start = String(source).indexOf("const DECLARED_PLUGINS");
  if (start < 0) throw new Error("catalog.ts does not declare DECLARED_PLUGINS");
  const eq = source.indexOf("=", start);
  const end = source.indexOf("\n]);", start);
  if (eq < 0 || end < 0) throw new Error("catalog.ts's DECLARED_PLUGINS does not end where this expects it to");
  const literal = source.slice(eq + 1, end + 3);
  let rows;
  try {
    rows = vm.runInNewContext(`(${literal})`, { Object }, { timeout: 5_000 });
  } catch (error) {
    throw new Error(`catalog.ts's rows are no longer a plain data literal: ${String(error?.message ?? error)}`);
  }
  if (!Array.isArray(rows)) throw new Error("catalog.ts's DECLARED_PLUGINS did not evaluate to a list");
  return rows;
}

export function loadCatalogPlugins(file = CATALOG_PATH) {
  return readCatalogPlugins(readFileSync(file, "utf8"));
}

/** The rows this job has anything to do: the ones that carry dated doc facts. */
export function rowsWithDocs(plugins) {
  return plugins.filter((row) => Array.isArray(row?.docs) && row.docs.length > 0);
}

// ---- reducing a page to something a fact can be found in ---------------------------------------

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–",
};

/**
 * HTML to plain text, with ONE rule that matters: a tag becomes a SPACE, not nothing.
 *
 * Buffer's per-plan quota table is the reason it is written down. Reduced the naive way, its cells
 * fuse into "FeatureFreeEssentialsTeamAPI Keys135App Clients135" and every number in it becomes
 * unfindable. One space per tag keeps the cells apart and costs nothing anywhere else.
 */
export function htmlToPlainText(html) {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
      const key = String(name);
      if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
      const decimal = /^#(\d+)$/.exec(key);
      if (decimal) return String.fromCodePoint(Number(decimal[1]));
      const hex = /^#x([0-9a-f]+)$/i.exec(key);
      if (hex) return String.fromCodePoint(Number.parseInt(hex[1], 16));
      return whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The boilerplate that moves without the facts moving, taken out before anything is compared or
 * hashed. Every pattern here is one that was measured on a real page on 2026-09-09, and each one
 * has a page named beside it, because a noise rule nobody can trace is a rule that quietly hides a
 * real change later.
 */
const NOISE = [
  // LinkedIn: every Marketing page carries this banner, and today it announces a sunset date three
  // weeks in the PAST (Marketing Version 202508, sunset 17 August 2026, read 2026-09-09). The
  // version and the date in it move on LinkedIn's own schedule; the facts underneath do not. Two
  // patterns rather than one greedy one, longest ending first, so the strip is bounded and cannot
  // run away into the page when LinkedIn drops the support-portal sentence.
  { why: "LinkedIn's deprecation banner", pattern: /(?:Warning\s+)?Deprecation Notice:[\s\S]{0,600}?Developer Support Portal\./gi },
  { why: "LinkedIn's deprecation banner, short form", pattern: /(?:Warning\s+)?Deprecation Notice:[\s\S]{0,400}?avoid disruptions\./gi },
  // Meta: an "Updated:" stamp on the documentation pages that moves without the facts moving.
  // Measured on the Instagram content-publishing page, 2026-09-09: "Updated: Jun 30, 2026".
  { why: "Meta's updated stamp", pattern: /Updated:\s*[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}/g },
  // The docs sites' own furniture on docs.x.com, docs.browserbase.com and developers.facebook.com.
  { why: "the docs site's own furniture", pattern: /\b(?:Copy for LLM|View as Markdown|Ask AI|Was this page helpful\?)\b/gi },
];

/**
 * A documentation site's left navigation, prepended to the page before its own heading.
 *
 * Measured on canva.dev, 2026-09-09: both /docs/connect/ and /docs/apps/ begin with several hundred
 * characters of section links -- "Getting started Overview Quickstart Creating integrations ..." --
 * before the first heading, and that block grows whenever the site gains a page. A whole-page hash
 * of either would move on a week when nothing about the API changed.
 *
 * The rule is deliberately conservative and general rather than named after one vendor: the prefix
 * before the page's own first heading is dropped ONLY when it is long and contains no sentence
 * punctuation at all, which is what a list of link labels looks like and what prose never does.
 * LinkedIn's page begins with two full sentences and is left alone; Meta's begins with its heading
 * and has no prefix to drop.
 */
export function stripNavPrefix(text) {
  const body = String(text ?? "");
  const heading = body.search(/(?:^|\n)#\s/);
  if (heading <= 0) return body;
  const prefix = body.slice(0, heading);
  if (prefix.length < 40) return body;
  if (/[.!?](\s|$)/.test(prefix)) return body;
  return body.slice(heading);
}

export function stripDocNoise(text) {
  let out = stripNavPrefix(String(text ?? ""));
  for (const rule of NOISE) out = out.replace(rule.pattern, " ");
  // A markdown renderer's escapes, undone. Measured on LinkedIn's Posts API page, 2026-09-09: the
  // permission is rendered as `w\_organization\_social`, so a run through a rendering fetcher would
  // report a permission name as CHANGED when what actually differed was who drew the underscore.
  // This is a rendering artifact, not a fact, and it is normalised rather than tolerated.
  out = out.replace(/\\([_*`[\]])/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}

/** The noise rules, named, so the admin screen and the docs can say what is being ignored. */
export function docNoiseRules() {
  return ["a documentation site's left navigation", ...NOISE.map((rule) => rule.why)];
}

/**
 * The stretch of a page a fact lives in. An anchor is a literal heading (or the first words of the
 * sentence the fact sits in); the section is what follows it. Reading the section rather than the
 * page is what lets the record quote BOTH SIDES of a change: the literal we expected, and what is
 * actually there now.
 */
export const SECTION_SPAN = 900;
/** Every stretch the anchor opens, not only the first. `anchorSection` is the first of them. */
export const SECTION_LIMIT = 8;
export function anchorSections(text, anchor, span = SECTION_SPAN) {
  const body = String(text ?? "");
  const needle = String(anchor ?? "");
  if (needle.length === 0) return [body.slice(0, span)];
  const haystack = body.toLowerCase();
  const target = needle.toLowerCase();
  const out = [];
  let at = haystack.indexOf(target);
  while (at >= 0 && out.length < SECTION_LIMIT) {
    out.push(body.slice(at, at + span));
    at = haystack.indexOf(target, at + target.length);
  }
  return out;
}

export function anchorSection(text, anchor, span = SECTION_SPAN) {
  return anchorSections(text, anchor, span)[0] ?? "";
}

/** `$.a.b.c` against a parsed JSON surface. Vendors that publish an openapi are read this way. */
export function readJsonPointer(value, pointer) {
  const parts = String(pointer ?? "").replace(/^\$\.?/, "").split(".").filter(Boolean);
  let at = value;
  for (const part of parts) {
    if (at == null || typeof at !== "object") return undefined;
    at = at[part];
  }
  return at;
}

/**
 * TOOLS-FETCH-2's rule, reused rather than reinvented: a big body that reduced to almost nothing is
 * a JavaScript shell, not a page. Told apart from a missing fact on purpose -- see the header.
 */
export function looksLikeShell(rawLength, text) {
  return rawLength >= 50_000 && String(text ?? "").length < 400;
}

// ---- checking one fact --------------------------------------------------------------------------

/**
 * Did the page land where the row says it lands?
 *
 * Redirects are recorded rather than treated as changes, because two of these vendors redirect
 * every request today: developers.facebook.com/docs/... goes to /documentation/..., and LinkedIn
 * appends ?view=li-lms-YYYY-MM, which would otherwise turn a row red every two months. What is a
 * change is landing somewhere that matches NEITHER the declared address nor the declared landing.
 */
export function landedWhereExpected(doc, finalUrl) {
  const landed = String(finalUrl ?? "");
  if (landed.length === 0) return true;
  const allowed = [doc.url, doc.finalUrl].filter((value) => typeof value === "string" && value.length > 0);
  return allowed.some((value) => landed === value || landed.startsWith(`${value}?`) || landed.startsWith(`${value}#`) || landed.startsWith(value));
}

/**
 * One fact against one fetch. Pure, so the whole differ is testable without a network: `answer` is
 * whatever the fetcher produced, and every outcome below is decided here and nowhere else.
 *
 *   verified       the literal is where the row says it is
 *   not-published  the vendor states it does not publish this. Never fetched, never flipped.
 *   changed        a 404, a landing somewhere else, or the literal gone from its section
 *   unreadable     the page came back as a shell, or the fetch failed. NOT a pass and NOT a change
 */
export function checkDoc(doc, answer) {
  const base = {
    id: String(doc.id ?? ""),
    what: String(doc.what ?? ""),
    url: String(doc.url ?? ""),
    anchor: String(doc.anchor ?? ""),
    expected: String(doc.expected ?? ""),
    checkedOn: String(doc.checkedOn ?? ""),
  };
  if (doc.state === "not-published") {
    return {
      ...base,
      state: "not-published",
      reason: "the vendor states it does not publish this, so there is nothing to re-read",
      found: "",
      digest: "",
    };
  }
  if (answer?.notModified === true) {
    return {
      ...base,
      state: String(doc.state ?? "verified") === "changed" ? "changed" : "verified",
      reason: "the origin answered that it has not changed since the last read",
      found: "",
      digest: String(answer.digest ?? ""),
      etag: answer.etag ?? doc.etag,
      lastModified: answer.lastModified,
      http: 304,
      notModified: true,
    };
  }
  if (answer?.ok !== true) {
    const status = Number(answer?.status ?? 0);
    return {
      ...base,
      state: status > 0 && status !== 200 ? "changed" : "unreadable",
      reason: status > 0
        ? `the page answered ${status}, so the address this row names is no longer the page`
        : `the page could not be fetched: ${String(answer?.error ?? "no answer")}`,
      found: "",
      digest: "",
      http: status || null,
    };
  }
  const finalUrl = String(answer.finalUrl ?? answer.url ?? doc.url);
  if (!landedWhereExpected(doc, finalUrl)) {
    return {
      ...base,
      state: "changed",
      reason: `the address now lands on ${finalUrl}, which is neither the address this row names nor the landing it records`,
      found: finalUrl,
      digest: "",
      http: Number(answer.status ?? 200),
      finalUrl,
    };
  }
  const contentType = String(answer.contentType ?? "");
  const raw = String(answer.body ?? "");
  const isJson = /json|yaml/i.test(contentType) || String(doc.anchor ?? "").startsWith("$.");
  let text;
  if (isJson && String(doc.anchor ?? "").startsWith("$.")) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const at = parsed == null ? undefined : readJsonPointer(parsed, doc.anchor);
    const value = at === undefined ? "" : String(at);
    const matched = value === base.expected;
    return {
      ...base,
      state: matched ? "verified" : "changed",
      reason: matched
        ? "the value at that path is what this row expects"
        : `the value at that path is now "${value || "absent"}"`,
      found: value,
      digest: createHash("sha256").update(value).digest("hex").slice(0, 16),
      http: Number(answer.status ?? 200),
      etag: answer.etag,
      lastModified: answer.lastModified,
      finalUrl,
    };
  }
  // A fetcher that already rendered the page hands back text; a plain HTTPS read hands back HTML.
  text = answer.text != null ? String(answer.text) : htmlToPlainText(raw);
  const clean = stripDocNoise(text);
  if (looksLikeShell(raw.length, clean)) {
    return {
      ...base,
      state: "unreadable",
      reason: `the page came back as ${raw.length} bytes that reduce to ${clean.length} characters, which is a shell rather than a page: this container cannot render it, and that is not the same as the vendor changing it`,
      found: clean.slice(0, 200),
      digest: "",
      http: Number(answer.status ?? 200),
      finalUrl,
    };
  }
  // EVERY stretch the anchor opens, not only the first. Measured while writing this: Buffer's page
  // says "create_post" three times before the paragraph that lists the networks, and X's pricing
  // page mentions its own model before the heading it is filed under. Matching only the first
  // occurrence turned three unchanged pages red, which is the false alarm this job cannot afford.
  const sections = anchorSections(clean, doc.anchor);
  const section = sections.find((candidate) => candidate.includes(base.expected)) ?? sections[0] ?? "";
  const haystack = section.length > 0 ? section : clean;
  const matched = haystack.includes(base.expected);
  return {
    ...base,
    state: matched ? "verified" : "changed",
    reason: matched
      ? `the vendor's page still says it, under "${doc.anchor}"`
      : section.length === 0
        ? `"${doc.anchor}" is no longer anywhere on that page, so the fact this row depends on has moved`
        : `"${doc.anchor}" is still there and no longer says it`,
    found: matched ? base.expected : haystack.slice(0, 400),
    // The digest is of the noise-stripped SECTION, so an edited banner or a grown left nav leaves it
    // alone. It is recorded and never acted on: what flips a row is the named fact, and a digest
    // that could flip one would be diffing page text, which is the thing this job does not do.
    digest: createHash("sha256").update(haystack).digest("hex").slice(0, 16),
    http: Number(answer.status ?? 200),
    etag: answer.etag,
    lastModified: answer.lastModified,
    finalUrl,
  };
}

/** A row is only as good as its worst fact. `unreadable` is neither a pass nor a change. */
export function rowState(docResults) {
  if (docResults.some((doc) => doc.state === "changed")) return "needs-re-verification";
  if (docResults.some((doc) => doc.state === "unreadable")) return "not-measured";
  return "verified";
}

// ---- the fetchers ------------------------------------------------------------------------------

/**
 * Plain HTTPS, with the origin's own validators replayed. No dependency, no browser, no meter.
 *
 * `stored` is the per-URL validators from the last run, read out of the previous record rather than
 * a file of its own, so there is one place a run's memory lives.
 */
export function plainFetcher({ fetchImpl = fetch, timeoutMs = DOC_FETCH_TIMEOUT_MS, stored = new Map() } = {}) {
  return async function fetchDoc(url) {
    const headers = { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" };
    const remembered = stored.get(url) ?? {};
    if (remembered.etag) headers["if-none-match"] = remembered.etag;
    if (remembered.lastModified) headers["if-modified-since"] = remembered.lastModified;
    try {
      const response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 304) {
        return { ok: true, notModified: true, status: 304, url, finalUrl: response.url || url, etag: remembered.etag, lastModified: remembered.lastModified };
      }
      const body = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        url,
        finalUrl: response.url || url,
        contentType: response.headers?.get?.("content-type") ?? "",
        etag: response.headers?.get?.("etag") ?? undefined,
        lastModified: response.headers?.get?.("last-modified") ?? undefined,
        body,
      };
    } catch (error) {
      return { ok: false, status: 0, url, error: error?.name === "TimeoutError" ? "it did not answer in time" : String(error?.message ?? error) };
    }
  };
}

/**
 * A configured document-fetch service, when the operator has pointed this container at one. It is
 * the FREE fetch -- rendering a documentation page costs nothing on the service this product
 * already uses -- and it exists because several of these vendors serve a JavaScript shell to a
 * plain client, which `plainFetcher` correctly reports as unreadable and cannot do anything about.
 *
 * The key is read from the environment of THIS container. Nothing here reads an operator's home
 * directory and no key is ever written into a record, a log line or an argument list.
 */
export function serviceFetcher({ endpoint, key, fetchImpl = fetch, timeoutMs = DOC_FETCH_TIMEOUT_MS } = {}) {
  return async function fetchDoc(url) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(key ? { "x-api-key": key } : {}) },
        body: JSON.stringify({ urls: [url], format: "markdown", links: false, image_links: false, page_metadata: false, include_etag_and_last_modified: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { ok: false, status: response.status, url, error: `the document service answered ${response.status}` };
      const answer = await response.json();
      const first = Array.isArray(answer?.results) ? answer.results[0] : null;
      if (first == null) {
        const failure = Array.isArray(answer?.errors) ? answer.errors[0] : null;
        return { ok: false, status: Number(failure?.status ?? 0), url, error: String(failure?.error ?? "the document service returned nothing for it") };
      }
      return {
        ok: true,
        status: 200,
        url,
        finalUrl: String(first.final_url ?? first.url ?? url),
        contentType: "text/markdown",
        etag: first.etag ?? undefined,
        lastModified: first.last_modified ?? undefined,
        text: String(first.text ?? ""),
        body: String(first.text ?? ""),
      };
    } catch (error) {
      return { ok: false, status: 0, url, error: error?.name === "TimeoutError" ? "it did not answer in time" : String(error?.message ?? error) };
    }
  };
}

/**
 * Fixtures, for the unit test and for `marketplace verify --fixtures`. One file per URL, named by a
 * hash of the URL, so a suite can change one vendor's page under the job and watch exactly one row
 * move -- which is the only way to prove the differ does what it says without waiting a week for a
 * vendor to edit something.
 */
export function fixtureKey(url) {
  return createHash("sha256").update(String(url)).digest("hex").slice(0, 16);
}

export function fixtureFetcher(dir, { overrides = new Map() } = {}) {
  return async function fetchDoc(url) {
    if (overrides.has(url)) {
      const forced = overrides.get(url);
      return typeof forced === "function" ? forced(url) : forced;
    }
    const file = path.join(dir, `${fixtureKey(url)}.html`);
    try {
      const body = readFileSync(file, "utf8");
      return { ok: true, status: 200, url, finalUrl: url, contentType: "text/html", body };
    } catch {
      return { ok: false, status: 404, url, error: "no fixture for that address" };
    }
  };
}

// ---- the run ------------------------------------------------------------------------------------

const isoDay = (at) => new Date(at).toISOString().slice(0, 10);

/** The validators the last run stored for this row's URLs, so the next one can replay them. */
export function storedValidators(previous) {
  const map = new Map();
  for (const doc of previous?.docs ?? []) {
    if (doc?.url == null) continue;
    if (doc.etag || doc.lastModified) map.set(String(doc.url), { etag: doc.etag, lastModified: doc.lastModified });
  }
  return map;
}

/**
 * One row: every fact checked, and the record that comes out of it.
 *
 * `previous` is the last record for this row, and it is read for two things only -- the validators
 * to replay, and the digest to compare against for the run's own information. It never decides a
 * state. A run has to be able to reach the same verdict from nothing, or two runs of the same job
 * against the same pages could disagree, and then the record is a diary rather than a fact.
 */
export async function verifyRow(row, { fetchDoc, now = Date.now, previous = null } = {}) {
  const at = now();
  const priorByDoc = new Map((previous?.docs ?? []).map((doc) => [String(doc.id), doc]));
  const results = [];
  for (const doc of row.docs ?? []) {
    if (doc.state === "not-published") { results.push(checkDoc(doc, null)); continue; }
    const prior = priorByDoc.get(String(doc.id));
    const answer = await fetchDoc(doc.url, { etag: doc.etag ?? prior?.etag, lastModified: prior?.lastModified });
    const result = checkDoc(doc, answer);
    if (result.notModified === true && prior != null) {
      result.digest = String(prior.digest ?? "");
      result.found = String(prior.found ?? "");
    }
    result.digestMoved = prior?.digest ? String(prior.digest) !== String(result.digest ?? "") : false;
    results.push(result);
  }
  const state = rowState(results);
  const changed = results.filter((doc) => doc.state === "changed");
  return {
    rowId: String(row.id),
    name: String(row.name ?? row.id),
    category: String(row.category ?? ""),
    state,
    checkedOn: isoDay(at),
    checkedAt: new Date(at).toISOString(),
    recheckDays: Number.isInteger(row.recheckDays) && row.recheckDays > 0 ? row.recheckDays : DEFAULT_RECHECK_DAYS,
    // Said on every record, because a number with no unit beside it is the thing that makes an
    // operator ask whether this job costs anything to run.
    meteredRuns: 0,
    docs: results,
    changed: changed.map((doc) => ({
      docId: doc.id,
      what: doc.what,
      url: doc.url,
      anchor: doc.anchor,
      // Both sides, quoted. A record that said only "this changed" makes the operator go and read
      // the vendor's page to find out what, which is the work this job exists to have already done.
      expected: doc.expected,
      found: doc.found,
      reason: doc.reason,
    })),
    unreadable: results.filter((doc) => doc.state === "unreadable").map((doc) => ({ docId: doc.id, url: doc.url, reason: doc.reason })),
  };
}

/**
 * Every row with doc facts, one run.
 *
 * `store` is the control plane's own store, handed in rather than opened here, so this module has
 * no opinion about where the database is and a test can run the whole job against a temporary one.
 */
export async function verifyCatalog({
  plugins = null,
  catalogPath = CATALOG_PATH,
  fetchDoc,
  store = null,
  now = Date.now,
  source = "cli",
  only = "",
  actor = "",
} = {}) {
  const rows = rowsWithDocs(plugins ?? loadCatalogPlugins(catalogPath))
    .filter((row) => only.length === 0 || String(row.id) === only);
  const records = [];
  for (const row of rows) {
    const previous = store == null ? null : readRecord(store, row.id);
    const validators = storedValidators(previous);
    const fetcher = typeof fetchDoc === "function"
      ? fetchDoc
      : plainFetcher({ stored: validators });
    const record = await verifyRow(row, { fetchDoc: fetcher, now, previous });
    record.source = String(source);
    records.push(record);
    if (store != null) store.setSetting(`${VERIFICATION_SETTING_PREFIX}${row.id}`, JSON.stringify(record), actor);
  }
  const rollup = {
    ranAt: new Date(now()).toISOString(),
    ranOn: isoDay(now()),
    source: String(source),
    rows: records.map((record) => record.rowId),
    verified: records.filter((record) => record.state === "verified").map((record) => record.rowId),
    needsReVerification: records.filter((record) => record.state === "needs-re-verification").map((record) => record.rowId),
    notMeasured: records.filter((record) => record.state === "not-measured").map((record) => record.rowId),
    meteredRuns: 0,
  };
  if (store != null) {
    store.setSetting(VERIFICATION_RUN_SETTING, JSON.stringify(rollup), actor);
    writeFeedback(store, records, { now, actor });
  }
  return { rollup, records };
}

/** The record for one row, or null. Never throws on a value somebody edited by hand. */
export function readRecord(store, rowId) {
  const raw = store.getSetting(`${VERIFICATION_SETTING_PREFIX}${rowId}`, "");
  if (raw.length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Every record, newest read first, for the admin panel and the CLI. */
export function readRecords(store) {
  return store.listSettings()
    .filter((setting) => setting.name.startsWith(VERIFICATION_SETTING_PREFIX))
    .map((setting) => {
      try { return { ...JSON.parse(setting.value), at: setting.at, actor: setting.actor }; }
      catch { return { rowId: setting.name.slice(VERIFICATION_SETTING_PREFIX.length), state: "unreadable-record", at: setting.at }; }
    })
    .sort((left, right) => String(left.rowId).localeCompare(String(right.rowId)));
}

export function readRollup(store) {
  const raw = store.getSetting(VERIFICATION_RUN_SETTING, "");
  if (raw.length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * The feedback-shaped list. One item per row that needs re-verifying, and the list is REPLACED on
 * every run rather than appended to, so a row that comes back does not leave a stale complaint
 * behind it -- which is the tracker-hygiene failure this product has already had once.
 */
export function writeFeedback(store, records, { now = Date.now, actor = "" } = {}) {
  const items = records
    .filter((record) => record.state !== "verified")
    .map((record) => ({
      id: `marketplace-verification-${record.rowId}`,
      at: new Date(now()).toISOString(),
      kind: "marketplace-verification",
      severity: record.state === "needs-re-verification" ? "needs-attention" : "not-measured",
      title: record.state === "needs-re-verification"
        ? `${record.name}: a fact this marketplace row depends on has moved`
        : `${record.name}: a vendor page for this marketplace row could not be read from here`,
      detail: (record.changed.length > 0 ? record.changed : record.unreadable)
        .map((change) => (change.expected != null
          ? `${change.what}\n  we expect: ${change.expected}\n  the page now says: ${String(change.found).slice(0, 300)}\n  ${change.url}`
          : `${change.reason}\n  ${change.url}`))
        .join("\n\n"),
      target: record.rowId,
      state: "open",
    }));
  store.setSetting(VERIFICATION_FEEDBACK_SETTING, JSON.stringify(items), actor);
  return items;
}

// ---- age, which is the customer-facing half ------------------------------------------------------

/**
 * How old this row's own dates are, in days, and whether that is past its recheck interval.
 *
 * The console draws this from the CATALOG, not from a record: nothing pushes control-plane state
 * into a running box, so between releases the only thing a customer's page can honestly say is how
 * long ago the facts on it were read. `stampCatalogSource` is what makes that date move.
 */
export function rowAge(row, at = Date.now()) {
  const dates = (row.docs ?? []).map((doc) => Date.parse(`${doc.checkedOn}T00:00:00Z`)).filter(Number.isFinite);
  if (dates.length === 0) return { days: null, stale: false, oldest: "" };
  const oldest = Math.min(...dates);
  const days = Math.floor((at - oldest) / (24 * 60 * 60 * 1000));
  const limit = Number.isInteger(row.recheckDays) && row.recheckDays > 0 ? row.recheckDays : DEFAULT_RECHECK_DAYS;
  return { days, stale: days > limit, oldest: isoDay(oldest), recheckDays: limit };
}

// ---- --write: stamping the answer back into the catalog -------------------------------------------

/**
 * Rewrite `checkedOn` and `state` on the doc facts a run just checked, IN PLACE, and nothing else.
 *
 * This is the release-time half of the delivery. The control plane's record reaches the operator
 * immediately; the customer's console reads a catalog compiled into the host bundle, so the only
 * way the corrected date reaches them is the next release carrying it. The rewrite is deliberately
 * blunt -- it finds the row's own doc entry by its id and replaces two string values inside it --
 * because a clever rewriter of somebody else's source file is a rewriter that eventually eats a
 * comment.
 */
export function stampCatalogSource(source, records) {
  let text = String(source);
  const stamped = [];
  for (const record of records) {
    for (const doc of record.docs ?? []) {
      if (doc.state === "not-published") continue;
      const idAt = findDocEntry(text, record.rowId, doc.id);
      if (idAt == null) continue;
      const block = text.slice(idAt.start, idAt.end);
      const next = block
        .replace(/checkedOn:\s*"[^"]*"/, `checkedOn: "${record.checkedOn}"`)
        .replace(/state:\s*"(?:verified|changed|not-published)"/, `state: "${doc.state === "verified" ? "verified" : "changed"}"`);
      if (next !== block) {
        text = text.slice(0, idAt.start) + next + text.slice(idAt.end);
        stamped.push({ rowId: record.rowId, docId: doc.id, state: doc.state, checkedOn: record.checkedOn });
      }
    }
  }
  return { text, stamped };
}

/** The character span of one doc entry inside one row, found by both ids so no two rows collide. */
function findDocEntry(text, rowId, docId) {
  const rowAt = text.indexOf(`id: "${rowId}",`);
  if (rowAt < 0) return null;
  // The row's own block ends where the next row's `Object.freeze({\n    id: "` begins.
  const nextRow = text.indexOf('\n  Object.freeze({\n    id: "', rowAt);
  const rowEnd = nextRow < 0 ? text.length : nextRow;
  const docAt = text.indexOf(`id: "${docId}",`, rowAt);
  if (docAt < 0 || docAt > rowEnd) return null;
  const close = text.indexOf("\n      }),", docAt);
  if (close < 0 || close > rowEnd) return null;
  return { start: docAt, end: close };
}

export function stampCatalogFile(records, file = CATALOG_PATH) {
  const source = readFileSync(file, "utf8");
  const { text, stamped } = stampCatalogSource(source, records);
  if (stamped.length > 0) writeFileSync(file, text, "utf8");
  return stamped;
}

// ---- the timer ------------------------------------------------------------------------------------

/**
 * Weekly, and once at boot. `unref` so it never holds the process open, which is the peer timer's
 * own pattern in cp/server.mjs and the reason a shutdown here is instant.
 *
 * It refuses to run when it has nowhere to fetch from and it never throws into the event loop: a
 * documentation service being down is not a reason for the control plane to be down.
 */
export function startVerificationTimer({ store, now = Date.now, fetchDoc = null, intervalMs = VERIFY_INTERVAL_MS, log = () => {} } = {}) {
  const run = async (source) => {
    try {
      const { rollup } = await verifyCatalog({ store, now, fetchDoc, source });
      log(`marketplace verification (${source}): ${rollup.verified.length} verified, ${rollup.needsReVerification.length} need re-verification, ${rollup.notMeasured.length} not measured, ${rollup.meteredRuns} metered runs`);
    } catch (error) {
      log(`marketplace verification (${source}) did not finish: ${String(error?.message ?? error)}`);
    }
  };
  void run("boot");
  const timer = setInterval(() => { void run("timer"); }, intervalMs);
  timer.unref?.();
  return timer;
}
