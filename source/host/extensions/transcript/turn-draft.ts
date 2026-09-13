/**
 * VOICE-3. The reply Titan is still writing, projected as one small object the gateway can hand out.
 *
 * WHY THIS EXISTS. A spoken turn waits for the whole reply today. ui/voice-edge.mjs polls
 * getAgentTranscriptTail and the reply lands as ONE finished `send-message` entry 5.5 to 25 s after
 * sendPrompt, so the voice model says "on it" and then reads a finished wall of text. Nothing on the
 * gateway carried the reply while it was still being written, which is the whole of VOICE-3.
 *
 * WHAT IS PROJECTED, AND WHAT IS DELIBERATELY NOT. The draft is the SendMessage tool call's own text
 * and nothing else. Plain assistant text is NOT the reply on this host and never reaches the person:
 * turn-runtime.ts's own reply-nudge prompt says so in writing -- "Plain assistant text is NEVER shown
 * to the user; only a real SendMessage tool invocation reaches them" -- so a draft built out of
 * `text-delta` would have the voice read the model's scratch prose out loud and then read the real
 * answer a second time. `text-delta` is ignored here ON PURPOSE, and that is the one decision in this
 * file worth arguing with.
 *
 * ONE MESSAGE PER TURN. The draft follows the turn's FIRST delivered message and stops there. That is
 * the message the relay's tool call is waiting on; every later message of the same turn is already an
 * announcement on the relay's side (makeTurnRunner.follow), read whole from the transcript. Growing
 * the draft through message two would have the voice start message two while it was still handing
 * message one back.
 *
 * NO SECRETS PASS THROUGH. The text arrives already redacted and already bounded: the only writer is
 * the forwarded `tool-call` update, whose `args` came out of conversation-outline.ts
 * getToolCallActivityArgs, which runs redactOutlineSecrets and caps at MAX_TOOL_ACTIVITY_ARGS_CHARS.
 * A reply long enough to hit that cap loses its tail here, and the relay's finished-entry read is what
 * puts the tail back -- which is why the relay must never treat a draft as the whole answer.
 */

/** The same ceiling conversation-outline.ts puts on a forwarded tool call's arguments. */
export const MAX_TURN_DRAFT_CHARS = 20_000;

/** What the truncation in getToolCallActivityArgs appends once the args pass the cap. */
const TRUNCATION_SUFFIX = "\n… (truncated)";

/** The tool-call name the host forwards for a delivered message. */
export const SEND_MESSAGE_TOOL_CALL_NAME = "sendMessageToolCall";

export interface TurnDraft {
  /** The agent whose conversation this turn belongs to. */
  readonly conversationId: string;
  /**
   * This turn, and the SAME id the finished entry carries as `evidence.attemptId`, so a reader can
   * prove the draft it spoke from and the entry it finished from are one turn. Falls back to the
   * turn epoch when no attempt is open.
   */
  readonly turnId: string;
  readonly turnEpoch: number;
  /**
   * Whatever the caller stamped the prompt with, echoed back. The relay sends `voice:<session>:<n>`
   * and reads it here to be sure the draft is ITS turn and not a turn the console started beside it.
   * Never a secret: the console mints it and the host only ever repeats it.
   */
  readonly clientNonce: string | null;
  /** As much of the first delivered message as the model has written. Empty until it starts one. */
  readonly text: string;
  /** Whether that first message is finished. A finished draft never grows again this turn. */
  readonly complete: boolean;
  /** How many messages this turn has delivered. A reader that wants the first one wants 0 or 1. */
  readonly sends: number;
  readonly updatedAtMs: number;
}

/**
 * The text out of a forwarded SendMessage tool call's `args`.
 *
 * The shape is SendMessageArgs.toJson(): `{"text":{"content":"..."}}` for a spoken message,
 * `{"attachment":{...}}` for a picture, `{}` before the model has written a character. Anything that
 * is not a text message answers "" -- an attachment, a widget, a card and a malformed string all mean
 * "there is nothing here to say out loud yet", which is the honest answer for each of them.
 */
export function readSendMessageDraftText(args: unknown): string {
  if (typeof args !== "string" || args.length === 0) return "";
  const body = args.endsWith(TRUNCATION_SUFFIX)
    ? args.slice(0, -TRUNCATION_SUFFIX.length)
    : args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed == null) return "";
  const text = (parsed as { readonly text?: unknown }).text;
  if (typeof text !== "object" || text == null) return "";
  const content = (text as { readonly content?: unknown }).content;
  return typeof content === "string" ? content.slice(0, MAX_TURN_DRAFT_CHARS) : "";
}

interface DraftState {
  turnId: string;
  turnEpoch: number;
  clientNonce: string | null;
  text: string;
  complete: boolean;
  sends: number;
  updatedAtMs: number;
}

/**
 * One draft per conversation, opened when a turn starts and dropped when it ends.
 *
 * The lifetime is the turn's, and it is cleared in runTurn's own `finally` beside every other
 * per-turn map in TurnRuntime. Nothing here survives the turn, so nothing here grows.
 */
export class TurnDraftStore {
  private readonly drafts = new Map<string, DraftState>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A turn begins. Any draft left over from a previous turn on this conversation is replaced. */
  openTurn(args: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly turnEpoch: number;
    readonly clientNonce?: string | null;
  }): void {
    if (args.conversationId.length === 0) return;
    const nonce = typeof args.clientNonce === "string" && args.clientNonce.length > 0
      ? args.clientNonce
      : null;
    this.drafts.set(args.conversationId, {
      turnId: args.turnId,
      turnEpoch: args.turnEpoch,
      clientNonce: nonce,
      text: "",
      complete: false,
      sends: 0,
      updatedAtMs: this.now(),
    });
  }

  /**
   * One forwarded agent update. Answers the draft when it changed and null when it did not, so the
   * caller can decide whether anything is worth telling anybody about.
   *
   * Only three update types matter. A pending `sendMessageToolCall` REPLACES the text, because the
   * forwarded args are the whole partial message every time and appending them would write the
   * reply N times -- the same mistake the relay's own caption reader documents. A completed one
   * closes the draft. A `send-message` counts the delivery, and a delivery is also what closes a
   * draft the model never streamed a partial for.
   */
  applyUpdate(conversationId: string, update: Record<string, unknown>): TurnDraft | null {
    const draft = this.drafts.get(conversationId);
    if (draft == null) return null;
    const type = update.type;
    if (type === "send-message") {
      draft.sends += 1;
      if (!draft.complete) {
        draft.complete = true;
        draft.updatedAtMs = this.now();
        return this.project(conversationId, draft);
      }
      return null;
    }
    if (type !== "tool-call") return null;
    if (update.name !== SEND_MESSAGE_TOOL_CALL_NAME) return null;
    // The first message of the turn is the one the caller is waiting on. Once it is finished the
    // draft is closed, and a second message's tool call must not reopen it.
    if (draft.complete) return null;
    const text = readSendMessageDraftText(update.args);
    const done = update.status === "done" || update.status === "failed";
    if (text.length === 0 && !done) return null;
    const changed = text.length > 0 && text !== draft.text;
    if (changed) draft.text = text;
    if (done) draft.complete = true;
    if (!changed && !done) return null;
    draft.updatedAtMs = this.now();
    return this.project(conversationId, draft);
  }

  /** The turn is over. */
  closeTurn(conversationId: string): void {
    this.drafts.delete(conversationId);
  }

  /** What the gateway hands out. Null when no turn is open on this conversation. */
  read(conversationId: string): TurnDraft | null {
    const draft = this.drafts.get(conversationId);
    return draft == null ? null : this.project(conversationId, draft);
  }

  private project(conversationId: string, draft: DraftState): TurnDraft {
    return {
      conversationId,
      turnId: draft.turnId,
      turnEpoch: draft.turnEpoch,
      clientNonce: draft.clientNonce,
      text: draft.text,
      complete: draft.complete,
      sends: draft.sends,
      updatedAtMs: draft.updatedAtMs,
    };
  }
}
