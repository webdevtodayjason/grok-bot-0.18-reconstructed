/**
 * VOICE-16c. A note filed into an agent's conversation as the person's own entry, with NO turn run
 * for it: no model call, no reply, no bill.
 *
 * WHY THIS EXISTS, and it is a measured hole rather than a preference. VOICE-16 ends every voice call
 * by writing the whole spoken exchange into the agent's conversation so the turns the voice answered
 * in its own head are not lost. It had exactly one way to write it: `sendPrompt`. And there is NO flag
 * on `sendPrompt` that means "remember this, do not answer it" -- it takes agentId,
 * directAddressedAcceptance, attachmentPaths, attachmentNames, richText, replyToId, clientNonce,
 * thinkHarder, isFork, traceparent, enterEpochMs, composedAtMs and awaitTurn, and not one of them
 * suppresses the reply (host-gateway-api.ts `sendPrompt`). The hidden prompt that a box hand-off, an
 * MCP authorization and a widget answer all ride, `boxHandoff.resumeWithHiddenPrompt`, is not on the
 * gateway protocol at all and RESUMES a turn rather than silencing one. So the closing note asked, in
 * its own first two sentences, not to be answered -- and five notes went out on the night of
 * 2026-09-12 with nothing but that politeness between the person and a message nobody asked for.
 * docs/VOICE-16-REPORT.md names it as "the single most likely thing to need a second pass".
 *
 * WHAT MAKES THE NOTE REACH THE AGENT ANYWAY, which is the whole reason a plain transcript append is
 * enough and a new store would have been wrong. MEASURED, reading the send path end to end:
 *
 *   1. `send-turn-dispatch.ts` builds `recentUserMessages` for every real send by filtering the
 *      agent's own transcript for `kind === "message" && role === "user" && fromAgent == null &&
 *      channel == null`, and hands the list to `runTurn`.
 *   2. `shell-terminal-watch.ts` `collectPrependUserMessages` runs `selectUnconfirmedUserMessages`
 *      (conversation-state.ts) over that list against the runner's own confirmed-user-turn watermark,
 *      and every user message that was never confirmed into a turn becomes a `UserMessage` PREPENDED
 *      to the next real turn's prompt, stamped with its entry id by `buildUserMessageAddressNote`.
 *
 * So a `role:"user"` row appended with no turn of its own is not a row the model never sees. It is in
 * the agent's context the next time the person actually says something, which is exactly what the
 * closing note is for: it is background for the next real turn, not a turn of its own.
 *
 * WHY IT IS THE PERSON'S OWN ENTRY AND NOT A NEW KIND. `ui/machine-room/gateway-adapter.js:652` keeps
 * `kind === "message" && role === "user"` in its projection filter and draws it as the "You" bubble
 * (`mine = e.kind !== "send-message"`). A console that does not know an entry kind throws it away one
 * function before the renderer -- UX-ERR-1 is the row in the tracker where a failed turn showed
 * nothing at all for exactly that reason. Reusing the shape the send pipeline already writes means
 * the note looks on screen precisely as it looked when `sendPrompt` wrote it, and no page changes.
 *
 * NOTHING HERE TOUCHES A FILESYSTEM, A CLOCK OR A SESSION, which is why the cap, the dedupe and the
 * entry shape can all be pinned without a box.
 */
import {
  createUserMessage,
  isUserMessageEntry,
} from "./send-message-shaping.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import type { TranscriptEntry } from "./transcript-hub.js";

/**
 * The most one note may weigh.
 *
 * The relay caps its own closing note at 6 KB (`VOICE_NOTE_MAX_CHARS` in ui/voice-edge.mjs) and drops
 * the oldest spoken lines to get there, so in the intended use this ceiling is never the one that
 * bites. It is here because this command is a WRITE into somebody's conversation reached over the
 * gateway, and a write with no ceiling is how one wedged caller fills an agent's transcript. Text
 * over the cap is REFUSED and named, never silently cut: a half a note read back as the record of a
 * call is worse than no note, because nobody can tell which half is missing.
 */
export const MAX_TRANSCRIPT_NOTE_CHARS = 16 * 1024;

export interface TranscriptNotePlan {
  /** The entry to append, or null when there is nothing to file. */
  readonly entry: TranscriptEntry | null;
  /** The id of the entry that already carries this nonce, when one does. */
  readonly duplicateOf: string | null;
}

/**
 * The id of the note already filed under this nonce, or null.
 *
 * WHY A NONCE AT ALL. The relay guards its own closing note with a `noted` flag, but that flag lives
 * for the life of one websocket session in one relay process. A gateway call that times out at the
 * caller and lands on the box anyway is a measured condition this very path already logs ("it may
 * still land"), and a retry after one of those would put the same call transcript into the person's
 * conversation twice. The nonce is the same `voice:<session>:note` string the relay already sends.
 */
export function findNoteByClientNonce(
  entries: readonly TranscriptEntry[],
  clientNonce: string,
): string | null {
  const nonce = clientNonce.trim();
  if (nonce.length === 0) return null;
  for (const entry of entries) {
    if (!isUserMessageEntry(entry)) continue;
    if (String((entry as { clientNonce?: unknown }).clientNonce ?? "") === nonce)
      return String(entry.id ?? "") || null;
  }
  return null;
}

/**
 * The entry a note becomes, given the conversation it is joining.
 *
 * `at` IS THE ENTRY'S OWN TIMESTAMP AND NOTHING ELSE. `createUserMessage` has a `composedAtMs`
 * option, and it is the wrong one to reach for: besides setting the timestamp it stamps
 * `sentWhileOfflineAtMs`, which `send-turn-dispatch.ts` turns into a "you composed this while
 * offline" preamble on the prompt. A call that ended a second ago was not composed offline. So the
 * timestamp is set over the built entry and the offline marker never appears.
 *
 * The id comes from `nextEntryId(entries, "user-message")`, which is the same mint the send pipeline
 * uses, so the note takes the next `t<n>u` in sequence and the real message after it takes the one
 * after that. Nothing downstream can tell this row apart from a typed one, which is the point.
 */
export function planTranscriptNote({
  entries = [],
  text = "",
  at = 0,
  clientNonce = "",
}: {
  readonly entries?: readonly TranscriptEntry[];
  readonly text?: string;
  readonly at?: number;
  readonly clientNonce?: string;
} = {}): TranscriptNotePlan {
  const body = String(text ?? "").trim();
  if (body.length === 0) return { entry: null, duplicateOf: null };
  if (body.length > MAX_TRANSCRIPT_NOTE_CHARS) {
    throw new Error(
      `this note is ${body.length} characters and the ceiling is ${MAX_TRANSCRIPT_NOTE_CHARS}`,
    );
  }
  const rows = Array.isArray(entries) ? entries : [];
  const nonce = String(clientNonce ?? "").trim();
  const duplicateOf = findNoteByClientNonce(rows, nonce);
  if (duplicateOf != null) return { entry: null, duplicateOf };
  const stamp = Number(at);
  const built = createUserMessage(nextEntryId(rows, "user-message"), body, {
    ...(nonce.length === 0 ? {} : { clientNonce: nonce }),
  });
  return {
    entry:
      Number.isFinite(stamp) && stamp > 0
        ? { ...built, timestampMs: stamp }
        : built,
    duplicateOf: null,
  };
}
