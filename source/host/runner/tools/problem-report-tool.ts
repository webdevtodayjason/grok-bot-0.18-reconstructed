import { z } from "zod";

import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  ReportBugArgs,
  ReportBugError,
  ReportBugResult,
  ReportBugSuccess,
  ReportBugToolCall,
} from "../../../packages/proto/generated/agent/v1/report_bug_tool_pb.js";
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.js";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/common.js";
import type { Context } from "../../../packages/context/core.js";
import type { ProblemReportPayload, ProblemReportTier } from "../../extensions/feedback/problem-reports.js";

/**
 * FEEDBACK-1. Jason, 2026-09-07: "Titan tried to cover up failure. We need to instill in the agents
 * that failure must be reported."
 *
 * This is a PLAIN zod agent tool rather than a `defineCommunicateTool` one, and that is not a
 * stylistic choice. A communicate-wrapped tool lands in the conversation outline as
 * `communicateUpdateToolCall`, and the console's NOT_A_RECEIPT filter drops every outline row whose
 * name matches /communicate|update_state|todo|.../ -- so the box-help template, which is otherwise
 * the closest shape in the tree, would have produced NO CHIP AT ALL. The chip is the whole point:
 * the person has to see that a report was written, in plain words, without ever seeing a tool name.
 *
 * The proto case it rides is `reportBugToolCall`, which the upstream 0.18 protocol already carries
 * with exactly the fields this payload needs (title, description, severity, category, rationale).
 * `getOutlineToolCallName` returns the proto case verbatim, so the outline row is named
 * `reportBugToolCall`; the console gives that name a TOOL_LABELS entry and a fixed headline, and a
 * test in this repo pins both halves so a rename on either side is a red test rather than a raw
 * tool name on a customer's screen.
 *
 * The tool POSTS NOTHING and asks for no credential. It writes a pending report into the box's own
 * store and returns a sentence. The console -- already authenticated as the tenant -- draws it,
 * lets the operator edit or drop it, and is the only thing that sends. See
 * source/host/extensions/feedback/problem-reports.ts for why that topology is the guarantee.
 */
export const PROBLEM_REPORT_TOOL_ID = "PROBLEM_REPORT";
export const PROBLEM_REPORT_TOOL_NAME = "report_problem";
/** The name this tool's row carries in the conversation outline. The console keys its label off it. */
export const PROBLEM_REPORT_OUTLINE_NAME = "reportBugToolCall";
/** The one line the model reads in the dynamic-tool hint table. */
export const PROBLEM_REPORT_TOOL_HINT =
  "Report a fault in the product itself to the person, who decides whether it reaches the developers.";

export const problemReportParameters = z.object({
  tier: z.enum(["critical", "quality", "observation"]).describe(
    'How much this is in the way. "critical" blocks the work you were asked to do. "quality" is friction you got past but should not have had to. "observation" is something you noticed that nobody is stuck on.',
  ),
  category: z.string().trim().min(1).describe(
    'What part of the product this is about, in one or two words the person would recognise: "shell", "browser", "files", "memory", "connectors", "desktop", "model", "console".',
  ),
  title: z.string().trim().min(1).describe(
    "One line naming the fault, as the person would say it. Not a stack trace and not an apology.",
  ),
  description: z.string().trim().min(1).describe(
    "What you were doing, what you expected, and what actually happened. Quote the exact answer a tool gave you rather than paraphrasing it.",
  ),
  steps: z.array(z.string().trim().min(1)).optional().catch(undefined).describe(
    "The shortest sequence that reproduces it, one step per entry. Omit when you genuinely cannot reproduce it, and say so in the description instead of inventing steps.",
  ),
  tools: z.array(z.object({
    name: z.string().trim().min(1).describe("The tool that misbehaved, by its own name."),
    status: z.string().trim().min(1).describe('What it did: "failed", "refused", "timed out", "wrong answer".'),
    error: z.string().trim().optional().catch(undefined).describe("Its answer, verbatim."),
  })).optional().catch(undefined).describe(
    "Which tools were involved and what each one answered. Leave empty when no tool was at fault.",
  ),
});

export type ProblemReportArgs = z.infer<typeof problemReportParameters>;

export interface ProblemReportDependencies {
  getAgentId(): string | undefined;
  getAgentName?(): string | undefined;
  savePending(entry: {
    readonly agentId: string;
    readonly agentName?: string;
    readonly report: ProblemReportPayload;
  }): Promise<{ readonly id: string }> | { readonly id: string };
  now?: () => number;
}

const DESCRIPTION = `Report a fault in this product to the person you are working with, so it can reach the people who build it.

Use this when something in the product itself is broken or in your way: a tool that fails, refuses, times out or answers wrongly; a step that cannot be done at all; a rough edge you had to work around. It is not for a task that simply did not succeed, and not for anything about the person's own data or accounts.

Say which tool failed and what it answered, word for word. Never call a failure temporary unless that same step has already succeeded for you before, and never present a workaround as if it were the result that was asked for.

What happens next is not up to you and not up to this tool. The report goes to the person in their console, where they read it, edit it, add context or drop it. Nothing leaves their workspace until they send it. So say plainly that you have written it down and offer it to them; do not promise that anyone has received it.

This tool sends nothing and needs no credential. After calling it, carry on with whatever can still be done.`;

/** ProblemReport v1, minted identically here, by the console's automatic offer and by the self-test. */
export function buildProblemReportPayload(
  args: ProblemReportArgs,
  options: { readonly now?: () => number } = {},
): ProblemReportPayload {
  return {
    version: 1,
    tier: args.tier as ProblemReportTier,
    category: args.category,
    title: args.title,
    description: args.description,
    steps: (args.steps ?? []).filter((step) => step.trim().length > 0),
    tools: (args.tools ?? []).map((tool) => ({
      name: tool.name,
      status: tool.status,
      ...(tool.error == null || tool.error.length === 0 ? {} : { error: tool.error }),
    })),
    at: new Date((options.now ?? Date.now)()).toISOString(),
  };
}

/**
 * The proto args. `rationale` carries the steps and the tool answers because ReportBugArgs has no
 * list fields; the console never draws any of this (the row is one detail-less muted line), so this
 * is the model's own honest record of the call and nothing more.
 */
export function problemReportProtoArgs(payload: ProblemReportPayload): ReportBugArgs {
  const steps = payload.steps.length === 0 ? "" : `Steps:\n${payload.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`;
  const tools = payload.tools.length === 0
    ? ""
    : `Tools:\n${payload.tools.map((tool) => `- ${tool.name} · ${tool.status}${tool.error == null ? "" : ` · ${tool.error}`}`).join("\n")}`;
  return new ReportBugArgs({
    title: payload.title,
    description: payload.description,
    severity: payload.tier,
    category: payload.category,
    rationale: [steps, tools].filter((part) => part.length > 0).join("\n\n"),
  });
}

/** The sentence the model reads back. It claims exactly what happened and nothing beyond it. */
export function problemReportAck(payload: ProblemReportPayload): string {
  const blocked = payload.tier === "critical"
    ? " Say what is now blocked and what you can still do without it."
    : "";
  return `Written down and shown to the person in their console, where they decide whether it goes to the developers. Nobody has received it yet, so do not say that anyone has.${blocked} Tell them plainly what failed and carry on with what can still be done.`;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const wrap = (value: ReportBugToolCall): ToolCall =>
  new ToolCall({ tool: { case: "reportBugToolCall", value } });

export function createProblemReportTool(dependencies: ProblemReportDependencies) {
  const execute = async (
    context: Context,
    interactionHandler: {
      executeToolCall: (
        context: Context,
        toolCall: ToolCall,
        id: string,
        run: (context: Context) => Promise<ReportBugResult>,
        merge: (result: ReportBugResult) => ToolCall,
      ) => Promise<ReportBugResult>;
    },
    args: ProblemReportArgs,
    meta: { readonly toolCallId: string },
  ): Promise<ReportBugResult> => {
    const payload = buildProblemReportPayload(args, dependencies.now == null ? {} : { now: dependencies.now });
    const protoArgs = problemReportProtoArgs(payload);
    const base = new ReportBugToolCall({ args: protoArgs });
    return interactionHandler.executeToolCall(context, wrap(base), meta.toolCallId, async () => {
      const agentId = dependencies.getAgentId();
      if (agentId == null || agentId.length === 0) {
        return new ReportBugResult({
          result: { case: "error", value: new ReportBugError({ errorMessage: "report_problem was called outside an agent run." }) },
        });
      }
      const agentName = dependencies.getAgentName?.();
      try {
        await dependencies.savePending({
          agentId,
          ...(agentName == null || agentName.length === 0 ? {} : { agentName }),
          report: payload,
        });
      } catch (error) {
        return new ReportBugResult({
          result: { case: "error", value: new ReportBugError({ errorMessage: `the report could not be written down: ${errorMessage(error)}` }) },
        });
      }
      return new ReportBugResult({
        result: { case: "success", value: new ReportBugSuccess({ output: problemReportAck(payload) }) },
      });
    }, (result) => wrap(new ReportBugToolCall({ args: protoArgs, result })));
  };

  return createZodAgentTool(PROBLEM_REPORT_TOOL_ID, {
    name: PROBLEM_REPORT_TOOL_NAME,
    descriptionGenerator: () => DESCRIPTION,
    parameters: problemReportParameters,
    // `emitInitialPartialToolCall: false`, the same as every sand tool: the chip says a report was
    // written, and a half-built row that appears while the model is still typing its arguments and
    // then changes under the reader is not that.
    execute: withSafeParsedArgs(problemReportParameters, execute, wrap(new ReportBugToolCall()), { emitInitialPartialToolCall: false }),
    render: async (_context: Context, result: ReportBugResult) => {
      if (result.result.case === "success") return createStringResult(result.result.value.output);
      if (result.result.case === "error") return createStringResult(`The report was not written down: ${result.result.value.errorMessage}`);
      return createStringResult("The report was not written down.");
    },
    serializeError: (error: unknown) => wrap(new ReportBugToolCall({
      result: new ReportBugResult({
        result: { case: "error", value: new ReportBugError({ errorMessage: errorMessage(error) }) },
      }),
    })),
  });
}
