import { readPersistedBoxSecrets } from "../extensions/secrets/secrets-service.js";
import type { JevQuestion } from "./questions.js";

/**
 * JEV-2. The one way the host talks to Jev.
 *
 * Plain `fetch`, no SDK and no dependency. One attempt, 750 ms, and any timeout, any non-200 and
 * any answer we cannot read all return `undefined`, which every caller treats as "Jev said
 * nothing" and proceeds exactly as a box with the flag off would. That is the whole failure
 * design: this judge is advisory, so it is never allowed to be the reason a turn does not happen.
 *
 * The key is a BOX secret, read from box-secrets.json per call like the endpoint pin is, and never
 * from the host process environment: the host's own environment is fixed when the container is
 * created, so an env-only key would mean a recreate to rotate, and it would also be visible to
 * every child process the box spawns. Nothing here logs the key or the state. The log line carries
 * the model id, the latency and the token counts, which is what a cost question needs and is the
 * most that can be said without saying what was judged.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 750;
export const TYPESAFE_API_KEY_SECRET = "TYPESAFE_API_KEY";

/** A noul answer carries `noul` 0..1; a choice answer carries `choice` and `confidence`. */
export interface JevNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}
export interface JevChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export interface JevReply {
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly model: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A noul's confidence is its distance from the middle, not its value: 0.02 is a confident false.
 * Every threshold in this feature is a confidence, so this is the only place that conversion
 * happens and callers never hand-roll it.
 */
export function noulConfidence(noul: number): number {
  return Math.max(noul, 1 - noul);
}

/** True or false at the halfway line, which is what the eval harness grades a noul on. */
export function noulValue(noul: number): boolean {
  return noul >= 0.5;
}

export function readJevApiKey(): string | undefined {
  const key = readPersistedBoxSecrets()[TYPESAFE_API_KEY_SECRET];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** Nothing but a shape check: a malformed answer is the same as no answer. */
function parseAnswers(value: unknown): Record<string, JevAnswer> | undefined {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return undefined;
  const answers: Record<string, JevAnswer> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw == null) return undefined;
    const answer = raw as Record<string, unknown>;
    if (answer.type === "noul") {
      if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) return undefined;
      answers[id] = { type: "noul", noul: answer.noul };
      continue;
    }
    if (answer.type === "choice") {
      if (typeof answer.choice !== "string") return undefined;
      const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
        ? answer.confidence
        : 0;
      answers[id] = { type: "choice", choice: answer.choice, confidence };
      continue;
    }
    return undefined;
  }
  return answers;
}

export interface AskJevOptions {
  readonly endpoint?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

/**
 * Asks one set of questions about one state. Returns `undefined` for every failure there is, and
 * never throws: a caller that has to write `try` around this has misread it.
 */
export async function askJev(
  state: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
  options: AskJevOptions = {},
): Promise<JevReply | undefined> {
  const apiKey = options.apiKey ?? readJevApiKey();
  if (apiKey === undefined) return undefined;

  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const model = options.model ?? JEV_MODEL;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.info(line));

  // No retries on purpose. A retry inside a turn spends the deadline twice over, and the fallback
  // for one failure and for two is the same fallback.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      log(`[sand][jev] ${model} refused with ${response.status} after ${latencyMs}ms`);
      return undefined;
    }
    const parsed = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    const answers = parseAnswers(parsed?.answers);
    if (answers === undefined) {
      log(`[sand][jev] ${model} sent an answer this host cannot read, after ${latencyMs}ms`);
      return undefined;
    }
    const usage = (parsed?.usage ?? {}) as Record<string, unknown>;
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const answered = typeof parsed?.model === "string" ? parsed.model : model;
    log(`[sand][jev] ${answered} answered in ${latencyMs}ms, ${inputTokens} input token(s), ${outputTokens} output token(s)`);
    return { answers, model: answered, latencyMs, inputTokens, outputTokens };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    // An abort is the 750 ms deadline, which is an ordinary outcome and not a fault to shout about.
    const why = (error as { name?: string })?.name === "AbortError" ? `no answer within ${timeoutMs}ms` : "the call failed";
    log(`[sand][jev] ${model}: ${why} after ${latencyMs}ms`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
