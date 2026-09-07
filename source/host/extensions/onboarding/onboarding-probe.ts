/**
 * ONBOARD-1. What the migration rule needs to know about a box, and how the host answers it.
 *
 * Two signals, both of which the host already keeps somewhere:
 *   - how many bots there are (groups excluded), and
 *   - whether any agent has a prompted conversation.
 *
 * The reading is split from the wiring so the rule can be tested against a fake: the pure half
 * takes a probe, and `createHostBoxUseProbe` is the one that reaches the session store. It only
 * ever runs on a box whose settings document carries no onboarding record -- once in the life of a
 * box -- so opening an agent's conversation to look at it is affordable.
 */

import { isUserMessageEntry } from "../transcript/send-message-shaping.js";
import type { TranscriptEntry } from "../transcript/transcript-hub.js";
import type { BoxUseSignals } from "./onboarding-state.js";

export interface BoxUseProbe {
  /** Agent record ids on this box, groups already excluded. */
  listBotIds(): Promise<readonly string[]>;
  /** Whether that agent's transcript holds an entry the person sent. */
  hasPromptedConversation(agentId: string): Promise<boolean>;
}

/**
 * Short-circuits deliberately. More than one bot already decides the rule, so a box with a full
 * roster never opens a single conversation to answer this.
 */
export async function readBoxUseSignals(probe: BoxUseProbe): Promise<BoxUseSignals> {
  const botIds = await probe.listBotIds();
  if (botIds.length > 1) return { agentCount: botIds.length, hasPromptedConversation: true };
  for (const agentId of botIds) {
    if (await probe.hasPromptedConversation(agentId)) {
      return { agentCount: botIds.length, hasPromptedConversation: true };
    }
  }
  return { agentCount: botIds.length, hasPromptedConversation: false };
}

export interface BoxUseProbeHost {
  /** `SandSessionMaterialization.listAgentRecordIds` */
  listAgentRecordIds(): Promise<readonly string[]>;
  /** `SandSessionMaterialization.getAgentDir` */
  getAgentDir(agentId: string): string;
  /** `isSandGroupDir` -- a room is not a bot. */
  isGroupDir(agentDir: string): boolean;
  /** `sessionStore.getAgentTranscriptEntries` */
  readTranscriptEntries(agentId: string): Promise<readonly TranscriptEntry[]>;
  report?(event: Record<string, unknown>): void;
}

export function createHostBoxUseProbe(host: BoxUseProbeHost): BoxUseProbe {
  return {
    listBotIds: async () => {
      const ids = await host.listAgentRecordIds();
      return ids.filter((agentId) => {
        const dir = host.getAgentDir(agentId);
        return dir.length === 0 || !host.isGroupDir(dir);
      });
    },
    hasPromptedConversation: async (agentId) => {
      try {
        return (await host.readTranscriptEntries(agentId)).some(isUserMessageEntry);
      } catch (error) {
        // An unreadable conversation is not evidence the box is fresh. Read it as used: getting
        // this wrong in the other direction throws somebody's working box into a first-run
        // interview, which is the one outcome this rule exists to prevent.
        host.report?.({
          family: "onboarding",
          kind: "probe_read_failed",
          agentId,
          errorClass: error instanceof Error ? error.name : typeof error,
        });
        return true;
      }
    },
  };
}
