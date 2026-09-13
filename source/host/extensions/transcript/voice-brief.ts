/**
 * VOICE-16. Who the agent is, what it remembers and what the two of you were just saying, projected
 * as one small object a voice session can be built out of.
 *
 * WHY THIS EXISTS. Until this, the realtime model on the phone knew nothing at all: ui/voice-edge.mjs
 * `voiceInstructions` told it in writing that it had "no memory, no tools and no knowledge of your
 * own" and that EVERY utterance had to go to the box through sendPrompt. So "how are you" and "what
 * did we decide about the gate" both cost a whole turn of the agent runtime, 5.5 to 25 s of it, and a
 * conversation was a sequence of pauses. Jason, 2026-09-12: "Why can't the voice just be Titan?" This
 * is what makes that possible -- the voice is handed the same three things the agent's own prompt is
 * built from, once, at dial, and answers conversation out of them. An ACTION still goes to the box,
 * because the box is where the files, the machines, the mail and the team are.
 *
 * WHAT IT IS BUILT FROM, and every one of these already existed:
 *   persona  `sessionStore.getAgentProfileText(agentId).description` -- the host's ONE identity
 *            field. marketplace-bot-import.ts:203 says so in writing ("The host has ONE identity
 *            field -- the agent's description") and BOTS-4 composes a catalog bot's persona into it.
 *   facts    `memory.list({agentId})`, which is exactly what the gateway's own getAgentMemories
 *            serves (transcript-manager.ts:374) and what BOTS-4's Add button writes into. Profile
 *            facts first, then most recent, which is the order FileMemoryStore.listMemories hands
 *            them out in, so a trim that drops the tail drops the least important thing.
 *   recent   `sessions.getAgentTranscriptTail`, the same read the relay already polls every 400 ms.
 *
 * THE CAP IS A GUARANTEE, NOT A HOPE. Everything here lands in a realtime session's instructions,
 * which are billed as a cached prefix and which nothing may rewrite mid-call, so an unbounded brief
 * would be an unbounded bill on every call. MAX_VOICE_BRIEF_BYTES is measured against the JSON that
 * actually goes over the wire, and the trim order is the brief's own: RECENT first (oldest turn
 * dropped first), then FACTS (from the tail, the least important end), and never the persona -- a
 * voice with no persona is not the agent, which is the whole point of the wave. The persona has its
 * own separate ceiling, which no real persona comes near, and that is what makes the 12 KB a
 * guarantee rather than a hope: without it a 200 KB description would blow the cap with nothing the
 * trim order is allowed to touch.
 *
 * NO SECRETS. `redact` is the box's own secret redactor (createBoxSecretRedactor), the same one
 * conversation-outline.ts, the action audit and the evidence ledger run their text through, and it
 * is applied to the persona, every fact and every turn. It redacts VALUES, not names: the memory
 * store may well hold "the mail connector is called anvil" and that is fine; what must never leave
 * is a value out of the box's own secret stores. The default here is identity ON PURPOSE -- a pure
 * function cannot read the filesystem, so the caller supplies the real redactor and a test supplies
 * one it can assert on.
 */
import {
  isUserMessageEntry,
  quotableEntryText,
} from "./send-message-shaping.js";
import type { TranscriptEntry } from "./transcript-hub.js";

/** Everything the brief may weigh on the wire, measured as the JSON the gateway hands out. */
export const MAX_VOICE_BRIEF_BYTES = 12 * 1024;

/** How many turns of the conversation the brief carries, newest last. */
export const VOICE_BRIEF_RECENT_TURNS = 20;

/**
 * How many transcript rows have to be read to find twenty TURNS. A conversation is mostly rows that
 * are neither: tool calls, cards, attachments, assistant prose that never reached a person. Measured
 * shape rather than arithmetic -- the filter below is what decides, and this is only the window it
 * looks in.
 */
export const VOICE_BRIEF_TAIL_LIMIT = 160;

/**
 * One turn's ceiling. A single pasted wall of text would otherwise spend the whole brief on itself
 * and push out the nineteen turns that give it any meaning.
 */
export const MAX_VOICE_BRIEF_TURN_CHARS = 1_000;

/**
 * One fact's ceiling. The memory store's own cap is MEMORY_MAX_CONTENT_LENGTH (500) and every write
 * path in the product enforces it, so this is a belt for a legacy line written before that existed
 * and never a cut a real fact will meet.
 */
export const MAX_VOICE_BRIEF_FACT_CHARS = 600;

/**
 * The persona's own ceiling, and the reason the byte cap above is a guarantee. Reserved out of the
 * cap so the envelope, the two names and at least some of the conversation always fit.
 */
export const MAX_VOICE_BRIEF_PERSONA_BYTES = MAX_VOICE_BRIEF_BYTES - 2_048;

/** What a cut leaves behind, so a reader can tell a clamped value from a short one. */
const CUT = "…";

/** Who said it. "person" is whoever is holding the phone; "agent" is the bot whose brief this is. */
export type VoiceBriefRole = "person" | "agent";

export interface VoiceBriefTurn {
  readonly role: VoiceBriefRole;
  readonly text: string;
  /** When it was said, epoch ms, or 0 when the entry carried no clock. */
  readonly at: number;
}

export interface VoiceBrief {
  /** The agent's description: who it is, in its own profile's words. Never trimmed for room. */
  readonly persona: string;
  /** Its remembered facts, most important first. */
  readonly facts: readonly string[];
  /** The last turns of its conversation, oldest first. */
  readonly recent: readonly VoiceBriefTurn[];
  readonly agentName: string;
  /** The box's own name for this workspace, for the voice to use when it names the place. */
  readonly workspaceName: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** One line, whitespace collapsed and clamped, because all of this is going to be spoken. */
function clamp(value: string, max: number): string {
  const tidy = value.replace(/\s+/g, " ").trim();
  return tidy.length > max ? `${tidy.slice(0, max)}${CUT}` : tidy;
}

/** A paragraph kept as a paragraph, clamped by BYTES because that is what the cap counts. */
function clampBytes(value: string, maxBytes: number): string {
  const tidy = value.trim();
  if (Buffer.byteLength(tidy, "utf8") <= maxBytes) return tidy;
  let cut = tidy.slice(0, maxBytes);
  while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > maxBytes - CUT.length) {
    cut = cut.slice(0, -1);
  }
  return `${cut}${CUT}`;
}

/**
 * The turns in a transcript tail, oldest first.
 *
 * `isUserMessageEntry` and `quotableEntryText` are send-message-shaping.ts's own readers and are
 * reused rather than copied: they already know that a person's row is `{kind:"message", role:"user"}`
 * and that an agent's DELIVERED message is `{kind:"send-message", message:{type:"text"}}`.
 *
 * THE KIND IS CHECKED AND NOT ONLY THE TEXT, and this is the one mistake this function was written
 * with and a test caught. `quotableEntryText` answers `entry.content` for EVERY `kind:"message"` row,
 * whatever its role, so an assistant's own prose came back as a turn -- and on this host plain
 * assistant text reaches nobody at all (turn-runtime.ts's reply nudge: "Plain assistant text is NEVER
 * shown to the user; only a real SendMessage tool invocation reaches them"). A voice told that the
 * agent said "let me look at the gate log" would be reading its scratch notes back as conversation.
 * So exactly two kinds of row become a turn and everything else -- assistant prose, tool calls, cards,
 * attachments, widgets -- is dropped, which is the same rule the relay's own reply reader follows and
 * the one turn-draft.ts exists to defend.
 */
export function voiceBriefTurnsOf(
  entries: readonly TranscriptEntry[],
  limit = VOICE_BRIEF_RECENT_TURNS,
): VoiceBriefTurn[] {
  const turns: VoiceBriefTurn[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry == null || typeof entry !== "object") continue;
    const fromPerson = isUserMessageEntry(entry);
    if (!fromPerson && entry.kind !== "send-message") continue;
    const said = clamp(quotableEntryText(entry), MAX_VOICE_BRIEF_TURN_CHARS);
    if (said.length === 0) continue;
    const at = Number(entry.timestampMs ?? (entry as { createdAt?: unknown }).createdAt);
    turns.push({
      role: fromPerson ? "person" : "agent",
      text: said,
      at: Number.isFinite(at) ? at : 0,
    });
  }
  const keep = Math.max(0, Math.floor(limit));
  return turns.slice(Math.max(0, turns.length - keep));
}

/** What the brief weighs on the wire. */
export function voiceBriefBytes(brief: VoiceBrief): number {
  return Buffer.byteLength(JSON.stringify(brief), "utf8");
}

/**
 * Build one brief, trimmed to fit.
 *
 * The trim order is the brief's own and it is the one thing in this file worth arguing with: the
 * OLDEST turn of the conversation goes first, then the LAST fact, and the persona never goes at all.
 * A voice that has forgotten the first of twenty turns is still the agent; a voice with no persona is
 * a stranger reading a script, which is exactly what VOICE-16 exists to stop.
 */
export function buildVoiceBrief(input: {
  readonly persona?: unknown;
  readonly agentName?: unknown;
  readonly workspaceName?: unknown;
  readonly facts?: readonly unknown[];
  readonly entries?: readonly TranscriptEntry[];
  readonly recent?: readonly VoiceBriefTurn[];
  readonly maxBytes?: number;
  readonly redact?: (value: string) => string;
}): VoiceBrief {
  const redact = typeof input.redact === "function" ? input.redact : (value: string) => value;
  const safe = (value: string): string => {
    try {
      return text(redact(value));
    } catch {
      // A redactor that throws must not cost the call its brief, but it must not leak either, so the
      // value it could not clear is dropped rather than passed through.
      return "";
    }
  };
  const cap = Number.isFinite(input.maxBytes) ? Math.max(0, Number(input.maxBytes)) : MAX_VOICE_BRIEF_BYTES;
  const personaCap = Math.max(0, cap - (MAX_VOICE_BRIEF_BYTES - MAX_VOICE_BRIEF_PERSONA_BYTES));
  const persona = clampBytes(safe(text(input.persona)), personaCap);
  const agentName = clamp(safe(text(input.agentName)), 120);
  const workspaceName = clamp(safe(text(input.workspaceName)), 120);
  let facts = (Array.isArray(input.facts) ? input.facts : [])
    .map((fact) => clamp(safe(text(fact)), MAX_VOICE_BRIEF_FACT_CHARS))
    .filter((fact) => fact.length > 0);
  let recent = (Array.isArray(input.recent)
    ? input.recent.slice(Math.max(0, input.recent.length - VOICE_BRIEF_RECENT_TURNS))
    : voiceBriefTurnsOf(input.entries ?? [], VOICE_BRIEF_RECENT_TURNS))
    .map((turn) => ({
      role: turn.role === "person" ? ("person" as const) : ("agent" as const),
      text: clamp(safe(text(turn.text)), MAX_VOICE_BRIEF_TURN_CHARS),
      at: Number.isFinite(turn.at) ? Number(turn.at) : 0,
    }))
    .filter((turn) => turn.text.length > 0);
  const project = (): VoiceBrief => ({ persona, facts, recent, agentName, workspaceName });
  while (recent.length > 0 && voiceBriefBytes(project()) > cap) recent = recent.slice(1);
  while (facts.length > 0 && voiceBriefBytes(project()) > cap) facts = facts.slice(0, -1);
  return project();
}
