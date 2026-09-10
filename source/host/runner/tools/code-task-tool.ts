import { z } from "zod";

import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  SendFinalSummaryArgs,
  SendFinalSummaryError,
  SendFinalSummaryResult,
  SendFinalSummarySuccess,
  SendFinalSummaryToolCall,
} from "../../../packages/proto/generated/agent/v1/send_final_summary_tool_pb.js";
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.js";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/common.js";
import type { Context } from "../../../packages/context/core.js";
import {
  CODE_CALL_TIMEOUT_MS,
  CODE_LIST_ROUTE,
  CODE_RESULT_ROUTE,
  CODE_START_ROUTE,
  CODE_STATUS_ROUTE,
  CODE_STOP_ROUTE,
  type CodeRelayAnswer,
  type CodeRoute,
  type RelayCodeTarget,
  codeNumber,
  codeString,
} from "../../extensions/code-sandbox/relay-code-client.js";

/**
 * CODE-1. The coding sandbox, from Titan's side. Jason, 2026-09-09 06:11: "coding is a good idea and
 * should be first-class. Richard is going to want to code stuff."
 *
 * A task is a throwaway container the relay creates on its own dedicated network, which reaches the
 * metering proxy and NOTHING ELSE (measured: no default route, no external DNS, Errno 101 by IP), with
 * exactly one mount -- the agent's own files under `code/<taskId>` -- a CPU, memory and wall-clock
 * limit, and a per-task model key with a hard spend cap that is revoked the moment the task ends. The
 * box holds none of that. It asks, over the bearer it already presents to the relay for everything
 * else, and everything about what the sandbox may spend is decided on the far side.
 *
 * THIS IS A PLAIN ZOD TOOL, not a `defineCommunicateTool` one, and problem-report-tool.ts and
 * send-email-tool.ts are the record of why: a communicate-wrapped tool lands in the outline as
 * `communicateUpdateToolCall`, and the console's NOT_A_RECEIPT filter drops every row whose name
 * matches /communicate|update_state|todo|.../ -- so a person would see NO CHIP AT ALL for work their
 * bot sent off to another machine. The chip is the point: a coding task spends money and writes files,
 * and the person has to see that it happened, in plain words, without ever reading a tool name.
 *
 * THE PROTO CARRIER IS `sendFinalSummaryToolCall`, whose args are ONE string (`finalSummary`), which is
 * the whole reason it is the right one: the outline's `summary` is that JSON serialized whole
 * (conversation-outline.ts getToolCallActivityArgs) and drawn on a customer's screen, so the
 * INSTRUCTIONS must not be able to reach it even by accident. What the one string holds is the VERB and
 * the TITLE, and on a refusal the marker in front of them.
 *
 * THE ONE COLLISION TO KNOW ABOUT, because it is invisible otherwise: task-client.ts:62
 * (`extractFinalSummaryFromSteps`) scans a SUBAGENT's own conversation steps for this very case to
 * pull out the subagent's final summary. That is never this tool's row, because the tool is WITHHELD
 * on a subagent runner (turn-toolset.ts, reason "subagent_runner") -- so the two uses can never be in
 * the same conversation. The withhold is therefore load-bearing for more than the chip, and
 * tests/code-task-tool.test.mjs pins it.
 *
 * THERE IS NO `repo` PARAMETER IN THIS RELEASE. A task has no egress -- measured -- so `git clone`,
 * `npm install` and `pip install` cannot run inside one, and a parameter that always refuses teaches
 * the model a capability the product does not have. CODE-2 is the owned row for a short-lived fetch
 * container that would make it real.
 */
export const CODE_TASK_TOOL_ID = "CODE_TASK";
export const CODE_TASK_TOOL_NAME = "code_task";
/** The name this tool's row carries in the conversation outline. The console keys its label off it. */
export const CODE_TASK_OUTLINE_NAME = "sendFinalSummaryToolCall";
/** The one line the model reads in the dynamic-tool hint table. */
export const CODE_TASK_TOOL_HINT =
  "Hand a coding job to a throwaway machine that runs it on its own, then read what it wrote.";

/**
 * The outcome marker, and the one place this design bends -- the same bend send-email-tool.ts
 * documents, for the same measured reason.
 *
 * An OutlineItem for a non-shell, non-task tool call carries `{kind, id, name, status, summary}` and
 * nothing else, and `getOutlineToolCallStatus` reports "failed" only for a failed taskToolCall. So the
 * console cannot see this tool's error result at all: left alone, a start the relay REFUSED would have
 * drawn "Started a coding task" on the person's screen. The outcome therefore travels in the one string
 * the outline does carry, in front of the verb, and the console's branch reads it.
 */
export const CODE_TASK_FAILED_PREFIX = "not done: ";

export const CODE_TASK_VERBS = Object.freeze(["start", "status", "stop", "result"] as const);
export type CodeTaskVerb = (typeof CODE_TASK_VERBS)[number];

/** The sentence the model reads back, keyed by the result object itself -- see send-email-tool.ts for
 * why a WeakMap on the result and not a field or an id: `render` is handed the very object `execute`
 * returned and is given neither the arguments nor the call id, so the object IS the key. */
const ACK_BY_RESULT = new WeakMap<SendFinalSummaryResult, string>();

export const codeTaskParameters = z.object({
  verb: z.enum(CODE_TASK_VERBS).describe(
    "What to do. `start` sends a new job off and comes back at once with an id. `status` says whether"
      + " it is still running and shows the last lines of its log. `stop` ends it early. `result` gives"
      + " the summary it wrote and the files it left, and you must call it before you describe the work.",
  ),
  title: z.string().trim().optional().catch(undefined).describe(
    "A short name for the job, for `start`. A handful of words the person would recognise, like"
      + " \"prime sieve script and its test\". This is the only part of the job that is shown on their"
      + " screen, so write it for them and not for yourself.",
  ),
  instructions: z.string().trim().optional().catch(undefined).describe(
    "For `start`: the whole job, in as much detail as you would give a careful engineer who cannot ask"
      + " you a question. Say what to build, which files to write, and HOW TO CHECK IT WORKED -- the"
      + " command to run and what passing looks like. The machine has no internet, so it cannot clone a"
      + " repository or install a package: everything it needs must be in what you send or already in"
      + " the image (node, python3, git, ripgrep).",
  ),
  files: z.array(z.string().trim().min(1)).optional().catch(undefined).describe(
    "For `start`: paths in your own files to copy in, if the job needs to start from something you"
      + " already have. Leave it out for a job that starts from nothing.",
  ),
  provider: z.enum(["local", "cloud"]).optional().catch(undefined).describe(
    "Where to run it. Leave this out: the workspace has a setting for it and the right answer is"
      + " almost always the one it already has. `cloud` is only for an operator who has asked for it.",
  ),
  task_id: z.string().trim().optional().catch(undefined).describe(
    "For `status`, `stop` and `result`: the id `start` gave you.",
  ),
});

export type CodeTaskArgs = z.infer<typeof codeTaskParameters>;

export interface CodeTaskDependencies {
  getAgentId(): string | undefined;
  /** Where the relay is and the bearer for it, or undefined when this box has no relay. */
  resolveRelay(): RelayCodeTarget | undefined;
  post(
    target: RelayCodeTarget,
    route: CodeRoute,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CodeRelayAnswer>;
  /**
   * Register a started task with the box's one watcher, so the agent is told when it finishes without
   * having to poll. Absent is survivable: the agent can call `status` itself, which is also the named
   * fallback if the transcript resume seam is ever contested.
   */
  watch?(agentId: string, taskId: string, title: string): void;
  timeoutMs?: number;
}

const DESCRIPTION = `Hand a coding job to a separate, throwaway machine that does it on its own.

Use this instead of doing the work here whenever the job is more than a few commands: something to build, a script plus its test, a refactor across several files, anything where the only way to know it worked is to run it. The machine is made for the job, does the work, writes its files, and is thrown away.

start returns straight away with an id. It does NOT wait for the job, and neither should you: go on with the conversation, and you will be told here when it finishes. When you are, read the result before you say a word about what it did.

What the machine has: node, python3, git and ripgrep, and the files you send it. What it does NOT have is the internet. It cannot clone a repository, install a package, or look anything up. If a job needs a dependency, it cannot be done this way yet, and the honest answer is to say so rather than to send a job that will fail.

Every job has a time limit and a spending limit set by the operator, and the machine is stopped when it reaches either. Its files land in your own files under code/ and the id, so you can read them here afterwards with your ordinary tools.

Say in one line what you sent off and, when it comes back, what it did and where the files are. Only describe work you have actually read with result. If it comes back with a reason instead, repeat that reason and do not describe the job as done.`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const wrap = (value: SendFinalSummaryToolCall): ToolCall =>
  new ToolCall({ tool: { case: "sendFinalSummaryToolCall", value } });

/**
 * The one string the outline carries: the verb, the title, and on a refusal the marker in front.
 *
 * NOTHING ELSE MAY EVER BE PUT HERE. Not the instructions, not a path, not a log line, not a task id
 * -- the instructions are the customer's own job description and the log is a sandbox's stdout, and
 * both are serialized whole onto their screen by the outline.
 */
export function codeTaskProtoArgs(
  verb: CodeTaskVerb,
  title: string,
  outcome: "done" | "failed",
): SendFinalSummaryArgs {
  const named = title.trim();
  const label = named.length > 0 ? `${verb} · ${named}` : verb;
  return new SendFinalSummaryArgs({
    finalSummary: outcome === "failed" ? `${CODE_TASK_FAILED_PREFIX}${label}` : label,
  });
}

/** The sentence the model reads back when a task was accepted. */
export function codeStartAck(
  taskId: string,
  provider: string,
  deadlineAt: number | undefined,
  capUsd: number | undefined,
): string {
  const minutes = deadlineAt == null
    ? null
    : Math.max(1, Math.round((deadlineAt - Date.now()) / 60_000));
  const clock = minutes == null ? "" : ` It has about ${minutes} minute${minutes === 1 ? "" : "s"} to finish.`;
  const cap = capUsd == null ? "" : ` It may spend up to ${capUsd.toFixed(2)} US dollars on models.`;
  const where = provider === "cloud" ? "a cloud sandbox" : "a machine beside this box";
  return `The job is running on ${where}. Its id is ${taskId}.${clock}${cap}`
    + " This did not wait for it: carry on with the conversation, tell the person in one line what you"
    + " sent off, and you will be told here when it is finished. Do not describe what it did until you"
    + " have read the result.";
}

/** A relay log tail, as the model reads it. Already redacted relay-side; trimmed here for the turn. */
const lastLines = (value: unknown, keep = 12): string => {
  const rows = (Array.isArray(value) ? value : [])
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
  return rows.slice(-keep).join("\n");
};

const fileList = (value: unknown): readonly { path: string; bytes?: number }[] =>
  (Array.isArray(value) ? value : []).flatMap((row) => {
    if (typeof row !== "object" || row == null) return [];
    const record = row as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (path.length === 0) return [];
    const bytes = typeof record.bytes === "number" && Number.isFinite(record.bytes)
      ? record.bytes
      : undefined;
    return [bytes == null ? { path } : { path, bytes }];
  });

export function createCodeTaskTool(dependencies: CodeTaskDependencies) {
  const execute = async (
    context: Context,
    interactionHandler: {
      executeToolCall: (
        context: Context,
        toolCall: ToolCall,
        id: string,
        run: (context: Context) => Promise<SendFinalSummaryResult>,
        merge: (result: SendFinalSummaryResult) => ToolCall,
      ) => Promise<SendFinalSummaryResult>;
    },
    args: CodeTaskArgs,
    meta: { readonly toolCallId: string },
  ): Promise<SendFinalSummaryResult> => {
    const verb = args.verb;
    const title = (args.title ?? "").trim();
    // What the row says while the call is in flight. The completed row is minted below from the
    // outcome, so a refusal never leaves "Started a coding task" on the person's screen.
    const pending = codeTaskProtoArgs(verb, title, "done");
    let outcome: "done" | "failed" = "failed";
    const refuse = (why: string): SendFinalSummaryResult => new SendFinalSummaryResult({
      result: { case: "error", value: new SendFinalSummaryError({ error: why }) },
    });
    const succeed = (ack: string): SendFinalSummaryResult => {
      outcome = "done";
      const done = new SendFinalSummaryResult({
        result: { case: "success", value: new SendFinalSummarySuccess({ finalSummary: "" }) },
      });
      ACK_BY_RESULT.set(done, ack);
      return done;
    };

    return interactionHandler.executeToolCall(
      context,
      wrap(new SendFinalSummaryToolCall({ args: pending })),
      meta.toolCallId,
      async () => {
        const agentId = dependencies.getAgentId();
        if (agentId == null || agentId.length === 0) {
          return refuse("the coding tool was called outside an agent run.");
        }
        const relay = dependencies.resolveRelay();
        if (relay == null || relay.token.length === 0) {
          // This box should never have been offered the tool at all (buildTurnTools withholds it with
          // reason "no_relay"), so this is the belt to that braces: a relay that vanished between the
          // offer and the call still gets a sentence rather than a thrown turn.
          return refuse(
            "there is no machine in front of this box that can run coding tasks, so nothing can be"
              + " sent off from here. Say so plainly and offer to do the work here instead.",
          );
        }

        const call = async (
          route: CodeRoute,
          body: Record<string, unknown>,
        ): Promise<CodeRelayAnswer | SendFinalSummaryResult> => {
          let answer: CodeRelayAnswer;
          try {
            answer = await dependencies.post(relay, route, body, dependencies.timeoutMs ?? CODE_CALL_TIMEOUT_MS);
          } catch (error) {
            // postCode does not throw; a dependency that did would otherwise read to the model as a
            // task whose outcome is unknown, which is the one thing it may not conclude.
            return refuse(`the coding task did not go through: ${errorMessage(error)}`);
          }
          // 409 not_available and every other non-200 arrive as one sentence the model may repeat.
          // notAvailable already carries the plain no-docker words, so there is no branch here.
          if (!answer.ok) return refuse(answer.message);
          return answer;
        };

        if (verb === "start") {
          const instructions = (args.instructions ?? "").trim();
          if (title.length === 0) {
            return refuse(
              "a coding task needs a short title, in words the person would recognise. Call it again"
                + " with one.",
            );
          }
          if (instructions.length === 0) {
            return refuse(
              "a coding task needs its instructions: what to build, which files to write, and the"
                + " command that proves it worked. Call it again with them.",
            );
          }
          const answered = await call(CODE_START_ROUTE, {
            agentId,
            title,
            instructions,
            ...(args.files == null || args.files.length === 0 ? {} : { files: args.files }),
            ...(args.provider == null ? {} : { provider: args.provider }),
          });
          if (!("ok" in answered)) return answered;
          if (answered.body.started !== true) {
            // The relay's own sentence, verbatim: the cap it hit, the image it does not have, the
            // concurrent task already running. The model repeats the true reason.
            return refuse(answered.message);
          }
          const taskId = codeString(answered.body, "taskId");
          if (taskId.length === 0) {
            return refuse(
              "the coding task was accepted but came back with no id, so there is nothing to follow."
                + " Say that rather than describing it as running.",
            );
          }
          const provider = codeString(answered.body, "provider") || "local";
          try { dependencies.watch?.(agentId, taskId, title); } catch { /* the watch is an optimisation */ }
          return succeed(codeStartAck(
            taskId,
            provider,
            codeNumber(answered.body, "deadlineAt"),
            codeNumber(answered.body, "capUsd"),
          ));
        }

        const taskId = (args.task_id ?? "").trim();
        if (taskId.length === 0) {
          return refuse(`\`${verb}\` needs the task id that \`start\` gave you.`);
        }

        if (verb === "status") {
          const answered = await call(CODE_STATUS_ROUTE, { agentId, taskId });
          if (!("ok" in answered)) return answered;
          if (answered.body.found !== true) {
            return refuse(
              `there is no coding task ${taskId} on this workspace. Check the id, or list what is`
                + " running instead of guessing.",
            );
          }
          const state = codeString(answered.body, "state") || "running";
          const elapsed = codeNumber(answered.body, "elapsedS");
          const provider = codeString(answered.body, "provider") || "local";
          const tail = lastLines(answered.body.lines);
          const clock = elapsed == null
            ? ""
            : ` It has been going ${Math.max(1, Math.round(elapsed / 60))} minute(s).`;
          const where = provider === "cloud" ? "a cloud sandbox" : "a machine beside this box";
          const head = state === "running"
            ? `The job is still running on ${where}.${clock} You will be told here when it finishes;`
              + " do not wait for it and do not keep checking."
            : `The job is ${state === "done" ? "finished" : state.replace(/_/g, " ")}.`
              + " Read the result now, before you describe what it did.";
          return succeed(tail.length === 0 ? head : `${head}\n\nThe last of its log:\n${tail}`);
        }

        if (verb === "stop") {
          const answered = await call(CODE_STOP_ROUTE, { agentId, taskId });
          if (!("ok" in answered)) return answered;
          if (answered.body.stopped !== true) return refuse(answered.message);
          return succeed(
            `The job is stopped. Anything it had already written is still in your files under`
              + ` code/${taskId}, so read that before you say nothing came of it.`,
          );
        }

        const answered = await call(CODE_RESULT_ROUTE, { agentId, taskId });
        if (!("ok" in answered)) return answered;
        if (answered.body.ready !== true) {
          return refuse(answered.message);
        }
        const summary = codeString(answered.body, "summary");
        const path = codeString(answered.body, "path");
        const files = fileList(answered.body.files);
        const written = files.length === 0
          ? "It left no files."
          : `It wrote ${files.length} file${files.length === 1 ? "" : "s"}${path.length === 0 ? "" : ` under ${path}`}:\n`
            + files.map((file) => `  ${file.path}${file.bytes == null ? "" : ` (${file.bytes} bytes)`}`).join("\n");
        const said = summary.length === 0
          ? "It wrote no summary of its own."
          : `What it says it did:\n${summary}`;
        return succeed(
          `${said}\n\n${written}\n\nOpen the files yourself before you report this: its summary is its`
            + " own account of the work, not proof the work is right. Then tell the person in plain words"
            + " what it did and where the files are.",
        );
      },
      (result) => wrap(new SendFinalSummaryToolCall({
        args: codeTaskProtoArgs(verb, title, outcome),
        result,
      })),
    );
  };

  return createZodAgentTool(CODE_TASK_TOOL_ID, {
    name: CODE_TASK_TOOL_NAME,
    descriptionGenerator: () => DESCRIPTION,
    parameters: codeTaskParameters,
    // `emitInitialPartialToolCall: false`, the same as every sand tool: a half-built row drawn while
    // the model is still typing the title, which then changes under the reader, is worse than no row
    // until the call is made.
    execute: withSafeParsedArgs(
      codeTaskParameters,
      execute,
      wrap(new SendFinalSummaryToolCall()),
      { emitInitialPartialToolCall: false },
    ),
    render: async (_context: Context, result: SendFinalSummaryResult) => {
      if (result.result.case === "error") {
        return createStringResult(`The coding task did not go ahead: ${result.result.value.error}`);
      }
      if (result.result.case === "success") {
        return createStringResult(
          ACK_BY_RESULT.get(result)
            // A success this process did not mint has no ack to read back -- a replayed transcript, a
            // host that restarted between the call and the render. It still may not be narrated as a
            // finished job, so it says exactly what is known.
            ?? "The machine that runs coding tasks answered. Ask it for the task's status before you"
              + " say anything about the work.",
        );
      }
      return createStringResult("The coding task did not go ahead.");
    },
    // A throw -- unparseable arguments, an execution timeout -- still produces a row, and its args
    // carry the marker with nothing after it. Without that the row would serialize to `{}`, the
    // console would find no verb, and its fallback sentence is "Started a coding task": a tool that
    // never ran drawing work that never happened, on the one screen this item exists for.
    serializeError: (error: unknown) => wrap(new SendFinalSummaryToolCall({
      args: new SendFinalSummaryArgs({ finalSummary: CODE_TASK_FAILED_PREFIX }),
      result: new SendFinalSummaryResult({
        result: { case: "error", value: new SendFinalSummaryError({ error: errorMessage(error) }) },
      }),
    })),
  });
}

/** The routes the tool uses, exported so a test can prove it never invents a sixth one. */
export const CODE_TASK_ROUTES = Object.freeze([
  CODE_START_ROUTE, CODE_STATUS_ROUTE, CODE_STOP_ROUTE, CODE_RESULT_ROUTE, CODE_LIST_ROUTE,
] as const);
