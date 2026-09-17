/**
 * JEV-2. Reading the arguments of `jevMarkWrong`, kept beside the feature rather than in the
 * gateway's untyped table, which is the shape BASELINE-1 used for the web search route.
 */
export interface JevMarkWrongArgs {
  readonly agentId: string;
  readonly decisionId: string;
  readonly by: string;
}

export type JevMarkWrongCheck =
  | { readonly ok: true; readonly mark: JevMarkWrongArgs }
  | { readonly ok: false; readonly why: string };

const isFilledString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function checkJevMarkWrong(args: unknown): JevMarkWrongCheck {
  if (typeof args !== "object" || args == null || Array.isArray(args)) {
    return { ok: false, why: "jevMarkWrong needs an object with agentId, decisionId and by" };
  }
  const candidate = args as Record<string, unknown>;
  if (!isFilledString(candidate.agentId)) return { ok: false, why: "jevMarkWrong needs an agentId" };
  if (!isFilledString(candidate.decisionId)) return { ok: false, why: "jevMarkWrong needs a decisionId" };
  // The relay stamps this from the session it authenticated. A request that arrives without it has
  // not been through that layer, and an unattributed correction is not worth keeping.
  if (!isFilledString(candidate.by)) return { ok: false, why: "jevMarkWrong needs the account it came from" };
  return {
    ok: true,
    mark: {
      agentId: candidate.agentId.trim(),
      decisionId: candidate.decisionId.trim(),
      by: candidate.by.trim(),
    },
  };
}
