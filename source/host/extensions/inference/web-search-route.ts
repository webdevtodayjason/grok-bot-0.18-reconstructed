/**
 * BASELINE-1 piece 1, the host's half: reading and describing this box's web search route.
 *
 * THE FAULT THIS EXISTS FOR. Measured on the R750 2026-09-15: ten tenants, three boxes with a
 * TinyFish section in `connector-env-secrets.json`, seven with no `connector-env-secrets.json` at
 * all. On those seven, WebSearch answered "No web search service is set up on this machine" to
 * every question the customer asked, and the only way to change that was a person with a shell on
 * the server editing a file inside a container. `tinyfish-route.ts` already resolves the route from
 * that file; nothing could WRITE it except a hand.
 *
 * So the control plane gets a door. `getWebSearchRoute` says what this box has, and
 * `setWebSearchRoute` points it at the metering proxy's two pass-throughs with this box's own
 * virtual key. Both live in `host-gateway-api.ts`; everything here is the pure part, so the rules
 * are testable with no box and no gateway.
 *
 * NOTHING HERE RETURNS A STORED VALUE. The read answers with the key's LENGTH and the first twelve
 * characters of its sha256, which is how every other credential in this product is proved to have
 * landed (`proxy migrate` compares exactly this). A length and a hash are safe on a terminal an
 * operator may be sharing; the value is not, and a read that returned it would be a new way to get
 * a customer's credential out of their box.
 */

import { createHash } from "node:crypto";

import {
  TINYFISH_CONNECTOR_NAME,
  TINYFISH_FETCH_ENDPOINT,
  TINYFISH_FETCH_ENDPOINT_FIELD,
  TINYFISH_KEY_FIELD,
  TINYFISH_SEARCH_ENDPOINT,
  TINYFISH_SEARCH_ENDPOINT_FIELD,
} from "./tinyfish-route.js";

/** The three fields one write moves together: the credential, and the two places it is presented. */
export const WEB_SEARCH_ROUTE_FIELDS = [
  TINYFISH_KEY_FIELD,
  TINYFISH_FETCH_ENDPOINT_FIELD,
  TINYFISH_SEARCH_ENDPOINT_FIELD,
] as const;

/** The server section in `connector-env-secrets.json` these three live under. */
export const WEB_SEARCH_ROUTE_SERVER = TINYFISH_CONNECTOR_NAME;

export interface WebSearchRouteView {
  /** connector: the box runs the MCP server itself. api: the REST route. none: nothing is set up. */
  readonly route: "connector" | "api" | "none";
  /** True when a question the customer asks can be answered. The console has no other word for it. */
  readonly answers: boolean;
  readonly fetchEndpoint: string;
  readonly searchEndpoint: string;
  /** Whether the two endpoints are this product's proxy rather than the vendor's own host. */
  readonly metered: boolean;
  readonly keyLength: number;
  /** Twelve hex characters, or "" with no key. Never the credential. */
  readonly keySha256: string;
}

export interface WebSearchRouteWrite {
  readonly apiKey: string;
  readonly fetchEndpoint: string;
  readonly searchEndpoint: string;
}

const sha12 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * A stored endpoint, or the product default. Blank reads as "not set", never as an empty URL, which
 * is the same rule `resolveEndpoint` in tinyfish-route.ts keeps, said once more here so the view and
 * the route cannot disagree about what a box is pointed at.
 */
const endpointOr = (stored: unknown, fallback: string): string => text(stored) || fallback;

/**
 * A URL this box may be pointed at. http and https only, with a host: everything else is either a
 * mistake that would be found at the first customer question or a scheme a credential should never
 * be presented over.
 */
export function isWebSearchEndpoint(value: unknown): boolean {
  const candidate = text(value);
  if (candidate.length === 0) return false;
  let url: URL;
  try { url = new URL(candidate); } catch { return false; }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
}

/** Whether an endpoint is the vendor's own host, which is the one that takes a key header. */
export function isVendorHost(endpoint: string): boolean {
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return true; }
  return host === "tinyfish.ai" || host.endsWith(".tinyfish.ai");
}

/**
 * What this box has, from the section as it is on disk and the connector names it runs.
 *
 * The order matches `resolveWebFallback`: a connector wins, then a stored key, then nothing. Getting
 * that order wrong here would make the control plane report a box as unserved while its customer's
 * searches were answering perfectly well through the connector.
 */
export function describeWebSearchRoute(
  section: Readonly<Record<string, string>> | null | undefined,
  connectors: readonly string[] = [],
): WebSearchRouteView {
  const fields = section ?? {};
  const apiKey = text(fields[TINYFISH_KEY_FIELD]);
  const fetchEndpoint = endpointOr(fields[TINYFISH_FETCH_ENDPOINT_FIELD], TINYFISH_FETCH_ENDPOINT);
  const searchEndpoint = endpointOr(fields[TINYFISH_SEARCH_ENDPOINT_FIELD], TINYFISH_SEARCH_ENDPOINT);
  const route = connectors.includes(TINYFISH_CONNECTOR_NAME)
    ? "connector"
    : apiKey.length > 0 ? "api" : "none";
  return {
    route,
    answers: route !== "none",
    fetchEndpoint,
    searchEndpoint,
    metered: !isVendorHost(searchEndpoint) && !isVendorHost(fetchEndpoint),
    keyLength: apiKey.length,
    keySha256: apiKey.length > 0 ? sha12(apiKey) : "",
  };
}

/**
 * The write, checked. Every refusal is a sentence rather than a code, because the only reader is an
 * operator running one command against one workspace and the next thing they need is what to fix.
 */
export function checkWebSearchRouteWrite(args: unknown): { ok: true; write: WebSearchRouteWrite } | { ok: false; why: string } {
  const body = (typeof args === "object" && args != null ? args : {}) as Record<string, unknown>;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const fetchEndpoint = text(body.fetchEndpoint);
  const searchEndpoint = text(body.searchEndpoint);
  if (apiKey.length === 0) return { ok: false, why: "setWebSearchRoute needs a non-empty `apiKey`, which is this box's own key and never the operator's" };
  if (!isWebSearchEndpoint(fetchEndpoint)) return { ok: false, why: "setWebSearchRoute needs `fetchEndpoint` to be an http or https address" };
  if (!isWebSearchEndpoint(searchEndpoint)) return { ok: false, why: "setWebSearchRoute needs `searchEndpoint` to be an http or https address" };
  if (fetchEndpoint === searchEndpoint) return { ok: false, why: "the fetch and search addresses are the same, so one of them is wrong" };
  return { ok: true, write: { apiKey, fetchEndpoint, searchEndpoint } };
}

/** The evidence line a write answers with: what landed, proved by length and hash and never by value. */
export function webSearchRouteEvidence(write: WebSearchRouteWrite): { keyLength: number; keySha256: string } {
  return { keyLength: write.apiKey.length, keySha256: sha12(write.apiKey) };
}
