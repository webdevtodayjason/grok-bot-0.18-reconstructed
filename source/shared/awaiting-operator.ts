/**
 * QOL-NEEDS-YOU: a turn that ended by asking the operator for something says so.
 *
 * `awaitingUserResponse` is set from exactly two places today -- a box hand-off
 * (sand-host.ts wires "session.box-handoff-started" to the awaiting sink) and a pending
 * auto-review approval. Both are structured events. A turn that ends with the agent asking in
 * prose ("I need you to sign in to the dashboard before I can keep going") raises neither, so
 * the roster row stayed clean and the console kept saying "Ready for the next task" while the
 * agent was blocked on a person.
 *
 * This is the missing read: the turn's last delivered message, classified deterministically.
 * No model call, no scoring. A question mark, a question widget, or one of a small closed set
 * of request phrases -- the wordings an agent actually uses when it hands a step back to the
 * person it is talking to. Everything else is left alone, because a badge that lights on an
 * ordinary sign-off is worse than one that misses the odd oblique ask.
 */

export type OperatorAskKind = "question" | "request" | "widget";
export interface OperatorAsk {
  readonly kind: OperatorAskKind;
  /** The sentence that asked, as the console pill and the notification body quote it. */
  readonly reason: string;
}
export interface AddressedMessage {
  readonly id: string;
  readonly type: string;
  readonly text: string;
}

/** The pill and the push body both truncate again; this only stops a whole essay reaching the db. */
export const OPERATOR_ASK_REASON_MAX = 200;

/**
 * A question mark inside a fenced block or an inline span is part of a quoted command or a code
 * sample, not an ask -- `grep -n "why?"` is not the agent asking anything.
 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The closed set. Anchored where anchoring matters: "you need to" is an instruction to the
 * operator, "we need to" is the agent thinking out loud, and a loose /need/ would read both the
 * same way.
 */
const OPERATOR_REQUEST =
  /\b(?:can|could|would|will)\s+you\b|\bi(?:'ll|'d| will| would)?\s+need\s+(?:you|your)\b|\byou(?:'ll|'ve| will)?\s+(?:need|have)\s+to\b|\bplease\s+(?:sign|log|open|go|head|click|paste|confirm|approve|authori[sz]e|enter|add|check|reply|send|share|grant|install|run|type|visit|verify|let)\b|\bwaiting\s+(?:on|for)\s+you\b/i;

/**
 * Bare imperatives only a person at a keyboard can carry out. Sentence-initial, because these
 * words are ordinary nouns and verbs everywhere else in a report ("Open questions:", "Confirm
 * that the build passed" written about what the agent itself did).
 */
const OPERATOR_IMPERATIVE =
  /^(?:sign\s+(?:in|into|back\s+in)|log\s+(?:in|into|back\s+in)|approve\s|confirm\s|paste\s|grant\s|authori[sz]e\s|head\s+(?:to|over)\b|click\s)/i;

function trimReason(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= OPERATOR_ASK_REASON_MAX
    ? collapsed
    : `${collapsed.slice(0, OPERATOR_ASK_REASON_MAX - 1).trimEnd()}…`;
}

/**
 * The last message the agent actually delivered to the operator on this conversation: not
 * hidden, not threaded (`branched` -- a threaded message is explicitly not where a question
 * belongs), and not addressed to a peer agent. The same three exclusions the roster's own
 * last-entry projection uses, so the badge and the sidebar preview are reading the same message.
 */
export function lastAddressedMessage(
  entries: readonly Record<string, unknown>[],
): AddressedMessage | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry == null) continue;
    if (entry.hidden === true || entry.branched === true) continue;
    if (entry.peerAgentId != null) continue;
    if (entry.kind !== "send-message") continue;
    const message = entry.message;
    if (message == null || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "widget") {
      const widget = record.widget as Record<string, unknown> | undefined;
      return {
        id,
        type,
        text: typeof widget?.prompt === "string" ? widget.prompt : "",
      };
    }
    return {
      id,
      type,
      text: type === "text" && typeof record.content === "string" ? record.content : "",
    };
  }
  return null;
}

/** The classifier. Null means the turn ended without handing anything back to the operator. */
export function classifyOperatorAsk(
  message: AddressedMessage | null,
): OperatorAsk | null {
  if (message == null) return null;
  if (message.type === "widget") {
    const prompt = message.text.trim();
    // A question widget IS the ask; it ends the turn by contract (see the system prompt's
    // "Asking for decisions"), and until now it lit nothing on the roster either.
    return prompt.length === 0
      ? { kind: "widget", reason: "Waiting for your answer." }
      : { kind: "widget", reason: trimReason(prompt) };
  }
  if (message.type !== "text") return null;
  const visible = stripCode(message.text);
  const lines = sentences(visible);
  // Backwards: the closing ask is the one the operator is looking at, so when a message both
  // reports and then asks, the reason quotes the ask rather than the first line of the report.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const sentence = lines[i] as string;
    if (sentence.endsWith("?")) return { kind: "question", reason: trimReason(sentence) };
    if (OPERATOR_REQUEST.test(sentence) || OPERATOR_IMPERATIVE.test(sentence)) {
      return { kind: "request", reason: trimReason(sentence) };
    }
  }
  return null;
}

/** The whole read, transcript in and verdict out -- what the host calls at the end of a turn. */
export function operatorAskFromTranscript(
  entries: readonly Record<string, unknown>[],
): OperatorAsk | null {
  return classifyOperatorAsk(lastAddressedMessage(entries));
}

/** The awaiting-state tab this classifier owns; `box` and `auto-review` are the other two. */
export const OPERATOR_ASK_AWAITING_TAB_ID = "turn-question";
