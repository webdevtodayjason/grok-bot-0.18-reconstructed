/**
 * CLOUD-BROWSER-1. Which browser runs this page, and where that choice is written down.
 *
 * Three ways an engine is chosen, in this order:
 *
 *   1. the operator pinned one for this workspace;
 *   2. the site is on the workspace's cloud list (instagram.com, facebook.com, linkedin.com out of
 *      the box, because those are the three a marketing team meets first);
 *   3. the in-box engine ran and came back with nothing usable -- a sign-in wall, a challenge page,
 *      or the no-content verdict page-text.mjs learned for this wave.
 *
 * The third one is the reason this file exists at all. Measured on grok-bot-local-vm 2026-09-09:
 * instagram.com/titaniumcomputing/ answered 200 in 3,259 ms with needsLogin false, blocked false
 * and Meta's footer as its whole text. A router keyed on the two old verdicts would never have
 * escalated on exactly the page a cloud browser is for.
 *
 * Escalation happens AT MOST ONCE per tool call. Not a loop, not a retry ladder, not "try the other
 * vendor as well": one page can cost one extra session and no more, because a session is money and
 * a loop is money that never stops.
 *
 * WHERE IT LIVES. browser-engines.json, in the sand root beside the other host-owned state, read
 * fresh on every routing decision so an operator's change lands without a restart. Deliberately NOT
 * in sand-host-settings.json: that file belongs to another wave this cycle, and a setting that has
 * a shape (an engine, a list of sites, a ceiling) is not a string a settings reader can carry.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";

import type { CloudBrowserVendor } from "./secrets.js";

export const CLOUD_BROWSER_POLICY_FILENAME = "browser-engines.json";

/** "auto" is the default: the box first, the cloud only when the site or the page asks for it. */
export type CloudBrowserEngineChoice = "auto" | "box" | CloudBrowserVendor;

export interface CloudBrowserPolicy {
  /** What the operator pinned for this workspace. */
  readonly engine: CloudBrowserEngineChoice;
  /** Hosts that always go to the cloud, matched on the registrable-looking suffix. */
  readonly cloudSites: readonly string[];
  /** Whether a page that came back empty may cost one cloud session. */
  readonly autoEscalate: boolean;
  /** How many cloud sessions one turn may open, in code rather than in a docs sentence. */
  readonly sessionCeilingPerTurn: number;
  /** Which vendor "auto" reaches for. Browser Use first: cheaper per hour and cheaper per gigabyte. */
  readonly preferred: CloudBrowserVendor;
}

export const DEFAULT_CLOUD_SITES: readonly string[] = ["instagram.com", "facebook.com", "linkedin.com"];

export const DEFAULT_CLOUD_BROWSER_POLICY: CloudBrowserPolicy = Object.freeze({
  engine: "auto",
  cloudSites: DEFAULT_CLOUD_SITES,
  autoEscalate: true,
  sessionCeilingPerTurn: 2,
  preferred: "browser-use",
});

const ENGINE_CHOICES: readonly string[] = ["auto", "box", "browser-use", "browserbase"];

function policyPath(rootDir: string): string {
  return join(rootDir, CLOUD_BROWSER_POLICY_FILENAME);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A host name reduced to something two spellings of the same site both land on. */
export function normalizeSiteHost(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw.length === 0) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^www\./, "").split("/")[0] ?? "";
  }
}

/** The policy on disk, with every missing or nonsense field falling back to the default. */
export function readCloudBrowserPolicy(rootDir: string): CloudBrowserPolicy {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(readFileSync(policyPath(rootDir), "utf8")));
  } catch {
    parsed = null;
  }
  if (parsed == null) return DEFAULT_CLOUD_BROWSER_POLICY;
  const engine = typeof parsed.engine === "string" && ENGINE_CHOICES.includes(parsed.engine)
    ? parsed.engine as CloudBrowserEngineChoice
    : DEFAULT_CLOUD_BROWSER_POLICY.engine;
  const preferred = parsed.preferred === "browserbase" ? "browserbase" : "browser-use";
  const sites = Array.isArray(parsed.cloudSites)
    ? parsed.cloudSites.map(normalizeSiteHost).filter((entry) => entry.length > 0)
    : DEFAULT_CLOUD_BROWSER_POLICY.cloudSites;
  const ceiling = Number(parsed.sessionCeilingPerTurn);
  return {
    engine,
    preferred,
    cloudSites: sites,
    autoEscalate: parsed.autoEscalate !== false,
    sessionCeilingPerTurn: Number.isFinite(ceiling) && ceiling >= 0 && ceiling <= 20
      ? Math.floor(ceiling)
      : DEFAULT_CLOUD_BROWSER_POLICY.sessionCeilingPerTurn,
  };
}

/**
 * Writes the policy. Temp file, rename, 0600 -- the same shape the secret store uses, not because
 * this file is a secret (it is not) but because a half-written policy read back as "no policy"
 * silently changes which browser a customer's agent uses.
 */
export function writeCloudBrowserPolicy(rootDir: string, patch: Partial<CloudBrowserPolicy>): CloudBrowserPolicy {
  const current = readCloudBrowserPolicy(rootDir);
  const next: CloudBrowserPolicy = {
    engine: patch.engine != null && ENGINE_CHOICES.includes(patch.engine) ? patch.engine : current.engine,
    preferred: patch.preferred === "browserbase" || patch.preferred === "browser-use" ? patch.preferred : current.preferred,
    cloudSites: patch.cloudSites == null
      ? current.cloudSites
      : [...new Set(patch.cloudSites.map(normalizeSiteHost).filter((entry) => entry.length > 0))],
    autoEscalate: typeof patch.autoEscalate === "boolean" ? patch.autoEscalate : current.autoEscalate,
    sessionCeilingPerTurn: Number.isFinite(Number(patch.sessionCeilingPerTurn))
      && Number(patch.sessionCeilingPerTurn) >= 0 && Number(patch.sessionCeilingPerTurn) <= 20
      ? Math.floor(Number(patch.sessionCeilingPerTurn))
      : current.sessionCeilingPerTurn,
  };
  const path = policyPath(rootDir);
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
  try { chmodSync(path, 0o600); } catch { /* the rename already carried the temp file's mode */ }
  return next;
}

/** Is this address one the workspace always sends to the cloud? Suffix match, so a subdomain counts. */
export function isCloudSite(url: unknown, sites: readonly string[]): boolean {
  const host = normalizeSiteHost(url);
  if (host.length === 0) return false;
  return sites.some((site) => site.length > 0 && (host === site || host.endsWith(`.${site}`)));
}

export interface CloudRouteInput {
  readonly policy: CloudBrowserPolicy;
  /** Vendors whose key is actually stored. A pin at a vendor with no key is not a route. */
  readonly available: readonly CloudBrowserVendor[];
  readonly url?: string | undefined;
  /** True on the second pass, after the box engine came back with nothing usable. */
  readonly escalating?: boolean;
  /** How many cloud sessions this turn has already opened. */
  readonly sessionsThisTurn?: number;
}

export interface CloudRoute {
  readonly engine: "box" | CloudBrowserVendor;
  /** Why, in the words the ledger row and the log line carry. Never shown to a person as is. */
  readonly reason: string;
}

/**
 * The whole routing decision, as one pure function over the policy, the stored keys and the page.
 *
 * It never throws and never reaches the network: everything it needs was read before it was called,
 * so the same call the box makes is the call the tests make.
 */
export function routeCloudBrowser(input: CloudRouteInput): CloudRoute {
  const { policy, available } = input;
  const pick = (wanted: CloudBrowserVendor, reason: string): CloudRoute =>
    available.includes(wanted) ? { engine: wanted, reason } : { engine: "box", reason: `${reason}, but no key is stored for it` };

  if ((input.sessionsThisTurn ?? 0) >= policy.sessionCeilingPerTurn) {
    return { engine: "box", reason: "this turn has already opened as many cloud sessions as it may" };
  }
  if (policy.engine === "box") return { engine: "box", reason: "this workspace is pinned to the browser on the box" };
  if (policy.engine === "browser-use" || policy.engine === "browserbase") {
    return pick(policy.engine, "this workspace is pinned to a cloud browser");
  }
  // "auto" from here.
  if (input.escalating === true) {
    if (!policy.autoEscalate) return { engine: "box", reason: "this workspace does not let a page escalate to the cloud" };
    return pick(policy.preferred, "the page came back with nothing worth reading");
  }
  if (isCloudSite(input.url, policy.cloudSites)) {
    return pick(policy.preferred, "this site is on the workspace's cloud list");
  }
  return { engine: "box", reason: "the browser on the box is the default" };
}

/**
 * Is THIS answer one worth spending a cloud session on? Exactly three verdicts, and no others: a
 * failed tool call is not an escalation (it is a bug or a bad address, and paying a vendor to see
 * it again teaches nobody anything), and a page that simply had little on it is not one either.
 */
export function shouldEscalateOnVerdicts(verdicts: {
  readonly needsLogin?: boolean | undefined;
  readonly blocked?: boolean | undefined;
  readonly emptyShell?: boolean | undefined;
}): boolean {
  return verdicts.needsLogin === true || verdicts.blocked === true || verdicts.emptyShell === true;
}
