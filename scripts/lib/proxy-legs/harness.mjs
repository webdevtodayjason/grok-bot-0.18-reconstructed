// The shared machinery every leg of scripts/verify-proxy.mjs runs on (PROXY-1).
//
// One reporter, one http helper, one leak recorder, one place the repository paths are worked out.
// The four legs (service, tenant, box, tinyfish) are separate files so four people can own one each
// without touching the runner or each other; this is the only thing all four import.
//
// THE LEAK RECORDER is the part worth reading. Every response body the harness fetches is kept, and
// at the end of a run `leakCheck()` looks through all of them for any value registered with
// `secret()`. The wave this gate belongs to exists because one operator provider key was copied
// into three customers' sandboxes; a proxy that hands the same key back in an error message would
// be the same failure with more steps. So the check is not a leg somebody remembers to write, it is
// something the harness does to every response automatically.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ---- reporting -----------------------------------------------------------------------------------
// The same three outcomes scripts/verify-deploy.mjs uses, and for the same reason: a check that
// could not run is a third thing, and calling it a PASS is how a gate starts lying while calling it
// a FAIL is how a gate starts being ignored.
export function createReport() {
  let failures = 0;
  let inconclusive = 0;
  let passes = 0;
  const lines = [];
  const check = (ok, label, detail = "") => {
    const line = `  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`;
    console.log(line);
    lines.push(line);
    if (ok) passes += 1; else failures += 1;
    return ok;
  };
  const unresolved = (label, detail) => {
    const line = `  ????  ${label} -- INCONCLUSIVE: ${detail}`;
    console.log(line);
    lines.push(line);
    inconclusive += 1;
  };
  const step = (title) => console.log(`\n== ${title}`);
  const note = (text) => console.log(`        ${text}`);
  return {
    check,
    unresolved,
    step,
    note,
    lines,
    get failures() { return failures; },
    get inconclusive() { return inconclusive; },
    get passes() { return passes; },
  };
}

// ---- secrets and what a body is allowed to contain -------------------------------------------------
const secrets = new Map();
const bodies = [];

// Register a value that must never appear in a response body, under a name the failure can print.
// A value shorter than eight characters is not tracked: a short string matches unrelated text and
// would make the check a lie in the other direction.
export function secret(name, value) {
  const text = String(value ?? "");
  if (text.length >= 8) secrets.set(name, text);
  return text;
}

export function fingerprint(value) {
  const text = String(value ?? "");
  return `${text.length} characters, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

export function recordBody(where, text) {
  bodies.push({ where, text: String(text ?? "") });
}

// Every body this run collected, against every registered secret. Returns the findings rather than
// printing them, so the runner decides how a leak is reported.
export function leakCheck() {
  const found = [];
  for (const { where, text } of bodies) {
    for (const [name, value] of secrets) {
      if (text.includes(value)) found.push({ where, name });
    }
  }
  return { found, bodies: bodies.length, secrets: secrets.size };
}

export function resetLeakRecorder() {
  bodies.length = 0;
  secrets.clear();
}

// ---- http ------------------------------------------------------------------------------------------
// One helper, so every response passes through the leak recorder without a leg having to remember.
export async function call(url, { method = "GET", token, body, timeoutMs = 10_000 } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    return { ok: false, status: 0, text: "", json: null, error: String(cause?.message ?? cause) };
  }
  const text = await response.text();
  recordBody(`${method} ${new URL(url).pathname}`, text);
  let json = null;
  if (text.length > 0) { try { json = JSON.parse(text); } catch { json = null; } }
  return { ok: response.ok, status: response.status, text, json, error: null };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for a predicate, polling. Returns the milliseconds it took, or null if it never came true --
// a gate that reports "revocation took 34 s" is worth more than one that reports "revocation
// worked", because the number is the thing the design promised.
export async function waitFor(predicate, { timeoutMs = 90_000, everyMs = 1_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await sleep(everyMs);
  }
  return null;
}
