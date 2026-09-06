import { errorLogTag, errorMessage } from "../../../shared/errors.js";
import {
  getMainTranscriptEntries,
  getThreadTranscriptEntries,
  isAgentPeerMessageEntry,
  SAND_REACTION_SELF,
  settlePendingAutoReviewApprovalEntry,
  settlePendingLocalToolPermissionEntry,
} from "../../../shared/transcript.js";
import { buildSecretProvidedAck } from "../../runner/tools/sand-secret-request.js";
import {
  isShellEnvSecretField,
  isShellSecretConnector,
  shellEnvSecretFieldRefusal,
} from "../shell-tools/shell-secret-field.js";
import { SPEND_GUARD_VALUE_PREFIX } from "./sand-automation-spend-guard.js";
import {
  describeReactedMessageQuote,
  isUserMessageEntry,
  skippablePromptSummary,
  toggleReaction,
} from "./send-message-shaping.js";
import { getTranscript, updateEntry } from "./transcript-store.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";

type LiveSession = any;

/**
 * The chat platforms a `channel-credential` can name. Kept here because routeSecret has to tell a
 * chat credential from a local connector credential and they arrive under the same field.
 */
const CHAT_CREDENTIAL_PLATFORMS = new Set(["slack", "github"]);

export class WidgetResponses {
  constructor(readonly tm: TranscriptManagerLike) {}

  collectUnansweredQuestionPrompts(session: LiveSession): {
    skippedQuestionPrompts: string[];
    dismissedQuestionPrompts: string[];
  } {
    const isActive = session.id === this.tm.sessions.activeSession?.id;
    const entries = isActive
      ? getTranscript()
      : session.db.getTranscriptEntries();
    const skippedQuestionPrompts: string[] = [];
    const dismissedQuestionPrompts: string[] = [];
    for (const entry of entries) {
      if (
        entry.kind !== "send-message" ||
        entry.respondedValue != null ||
        entry.widgetSkipped === true
      )
        continue;
      const summary = skippablePromptSummary(entry.message as any);
      if (summary == null) continue;
      if (entry.widgetDismissed === true)
        dismissedQuestionPrompts.push(summary);
      else skippedQuestionPrompts.push(summary);
      const markSkipped = (current: TranscriptEntry): TranscriptEntry =>
        current.kind === "send-message"
          ? { ...current, widgetSkipped: true }
          : current;
      if (isActive) {
        const updated = updateEntry(entry.id, markSkipped);
        if (updated != null)
          this.tm.roster.emit({ type: "updated", entry: updated });
      }
      session.db.updateTranscriptEntry(entry.id, markSkipped);
    }
    return { skippedQuestionPrompts, dismissedQuestionPrompts };
  }

  async respondToWidget(
    entryId: string,
    value: string,
    agentId: string,
  ): Promise<{ accepted: boolean }> {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) return { accepted: false };
    await this.tm.sessions.ensureActionTarget(agentId);
    const targetAgentId = this.tm.sessions.activeSession?.id;
    if (!this.recordWidgetResponse(entryId, trimmedValue))
      return { accepted: false };

    const widgetEntry = getTranscript().find((entry) => entry.id === entryId);
    const replyToId =
      widgetEntry?.kind === "send-message"
        ? (widgetEntry.replyTo as string | undefined)
        : undefined;
    let modelPrompt = trimmedValue;
    let guardApplied = false;
    try {
      if (
        trimmedValue.startsWith(SPEND_GUARD_VALUE_PREFIX) &&
        targetAgentId != null
      ) {
        const applied =
          await this.tm.automationRuntime.handleSpendGuardWidgetAnswer({
            agentId: targetAgentId,
            entryId,
            value: trimmedValue,
            onApplied: () => {
              guardApplied = true;
            },
          });
        if (applied == null) {
          this.rollbackWidgetResponse(entryId);
          return { accepted: false };
        }
        modelPrompt = applied;
      }
      await this.tm.sendPrompt(modelPrompt, {
        ...(targetAgentId == null ? {} : { agentId: targetAgentId }),
        ...(replyToId == null ? {} : { replyToId }),
        appendUserMessage: false,
        awaitTurn: false,
      });
    } catch (error) {
      if (guardApplied) return { accepted: true };
      this.rollbackWidgetResponse(entryId);
      throw error;
    }
    return { accepted: true };
  }

  async settleStaleAutoReviewCard(args: {
    agentId: string;
    entryId: string;
    requestId: string;
  }): Promise<boolean> {
    if (
      this.settlePendingAutoReviewApprovalsOnSession({
        agentId: args.agentId,
        status: "expired",
        requestId: args.requestId,
      })
    )
      return true;
    const expired = await this.tm.sessionStore.expirePendingAutoReviewApprovals(
      args.agentId,
      args.requestId,
    );
    if (expired.length > 0) void this.tm.roster.emitAgentUpdate(args.agentId);
    const settled = this.tm.sessionStore
      .readAgentTranscriptEntries(args.agentId)
      .find(
        (entry: any) =>
          entry.id === args.entryId &&
          entry.kind === "send-message" &&
          entry.message.type === "auto-review-approval" &&
          entry.message.approval.requestId === args.requestId,
      );
    if (settled == null) return false;
    this.tm.roster.emit({ type: "updated", entry: settled }, args.agentId);
    return true;
  }

  async expireAllPendingAutoReviewApprovalCards(): Promise<void> {
    const reportFailure = (stage: string, error: unknown): void => {
      this.tm.telemetry.reportAutoReviewExpireSweepFailed({
        stage,
        errorClass: errorLogTag(error),
      });
    };
    try {
      const activeId = this.tm.sessions.activeSession?.id;
      if (activeId != null) {
        this.settlePendingAutoReviewApprovalsOnSession({
          agentId: activeId,
          status: "expired",
        });
      }
      let agentIds: string[];
      try {
        agentIds = await this.tm.sessionStore.listAgentIds();
      } catch (error) {
        reportFailure("list_agents", error);
        return;
      }
      for (const agentId of agentIds) {
        if (agentId === activeId) continue;
        try {
          const expired =
            await this.tm.sessionStore.expirePendingAutoReviewApprovals(
              agentId,
            );
          if (expired.length > 0) void this.tm.roster.emitAgentUpdate(agentId);
        } catch (error) {
          reportFailure("expire_agent", error);
        }
      }
    } catch (error) {
      reportFailure("sweep", error);
    }
  }

  settlePendingAutoReviewApprovalsOnSession(args: {
    agentId: string;
    status: string;
    requestId?: string;
  }): boolean {
    const session = this.liveSessionFor(args.agentId);
    if (session == null) return false;
    let retired = false;
    for (const entry of session.db.getTranscriptEntries()) {
      const settled = settlePendingAutoReviewApprovalEntry(
        entry,
        args.status,
        args.requestId,
      ) as TranscriptEntry | null;
      if (settled == null) continue;
      session.db.updateTranscriptEntry(entry.id, () => settled);
      retired = true;
      const live =
        args.agentId === this.tm.sessions.activeSession?.id
          ? updateEntry(entry.id, () => settled)
          : null;
      this.tm.roster.emit(
        { type: "updated", entry: live ?? settled },
        args.agentId,
      );
    }
    return retired;
  }

  async settleStaleLocalToolPermissionCard(args: {
    agentId: string;
    entryId: string;
    requestId: string;
  }): Promise<"retired" | "already-settled" | false> {
    if (this.settlePendingLocalToolPermissionAsksOnSession(args))
      return "retired";
    const expired =
      await this.tm.sessionStore.expirePendingLocalToolPermissionAsks({
        agentId: args.agentId,
        onlyRequestId: args.requestId,
      });
    if (expired.length > 0) void this.tm.roster.emitAgentUpdate(args.agentId);
    const settled = this.tm.sessionStore
      .readAgentTranscriptEntries(args.agentId)
      .find(
        (entry: any) =>
          entry.id === args.entryId &&
          entry.kind === "send-message" &&
          entry.message.type === "local-tool-permission" &&
          entry.message.ask.requestId === args.requestId,
      );
    if (settled == null) return false;
    this.tm.roster.emit({ type: "updated", entry: settled }, args.agentId);
    return expired.length > 0 ? "retired" : "already-settled";
  }

  async expireAllPendingLocalToolPermissionCards(options?: {
    ifPendingBeforeMs?: number;
  }): Promise<void> {
    try {
      const activeId = this.tm.sessions.activeSession?.id;
      if (activeId != null) {
        this.settlePendingLocalToolPermissionAsksOnSession({
          agentId: activeId,
          ...(options?.ifPendingBeforeMs == null
            ? {}
            : { ifPendingBeforeMs: options.ifPendingBeforeMs }),
        });
      }
      let agentIds: string[];
      try {
        agentIds = await this.tm.sessionStore.listAgentIds();
      } catch {
        return;
      }
      for (const agentId of agentIds) {
        if (agentId === activeId) continue;
        try {
          const expired =
            await this.tm.sessionStore.expirePendingLocalToolPermissionAsks({
              agentId,
              ifPendingBeforeMs: options?.ifPendingBeforeMs,
            });
          if (expired.length > 0) void this.tm.roster.emitAgentUpdate(agentId);
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  settlePendingLocalToolPermissionAsksOnSession(args: {
    agentId: string;
    requestId?: string;
    ifPendingBeforeMs?: number;
  }): boolean {
    const session = this.liveSessionFor(args.agentId);
    if (session == null) return false;
    let retired = false;
    for (const entry of session.db.getTranscriptEntries()) {
      if (
        args.ifPendingBeforeMs != null &&
        entry.kind === "send-message" &&
        entry.timestampMs != null &&
        entry.timestampMs >= args.ifPendingBeforeMs
      )
        continue;
      const settled = settlePendingLocalToolPermissionEntry(
        entry,
        "expired",
        args.requestId,
      ) as TranscriptEntry | null;
      if (settled == null) continue;
      session.db.updateTranscriptEntry(entry.id, () => settled);
      retired = true;
      const live =
        args.agentId === this.tm.sessions.activeSession?.id
          ? updateEntry(entry.id, () => settled)
          : null;
      this.tm.roster.emit(
        { type: "updated", entry: live ?? settled },
        args.agentId,
      );
    }
    return retired;
  }

  async dismissWidget(args: {
    entryId: string;
    agentId: string;
  }): Promise<{ accepted: boolean }> {
    await this.tm.sessions.ensureActionTarget(args.agentId);
    const existing = getTranscript().find((entry) => entry.id === args.entryId);
    if (
      existing == null ||
      existing.kind !== "send-message" ||
      (existing.message as any)?.type !== "widget" ||
      existing.respondedValue != null ||
      existing.widgetDismissed === true
    )
      return { accepted: false };
    let didStamp = false;
    const markDismissed = (entry: TranscriptEntry): TranscriptEntry => {
      if (
        entry.kind !== "send-message" ||
        entry.respondedValue != null ||
        entry.widgetDismissed === true
      )
        return entry;
      didStamp = true;
      const { widgetSkipped: _skipped, ...rest } = entry;
      return { ...rest, widgetDismissed: true } as TranscriptEntry;
    };
    const updated = updateEntry(args.entryId, markDismissed);
    if (didStamp && updated != null) {
      this.tm.roster.emit({ type: "updated", entry: updated });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        args.entryId,
        markDismissed,
      );
    }
    return { accepted: didStamp };
  }

  async submitSecret(
    entryId: string,
    value: string,
    agentId: string,
  ): Promise<void> {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    await this.tm.sessions.ensureActionTarget(agentId);
    const session = this.tm.sessions.activeSession;
    if (session == null) return;
    const entry = getTranscript().find((item) => item.id === entryId);
    if (
      entry == null ||
      entry.kind !== "send-message" ||
      (entry.message as any)?.type !== "secret-request" ||
      entry.secretProvided === true
    )
      return;
    const request = (entry.message as any).secretRequest;
    const routed = await this.routeSecret(session.id, request.target, trimmed);
    if (routed != null && "refused" in routed) {
      // CONNECT-4. The host refused the field, so NOTHING was stored anywhere. The operator hears
      // the rule (the fix is in the connector entry, and the console's credential card is where the
      // key belongs) and the agent hears that its request went unanswered, rather than an ack that
      // says the value "was written straight to its destination".
      this.tm.trayErrors.pushError({
        agentId: session.id,
        title: "The secret was not stored",
        detail: routed.refused,
      });
      await this.tm.boxHandoff.resumeWithHiddenPrompt(
        session.id,
        [
          `[The user securely provided the requested secret: "${request.label}", but the host REFUSED the field and discarded the value: nothing was stored. You never see the value and it is not in this conversation.]`,
          `Reason: ${routed.refused}`,
          isShellSecretConnector(request.target?.platform)
          // SECRET-1. The connector advice is wrong for a shell field: there is no Plugins card
          // behind it. What was refused is the VARIABLE NAME, and the fix is a legal one.
          ? "Do not ask for it again with the same field. Tell the user the variable name was refused; if you still need the value, ask once more with an UPPERCASE variable name that is not process control, not the shell's own HOME/PWD/USER and not a SAND_* switch."
          : "Do not ask for it again. Tell the user the field was refused and that a connector credential goes in that connector's card in the console's Plugins panel.",
        ].join("\n"),
        "Agent failed to resume after a refused secret",
      );
      return;
    }
    if (routed == null) {
      this.tm.trayErrors.pushError({
        agentId: session.id,
        title: "Could not store the secret",
        detail: "The secure input could not write the credential to its store.",
      });
      return;
    }
    const markProvided = (item: TranscriptEntry): TranscriptEntry =>
      item.kind === "send-message" ? { ...item, secretProvided: true } : item;
    const updated = updateEntry(entryId, markProvided);
    if (updated != null)
      this.tm.roster.emit({ type: "updated", entry: updated });
    session.db.updateTranscriptEntry(entryId, markProvided);
    await this.tm.boxHandoff.resumeWithHiddenPrompt(
      session.id,
      buildSecretProvidedAck(request, routed),
      "Agent failed to resume after secret submission",
    );
  }

  /**
   * CP-10. A submitted secret used to have exactly one destination: the per-agent chat-channel
   * store under `connector-secrets/<agentId>/<platform>.json`, which no MCP code reads and the
   * agent can read back. When the named platform is a local stdio connector instead of a chat
   * channel, the value now goes to the host-owned connector store and into that server's process
   * environment, and the server is restarted so it picks it up. Slack and GitHub keep the channel
   * branch. Returns null when nothing accepted the value, and `{ refused }` when the host rejected
   * the field: a refusal is not a reason to write the value somewhere else.
   */
  async routeSecret(
    agentId: string,
    target: any,
    value: string,
  ): Promise<
    | { destination: string; server?: string; restarted?: boolean; shellField?: string; applied?: boolean; pendingWindows?: readonly string[] }
    | { refused: string }
    | null
  > {
    if (target.kind !== "channel-credential") return null;
    const platform = typeof target.platform === "string" ? target.platform.trim() : "";
    // SECRET-1. The reserved connector name. The original product answers a card like "Titan Job
    // Bus token ... it'll land as env TITAN_JOB_TOKEN for this box" and the value becomes an
    // environment variable of the agent's OWN shell; every other destination this method knows is
    // somebody else's process. The shell store from CONNECT-5 already IS that environment, so the
    // route is a name, not a new store. It returns before the connector and channel branches:
    // "shell" must never fall through to a store the agent can read back.
    if (isShellSecretConnector(platform)) {
      const field = typeof target.field === "string" ? target.field.trim() : "";
      // The field name comes from the model. A refusal is answered the way the connector branch
      // answers one -- nothing is stored anywhere, and the agent is told the request went
      // unanswered rather than handed an ack that says the value reached its destination.
      if (!isShellEnvSecretField(field)) return { refused: shellEnvSecretFieldRefusal(field) };
      // SECRET-2. A null here reached submitSecret's "Could not store the secret" tray error and
      // stopped: the agent was never resumed, so it sat waiting forever on a card it had already
      // been answered. Every way this route can fail now answers `{refused}`, which submitSecret
      // resumes the agent with. A host without the sink is a host that cannot honour the card,
      // and saying so is the only honest beat.
      if (this.tm.shellSecretSink == null) {
        return { refused: "this host has no route from a secret card to the agent's shell environment, so nothing was stored. Ask the user to store the value from the console's Shell tools card instead." };
      }
      let applied = false;
      let pendingWindows: readonly string[] = [];
      try {
        const stored = await this.tm.shellSecretSink({ field, value });
        if (stored == null || stored.stored !== true) {
          return { refused: `the shell secret store did not take $${field}, so nothing was stored. Ask the user to store the value from the console's Shell tools card instead.` };
        }
        applied = stored.applied === true;
        pendingWindows = stored.pendingWindows ?? [];
      } catch (error) {
        console.log(
          `[sand:transcript] shell secret sink refused the value (${errorLogTag(error)}); nothing was stored`,
        );
        return { refused: errorMessage(error) };
      }
      return { destination: `your shell's environment as $${field}`, shellField: field, applied, pendingWindows };
    }
    // The connector route and the chat-channel route share ONE namespace -- `target.platform` --
    // and the collision is not hypothetical: the worked example in local-connectors.ts is a local
    // connector named `github`, and github is also one of the two chat platforms. On such a box a
    // GitHub channel token tried first against the connector would land in an MCP server's process
    // env, the channel would silently never connect, and the ack would report success. The chat
    // platforms therefore win the name race; everything else may be a connector.
    if (!CHAT_CREDENTIAL_PLATFORMS.has(platform.toLowerCase())) {
      // A throw here used to escape submitSecret entirely: the value reached NO store, the entry
      // was never marked provided, and the agent waited forever on the secret it had just asked
      // for. The field name comes from the model unvalidated, so "api-key" or a missing field is
      // ordinary input, not an edge case. The refusal is reported to the caller instead -- see the
      // catch below for why it is NOT answered by falling through to the channel store.
      let connector: { server: string; restarted?: boolean } | null = null;
      try {
        connector = await this.tm.connectorSecretSink?.({
          server: platform,
          field: target.field,
          value,
        }) ?? null;
      } catch (error) {
        // CONNECT-4. Falling through to the channel store here was a leak: the sink only throws for
        // a platform it has already identified as a local connector (sand-host returns null for
        // anything else), so a throw is the host REFUSING the field -- and the fallback wrote the
        // refused value into `connector-secrets/<agentId>/<platform>.json`, the per-agent store the
        // agent can read back, which is the CP-10 bug this route exists to fix. Nothing is stored.
        console.log(
          `[sand:transcript] connector secret sink refused the value (${errorLogTag(error)}); nothing was stored`,
        );
        return { refused: errorMessage(error) };
      }
      if (connector != null) {
        return {
          destination: "the connector's process environment",
          server: connector.server,
          restarted: connector.restarted === true,
        };
      }
    }
    const stored = this.tm.sessionStore.storeConnectorCredential(
      agentId,
      platform,
      target.field,
      value,
    );
    if (!stored) return null;
    this.tm.channelConfigChanged?.();
    return { destination: "channel-credential" };
  }

  recordWidgetResponse(entryId: string, value: string): boolean {
    const transcript = getTranscript();
    const existing = transcript.find((entry) => entry.id === entryId);
    if (
      existing == null ||
      existing.kind !== "send-message" ||
      (existing.message as any)?.type !== "widget" ||
      existing.respondedValue != null ||
      existing.widgetDismissed === true
    )
      return false;

    if ((existing.message as any).widget.dismissOnMoveOn === true) {
      const hasLaterUserMoment = (
        scope: readonly TranscriptEntry[],
      ): boolean => {
        const index = scope.findIndex((entry) => entry.id === entryId);
        return (
          index >= 0 &&
          scope
            .slice(index + 1)
            .some(
              (entry) =>
                (isUserMessageEntry(entry) &&
                  !isAgentPeerMessageEntry(entry)) ||
                (entry.kind === "send-message" &&
                  (entry.message as any)?.type === "widget" &&
                  (entry.respondedValue != null ||
                    entry.widgetDismissed === true)),
            )
        );
      };
      const surfaces: Array<readonly TranscriptEntry[]> = [];
      const main = getMainTranscriptEntries(
        transcript,
      ) as readonly TranscriptEntry[];
      if (main.some((entry) => entry.id === entryId)) surfaces.push(main);
      const thread = getThreadTranscriptEntries(
        transcript,
        entryId,
      ) as readonly TranscriptEntry[];
      if (thread.length > 1) surfaces.push(thread);
      if (surfaces.length > 0 && surfaces.every(hasLaterUserMoment))
        return false;
    }

    let didStamp = false;
    const withResponse = (entry: TranscriptEntry): TranscriptEntry => {
      if (
        entry.kind !== "send-message" ||
        entry.respondedValue != null ||
        entry.widgetDismissed === true
      )
        return entry;
      didStamp = true;
      return { ...entry, respondedValue: value };
    };
    const updated = updateEntry(entryId, withResponse);
    if (didStamp && updated != null) {
      this.tm.roster.emit({ type: "updated", entry: updated });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        entryId,
        withResponse,
      );
    }
    return didStamp;
  }

  rollbackWidgetResponse(entryId: string): TranscriptEntry | null {
    const withoutResponse = (entry: TranscriptEntry): TranscriptEntry => {
      if (entry.kind !== "send-message") return entry;
      const { respondedValue: _value, ...rest } = entry;
      return rest as TranscriptEntry;
    };
    const updated = updateEntry(entryId, withoutResponse);
    if (updated != null)
      this.tm.roster.emit({ type: "updated", entry: updated });
    this.tm.sessions.activeSession?.db.updateTranscriptEntry(
      entryId,
      withoutResponse,
    );
    return updated;
  }

  async reactToMessage(
    entryId: string,
    emoji: string,
    agentId: string,
  ): Promise<void> {
    const trimmed = emoji.trim();
    if (trimmed.length === 0) return;
    await this.tm.sessions.ensureActionTarget(agentId);
    const result = this.applyReaction({
      session: this.tm.sessions.activeSession ?? null,
      entryId,
      emoji: trimmed,
      by: SAND_REACTION_SELF,
    });
    const activeAgentId = this.tm.sessions.activeSession?.id;
    if (
      result?.isAdding &&
      activeAgentId != null &&
      !isUserMessageEntry(result.before)
    ) {
      void this.resumeAfterReaction(
        activeAgentId,
        trimmed,
        describeReactedMessageQuote(result.before),
      );
    }
  }

  applyReaction(args: {
    session?: LiveSession | null;
    entryId: string;
    emoji: string;
    by: string;
  }): { before: TranscriptEntry; isAdding: boolean } | null {
    const isActive =
      args.session == null ||
      args.session.id === this.tm.sessions.activeSession?.id;
    const entries = isActive
      ? getTranscript()
      : args.session.db.getTranscriptEntries();
    const before = entries.find(
      (entry: TranscriptEntry) => entry.id === args.entryId,
    );
    if (before == null) return null;
    const isAdding = !((before.reactions as any[]) ?? []).some(
      (reaction) => reaction.emoji === args.emoji && reaction.by === args.by,
    );
    const withToggle = (entry: TranscriptEntry): TranscriptEntry => {
      const next = toggleReaction(entry.reactions as any, args.emoji, args.by);
      const { reactions: _omit, ...rest } = entry;
      return next == null
        ? (rest as TranscriptEntry)
        : { ...rest, reactions: next };
    };
    if (isActive) {
      const updated = updateEntry(args.entryId, withToggle);
      if (updated == null) return null;
      this.tm.roster.emit({ type: "updated", entry: updated });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        args.entryId,
        withToggle,
      );
    } else {
      args.session.db.updateTranscriptEntry(args.entryId, withToggle);
      void this.tm.roster.emitAgentUpdate(args.session.id);
    }
    return { before, isAdding };
  }

  async resumeAfterReaction(
    agentId: string,
    emoji: string,
    messageQuote: string,
  ): Promise<void> {
    await this.tm.boxHandoff.resumeWithHiddenPrompt(
      agentId,
      `[The user reacted ${emoji} to your message: "${messageQuote}". You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).]`,
      "Agent failed to resume after reaction",
    );
  }

  private liveSessionFor(agentId: string): LiveSession | null {
    return this.tm.sessions.activeSession?.id === agentId
      ? this.tm.sessions.activeSession
      : (this.tm.sessions.liveSessions.get(agentId) ?? null);
  }
}
