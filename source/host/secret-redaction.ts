// PROXY-9. A receipt of what a tool did must not carry the credential it did it with.
//
// MEASURED ON THE R750 2026-09-08. `agents/f97bfb2e-.../audit.jsonl` in Jason's box carried the
// operator's TinyFish key in two `shell_command` rows, in full, because `localAuditJsonlLine` wrote
// `action.command` whole. 44 characters, sha256 prefix 9165ce2daa86 -- the same prefix the gap row
// named. The demo box scanned clean across 87 ledgers, so it was one agent's history and not a
// fleet-wide spray, but the write path that produced it was unchanged and would produce it again.
//
// The fix is at WRITE time rather than a sweep afterwards, because a sweep is a race with the next
// turn and because deleting a receipt to chase a key is the wrong trade in the other direction. The
// host already knows its own secrets: `box-secrets.json` (the endpoint pin and whatever else the
// console has set) and `connector-env-secrets.json` (every connector's environment). Any value from
// either that appears in the text is replaced with `<redacted:<first 12 of its sha256>>`, which
// keeps the receipt readable and keeps the hash comparable across boxes -- an operator chasing a
// leaked key can still match a ledger row to a key without the ledger holding one.
//
// THE LENGTH FLOOR IS THE WHOLE DESIGN DECISION. These files also hold a model name, a context
// window and a boolean, and redacting `1` or `gpt-4` would mangle every command in the ledger while
// protecting nothing. A credential is long and has no spaces; a setting is short or is prose. So
// the rule is 12 characters or more with no whitespace, and it is stated here rather than guessed
// at a call site. A short secret is out of scope by construction, and a secret store is not where a
// short secret belongs.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BOX_STORE_SECRET_FILE_NAMES } from "./durable-file-policy.js";
import { getSandRootDir } from "./host-paths.js";

export const MIN_REDACTABLE_SECRET_LENGTH = 12;
export const SECRET_REDACTION_CACHE_MS = 5_000;

export function isRedactableSecretValue(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= MIN_REDACTABLE_SECRET_LENGTH
    && !/\s/.test(value);
}

// Both stores nest one level deep and neither has a fixed key set: box-secrets.json is
// `{version, secrets: {NAME: value}}` and connector-env-secrets.json is `{server: {NAME: value}}`.
// Walking every string rather than reading two known shapes means a third shape, or a new field in
// either, is covered the day it appears instead of the day somebody notices.
export function collectRedactableSecretValues(node: unknown, into = new Set<string>()): Set<string> {
  if (isRedactableSecretValue(node)) into.add(node);
  else if (Array.isArray(node)) for (const child of node) collectRedactableSecretValues(child, into);
  else if (node != null && typeof node === "object") {
    for (const child of Object.values(node as Record<string, unknown>)) collectRedactableSecretValues(child, into);
  }
  return into;
}

export function secretRedactionToken(value: string): string {
  return `<redacted:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)}>`;
}

// Longest first, so a key that contains a shorter one does not leave the shorter one's tail behind.
export function redactSecretValues(text: string, values: Iterable<string>): string {
  if (text.length === 0) return text;
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length === 0 || !out.includes(value)) continue;
    out = out.split(value).join(secretRedactionToken(value));
  }
  return out;
}

export interface BoxSecretRedactorOptions {
  readonly sandRoot?: string;
  readonly now?: () => number;
  readonly cacheMs?: number;
}

// Reads the two stores at most once every few seconds and never throws: a ledger line must be
// written even when a secret store is missing, unreadable or half-written by the console, and the
// honest degradation is an unredacted line rather than a lost receipt or a failed turn. On a
// machine with no box (a unit test, the Mac app) both files are absent and this is the identity.
export function createBoxSecretRedactor(options: BoxSecretRedactorOptions = {}): (text: string) => string {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? SECRET_REDACTION_CACHE_MS;
  let values = new Set<string>();
  let readAtMs = -Infinity;
  let stamp = "";
  const refresh = (): void => {
    const at = now();
    if (at - readAtMs < cacheMs) return;
    readAtMs = at;
    const root = options.sandRoot ?? getSandRootDir();
    const paths = BOX_STORE_SECRET_FILE_NAMES.map((name) => join(root, name));
    const nextStamp = paths.map((path) => {
      try {
        const info = statSync(path);
        return `${info.mtimeMs}:${info.size}`;
      } catch {
        return "-";
      }
    }).join("|");
    if (nextStamp === stamp) return;
    stamp = nextStamp;
    const next = new Set<string>();
    for (const path of paths) {
      try {
        collectRedactableSecretValues(JSON.parse(readFileSync(path, "utf8")), next);
      } catch {
        // A missing or half-written store redacts nothing rather than failing the write.
      }
    }
    values = next;
  };
  return (text) => {
    if (typeof text !== "string" || text.length < MIN_REDACTABLE_SECRET_LENGTH) return text;
    try {
      refresh();
    } catch {
      // Keep whatever the last good read produced.
    }
    return values.size === 0 ? text : redactSecretValues(text, values);
  };
}
