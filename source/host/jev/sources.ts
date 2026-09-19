import { takeWebFetchRoute } from "../extensions/inference/web-tools.js";
import { currentJevTurn, type JevTurn } from "./turn-state.js";

/**
 * SOURCES-1. Where a research answer came from, said under the answer.
 *
 * A tester read a reply and asked "not sure if it was their website or internet search". The turn
 * knew: JEV-2 already keeps every search and every fetched page for the claim check. That list was
 * only ever read by the judge, so the person who owns the business could not see it.
 *
 * This is the same collection point, recording the half the judge does not need -- what was asked,
 * which page it landed on, and how the page was reached -- and none of the half it does: the page
 * text never enters this record and never leaves the host.
 *
 * It rides beside `jev.evidence` rather than inside it. The claim check's prompt is built from
 * `evidence` and is tuned on its shape, so a field added there would change what the judge reads;
 * a second list changes nothing about JEV-2 at all.
 */

/** How a page was reached. The words the console says for each are in `ROUTE_WORDS`. */
export type JevSourceRoute = "fetch" | "tinyfish" | "browser";

export interface JevSearchSource {
  readonly kind: "search";
  readonly query: string;
  /** The tool that ran the search, kept so a record can be read back without guessing. */
  readonly tool: string;
}

export interface JevPageSource {
  readonly kind: "page";
  readonly domain: string;
  readonly title?: string;
  readonly route: JevSourceRoute;
}

export type JevSource = JevSearchSource | JevPageSource;

/**
 * What is stamped onto the reply. The counts are the whole deduplicated totals and the two lists
 * are capped, so a turn that read forty pages says forty and shows the first twelve rather than
 * quietly becoming a turn that read twelve.
 */
export interface JevSourcesRecord {
  readonly pages: readonly JevPageSource[];
  readonly searches: readonly JevSearchSource[];
  readonly pageCount: number;
  readonly searchCount: number;
}

export const JEV_SOURCES_LIST_MAX = 12;
/** A title longer than this is a page's first paragraph, not its name. */
export const JEV_SOURCE_TITLE_CHARS = 120;

/**
 * Which tools reach the web, and what reaching it through each of them is called. Names differ by
 * prompt version for the same reason `isJevWebToolName` carries several: the same tool is
 * `WebSearch` on the current prompts and `web_search` on an older one.
 *
 * The browser entries are the two that land on a page. A click or a screenshot happens on a page
 * that is already in this list, so counting it again would say a turn read four pages when it read
 * one.
 */
const SOURCE_TOOLS: Readonly<Record<string, { readonly kind: "search" | "page"; readonly route: JevSourceRoute }>> = {
  WebSearch: { kind: "search", route: "fetch" },
  web_search: { kind: "search", route: "fetch" },
  WebFetch: { kind: "page", route: "fetch" },
  web_fetch: { kind: "page", route: "fetch" },
  mcp_web_fetch: { kind: "page", route: "fetch" },
  browser_open: { kind: "page", route: "browser" },
  browser_navigate: { kind: "page", route: "browser" },
};

export function isJevSourceToolName(name: string): boolean {
  return Object.hasOwn(SOURCE_TOOLS, name);
}

/**
 * The host address of a URL, without `www.`, which is the part a person recognises. Anything this
 * cannot parse is not a page and is not recorded: a record that named a source it could not
 * identify would be worse than a record one line shorter.
 */
export function domainOf(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.replace(/^www\./i, "");
    return host.length === 0 ? undefined : host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The arguments of a tool call, whichever position they are in, when they arrive already parsed.
 *
 * Most of the tools here do NOT arrive that way, which is what the tee below exists for. This is
 * the fallback for a caller that hands over a plain object, and for the tests.
 */
export function readSourceArgs(args: readonly unknown[]): Record<string, unknown> | undefined {
  for (const candidate of args) {
    if (typeof candidate !== "object" || candidate === null) continue;
    if (Symbol.asyncIterator in candidate || Symbol.iterator in candidate) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.url === "string" || typeof record.search_term === "string"
      || typeof record.searchTerm === "string" || typeof record.query === "string") return record;
  }
  return undefined;
}

/**
 * The arguments as the tool actually receives them, which is a STREAM.
 *
 * This is the whole reason the first build of this feature collected nothing on a live box while
 * every unit test passed. `createZodAgentTool` (packages/agent/tools/common.ts) calls
 * `execute(context, interactionHandler, argsStream, meta)` where `argsStream` is an
 * `AsyncIterable<string>` of JSON chunks: there is no parsed arguments object anywhere in the call
 * for a search or a fetch. The evidence collector beside this one never noticed, because it reads
 * the RESULT; this one wants the query, and a query only exists in the arguments.
 *
 * So the stream is passed through a tee that yields exactly what it was given, in order, and keeps
 * a copy. It never buffers ahead of the consumer, never re-yields, and forwards `return` and
 * `throw`, so a tool that abandons the stream early abandons the real one the same way. If nothing
 * consumes it, the copy is empty and the turn is one source short: the same failure mode as every
 * other read here, and never a changed call.
 */
export interface TeedArgs {
  readonly args: readonly unknown[];
  /** The parsed arguments, once the tool has consumed the stream. */
  read(): Record<string, unknown> | undefined;
}

export function teeSourceArgs(args: readonly unknown[]): TeedArgs {
  const chunks: string[] = [];
  let teed = false;
  const out = args.map((candidate) => {
    if (teed || typeof candidate !== "object" || candidate === null) return candidate;
    if (!(Symbol.asyncIterator in candidate)) return candidate;
    teed = true;
    const source = candidate as AsyncIterable<unknown>;
    return {
      [Symbol.asyncIterator]() {
        const inner = source[Symbol.asyncIterator]();
        return {
          async next(...rest: []) {
            const step = await inner.next(...rest);
            if (step.done !== true && typeof step.value === "string") chunks.push(step.value);
            return step;
          },
          async return(value?: unknown) {
            return inner.return === undefined ? { done: true as const, value } : inner.return(value);
          },
          async throw(error?: unknown) {
            if (inner.throw === undefined) throw error;
            return inner.throw(error);
          },
        };
      },
    };
  });
  return {
    args: out,
    read() {
      if (chunks.length === 0) return undefined;
      try {
        const parsed: unknown = JSON.parse(chunks.join(""));
        return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
      } catch {
        // A stream the tool abandoned mid-argument is not valid JSON, and a half-read query is
        // worse than none.
        return undefined;
      }
    },
  };
}

/**
 * A string field somewhere in a tool result. Results here are protobuf messages, plain objects and
 * strings depending on the tool, and the page's name sits at a different depth in each, so this
 * walks rather than reaching for a path. Bounded on depth and breadth because a browser result
 * carries a screenshot and walking one whole is not worth a title.
 */
export function findStringField(value: unknown, field: string, depth = 4): string | undefined {
  if (depth < 0 || typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      const found = findStringField(item, field, depth - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record[field];
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  for (const nested of Object.values(record).slice(0, 16)) {
    const found = findStringField(nested, field, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The page's name. A browser result states it; a fetched page carries it as the heading
 * `htmlToText` puts on top of the text (web-tools.ts), which is the page's own `<title>`.
 * A page that names itself only by its address gets no title rather than a made-up one.
 */
export function pageTitle(result: unknown): string | undefined {
  const stated = findStringField(result, "title");
  const heading = stated ?? headingOf(findStringField(result, "markdown") ?? findStringField(result, "text"));
  if (heading === undefined) return undefined;
  const flat = heading.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length > JEV_SOURCE_TITLE_CHARS ? `${flat.slice(0, JEV_SOURCE_TITLE_CHARS)}...` : flat;
}

function headingOf(markdown: string | undefined): string | undefined {
  if (markdown === undefined) return undefined;
  // `\n` is a real newline in an object and an escaped one once a protobuf has been stringified.
  const match = /^#\s+(.+?)(?:\\n|\n|$)/.exec(markdown.trimStart());
  const heading = match?.[1]?.trim();
  if (heading === undefined || heading.length === 0) return undefined;
  // "# Content from https://..." is the fetch tool's own caption, not the page's name.
  return /^content from\s+https?:/i.test(heading) ? undefined : heading;
}

/**
 * Records what one call reached. Never throws and never changes the call: a result this cannot
 * read leaves the turn with one less source and nothing else, which is the same rule the evidence
 * collector beside it keeps.
 */
export function noteJevSource(
  jev: JevTurn,
  toolName: string,
  args: readonly unknown[] | Record<string, unknown> | undefined,
  result: unknown,
): void {
  const spec = SOURCE_TOOLS[toolName];
  if (spec === undefined) return;
  const parsed: Record<string, unknown> | undefined = Array.isArray(args)
    ? readSourceArgs(args)
    : args as Record<string, unknown> | undefined;
  if (spec.kind === "search") {
    // A query exists nowhere but the arguments, so a search the tee could not read is not recorded.
    if (parsed === undefined) return;
    const query = [parsed.search_term, parsed.searchTerm, parsed.query].find((value) => typeof value === "string");
    const text = String(query ?? "").trim();
    if (text.length === 0) return;
    jev.sources.push({ kind: "search", query: text, tool: toolName });
    return;
  }
  // The address the RESULT reports wins over the one the request asked for: it is the address that
  // was actually read, after credentials were stripped and a redirect was followed, and it is also
  // the key the fetch service left its road under. The request's own address is the fallback for a
  // tool whose result does not carry one.
  const url = findStringField(result, "url") ?? (typeof parsed?.url === "string" ? parsed.url : "");
  const domain = domainOf(url);
  if (domain === undefined) return;
  // A fetch that fell through to the backup web service really was reached through TinyFish, and
  // the tool name cannot say so: the fallback happens under the tool, inside the fetch service.
  const route = spec.route === "fetch" && takeWebFetchRoute(url) === "backup" ? "tinyfish" : spec.route;
  const title = pageTitle(result);
  jev.sources.push({ kind: "page", domain, route, ...(title === undefined ? {} : { title }) });
}

interface WrappableTool {
  readonly name: string;
  execute(...args: readonly unknown[]): unknown;
}

/** Wraps a search, fetch or browser tool so what it reached is recorded for this turn. */
export function collectJevSources<T extends WrappableTool>(tool: T, jev: JevTurn): T {
  return {
    ...tool,
    async execute(...args: readonly unknown[]) {
      // Teed BEFORE the call and read AFTER it: the arguments arrive as a stream the tool has not
      // consumed yet, so there is nothing to read until it has.
      const teed = teeSourceArgs(args);
      const result = await tool.execute(...teed.args);
      try { noteJevSource(jev, tool.name, teed.read() ?? readSourceArgs(args), result); } catch {}
      return result;
    },
  };
}

/**
 * The record, from what the turn collected. A page read twice is one page and a query run twice is
 * one search, because the line under the reply is what the person counts and a person counting
 * sources counts distinct ones. A page seen both fetched and in the browser keeps both rows: how
 * it was reached is the question this feature was asked.
 */
export function describeJevSources(sources: readonly JevSource[]): JevSourcesRecord | undefined {
  const pages = new Map<string, JevPageSource>();
  const searches = new Map<string, JevSearchSource>();
  for (const source of sources) {
    if (source.kind === "search") {
      const key = source.query.toLowerCase();
      if (!searches.has(key)) searches.set(key, source);
      continue;
    }
    const key = `${source.route} ${source.domain} ${source.title ?? ""}`;
    if (!pages.has(key)) pages.set(key, source);
  }
  if (pages.size === 0 && searches.size === 0) return undefined;
  return {
    pages: [...pages.values()].slice(0, JEV_SOURCES_LIST_MAX),
    searches: [...searches.values()].slice(0, JEV_SOURCES_LIST_MAX),
    pageCount: pages.size,
    searchCount: searches.size,
  };
}

/**
 * Transcript store hook, beside `withEvidence` and `withJevChip`. Stamps in place for the same
 * reason those do: the live session serves this object from memory, so a copy would leave the
 * console blind until a reload.
 *
 * Only a text reply carries one, and only when the turn reached something. A reply to "hi" reached
 * nothing, so it gets no record and the console draws no line.
 */
export function withJevSources<T extends object>(agentId: string, entry: T): T {
  const e = entry as { kind?: string; message?: { type?: string }; sources?: unknown };
  if (e.kind !== "send-message" || e.sources != null || e.message?.type !== "text") return entry;
  const turn = currentJevTurn(agentId);
  if (turn === undefined || turn.sources.length === 0) return entry;
  const record = describeJevSources(turn.sources);
  if (record !== undefined) e.sources = record;
  return entry;
}
