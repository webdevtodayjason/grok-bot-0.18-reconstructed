import { EVIDENCE_CHARS, trimEvidence } from "./judgment-3.js";
import type { JevTurn } from "./turn-state.js";

/**
 * JEV-2. Keeping what the turn retrieved, so the claim check has something to judge against.
 *
 * The tool names differ by prompt version, which is why this is a set rather than two constants:
 * the same tool is `WebSearch` on the current prompts and `web_search` on one older one, and a
 * claim check that silently collected nothing because the name changed would look exactly like a
 * claim check that found no evidence.
 */
const WEB_TOOL_NAMES = new Set(["WebSearch", "web_search", "WebFetch", "mcp_web_fetch"]);

export function isJevWebToolName(name: string): boolean {
  return WEB_TOOL_NAMES.has(name);
}

const URL_PATTERN = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;

/** The domain a result came from, which is the half of the evidence the judge reasons about. */
export function firstDomain(text: string, fallback: string): string {
  URL_PATTERN.lastIndex = 0;
  const match = URL_PATTERN.exec(text);
  const host = match?.[1];
  return host === undefined ? fallback : host.replace(/^www\./i, "");
}

/**
 * Reads a tool result as text without caring what shape it is. Tool results here are protobuf
 * messages, plain objects and strings depending on the tool, and nothing downstream needs the
 * structure: the judge reads prose.
 */
export function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) ?? "";
  } catch {
    return String(result);
  }
}

interface WrappableTool {
  readonly name: string;
  execute(...args: readonly unknown[]): unknown;
}

/**
 * Wraps a search or fetch tool so its result is kept for this turn. It never changes the result and
 * never fails the call: a throw from the inner tool is rethrown untouched, and anything that goes
 * wrong while reading a result leaves the turn with one less piece of evidence and nothing else.
 */
export function collectJevEvidence<T extends WrappableTool>(tool: T, jev: JevTurn): T {
  return {
    ...tool,
    async execute(...args: readonly unknown[]) {
      const result = await tool.execute(...args);
      try {
        const text = resultText(result);
        if (text.length > 0) {
          jev.evidence.push(trimEvidence({ source: firstDomain(text, tool.name), text }));
        }
      } catch {}
      return result;
    },
  };
}

export { EVIDENCE_CHARS };
