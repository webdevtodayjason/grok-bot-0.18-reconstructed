/**
 * CURSOR-1. The backup behind WebFetch and WebSearch: TinyFish, reached two ways.
 *
 * A direct read from this machine covers most of the web. What it does not cover is the part that
 * refuses a plain fetch -- a 403 to anything that is not a browser, a rate limit, a login wall, a
 * page that only exists once JavaScript has run. TinyFish renders those in a real browser, and it
 * is already a first-class connector on this product (docs/CONNECTORS-TINYFISH.md).
 *
 * Two routes, in this order, and the order matters:
 *
 *  1. The connector. If a server called `tinyfish` is in `connectors.json`, the box already runs it
 *     and already holds its credential, whether that credential is an API key in the 0600 store or
 *     an OAuth refresh token from the desktop sign-in. Going through the connector means this code
 *     never needs to see either. `fetch_content` and `search` are two of the nineteen tools that
 *     connector exposes (measured on the R750 2026-09-05).
 *  2. The REST APIs, with the key from `connector-env-secrets.json` under server `tinyfish`, field
 *     `TINYFISH_API_KEY`. This is the route when the connector is not installed but the operator
 *     has stored the key. `POST https://api.fetch.tinyfish.ai` and
 *     `GET https://api.search.tinyfish.ai?query=...`, both with `X-API-Key`, both free per
 *     TinyFish's own documentation.
 *
 * PROXY-1 changed WHERE route 2 dials and WHAT it carries, and changed nothing else. On an operator
 * install both endpoints are still TinyFish's own hosts and the header is still `X-API-Key`. On a
 * tenant box the control plane writes the proxy's two pass-through paths into the same 0600 store,
 * and the key in `TINYFISH_API_KEY` is that box's own virtual key rather than the operator's
 * TinyFish key -- so the header becomes an `Authorization` bearer, which is what the pass-through
 * authenticates and meters on. One box, one credential, revocable, and the operator's key never
 * lands in it. See docs/PROXY.md.
 *
 * Neither route ever reads a key off the operator's own laptop. The only place a key comes from is
 * the host-owned secret store this product already writes.
 *
 * Like web-tools.ts this file has no runtime imports: the two file readers and the connector caller
 * arrive as options, so production.ts owns the paths and the tests own a fake TinyFish.
 */

import type { FetchLike, WebFallback, WebSearchDocument } from "./web-tools.js";

export const TINYFISH_CONNECTOR_NAME = "tinyfish";
export const TINYFISH_KEY_FIELD = "TINYFISH_API_KEY";
export const TINYFISH_FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";
export const TINYFISH_SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
export const TINYFISH_FETCH_TOOL = "fetch_content";
export const TINYFISH_SEARCH_TOOL = "search";

/**
 * PROXY-1. The two endpoints above are defaults now, not constants of the product. A tenant box is
 * pointed at the proxy instead, and the two names below are where that redirection is written: the
 * SAME 0600 store the key already comes from (`connector-env-secrets.json`, server `tinyfish`), so
 * one file write moves the credential and the target together, and a box with neither field set
 * behaves exactly as it did before.
 *
 * They are endpoints, not credentials. They live in that file because it is the per-server
 * configuration the host already merges into this connector's world, not because a URL is a secret.
 */
export const TINYFISH_FETCH_ENDPOINT_FIELD = "TINYFISH_FETCH_ENDPOINT";
export const TINYFISH_SEARCH_ENDPOINT_FIELD = "TINYFISH_SEARCH_ENDPOINT";

/**
 * The pass-through contract, pinned here so the proxy's config, the control plane's writer and this
 * caller cannot disagree: the proxy mounts TinyFish's two REST APIs under these two paths and
 * injects the OPERATOR key on the way out. A box therefore holds `<proxy base>/tinyfish/fetch` and
 * `<proxy base>/tinyfish/search` in the two fields above, and its own virtual key in
 * `TINYFISH_API_KEY`.
 */
export const PROXY_TINYFISH_FETCH_PATH = "/tinyfish/fetch";
export const PROXY_TINYFISH_SEARCH_PATH = "/tinyfish/search";

/** The one thing this module needs from the box's own MCP client. */
export interface ConnectorToolCaller {
  callTool(request: {
    readonly server: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
  }): Promise<string>;
}

export interface TinyFishRouteDeps {
  /** Names of the servers in this machine's connectors.json. */
  readonly listConnectors: () => readonly string[];
  /** The stored TinyFish key, or null. Never returns a value from anywhere but the host store. */
  readonly readApiKey: () => string | null;
  /**
   * PROXY-1. Where the REST leg dials, or null for TinyFish's own host. Optional, so every caller
   * that predates the proxy -- and every box with nothing configured -- keeps today's behaviour
   * byte for byte.
   */
  readonly readFetchEndpoint?: () => string | null;
  readonly readSearchEndpoint?: () => string | null;
  /** The box's MCP client, or null before the box is up. */
  readonly connectorTools: () => ConnectorToolCaller | null;
  readonly fetchImpl?: FetchLike;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A TinyFish payload, however it arrived. The connector hands back the tool's text content, which
 * is the same JSON body the REST API returns; a server that answered with plain prose instead is
 * still useful, so an unparseable body becomes the page text rather than an error.
 */
export function parseFetchPayload(raw: string, url: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw.trim(); }
  const document = asRecord(parsed);
  if (document == null) return raw.trim();
  const results = Array.isArray(document.results) ? document.results : [];
  const texts: string[] = [];
  for (const entry of results) {
    const result = asRecord(entry);
    if (result == null) continue;
    const text = typeof result.text === "string" ? result.text : JSON.stringify(result.text ?? "");
    if (text.trim().length === 0) continue;
    const title = asString(result.title);
    texts.push(title.length > 0 && !text.startsWith("#") ? `# ${title}\n\n${text}` : text);
  }
  if (texts.length > 0) return texts.join("\n\n").trim();
  const errors = Array.isArray(document.errors) ? document.errors : [];
  const first = asRecord(errors[0]);
  throw new Error(first == null ? `no content for ${url}` : `${asString(first.error) || "fetch failed"} for ${asString(first.url) || url}`);
}

export function parseSearchPayload(raw: string): readonly WebSearchDocument[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw.trim().length === 0 ? [] : [{ title: "Web search results", url: "", text: raw.trim() }]; }
  const document = asRecord(parsed);
  const results = document != null && Array.isArray(document.results) ? document.results : Array.isArray(parsed) ? parsed : [];
  const documents: WebSearchDocument[] = [];
  for (const entry of results) {
    const result = asRecord(entry);
    if (result == null) continue;
    const text = asString(result.snippet) || asString(result.text) || asString(result.description);
    const title = asString(result.title) || asString(result.site_name);
    const url = asString(result.url);
    if (text.length === 0 && title.length === 0) continue;
    documents.push({ title: title.length > 0 ? title : url, url, text });
  }
  return documents;
}

function createConnectorFallback(caller: ConnectorToolCaller): WebFallback {
  return {
    route: "connector",
    async fetchPage(url) {
      const raw = await caller.callTool({
        server: TINYFISH_CONNECTOR_NAME,
        tool: TINYFISH_FETCH_TOOL,
        args: { urls: [url], format: "markdown", links: false, image_links: false, page_metadata: false },
      });
      return parseFetchPayload(raw, url);
    },
    async search(query) {
      const raw = await caller.callTool({
        server: TINYFISH_CONNECTOR_NAME,
        tool: TINYFISH_SEARCH_TOOL,
        args: { query },
      });
      return parseSearchPayload(raw);
    },
  };
}

/**
 * TinyFish's own REST endpoints require `X-API-Key`; the proxy's pass-through authenticates and
 * meters on an `Authorization` bearer, which is what its virtual keys are everywhere else in this
 * product. BOTH shapes stay in this file on purpose -- the connector preset's own description
 * records that the MCP endpoint refuses `X-API-Key` while the REST endpoints require it, so neither
 * header is a leftover and deleting either one breaks a real route.
 *
 * The endpoint decides, not a flag: a host under `tinyfish.ai` is TinyFish itself and takes the key
 * header; anything else a box has been pointed at is the proxy and takes the bearer. An endpoint
 * that will not parse is treated as TinyFish's own, which is exactly today's behaviour.
 */
function isTinyFishOwnHost(endpoint: string): boolean {
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return true; }
  return host === "tinyfish.ai" || host.endsWith(".tinyfish.ai");
}

function authHeaders(endpoint: string, apiKey: string): Record<string, string> {
  return isTinyFishOwnHost(endpoint) ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
}

/** `?query=` on a bare endpoint, `&query=` on one that already carries a query string. */
function withQuery(endpoint: string, query: string): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}query=${encodeURIComponent(query)}`;
}

/** A stored endpoint, or the default. Blank or whitespace reads as "not set", never as an empty URL. */
function resolveEndpoint(read: (() => string | null) | undefined, fallback: string): string {
  const value = read?.() ?? null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function createApiFallback(
  apiKey: string,
  fetchImpl: FetchLike,
  fetchEndpoint: string,
  searchEndpoint: string,
): WebFallback {
  const headers = { ...authHeaders(fetchEndpoint, apiKey), "content-type": "application/json", accept: "application/json" };
  return {
    route: "api",
    async fetchPage(url) {
      const response = await fetchImpl(fetchEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ urls: [url], format: "markdown" }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`fetch API answered ${response.status}`);
      return parseFetchPayload(await response.text(), url);
    },
    async search(query) {
      const response = await fetchImpl(withQuery(searchEndpoint, query), {
        method: "GET",
        headers: { ...authHeaders(searchEndpoint, apiKey), accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`search API answered ${response.status}`);
      return parseSearchPayload(await response.text());
    },
  };
}

/**
 * The route this machine actually has, resolved on every tool call so a connector added or a key
 * stored while the host is up takes effect on the next call rather than the next restart.
 *
 * `null` is a real answer: neither route is configured, and the failure text says so in words the
 * person can act on instead of blaming the site.
 */
export function resolveWebFallback(deps: TinyFishRouteDeps): WebFallback | null {
  const caller = deps.connectorTools();
  if (caller != null && deps.listConnectors().includes(TINYFISH_CONNECTOR_NAME)) {
    return createConnectorFallback(caller);
  }
  const apiKey = deps.readApiKey();
  if (apiKey != null && apiKey.length > 0) {
    return createApiFallback(
      apiKey,
      deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
      resolveEndpoint(deps.readFetchEndpoint, TINYFISH_FETCH_ENDPOINT),
      resolveEndpoint(deps.readSearchEndpoint, TINYFISH_SEARCH_ENDPOINT),
    );
  }
  return null;
}
