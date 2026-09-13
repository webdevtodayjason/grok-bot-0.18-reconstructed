import { randomUUID } from "node:crypto";
import { isMessageAddress } from "../../../shared/message-reference.js";
import {
  OPERATOR_ASK_AWAITING_TAB_ID,
  operatorAskForTurn,
} from "../../../shared/awaiting-operator.js";
import { sandDualSurfaceToolTelemetry } from "../../../shared/agents/agent-tool-names.js";
import { SAND_REACTION_AGENT } from "../../../shared/transcript.js";
import { UNKNOWN_CONNECTOR_TAG } from "../../../shared/observability/connector-auth-telemetry.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import {
  isContextOverflowDeadEnd,
  isConversationTooLargeRefusal,
  isFirstTokenStallError,
  isProviderCapacityError,
  isRetryableProviderError,
  isTransientStreamError,
  serverRetryAfterMsFromError,
} from "../../runner/transient-stream-error.js";
import { isDeliveryToolCallName } from "../../runner/turn-shape.js";
import {
  beginTurnTrace,
  markTurnTraceError,
  resolveTurnTraceOutcome,
  setTurnTraceAttributes,
  type HostTrace,
} from "../../send-trace-host.js";
import { brandedEnumOf, brandedErrno } from "../../../shared/errors/bounded.js";
import { SandError } from "../../../shared/errors/registry.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import {
  describeAgentRunError,
  findBackendConnectError,
  PROVIDER_OVERLOAD_ERROR_TITLE,
} from "./agent-run-error.js";
import {
  createSendMessageEntry,
  describeRepliedMessageQuote,
  isUserMessageEntry,
  stampBoxRequestEntry,
  type SendMessage,
} from "./send-message-shaping.js";
import { nextEntryId } from "./transcript-entry-ids.js";
import { TurnDraftStore, type TurnDraft } from "./turn-draft.js";
import { evidenceRegistry } from "../evidence/evidence-registry.js";
import { buildTurnFailedEntry } from "./turn-failed-entry.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";
import { getTranscript, updateEntry } from "./transcript-store.js";
import type { LiveTranscriptSession } from "./session-runtime.js";

export const MAX_REPLY_NUDGES = 3;
export const REPLY_NUDGE_PROMPT =
  "Your previous turn left the user without the result they're waiting on — you never called SendMessage that turn, or every SendMessage you tried failed to deliver. Either way they received nothing and are still waiting. Do not assume a send from an earlier turn covered it: an opening acknowledgement back then did not deliver this result (ack ≠ delivery). Deliver the result now by actually invoking the SendMessage tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them, so if you don't call the tool they just keep seeing silence.";
export const CLOSING_SEND_NUDGE_PROMPT =
  "Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendMessage — the last thing the user saw is that opening acknowledgement, so whatever the tool calls produced after it never reached them. If that work produced the result or answer they are waiting on, deliver it now by actually invoking the SendMessage tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendMessage tool invocation reaches them. If the work is genuinely unfinished, continue it and send the result once you have it.";
export const MAX_WORK_REDRIVES = 3;
export const WORK_REDRIVE_PROMPT =
  "Your previous turn replied to the user and then ended without calling a single tool — you acknowledged the request but never did the work it asked for. An acknowledgement is not the work, and from the user's side an unstarted task and a finished one look identical until you tell them otherwise. If the request needs tools — reading, running, editing, searching, reaching another system — start on it now and actually invoke them, then send the real outcome with SendMessage. If it genuinely needed no tools and your reply already answered it in full, end this turn without sending anything further: do not send another message just to break the silence.";
export const REPORT_REDRIVE_PROMPT =
  "Your previous turn ran a tool after your last message to the user, and then ended without telling them what it produced. The user is still looking at your acknowledgement; the result exists only in your own context. Send it now with SendMessage: what you actually found or did, in the detail they asked for. Do not re-run the work unless you genuinely need to, and do not send a message that only says you are working on it.";
export const TASK_ERROR_RESULT_CLASS = "task_error_result";
export const CONNECT_CODE_NAMES = [
  "Canceled",
  "Unknown",
  "InvalidArgument",
  "DeadlineExceeded",
  "NotFound",
  "AlreadyExists",
  "PermissionDenied",
  "ResourceExhausted",
  "FailedPrecondition",
  "Aborted",
  "OutOfRange",
  "Unimplemented",
  "Internal",
  "Unavailable",
  "DataLoss",
  "Unauthenticated",
] as const;
export const connectCodeTag = brandedEnumOf(CONNECT_CODE_NAMES, "Other");

export interface TurnTraceContext {
  withName(name: string): unknown;
}

export type TurnCompletedSpanRecorder = (
  context: unknown,
  options: {
    readonly startTime: Date;
    readonly attributes: Readonly<Record<string, unknown>>;
  },
  endTime: Date,
) => void;

let turnCompletedSpanRecorder: TurnCompletedSpanRecorder | undefined;

/** Supplies the bundle-scope tracing helper without guessing an OTel runtime. */
export function setTurnCompletedSpanRecorder(
  recorder: TurnCompletedSpanRecorder | undefined,
): void {
  turnCompletedSpanRecorder = recorder;
}

export function recordTurnQueueWaitSpan(args: {
  traceCtx: unknown;
  queueStartEpochMs?: number;
  queueStartPerfMs?: number;
  conversationId: string;
  clientNonce?: string;
}): void {
  if (
    turnCompletedSpanRecorder == null ||
    args.queueStartEpochMs == null ||
    args.queueStartPerfMs == null ||
    args.traceCtx == null ||
    typeof args.traceCtx !== "object" ||
    !("withName" in args.traceCtx) ||
    typeof args.traceCtx.withName !== "function"
  ) {
    return;
  }
  try {
    const queueWaitMs = Math.max(
      0,
      Math.round(performance.now() - args.queueStartPerfMs),
    );
    turnCompletedSpanRecorder(
      (args.traceCtx as TurnTraceContext).withName("turn-queue-wait"),
      {
        startTime: new Date(args.queueStartEpochMs),
        attributes: {
          "sand.queue_wait_ms": queueWaitMs,
          "sand.conversation_id": args.conversationId,
          ...(args.clientNonce != null && args.clientNonce.length > 0
            ? { "sand.client_nonce": args.clientNonce }
            : {}),
        },
      },
      new Date(args.queueStartEpochMs + queueWaitMs),
    );
  } catch {}
}

export function connectCodeOf(error: unknown): string | undefined {
  const connectError = findBackendConnectError(error, false);
  if (connectError == null || typeof connectError.code !== "number") {
    return undefined;
  }
  return connectCodeTag(CONNECT_CODE_NAMES[connectError.code - 1]);
}

export interface TurnResult {
  sentMessageCount: number;
  reacted: boolean;
  aborted: boolean;
  quiescedForUpgrade?: boolean;
  streamOutputProduced?: boolean;
  endedOnSilentToolCalls?: boolean;
  awaitingUserSelection?: boolean;
  /**
   * Whether the run called a non-delivery tool, per `turnMadeWorkToolCall` over
   * the prompt messages. Optional because only a runner that settles through
   * turn-settle can know it; when absent the host falls back to counting the
   * tool-call updates it saw on the wire.
   */
  madeWorkToolCall?: boolean;
}

export interface AgentRunner {
  run(prompt: string, options: Record<string, unknown>): Promise<TurnResult>;
  wouldRecoverViaPrepend?(
    recent: readonly unknown[],
    latestMessageId: string,
    skippedMessageId: string,
  ): Promise<boolean>;
  getObservedToolCallCount?(): number;
}

export interface TurnOptions extends Record<string, unknown> {
  readonly selectedImages: readonly unknown[];
  readonly messageId?: string;
  readonly recentUserMessages?: readonly { id: string; text: string }[];
  readonly selectedVideos?: readonly unknown[];
  readonly attachedFilePaths?: readonly string[];
  readonly replyContext?: { targetId: string };
  readonly isFork?: boolean;
  readonly traceCtx?: unknown;
  readonly queueStartEpochMs?: number;
  readonly queueStartPerfMs?: number;
  readonly clientNonce?: string;
  readonly thinkHarder?: boolean;
  readonly ackToken?: string;
}

export function isDeliveryOwed(
  result: Pick<TurnResult, "sentMessageCount" | "reacted">,
): boolean {
  return result.sentMessageCount === 0 && !result.reacted;
}

const CONVERSATIONAL_OPENERS =
  /^(what|why|how|who|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will|any|thanks|thank|ok|okay|cool|nice|great|sure|yes|no|hi|hey|hello)\b/i;
// Anchored, because half these verbs are also nouns: loose matching reads "the
// build is broken" as an order to build something.
const ACTION_REQUEST_PATTERN =
  /^(?:(?:please|pls|now|also|then|and|go ahead and|go|let'?s|i need you to|you need to)\s+)*(?:add|build|change|check|clean|commit|configure|create|delete|deploy|download|edit|fix|generate|implement|install|kill|make|merge|move|open|pull|push|read|rebase|refactor|remove|rename|restart|run|search|send|set|start|stop|test|update|upgrade|upload|write)\b/i;

/**
 * A deliberately narrow read of "the user asked for work": a bare imperative,
 * nothing else. Questions, asides and observations are excluded outright, since
 * redriving one of those badgers a user who already got what they wanted —
 * worse than the ack-and-stall this catches. Missing requests is the trade.
 */
export function requestImpliesAction(prompt: string | undefined): boolean {
  const trimmed = prompt?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.endsWith("?")) return false;
  if (CONVERSATIONAL_OPENERS.test(trimmed)) return false;
  return ACTION_REQUEST_PATTERN.test(trimmed);
}

/**
 * The turn where the agent acknowledged, went and did the work, and ended without saying what came
 * of it. Sibling of `isWorkOwed`, and the stronger of the two: it needs no guess about whether the
 * request implied action, because the agent answered that question itself by calling a tool. A
 * purely conversational turn calls no work tool and can never trip this.
 */
export function isReportOwed(
  result: Pick<
    TurnResult,
    "sentMessageCount" | "reacted" | "aborted" | "quiescedForUpgrade" | "awaitingUserSelection"
  >,
  ticks: { readonly lastWorkTick: number; readonly lastDeliveryTick: number },
): boolean {
  if (
    result.aborted ||
    result.quiescedForUpgrade === true ||
    result.awaitingUserSelection === true ||
    result.reacted ||
    result.sentMessageCount === 0
  )
    return false;
  return ticks.lastWorkTick > 0 && ticks.lastWorkTick > ticks.lastDeliveryTick;
}

export interface TurnWorkSignals {
  readonly prompt: string | undefined;
  /** Aggregated over every run in the turn; undefined when no run reported it. */
  readonly madeWorkToolCall: boolean | undefined;
  readonly workToolCalls: number;
  readonly deliveryToolCalls: number;
}

/**
 * The turn the user asked for work, got an answer, and did nothing. Sibling of
 * `isDeliveryOwed`, never a replacement: that one catches silence, this one
 * catches the "on it" that never became work, and the two are disjoint because
 * this requires a message to have been sent.
 */
export function isWorkOwed(
  result: Pick<
    TurnResult,
    | "sentMessageCount"
    | "reacted"
    | "aborted"
    | "quiescedForUpgrade"
    | "awaitingUserSelection"
  >,
  signals: TurnWorkSignals,
): boolean {
  if (
    result.aborted ||
    result.quiescedForUpgrade === true ||
    result.awaitingUserSelection === true ||
    result.reacted ||
    result.sentMessageCount === 0
  )
    return false;
  if (!requestImpliesAction(signals.prompt)) return false;
  if (signals.madeWorkToolCall != null) return !signals.madeWorkToolCall;
  // The delivery count calibrates the work count. SendMessage is itself a tool
  // call, so a turn that delivered without producing one tool-call update means
  // this session's calls are not reaching the counter at all, and redriving off
  // a counter that reads zero for everything would badger a working agent.
  return signals.deliveryToolCalls > 0 && signals.workToolCalls === 0;
}

/** Folds one run's work report into the turn's, leaving it undefined until some run reports. */
function mergeWorkReport(
  reported: boolean | undefined,
  run: TurnResult,
): boolean | undefined {
  return run.madeWorkToolCall == null
    ? reported
    : (reported ?? false) || run.madeWorkToolCall;
}

export function classifyAgentError(error: unknown): Record<string, unknown> {
  if (isProviderCapacityError(error)) {
    const retryAfterMs = serverRetryAfterMsFromError(error);
    if (retryAfterMs !== undefined) {
      return SandError.backendCapacityDeferred({
        connectCode: connectCodeOf(error),
        retryAfterMs,
      });
    }
    return SandError.providerOverloaded({ connectCode: connectCodeOf(error) });
  }
  if (isFirstTokenStallError(error)) return SandError.firstTokenStall();
  if (isContextOverflowDeadEnd(error)) return SandError.contextWindowOverflow();
  if (isConversationTooLargeRefusal(error)) {
    return SandError.conversationTooLarge();
  }
  const connectCode = connectCodeOf(error);
  if (isRetryableProviderError(error)) {
    if (isTransientStreamError(error)) {
      return SandError.streamReset({
        connectCode,
        errno: brandedErrno(findSystemErrno(error)),
      });
    }
    return SandError.turnRetryable({ connectCode });
  }
  if (connectCode !== undefined) {
    return SandError.backendRejected({ connectCode });
  }
  return SandError.agentUnclassified();
}

type CardPredicate = (entry: TranscriptEntry) => boolean;
type CardUpdate = (entry: TranscriptEntry) => TranscriptEntry;

function messageOf(entry: TranscriptEntry): Record<string, any> | undefined {
  return typeof entry.message === "object" && entry.message != null
    ? (entry.message as Record<string, any>)
    : undefined;
}

export class TurnRuntime {
  readonly replyThreadTargets = new Map<LiveTranscriptSession, string>();
  readonly forkTurnSessions = new Set<LiveTranscriptSession>();
  readonly activeRequestPrompts = new Map<string, string>();
  readonly activeRequestSources = new Map<string, string>();
  readonly activeTurnEpochs = new Map<string, number>();
  readonly activeTurns = new Map<string, Record<string, any>>();
  readonly reportedDualSurfaceToolCalls = new Map<string, Set<string>>();
  readonly reportedToolCallErrors = new Map<string, Set<string>>();
  readonly reportedToolCallStalls = new Map<string, Set<string>>();
  readonly pendingToolCallStarts = new Map<string, Map<string, number>>();
  readonly workToolCallCounts = new Map<string, number>();
  readonly deliveryToolCallCounts = new Map<string, number>();
  /**
   * Counts answer "did it work" but not "did it work AFTER it last spoke", and the failure operators
   * actually hit is the latter: the agent acknowledges, runs the tool, and the turn ends with the
   * output still in its own context. A per-session monotonic tick, and the tick of the last call of
   * each kind, is all it takes to see that ordering.
   */
  readonly toolCallTicks = new Map<string, number>();
  readonly lastWorkToolTick = new Map<string, number>();
  readonly lastDeliveryToolTick = new Map<string, number>();
  /**
   * VOICE-3. The reply the agent is still writing, for a caller that has to start speaking before the
   * turn ends. Opened in runTurn, fed from handleAgentUpdate, dropped in runTurn's `finally` beside
   * every other per-turn map above it, and read by the gateway through `getTurnDraft`.
   */
  readonly turnDrafts = new TurnDraftStore();
  /** Consecutive work-owed turns per session; survives the turn, unlike the counts. */
  readonly workRedriveStreaks = new Map<string, number>();
  /**
   * Conversations whose last turn was ended by the self-talk cap. The work redrive exists to
   * push an agent that only talked into doing something, but an agent the cap just stopped has
   * already proved it will keep talking: redriving it buys another cap's worth of paid model
   * calls and nothing else.
   */
  readonly selfTalkCapped = new Set<string>();

  constructor(readonly tm: TranscriptManagerLike) {}

  /**
   * Whether an agent has a turn in flight. `activeTurns` is keyed by session id, which is the agent
   * id. The local schedule tick asks before firing a routine: firing into a busy agent aborted an
   * in-flight computerUse subagent during verification, and a routine that waits is strictly
   * better than one that kills the operator's work.
   */
  isAgentBusy(agentId: string): boolean {
    return this.activeTurns.has(agentId);
  }

  /**
   * VOICE-3. The reply this agent is part way through writing, or null when no turn is open.
   *
   * The gateway's one door onto the draft, reached as the `getTurnDraft` command. It is a READ and it
   * costs a map lookup: a caller polling it beside a 400 ms tail poll adds no work to the turn. A host
   * that predates this answers "unknown gateway method", which is the signal a caller degrades on
   * rather than a condition it has to probe for.
   */
  getTurnDraft(agentId: string): TurnDraft | null {
    return this.turnDrafts.read(String(agentId ?? ""));
  }

  settleCardStatus(args: {
    runSession?: LiveTranscriptSession | null;
    isForActiveAgent: boolean;
    matchesCard: CardPredicate;
    applyStatus: CardUpdate;
  }): void {
    const targetSession =
      args.runSession ?? this.tm.sessions.activeSession ?? null;
    const dbTarget = targetSession?.db
      .getTranscriptEntries()
      .find(args.matchesCard) as TranscriptEntry | undefined;
    const persisted =
      targetSession != null && dbTarget != null
        ? (targetSession.db.updateTranscriptEntry(
            dbTarget.id,
            args.applyStatus,
          ) as TranscriptEntry | null)
        : null;
    const liveTarget = args.isForActiveAgent
      ? getTranscript().find(args.matchesCard)
      : undefined;
    const live =
      liveTarget == null ? null : updateEntry(liveTarget.id, args.applyStatus);
    const shipped = live ?? persisted;
    if (shipped != null)
      this.tm.roster.emit(
        { type: "updated", entry: shipped },
        targetSession?.id,
      );
  }

  markReportedOnce(args: {
    reported: Map<string, Set<string>>;
    sessionId: string;
    toolCallId: string;
  }): boolean {
    let seen = args.reported.get(args.sessionId);
    if (seen == null) {
      seen = new Set();
      args.reported.set(args.sessionId, seen);
    }
    if (seen.has(args.toolCallId)) return false;
    seen.add(args.toolCallId);
    return true;
  }

  reportToolCallDiagnostic(
    session: LiveTranscriptSession,
    observation: Record<string, any>,
  ): void {
    const requestId =
      observation.requestId ??
      this.tm.runLifecycle.lastRequestIdBySession.get(session.id);
    const base = {
      conversationId: session.id,
      requestId,
      toolName: observation.toolName,
      toolCallId: observation.toolCallId,
      connector: observation.connector,
    };
    if (observation.kind === "error") {
      if (
        !this.markReportedOnce({
          reported: this.reportedToolCallErrors,
          sessionId: session.id,
          toolCallId: observation.toolCallId,
        })
      )
        return;
      this.tm.telemetry.reportToolCallError({
        ...base,
        errorClass: observation.errorClass,
        durationMs: observation.durationMs,
      });
    } else {
      if (
        !this.markReportedOnce({
          reported: this.reportedToolCallStalls,
          sessionId: session.id,
          toolCallId: observation.toolCallId,
        })
      )
        return;
      this.tm.telemetry.reportToolCallStalled({
        ...base,
        elapsedMs: observation.elapsedMs,
      });
    }
  }

  async runTurn(
    session: LiveTranscriptSession,
    runner: AgentRunner,
    prompt: string,
    options: TurnOptions,
    epoch: number,
  ): Promise<void> {
    const turnTrace = beginTurnTrace({
      parentCtx: options.traceCtx,
      conversationId: session.id,
      turnType: "user",
      ...(options.queueStartEpochMs == null
        ? {}
        : { startTime: options.queueStartEpochMs }),
      attributes: {
        "sand.turn_epoch": epoch,
        ...(options.clientNonce
          ? { "sand.client_nonce": options.clientNonce }
          : {}),
        ...(options.messageId == null
          ? {}
          : { "sand.message_id": options.messageId }),
        ...(options.isFork === true ? { "sand.is_fork": true } : {}),
      },
    });
    const turnCtx = turnTrace?.context ?? options.traceCtx;
    try {
      recordTurnQueueWaitSpan({
        traceCtx: turnCtx,
        ...(options.queueStartEpochMs == null
          ? {}
          : { queueStartEpochMs: options.queueStartEpochMs }),
        ...(options.queueStartPerfMs == null
          ? {}
          : { queueStartPerfMs: options.queueStartPerfMs }),
        conversationId: session.id,
        ...(options.clientNonce == null
          ? {}
          : { clientNonce: options.clientNonce }),
      });
      if (
        epoch !== this.tm.sendPipeline.currentTurnEpoch(session) &&
        options.messageId != null
      ) {
        const latest = this.tm.sendPipeline.latestRecoverySends.get(session.id);
        const rawText = options.recentUserMessages?.find(
          (message) => message.id === options.messageId,
        )?.text;
        const recoverable =
          options.selectedImages.length === 0 &&
          (options.selectedVideos?.length ?? 0) === 0 &&
          (options.attachedFilePaths?.length ?? 0) === 0 &&
          options.isFork !== true &&
          options.replyContext == null &&
          rawText != null &&
          rawText === prompt.trim() &&
          epoch >
            (this.tm.sendPipeline.recoveryBreakEpochs.get(session.id) ?? 0) &&
          latest != null &&
          latest.epoch === this.tm.sendPipeline.currentTurnEpoch(session) &&
          runner.wouldRecoverViaPrepend != null &&
          (await runner.wouldRecoverViaPrepend(
            latest.recentUserMessages,
            latest.messageId,
            options.messageId,
          ));
        if (recoverable) {
          this.tm.telemetry
            .startTurn({ conversationId: session.id, turnType: "new" })
            .finalize("cancelled");
          this.tm.ackObligations.retireAckRunToken(
            session.id,
            options.ackToken,
          );
          setTurnTraceAttributes(turnTrace, { "sand.outcome": "superseded" });
          this.tm.runLifecycle.endSessionRun(session);
          return;
        }
      }

      const trimmed = prompt.trim();
      if (trimmed) this.activeRequestPrompts.set(session.id, trimmed);
      else this.activeRequestPrompts.delete(session.id);
      if (options.replyContext != null)
        this.replyThreadTargets.set(session, options.replyContext.targetId);
      else this.replyThreadTargets.delete(session);
      if (options.isFork === true) this.forkTurnSessions.add(session);
      else this.forkTurnSessions.delete(session);
      this.activeTurnEpochs.set(session.id, epoch);
      // VOICE-3. The draft opens with the turn, so a reader that arrives before the model has written
      // a character gets "this turn exists and has said nothing yet" rather than nothing at all --
      // which is what tells a voice caller its prompt is running from a draft that is not its own.
      // The attempt id is the id the finished send-message entry carries as `evidence.attemptId`, so
      // the draft and the entry are provably one turn; the epoch is the fallback when none is open.
      this.turnDrafts.openTurn({
        conversationId: session.id,
        turnId: evidenceRegistry.current(session.id)?.attemptId ?? `epoch-${epoch}`,
        turnEpoch: epoch,
        ...(options.clientNonce == null ? {} : { clientNonce: options.clientNonce }),
      });
      const startedAtMs = Date.now();
      const turn = this.tm.telemetry.startTurn({
        conversationId: session.id,
        turnType: "new",
      });
      this.activeTurns.set(session.id, turn);
      this.activeRequestSources.set(session.id, "turn");
      // QOL-NEEDS-YOU: where this turn starts on the transcript. The operator-ask read at the end
      // classifies only what gets appended after this entry -- read the whole conversation instead
      // and a turn that delivers nothing to the operator re-lights an ask they already answered.
      const turnStartEntryId = session.db.getTranscriptEntries().at(-1)?.id ?? null;
      try {
        const unansweredPrompts =
          this.tm.widgetResponses.collectUnansweredQuestionPrompts(session);
        const result = await runner.run(prompt, {
          ...options,
          ...unansweredPrompts,
          traceCtx: turnCtx,
          appendReplyReminder: true,
          requestSource: "turn",
          onModelResolved: (modelId: string) => turn.setModel(modelId),
        });
        let settledResult = result;
        if (result.quiescedForUpgrade)
          this.tm.upgradeResume.markAgentResumePending(session, "turn");
        else if (
          !result.aborted &&
          epoch === this.tm.sendPipeline.currentTurnEpoch(session)
        ) {
          const settled = await this.ensureUserReply(
            runner,
            result,
            session,
            epoch,
            options.ackToken,
            turnCtx,
            turnTrace,
            turn,
          );
          settledResult = settled.result;
          if (
            settled.deliveryOwed &&
            !settledResult.aborted &&
            settledResult.quiescedForUpgrade !== true &&
            epoch === this.tm.sendPipeline.currentTurnEpoch(session)
          ) {
            this.tm.telemetry.reportTurnEmptyDelivery({
              conversationId: session.id,
              requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
                session.id,
              ),
              source: "turn",
              requestSource: "turn",
              replyNudgeAttempts: settled.replyNudgeAttempts,
              toolCallCount: runner.getObservedToolCallCount?.() ?? 0,
              streamOutputProduced: settled.streamOutputProduced,
              durationMs: Date.now() - startedAtMs,
              ackOutstanding:
                this.tm.ackObligationStore?.get(session.id) != null,
            });
          }
        }
        turn.finalize(
          result.aborted || result.quiescedForUpgrade ? "cancelled" : "success",
        );
        setTurnTraceAttributes(turnTrace, {
          "sand.outcome": resolveTurnTraceOutcome(settledResult),
        });
        this.noteOperatorAsk(
          session,
          settledResult,
          epoch,
          turnStartEntryId,
          turnTrace,
        );
        await this.tm.roster.emitAgentUpdate(session.id);
        this.tm.automationRuntime.emitAutomations(session);
      } catch (error) {
        console.error(
          `[sand][turn] agent run failed for ${session.id}`,
          error,
        );
        turn.finalize(
          "error",
          classifyAgentError(error),
          sandErrorDetail(error),
        );
        // UX-ERR-1. The console reads the conversation, not the tray and not this log line, so a
        // failed turn that writes only here is a turn that ends in silence on the page. One entry,
        // plain words, no stack: the detail is above, in the log, where an operator can read it.
        // Wrapped because a store that is itself the failure must not turn a failed turn into a
        // crashed host -- that is the BOX-6 shape exactly.
        try {
          session.db.appendTranscriptEntry(buildTurnFailedEntry({
            agentName: typeof session.db.get("name") === "string" ? session.db.get("name") as string : undefined,
            error,
            turnId: turnStartEntryId,
          }));
        } catch (writeError) {
          console.error(`[sand][turn] could not write the turn-failed entry for ${session.id}`, writeError);
        }
        markTurnTraceError(turnTrace, error);
        if (epoch === this.tm.sendPipeline.currentTurnEpoch(session)) {
          const description = describeAgentRunError(error);
          const requestId = session.db.getRequestIds().at(-1)?.id;
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title:
              description.errorKind === "provider_overloaded"
                ? PROVIDER_OVERLOAD_ERROR_TITLE
                : "Agent failed to respond",
            requestId,
            ...description,
          });
        }
        await this.tm.roster.emitAgentUpdate(session.id);
      } finally {
        for (const map of [
          this.activeTurns,
          this.reportedDualSurfaceToolCalls,
          this.reportedToolCallErrors,
          this.reportedToolCallStalls,
          this.pendingToolCallStarts,
          this.workToolCallCounts,
          this.deliveryToolCallCounts,
          this.toolCallTicks,
          this.lastWorkToolTick,
          this.lastDeliveryToolTick,
          this.activeRequestPrompts,
          this.activeRequestSources,
          this.selfTalkCapped,
        ])
          map.delete(session.id);
        this.tm.runLifecycle.lastRequestIdBySession.delete(session.id);
        this.turnDrafts.closeTurn(session.id);
        this.replyThreadTargets.delete(session);
        this.forkTurnSessions.delete(session);
        if (this.activeTurnEpochs.get(session.id) === epoch)
          this.activeTurnEpochs.delete(session.id);
        this.tm.ackObligations.retireAckRunToken(session.id, options.ackToken);
        this.tm.runLifecycle.endSessionRun(session);
      }
    } finally {
      try {
        turnTrace?.span.end();
      } catch {}
      this.tm.traceFlusher();
    }
  }

  /**
   * QOL-NEEDS-YOU. The turn is over: if the last thing the agent delivered was a question or a
   * request aimed at the operator, raise `awaitingUserResponse` so the roster row, the console's
   * amber "Waiting on you" and the existing notification decider all say so. Cleared by the
   * operator's next message to this agent (send-acceptance.ts clears the badge on accept).
   *
   * Guards, in order: a turn that did not really end (aborted, or quiesced for an upgrade) is not
   * waiting on an answer; a newer turn already started, so this one's closing message is stale; and
   * a badge already on the row belongs to the box hand-off or an auto-review approval, which are
   * structured facts and outrank a read of prose.
   *
   * `awaitingUserSelection` is deliberately NOT a guard. Every widget, secret request and
   * auto-review approval sets it, so guarding on it made the classifier's widget branch dead code:
   * a question widget is the clearest ask there is and lit nothing on the roster. The classifier
   * sorts the three out on its own -- a widget is an ask, a secret request and an approval carry
   * their own surfaces and classify as null.
   *
   * `turnStartEntryId` is the last entry that existed before the run; only what came after it is
   * this turn's, and a turn that appended nothing addressed to the operator asks nothing.
   */
  noteOperatorAsk(
    session: LiveTranscriptSession,
    result: TurnResult,
    epoch: number,
    turnStartEntryId: string | null,
    turnTrace?: HostTrace,
  ): void {
    try {
      if (result.aborted || result.quiescedForUpgrade === true) return;
      if (epoch !== this.tm.sendPipeline.currentTurnEpoch(session)) return;
      if (session.db.getAwaitingUserResponse() != null) return;
      const ask = operatorAskForTurn(
        session.db.getTranscriptEntries(),
        turnStartEntryId,
      );
      if (ask == null) return;
      session.db.setAwaitingUserResponse({
        tabId: OPERATOR_ASK_AWAITING_TAB_ID,
        reason: ask.reason,
        since: Date.now(),
      });
      setTurnTraceAttributes(turnTrace, { "sand.operator_ask": ask.kind });
    } catch {
      // Advisory, like every other awaiting badge: never fail a finished turn over it.
    }
  }

  async ensureUserReply(
    runner: AgentRunner,
    result: TurnResult,
    session: LiveTranscriptSession,
    epoch: number,
    ackToken: string | undefined,
    traceCtx: unknown,
    turnTrace: HostTrace | undefined,
    turn?: Record<string, any>,
  ): Promise<{
    result: TurnResult;
    replyNudgeAttempts: number;
    deliveryOwed: boolean;
    streamOutputProduced: boolean;
  }> {
    let latest = result;
    let attempts = 0;
    let delivered = !isDeliveryOwed(result);
    let streamOutputProduced = result.streamOutputProduced === true;
    let workReported = result.madeWorkToolCall;
    while (
      isDeliveryOwed(latest) &&
      attempts < MAX_REPLY_NUDGES &&
      epoch === this.tm.sendPipeline.currentTurnEpoch(session)
    ) {
      attempts += 1;
      latest = await runner.run(REPLY_NUDGE_PROMPT, {
        hidden: true,
        ackToken,
        traceCtx,
        onModelResolved: (id: string) => turn?.setModel(id),
      });
      delivered ||= !isDeliveryOwed(latest);
      streamOutputProduced ||= latest.streamOutputProduced === true;
      workReported = mergeWorkReport(workReported, latest);
      if (latest.aborted) break;
    }
    if (
      latest.endedOnSilentToolCalls === true &&
      !latest.aborted &&
      latest.awaitingUserSelection !== true &&
      epoch === this.tm.sendPipeline.currentTurnEpoch(session)
    ) {
      setTurnTraceAttributes(turnTrace, { "sand.closing_send_nudge": true });
      let nudged: TurnResult | undefined;
      try {
        nudged = await runner.run(CLOSING_SEND_NUDGE_PROMPT, {
          hidden: true,
          ackToken,
          traceCtx,
          onModelResolved: (id: string) => turn?.setModel(id),
        });
        latest = nudged;
        delivered ||= !isDeliveryOwed(nudged);
        streamOutputProduced ||= nudged.streamOutputProduced === true;
        workReported = mergeWorkReport(workReported, nudged);
      } finally {
        this.tm.telemetry.reportClosingSendNudge({
          conversationId: session.id,
          delivered:
            nudged != null && (nudged.sentMessageCount > 0 || nudged.reacted),
          sentMessageCount: nudged?.sentMessageCount ?? 0,
          aborted: nudged?.aborted ?? false,
        });
      }
    }
    const reportOwed = isReportOwed(latest, {
      lastWorkTick: this.lastWorkToolTick.get(session.id) ?? 0,
      lastDeliveryTick: this.lastDeliveryToolTick.get(session.id) ?? 0,
    });
    const workOwed = reportOwed || isWorkOwed(latest, {
      prompt: this.activeRequestPrompts.get(session.id),
      madeWorkToolCall: workReported,
      workToolCalls: this.workToolCallCounts.get(session.id) ?? 0,
      deliveryToolCalls: this.deliveryToolCallCounts.get(session.id) ?? 0,
    });
    const streak = this.workRedriveStreaks.get(session.id) ?? 0;
    if (this.selfTalkCapped.has(session.id)) {
      this.workRedriveStreaks.delete(session.id);
      setTurnTraceAttributes(turnTrace, { "sand.work_redrive_paused": true, "sand.work_redrive_pause_reason": "self_talk_cap" });
    }
    else if (!workOwed) this.workRedriveStreaks.delete(session.id);
    else if (streak >= MAX_WORK_REDRIVES)
      // Stop rather than spin: an agent that has answered this many turns
      // running without touching a tool will not start because we asked again.
      setTurnTraceAttributes(turnTrace, {
        "sand.work_redrive_paused": true,
        "sand.work_redrive_pause_reason": "anti_spin",
      });
    else if (epoch === this.tm.sendPipeline.currentTurnEpoch(session)) {
      this.workRedriveStreaks.set(session.id, streak + 1);
      setTurnTraceAttributes(turnTrace, { "sand.work_redrive": streak + 1 });
      const workBefore = this.workToolCallCounts.get(session.id) ?? 0;
      // The redrive is speculative: the user may already have a good answer. An unguarded throw
      // here would surface as "Agent failed to respond" on a turn that worked, and overwriting the
      // settled result would record `aborted` for it. Keep the original on any failure.
      let redriven: Awaited<ReturnType<typeof runner.run>> | undefined;
      try {
        redriven = await runner.run(reportOwed ? REPORT_REDRIVE_PROMPT : WORK_REDRIVE_PROMPT, {
          hidden: true,
          ackToken,
          traceCtx,
          onModelResolved: (id: string) => turn?.setModel(id),
        });
      } catch {
        setTurnTraceAttributes(turnTrace, { "sand.work_redrive_failed": true });
      }
      if (redriven !== undefined) {
        latest = redriven;
        streamOutputProduced ||= redriven.streamOutputProduced === true;
      }
      // Clear the streak only when the redrive actually did something. A
      // redrive that answered again is what the cap above exists to stop.
      if (
        (this.workToolCallCounts.get(session.id) ?? 0) > workBefore ||
        redriven?.madeWorkToolCall === true
      )
        this.workRedriveStreaks.delete(session.id);
    }
    return {
      result: latest,
      replyNudgeAttempts: attempts,
      deliveryOwed: !delivered,
      streamOutputProduced,
    };
  }

  resolveReplyTarget(
    entries: readonly TranscriptEntry[],
    candidateId: string,
  ): string | undefined {
    return entries.some((entry) => entry.id === candidateId)
      ? candidateId
      : undefined;
  }

  buildReplyContext(
    entries: readonly TranscriptEntry[],
    targetId?: string,
  ): { targetId: string; quote: string } | undefined {
    if (targetId == null) return undefined;
    const target = entries.find((entry) => entry.id === targetId);
    return target == null
      ? undefined
      : { targetId, quote: describeRepliedMessageQuote(target) };
  }

  handleAgentUpdate(
    update: Record<string, any>,
    session?: LiveTranscriptSession,
  ): string | undefined {
    const runSession =
      session ??
      this.tm.runLifecycle.activeRunSession ??
      this.tm.sessions.activeSession ??
      null;
    const isForActiveAgent =
      runSession == null ||
      runSession.id === this.tm.sessions.activeSession?.id;
    if (isForActiveAgent) this.tm.roster.applyAgentUpdateToOutline(update);
    if (runSession != null) {
      // VOICE-3, and NOT behind `isForActiveAgent`. The outline above it only tracks the host's one
      // globally open agent, which is exactly why ui/voice-edge.mjs refuses to read the SSE and polls
      // instead; a draft gated the same way would be empty for every agent a person is not looking at.
      this.turnDrafts.applyUpdate(runSession.id, update);
      this.tm.runLifecycle.trackComposingFromUpdate(update, runSession.id);
      this.tm.runLifecycle.trackRetryingFromUpdate(update, runSession);
      this.tm.runLifecycle.trackActivityFromUpdate(update, runSession.id);
    }
    switch (update.type) {
      case "client-side-tool-v2": {
        if (runSession == null) return undefined;
        const event = this.tm.clientSideToolV2.publish(runSession.id, update.update);
        if (event != null) this.tm.roster.emitClientSideToolV2(event);
        return undefined;
      }
      case "tool-call": {
        if (update.status === "pending" && runSession != null) {
          let starts = this.pendingToolCallStarts.get(runSession.id);
          if (starts == null) {
            starts = new Map();
            this.pendingToolCallStarts.set(runSession.id, starts);
          }
          if (!starts.has(update.id)) {
            starts.set(update.id, performance.now());
            // One count per distinct call, split by whether it was the agent
            // working or the agent talking. Feeds the work-owed redrive.
            const isDelivery = isDeliveryToolCallName(String(update.name ?? ""));
            const counts = isDelivery
              ? this.deliveryToolCallCounts
              : this.workToolCallCounts;
            counts.set(runSession.id, (counts.get(runSession.id) ?? 0) + 1);
            const tick = (this.toolCallTicks.get(runSession.id) ?? 0) + 1;
            this.toolCallTicks.set(runSession.id, tick);
            (isDelivery ? this.lastDeliveryToolTick : this.lastWorkToolTick)
              .set(runSession.id, tick);
          }
          const dual = sandDualSurfaceToolTelemetry(update.name);
          if (
            dual != null &&
            this.markReportedOnce({
              reported: this.reportedDualSurfaceToolCalls,
              sessionId: runSession.id,
              toolCallId: update.id,
            })
          ) {
            this.tm.telemetry.reportToolCallStarted({
              conversationId: runSession.id,
              requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
                runSession.id,
              ),
              toolName: dual.toolName,
              toolCallId: update.id,
              surface: dual.surface,
            });
          }
        } else if (runSession != null) {
          const starts = this.pendingToolCallStarts.get(runSession.id);
          const started = starts?.get(update.id);
          starts?.delete(update.id);
          if (update.status === "failed")
            this.reportToolCallDiagnostic(runSession, {
              kind: "error",
              toolCallId: update.id,
              toolName: update.name,
              connector: UNKNOWN_CONNECTOR_TAG,
              errorClass: TASK_ERROR_RESULT_CLASS,
              ...(started == null
                ? {}
                : { durationMs: Math.round(performance.now() - started) }),
            });
        }
        return undefined;
      }
      case "request-id":
        if (runSession != null) {
          this.activeTurns.get(runSession.id)?.setRequestId(update.requestId);
          this.tm.runLifecycle.lastRequestIdBySession.set(
            runSession.id,
            update.requestId,
          );
          this.tm.runLifecycle.trackTurnRequestId(
            runSession.id,
            update.requestId,
          );
        }
        void this.tm.runLifecycle.recordRequestId(
          update.requestId,
          runSession,
          update.source,
        );
        return undefined;
      case "turn-ended":
        if (runSession != null)
          this.tm.runLifecycle.reportTurnUsage(runSession, update.usage);
        return undefined;
      case "send-message": {
        const incoming = update.message as SendMessage;
        if (
          (incoming.type === "text" || incoming.type === "attachment") &&
          typeof incoming.channel === "string" &&
          incoming.channel.length > 0
        )
          this.tm.backgroundWakes.deliverToChannel(
            runSession,
            incoming,
            incoming.channel,
          );
        if (incoming.type === "listener-connect")
          this.notifyListenerConnect(runSession, incoming);
        if (incoming.type === "connector" && incoming.variant === "connect")
          this.notifyConnectorConnect(runSession, incoming);
        const entries =
          isForActiveAgent || runSession == null
            ? getTranscript()
            : (runSession.db.getTranscriptEntries() as TranscriptEntry[]);
        const sendId = nextEntryId(entries, "send-message");
        const validated = this.tm.sendPipeline.validateAiReplyTarget(
          incoming,
          sendId,
          entries,
        );
        const threaded = this.tm.sendPipeline.applyAutoReplyThread(
          validated,
          runSession,
          entries,
        ) as SendMessage;
        const batchId =
          threaded.type === "attachment" && runSession != null
            ? this.tm.sendPipeline.claimSendAttachmentBatchId(runSession.id)
            : undefined;
        const base = {
          ...createSendMessageEntry(sendId, threaded, update.timestampMs),
          ...(batchId == null ? {} : { batchId }),
        };
        const stamped =
          update.boxHandoff == null
            ? base
            : stampBoxRequestEntry(base, update.boxHandoff);
        const entry =
          runSession != null && this.forkTurnSessions.has(runSession)
            ? { ...stamped, branched: true }
            : stamped;
        if (isForActiveAgent || runSession == null) {
          this.tm.sendPipeline.appendSendMessageEntry(entry);
          const activeId = runSession?.id ?? this.tm.sessions.activeSession?.id;
          this.tm.ackObligations.fulfillAckObligation(
            activeId,
            update.ackToken,
          );
          if (activeId != null) void this.tm.roster.emitAgentUpdate(activeId);
        } else {
          runSession.db.appendTranscriptEntry(entry);
          this.tm.ackObligations.fulfillAckObligation(
            runSession.id,
            update.ackToken,
          );
          this.tm.sessionStore.markSessionActivity(runSession);
          void this.tm.roster.emitAgentUpdate(runSession.id);
        }
        return sendId;
      }
      // A line the host puts in the transcript in its own voice. It is not the agent speaking, so
      // it never touches the ack obligation or the delivery bookkeeping: it only has to be seen.
      case "notice": {
        const text = String(update.text ?? "").trim();
        if (text.length === 0) return undefined;
        if (update.reason === "self-talk-cap" && runSession != null) this.selfTalkCapped.add(runSession.id);
        const entry: TranscriptEntry = {
          kind: "notice",
          id: `notice-${randomUUID()}`,
          text,
          timestampMs: typeof update.timestampMs === "number" ? update.timestampMs : Date.now(),
        };
        if (isForActiveAgent || runSession == null) {
          this.tm.appendEntry(entry);
        } else {
          runSession.db.appendTranscriptEntry(entry);
          this.tm.sessionStore.markSessionActivity(runSession);
        }
        if (runSession != null) void this.tm.roster.emitAgentUpdate(runSession.id);
        return entry.id;
      }
      case "auto-review-status":
        this.settleNestedStatus(
          runSession,
          isForActiveAgent,
          "auto-review-approval",
          "approval",
          update.requestId,
          update.status,
        );
        return undefined;
      case "local-tool-permission-status":
        this.settleNestedStatus(
          runSession,
          isForActiveAgent,
          "local-tool-permission",
          "ask",
          update.requestId,
          update.status,
        );
        return undefined;
      case "react-to-message": {
        const emoji = String(update.emoji ?? "").trim();
        if (!emoji || !isMessageAddress(update.messageAddress))
          return undefined;
        const reactSession =
          runSession ?? this.tm.sessions.activeSession ?? null;
        const entries =
          reactSession != null &&
          reactSession.id !== this.tm.sessions.activeSession?.id
            ? (reactSession.db.getTranscriptEntries() as TranscriptEntry[])
            : getTranscript();
        const target = entries.find(
          (entry) => entry.id === update.messageAddress,
        );
        if (target == null || !isUserMessageEntry(target)) return undefined;
        const applied = this.tm.widgetResponses.applyReaction({
          session: reactSession,
          entryId: update.messageAddress,
          emoji,
          by: reactSession?.id ?? SAND_REACTION_AGENT,
        });
        return applied == null ? undefined : update.messageAddress;
      }
      default:
        return undefined;
    }
  }

  private notifyListenerConnect(
    session: LiveTranscriptSession | null,
    message: SendMessage,
  ): void {
    const ownerId = session?.id ?? this.tm.sessions.activeSession?.id;
    if (ownerId == null) return;
    try {
      this.tm.onListenerConnectCard?.({
        agentId: ownerId,
        platform: message.platform,
      });
    } catch {}
  }

  private notifyConnectorConnect(
    session: LiveTranscriptSession | null,
    message: SendMessage,
  ): void {
    const ownerId = session?.id ?? this.tm.sessions.activeSession?.id;
    if (ownerId == null) return;
    try {
      this.tm.onConnectorConnectCard?.({
        agentId: ownerId,
        connector: message.connector,
        ...(message.serverId == null ? {} : { serverId: message.serverId }),
      });
    } catch {}
  }

  private settleNestedStatus(
    runSession: LiveTranscriptSession | null,
    isForActiveAgent: boolean,
    type: string,
    key: string,
    requestId: string,
    status: unknown,
  ): void {
    const matchesCard = (entry: TranscriptEntry) =>
      messageOf(entry)?.type === type &&
      messageOf(entry)?.[key]?.requestId === requestId;
    const applyStatus = (entry: TranscriptEntry): TranscriptEntry => {
      const message = messageOf(entry);
      if (
        message == null ||
        message.type !== type ||
        message[key]?.requestId !== requestId
      )
        return entry;
      return {
        ...entry,
        message: { ...message, [key]: { ...message[key], status } },
      };
    };
    this.settleCardStatus({
      runSession,
      isForActiveAgent,
      matchesCard,
      applyStatus,
    });
  }
}
