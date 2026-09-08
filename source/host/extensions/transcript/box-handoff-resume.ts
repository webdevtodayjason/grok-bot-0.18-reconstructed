import { formatMcpAccountDisplayName } from "../../../shared/mcp.js";
import { aliasBoxResolution } from "../session/box-handoff-service.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import { describeAgentRunError } from "./agent-run-error.js";
import { classifyAgentError } from "./turn-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export interface AwaitingStateSink {
  set(agentId: string, state: unknown): void;
  clear(agentId: string): void;
  trySetForTab(
    agentId: string,
    state: { tabId: string; [key: string]: unknown },
  ): void;
  clearForTab(
    agentId: string,
    tabId: string,
    options?: { ifSinceBefore?: number },
  ): void;
}

/** How the hand-off ended. The resolution decides what the agent is told; the trigger only says how. */
export interface BoxHandoffOutcome {
  readonly resolution?: string | null;
  readonly trigger?: string | null;
}

/**
 * HANDBACK-1. Keyed off the RESOLUTION, never a raw trigger string. The pair used to disagree: a skip
 * wrote "cancelled" on the transcript entry and still resumed the agent with "the user handed the box
 * back", so a skipped step was indistinguishable from a done one. The wording is the original's.
 */
export function resumeBoxHandoffPrompt(outcome: BoxHandoffOutcome): string {
  if (aliasBoxResolution(outcome.resolution) === "dismissed") {
    return "[The user dismissed your box help request without doing the step you asked for. Treat it as declined: do not assume the step happened, and do not immediately request the box again for the same step. Continue the task without it if you can — skip the step or find another way. If the task cannot proceed without it, send the user a brief message saying what is blocked, then stop and wait for their reply.]";
  }
  if (outcome.trigger === "viewer-closed") {
    return "[The user closed the box desktop viewer without explicitly handing control back, so they may or may not have finished the step you asked for. Start with the read-only Screenshot tool to check the current state of the box desktop. If the step is clearly done, continue the task. If you can't tell, send the user a brief message asking whether they finished so you can keep going.]";
  }
  return "[The user handed the box back to you. Please continue your task — start with the read-only Screenshot tool to see the current state of the box desktop.]";
}

export class BoxHandoffResume {
  readonly awaitingSink = this.createAwaitingStateSink();

  constructor(readonly tm: TranscriptManagerLike) {}

  createAwaitingStateSink(): AwaitingStateSink {
    return {
      set: (agentId, state) => {
        void this.applyAwaitingState(agentId, state);
      },
      clear: (agentId) => {
        void this.applyAwaitingState(agentId, null);
      },
      trySetForTab: (agentId, state) => {
        void this.applyAwaitingStateForTab(agentId, state.tabId, state);
      },
      clearForTab: (agentId, tabId, options) => {
        void this.applyAwaitingStateForTab(agentId, tabId, null, options);
      },
    };
  }

  async applyAwaitingState(agentId: string, state: unknown): Promise<void> {
    if (this.tm.sessions.isAgentGone(agentId)) return;
    try {
      await this.tm.sessionStore.setAwaitingUserResponse(agentId, state);
      await this.tm.roster.emitAgentUpdate(agentId);
    } catch {
      // Awaiting badges are advisory and must not interrupt a turn.
    }
  }

  async applyAwaitingStateForTab(
    agentId: string,
    tabId: string,
    state: unknown,
    options?: { ifSinceBefore?: number },
  ): Promise<void> {
    if (this.tm.sessions.isAgentGone(agentId)) return;
    try {
      const applied = await this.tm.sessionStore.setAwaitingUserResponseForTab(
        agentId,
        tabId,
        state,
        options,
      );
      if (applied) await this.tm.roster.emitAgentUpdate(agentId);
    } catch {
      // A stale tab or disappearing agent is an expected race.
    }
  }

  async resumeAfterBoxHandoff(
    agentId: string,
    outcome: BoxHandoffOutcome | string = {},
  ): Promise<void> {
    await this.resumeWithHiddenPrompt(
      agentId,
      resumeBoxHandoffPrompt(
        typeof outcome === "string" ? { trigger: outcome } : outcome,
      ),
      "Agent failed to resume after box handoff",
    );
  }

  async resumeAfterMcpAuth(
    agentId: string,
    serverName: string,
    accountLabel: string,
  ): Promise<void> {
    const displayName = formatMcpAccountDisplayName(serverName, accountLabel);
    await this.resumeWithHiddenPrompt(
      agentId,
      `[The "${displayName}" MCP server finished authorizing — it's connected and its tools are available now. Your first action is a SendMessage telling the user it's connected, then pick up whatever you paused to authorize it. If there was nothing else to do, just confirm it's ready and ask what they'd like to do with it. Remember: nothing reaches the user unless it's inside a SendMessage.]`,
      "Agent failed to resume after MCP authentication",
    );
  }

  async resumeAfterListenerConnect(
    agentId: string,
    platform: string,
  ): Promise<void> {
    const displayName = platform === "slack" ? "Slack" : "GitHub";
    const reminder =
      platform === "slack"
        ? " For a channel listener, also remind them the Cursor bot must be in the channel (/invite @Cursor) or messages there can't reach it."
        : "";
    await this.resumeWithHiddenPrompt(
      agentId,
      `[${displayName} is now connected to the user's Cursor account — ${displayName} listener routines can fire. Your first action is a SendMessage telling the user it's connected, then pick up whatever you paused (e.g. finish or re-check the listener routine you were setting up).${reminder} Remember: nothing reaches the user unless it's inside a SendMessage.]`,
      "Agent failed to resume after listener connect",
    );
  }

  async resumeWithHiddenPrompt(
    agentId: string,
    prompt: string,
    errorTitle: string,
  ): Promise<void> {
    if (!this.tm.execution.canExecute) return;
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return;
    }
    if (this.tm.groupChat.isGroupSession(session)) return;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    const ackToken = this.tm.ackObligations.mintAckRunToken(session.id);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
        this.tm.turnRuntime.activeRequestSources.set(
          session.id,
          "handoff-resume",
        );
        try {
          await runner.run(prompt, {
            hidden: true,
            ackToken,
            requestSource: "handoff-resume",
          });
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "resume",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title: errorTitle,
            ...describeAgentRunError(error),
          });
        } finally {
          this.tm.ackObligations.retireAckRunToken(session.id, ackToken);
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "handoff-resume", ackToken },
    );
  }
}
