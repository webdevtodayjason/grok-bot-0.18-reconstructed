// BOX-6b. Repairing one agent's conversation store on demand, from the console.
//
// Jason's standing rule: anything done by hand on a live instance has to become a console and agent
// mechanism. Before this, unsticking the demo tenant's Titan meant a shell inside the container.
//
// What this can and cannot do, stated plainly because the difference decides the counts it reports.
// The in-turn recovery (transcript-journal-repair.repairTranscriptJournal) has the live checkpoint
// and the conversation blobs, so it can rebuild the conversation file. This verb runs outside a
// turn and has neither, so it does the half that is safe from outside: it sets the stale
// write-ahead copy and cursor aside, REINDEXes the agent's databases, and clears the needs-repair
// latch. Clearing the latch is what matters -- the next message runs the recovery again, and that
// is the run which rebuilds. `after` is therefore the conversation file's count as it stands, not a
// promise about what the next message will write.
import { join } from "node:path";

import { evidenceRegistry } from "../evidence/evidence-registry.js";
import {
  CONVERSATION_BLOBS_FILENAME,
  STORE_FILENAME,
} from "../session/session-paths.js";
import { getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { isSafeFolderId } from "../../storage/folder-id.js";
import {
  repairTranscriptFiles,
  transcriptsDirForAgentDir,
  type TranscriptRepairReport,
} from "../../transcript-mirror/transcript-journal-repair.js";

export interface RepairAgentTranscriptInput {
  readonly agentId: string;
  /** The agent's directory, when the caller already holds it. Derived from the id otherwise. */
  readonly agentDir?: string | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export interface RepairAgentTranscriptResult {
  readonly agentId: string;
  readonly before: number;
  readonly after: number;
  /** Empty is a normal outcome: on the one real case in production there was nothing to set aside. */
  readonly quarantined: readonly string[];
  readonly outcome: TranscriptRepairReport["outcome"];
  readonly reason: string;
}

export async function repairAgentTranscript(input: RepairAgentTranscriptInput): Promise<RepairAgentTranscriptResult> {
  const agentId = String(input.agentId ?? "").trim();
  if (agentId.length === 0 || !isSafeFolderId(agentId)) {
    return {
      agentId,
      before: 0,
      after: 0,
      quarantined: [],
      outcome: "needs-attention",
      reason: "that is not an agent this box knows",
    };
  }

  const agentDir = input.agentDir != null && input.agentDir.length > 0
    ? input.agentDir
    : join(getSandAgentsRootDir(), agentId);

  const report = await repairTranscriptFiles({
    transcriptsDir: transcriptsDirForAgentDir(agentDir),
    conversationId: agentId,
    sqlitePaths: [join(agentDir, CONVERSATION_BLOBS_FILENAME), join(agentDir, STORE_FILENAME)],
    ...(input.log == null ? {} : { log: input.log }),
  });

  const result: RepairAgentTranscriptResult = {
    agentId,
    before: report.before,
    after: report.after,
    quarantined: report.quarantined,
    outcome: report.outcome,
    reason: report.reason ?? "",
  };

  evidenceRegistry.note(agentId, {
    type: "transcript_repair",
    outcome: result.outcome,
    before: result.before,
    after: result.after,
    quarantined: result.quarantined,
    reason: result.reason,
  });

  return result;
}
