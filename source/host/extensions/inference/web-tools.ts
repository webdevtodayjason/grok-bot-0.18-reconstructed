/**
 * CURSOR-1 / TOOLS-FETCH-1. WebFetch and WebSearch, ours.
 *
 * What these two tools used to be: `createCursorWebSearchService` and `createCursorWebFetchService`,
 * two Connect-RPC clients calling `AiService.RunWebSearch` and `AiService.RunWebFetch` on
 * api2.cursor.sh. Measured on the R750 2026-09-07: every call answered
 * "Error: Tool failed; this may be temporary. Try again." Richard's first session made 11 fetches
 * and 8 searches and every one of them failed, because those RPCs authenticate against a backend
 * that is not ours and answers 401. The provider router only ever overrode `createSession` and
 * `createSummarizationSession`, so moving the whole box to xAI or a local endpoint left both web
 * tools still dialling Cursor.
 *
 * This module is the replacement, and it is deliberately free of imports so it can be loaded and
 * exercised on its own. Everything it needs from the rest of the host -- how to reach the backup
 * web service, which error class to throw -- arrives as an option.
 *
 * The order, in one line: read the page from this machine first, and only when the site refuses
 * hand it to the backup web service.
 *
 * The tool names, argument schemas, renderers and console tool rows are untouched. The seam is
 * `createWebSearch` / `createWebFetch` in production.ts, so `packages/agent/tools/core/web-fetch.ts`
 * and `web-search.ts` keep their shells and the model keeps its habits.
 */

/** A page bigger than this is not a page, it is a download. */
export const MAX_WEB_FETCH_BYTES = 25 * 1024 * 1024;

/** How long one direct read may take before this machine gives up and tries the backup. */
export const WEB_FETCH_TIMEOUT_MS = 30_000;

/**
 * A real browser's User-Agent. A plain node fetch identifies itself as `node`, and a large share of
 * the sites a person actually asks about answer that with a 403 or an interstitial. Sending a
 * browser string is not a disguise: the request really is a person asking to read the page, made on
 * their behalf, and the site's own robots and rate limits still apply.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": BROWSER_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export interface WebFetchOutcome {
  readonly content?: string;
  readonly error?: string;
  readonly isTimeout?: boolean;
}

export interface WebSearchDocument {
  readonly title: string;
  readonly url: string;
  readonly text: string;
}

export interface WebSearchOutcome {
  readonly answer?: string;
  readonly documents: readonly WebSearchDocument[];
}

/**
 * The backup web service. `resolveWebFallback` in tinyfish-route.ts builds one of these out of the
 * TinyFish connector or the TinyFish REST key; `null` means this machine has neither, which is a
 * state the failure text has to name rather than hide.
 */
export interface WebFallback {
  /** Resolves the page text. Throws when the backup could not read it either. */
  fetchPage(url: string): Promise<string>;
  /** Resolves ranked results. Throws when the backup could not answer. */
  search(query: string): Promise<readonly WebSearchDocument[]>;
  /** "connector" when it goes through this machine's own connector, "api" when it goes direct. */
  readonly route: "connector" | "api";
}

export interface ToolErrorFields {
  readonly clientVisibleErrorMessage: string;
  readonly modelVisibleErrorMessage: string;
  readonly error: string;
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<WebResponseLike>;

export interface WebResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: unknown;
  text(): Promise<string>;
}

export interface SandWebToolsOptions {
  /** Called per tool call, so a connector added while the host is up is picked up on the next call. */
  readonly resolveFallback: () => WebFallback | null | Promise<WebFallback | null>;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Wraps a failure so the tool layer can show one text to the person and another to the model. */
  readonly createError?: (fields: ToolErrorFields) => Error;
  /** Injected by the tests; production resolves the name through this machine's own resolver. */
  readonly resolveAddresses?: HostResolver;
}

/** Every address a name lands on. Never throws: a name that will not resolve reaches nothing. */
export type HostResolver = (host: string) => Promise<readonly string[]>;

/* ------------------------------------------------------------------ *
 * The words a failure ends in.
 * ------------------------------------------------------------------ */

/**
 * "Error: Tool failed; this may be temporary. Try again." is the string Richard saw eleven times.
 * It tells the person nothing they can act on and it tells the model to retry a call that can
 * never succeed, so the agent loops. Every message below names what was tried and ends on the one
 * thing that still works: open it yourself.
 *
 * No tool name, no service name and no vendor name appears in any of them. The person asked to
 * read a page, not to run a tool.
 */
const NEXT_STEP_PAGE = "Open the page in your browser and read it from there.";
const NEXT_STEP_SEARCH = "Search for it in your browser instead.";
const NO_RETRY = "Trying again will not help.";

export type DirectFailure = "refused" | "unreachable" | "empty" | "not-text" | "private";

function describeDirectRead(why: DirectFailure): string {
  switch (why) {
    case "refused": return "The site refused a direct fetch";
    case "unreachable": return "This machine could not reach the site";
    case "empty": return "The page came back empty, which usually means it only draws itself in a browser";
    case "not-text": return "The page is not text";
    case "private": return "That address is not on the public web";
  }
}

/**
 * BROWSER-1 wrote this refusal for the browser; TOOLS-FETCH-4 owes it to the fetch. Before CURSOR-1
 * this tool ran on somebody else's servers and could not reach the box at all. It runs here now, so
 * a page the model was told to read is one address away from the operator console, another agent's
 * Chrome, or anything else on the network this box sits on.
 */
export function webFetchPrivateAddressMessage(where: string): string {
  return `Could not read that page. ${where} is on this machine or on the private network this machine `
    + `sits on, and this reads pages on the public web. ${NO_RETRY} ${NEXT_STEP_PAGE}`;
}

export function webFetchFailureMessage(args: {
  readonly why: DirectFailure;
  readonly fallback: "failed" | "missing";
}): string {
  const tail = args.fallback === "failed"
    ? "and the fallback could not reach it either."
    : "and there is no backup web service set up on this machine.";
  return `Could not read that page. ${describeDirectRead(args.why)} ${tail} ${NO_RETRY} ${NEXT_STEP_PAGE}`;
}

export function webSearchFailureMessage(fallback: "failed" | "missing"): string {
  return fallback === "failed"
    ? `Could not run that search. The web search service on this machine did not answer. ${NO_RETRY} ${NEXT_STEP_SEARCH}`
    : "Could not run that search. No web search service is set up on this machine. Ask whoever set this up to add one under Settings, or search for it in your browser.";
}

/* ------------------------------------------------------------------ *
 * Reading a page from this machine.
 * ------------------------------------------------------------------ */

const TEXTUAL_CONTENT_TYPES = ["text/", "application/json", "application/xml", "application/xhtml", "+json", "+xml", "application/javascript"];

export function isTextualContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  if (value.length === 0) return true; // no header at all: read it and let the body decide
  return TEXTUAL_CONTENT_TYPES.some((marker) => value.includes(marker));
}

const BLOCK_ELEMENTS = ["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "ul", "ol", "table", "tr", "blockquote", "pre", "form"];

/**
 * The named entities a page a person actually asks about tends to use. Numeric entities are decoded
 * arithmetically below, so this table only has to cover names; anything not on it is left as it was
 * written rather than guessed at, which is wrong-looking but never wrong.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  pound: "£", euro: "€", cent: "¢", yen: "¥", copy: "©", reg: "®", trade: "™",
  deg: "°", plusmn: "±", times: "×", divide: "÷", frac12: "½", frac14: "¼",
  middot: "·", bull: "•", dagger: "†", sect: "§", para: "¶", permil: "‰",
  laquo: "«", raquo: "»", sbquo: "‚", bdquo: "„", prime: "′", Prime: "″",
  larr: "←", rarr: "→", harr: "↔", darr: "↓", uarr: "↑", ne: "≠", le: "≤", ge: "≥",
  shy: "", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole: string, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    const known = ENTITIES[name.toLowerCase()];
    return known === undefined ? whole : known;
  });
}

/**
 * HTML reduced to something a model can read. Not a renderer: headings keep their level as markdown
 * hashes, list items keep a dash, links keep their text, and everything a page uses to draw itself
 * (script, style, svg, template, head) is dropped before any of that. A page that leaves nothing
 * behind is reported as empty; a page that leaves only its own title behind reads as a shell, which
 * is `looksLikeTitleOnly` above rather than the empty branch, because the title is prepended here.
 */
export function htmlToText(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(script|style|noscript|svg|template|head|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n\n");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(/<h([1-6])\b[^>]*>/gi, (_whole: string, level: string) => `\n\n${"#".repeat(Number(level))} `);
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  for (const element of BLOCK_ELEMENTS) {
    text = text.replace(new RegExp(`</?${element}\\b[^>]*>`, "gi"), "\n\n");
  }
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  if (title != null && title.length > 0 && !text.startsWith("# ")) {
    const decodedTitle = decodeEntities(title).replace(/\s+/g, " ").trim();
    if (decodedTitle.length > 0) return `# ${decodedTitle}\n\n${text}`;
  }
  return text;
}

export type DirectRead =
  | { readonly ok: true; readonly text: string; readonly wall: boolean }
  | { readonly ok: false; readonly why: DirectFailure; readonly detail: string };

/**
 * A wall is a page that answered 200 and still did not give up its content: a sign-in page, a bot
 * check, or a "turn on JavaScript" shim. Measured 2026-09-07 from this Mac: a plain fetch of
 * https://www.linkedin.com/feed/ answers 200 with 792 characters that are entirely a sign-in form,
 * so a status code alone never catches it.
 *
 * The detector is deliberately narrow, because a false positive costs a needless call to the
 * backup and, worse, would hand the person a different page than the one they asked for. Both
 * halves have to hold: the page has to be SHORT (a real article is not 1200 characters of
 * navigation) and it has to say one of these things. And a wall is not a failure -- the text is
 * kept, and handed back if the backup cannot beat it.
 */
const WALL_MARKERS = [
  "sign in", "sign up", "log in", "login", "create an account", "you must be logged in",
  "enable javascript", "javascript is disabled", "javascript is required", "turn on javascript",
  "verify you are human", "checking your browser", "are you a robot", "unusual traffic",
  "access denied", "please complete the security check", "cookies are disabled",
];
const WALL_MAX_CHARS = 1_200;

export function looksLikeWall(text: string): boolean {
  if (text.length > WALL_MAX_CHARS) return false;
  const lowered = text.toLowerCase();
  return WALL_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * A shell is a page that answered 200 with a lot of markup and almost no words: the page draws
 * itself in a browser and the plain fetch only got the frame. Measured 2026-09-07 from this Mac:
 * https://www.instagram.com/titaniumcomputing/ answers 200 with a 620,447 byte body that reduces
 * to 13 characters, "# Instagram", and says none of the wall phrases. example.com reduces to 131
 * characters from a 559 byte body, and is a real page, as is any small page with few words. So
 * the rule is a big body that left almost nothing behind, both halves. A shell is handled like a
 * wall: the backup is asked, and the title is kept only if the backup cannot beat it.
 */
const SHELL_MIN_BODY_BYTES = 50_000;
const SHELL_MAX_CHARS = 400;

export function looksLikeShell(text: string, bodyBytes: number): boolean {
  return bodyBytes >= SHELL_MIN_BODY_BYTES && text.length < SHELL_MAX_CHARS;
}

/**
 * TOOLS-FETCH-3. A page whose whole readable content is its own title line. `htmlToText` puts the title on top of
 * whatever the body left behind, so a shell with a <title> -- which is nearly every real page --
 * never reduced to the empty string, and the empty branch below could not be reached for one.
 * Measured 2026-09-07: https://www.reddit.com/r/smallbusiness/ came back as "# Reddit" and nothing
 * else, and the person was told the page was empty rather than handed the article. Judged on what
 * is left after the title rather than on the body's size, so a small app shell is caught too.
 */
export function looksLikeTitleOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("# ") && !trimmed.slice(2).includes("\n");
}

/* ------------------------------------------------------------------ *
 * Where a fetch may go.
 * ------------------------------------------------------------------ */

/**
 * TOOLS-FETCH-4, the sibling of BROWSER-1's `assertBrowsableUrl`. The address in a WebFetch comes
 * from the model, and the model is told things by the pages it reads and by text a person pasted.
 * Measured on this Mac 2026-09-08 against the production module: `http://127.0.0.1:<port>/internal`
 * was refused by the tool's own precheck, and `http://localtest.me:<port>/internal` -- a public name
 * that resolves to loopback -- was allowed and returned the page. A 302 from that name to
 * 127.0.0.1 returned it too, because the read followed redirects without looking again.
 *
 * So the check is on the name, on every literal address the name lands on, and on every redirect
 * hop. The window between resolving a name and connecting to it is not closed here (nothing short
 * of a pinned socket closes it), and it is the same window the browser driver lives with.
 */
const PRIVATE_WEB_HOST_NAMES = new Set([
  "localhost", "ip6-localhost", "ip6-loopback", "host.docker.internal", "gateway.docker.internal",
]);

export function isPrivateWebHostName(host: string): boolean {
  return PRIVATE_WEB_HOST_NAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal");
}

/** True only for a literal address. A name is not an address and answers false. */
export function isPrivateWebAddress(host: string): boolean {
  if (host.includes(":")) {
    const plain = host.split("%")[0] ?? "";
    if (plain === "::" || plain === "::1") return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
    if (mapped != null) return isPrivateWebAddress(mapped[1] ?? "");
    return /^(fe8|fe9|fea|feb|fc|fd)/.test(plain);
  }
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts as [number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

/**
 * The default resolver. It never throws: a name this machine cannot resolve is a name the fetch
 * below cannot reach either, so an empty answer means "nothing private found" rather than a
 * failure, and the fetch decides.
 */
const lookupHostAddresses: HostResolver = async (host: string) => {
  try {
    const dns = await import("node:dns");
    const found = await dns.promises.lookup(host, { all: true, verbatim: true });
    return found.map((entry) => entry.address);
  } catch { return []; }
};

/** How many hops a redirect chain may take before it is treated as a site that will not settle. */
export const MAX_WEB_FETCH_REDIRECTS = 5;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

async function readBodyCapped(response: WebResponseLike, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`the page is ${declared} bytes, over the ${maxBytes} byte limit`);
  }
  const body = response.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | undefined;
  if (body == null || typeof body.getReader !== "function") {
    const whole = await response.text();
    return whole.length > maxBytes ? whole.slice(0, maxBytes) : whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value == null) continue;
    size += value.byteLength;
    if (size > maxBytes) throw new Error(`the page is over the ${maxBytes} byte limit`);
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8").decode(joined);
}

export async function readPageDirectly(
  url: string,
  options: {
    readonly fetchImpl: FetchLike;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly resolveAddresses?: HostResolver;
  },
): Promise<DirectRead> {
  const resolveAddresses = options.resolveAddresses ?? lookupHostAddresses;
  // Redirects are followed here rather than by fetch, because fetch's own follow re-checks nothing:
  // a public name that answers 302 to http://127.0.0.1/ handed back the box's own page.
  let target = url;
  let response: WebResponseLike;
  for (let hop = 0; ; hop += 1) {
    let parsed: URL;
    try { parsed = new URL(target); }
    catch { return { ok: false, why: "unreachable", detail: "that is not a web address" }; }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const where = parsed.port.length > 0 ? `${host}:${parsed.port}` : host;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, why: "private", detail: where };
    if (host.length === 0 || isPrivateWebHostName(host) || isPrivateWebAddress(host)) {
      return { ok: false, why: "private", detail: where };
    }
    if ((await resolveAddresses(host)).some(isPrivateWebAddress)) return { ok: false, why: "private", detail: where };
    try {
      response = await options.fetchImpl(target, {
        redirect: "manual",
        headers: { ...BROWSER_HEADERS },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      return { ok: false, why: "unreachable", detail: errorText(error) };
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location == null || location.length === 0) break;
    if (hop >= MAX_WEB_FETCH_REDIRECTS) {
      return { ok: false, why: "unreachable", detail: `the site redirected more than ${MAX_WEB_FETCH_REDIRECTS} times` };
    }
    try { target = new URL(location, target).toString(); }
    catch { return { ok: false, why: "unreachable", detail: "the site redirected to something that is not a web address" }; }
  }
  // Anything that is not a 2xx is the site declining to hand this machine the page: 403 and 429
  // are the measured ones, a login wall is usually a 401 or a redirect that lands on one, and a
  // 5xx is the site being unable to answer. All of them are worth one attempt through the backup.
  if (!response.ok) return { ok: false, why: "refused", detail: `HTTP ${response.status}` };
  const contentType = response.headers.get("content-type") ?? "";
  if (!isTextualContentType(contentType)) return { ok: false, why: "not-text", detail: contentType };
  let body: string;
  try {
    body = await readBodyCapped(response, options.maxBytes);
  } catch (error) {
    return { ok: false, why: "unreachable", detail: errorText(error) };
  }
  const text = contentType.toLowerCase().includes("html") || /^\s*<(!doctype|html)\b/i.test(body)
    ? htmlToText(body)
    : body.trim();
  if (text.length === 0) return { ok: false, why: "empty", detail: "no readable text" };
  return {
    ok: true,
    text,
    wall: looksLikeWall(text) || looksLikeShell(text, body.length) || looksLikeTitleOnly(text),
  };
}

/* ------------------------------------------------------------------ *
 * The two services.
 * ------------------------------------------------------------------ */

function defaultError(fields: ToolErrorFields): Error {
  return Object.assign(new Error(fields.error), fields);
}

async function resolveFallbackSafely(options: SandWebToolsOptions): Promise<WebFallback | null> {
  try { return await options.resolveFallback(); }
  catch { return null; }
}

export function createSandWebFetchService(options: SandWebToolsOptions) {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_WEB_FETCH_BYTES;
  const resolveAddresses = options.resolveAddresses ?? lookupHostAddresses;
  return async (_context: unknown, url: string): Promise<WebFetchOutcome> => {
    const direct = await readPageDirectly(url, { fetchImpl, timeoutMs, maxBytes, resolveAddresses });
    if (direct.ok && !direct.wall) return { content: direct.text };
    // An address on this machine or this network is not a page the backup should be asked to read
    // on our behalf either. It is refused here, and the person is told which address was refused.
    if (!direct.ok && direct.why === "private") return { error: webFetchPrivateAddressMessage(direct.detail) };
    const fallback = await resolveFallbackSafely(options);
    if (fallback != null) {
      try {
        const text = await fallback.fetchPage(url);
        if (text.trim().length > 0) return { content: text };
      } catch {
        // The backup's own reason is not the person's problem; what they can do about it is.
      }
    }
    // A wall still said something. Handing back a sign-in page is worse than an article and better
    // than an error, and it is what lets the model tell the person the page wants an account.
    if (direct.ok) return { content: direct.text };
    return { error: webFetchFailureMessage({ why: direct.why, fallback: fallback == null ? "missing" : "failed" }) };
  };
}

export function createSandWebSearchService(options: SandWebToolsOptions) {
  const createError = options.createError ?? defaultError;
  const fail = (kind: "failed" | "missing"): never => {
    const message = webSearchFailureMessage(kind);
    throw createError({ clientVisibleErrorMessage: message, modelVisibleErrorMessage: message, error: message });
  };
  return async (_context: unknown, args: { readonly searchTerm: string; readonly explanation?: string }): Promise<WebSearchOutcome> => {
    const fallback = await resolveFallbackSafely(options);
    if (fallback == null) return fail("missing");
    let documents: readonly WebSearchDocument[];
    try {
      documents = await fallback.search(args.searchTerm);
    } catch {
      return fail("failed");
    }
    if (documents.length === 0) return fail("failed");
    return { documents };
  };
}
