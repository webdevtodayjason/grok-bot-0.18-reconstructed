/**
 * CODE-1. One owner for the watcher, so the tool does not have to be one.
 *
 * The tool is built per turn -- `buildTurnTools` runs on every turn of every agent -- and the watcher
 * is one object per BOX that outlives every turn, reads a file at the sand root and holds a timer.
 * Those two lifetimes must not be the same object, or a box with four busy agents ends up with four
 * timers polling the same route and four copies of the announced-ids list racing each other over one
 * file. So the watcher is made once, lazily, and handed out.
 *
 * It is lazy on purpose rather than constructed at host start: a box with no relay in front of it
 * never gets the tool at all (see relay-code-client's header), and on that box this module should
 * cost nothing -- no file read, no timer, no poll.
 */
import { getSandRootDir } from "../../host-paths.js";
import {
  type CodeRelayAnswer,
  type CodeRoute,
  type RelayCodeTarget,
  postCode,
  resolveRelayCode,
} from "./relay-code-client.js";
import { CodeTaskWatch } from "./task-watch.js";

export interface CodeSandboxRuntimeOptions {
  /**
   * One hidden bracketed sentence into that agent's own conversation. The caller supplies it because
   * this module must not know about the transcript manager: composition has the facade, and the one
   * method it needs (`resumeWithHiddenPrompt`) is reached through the same optional-method seam every
   * other extension uses.
   */
  announce(agentId: string, prompt: string): void;
  resolveRelay?(): RelayCodeTarget | undefined;
  post?(
    target: RelayCodeTarget,
    route: CodeRoute,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CodeRelayAnswer>;
  rootDir?(): string;
  log?(line: string): void;
}

let runtime: CodeTaskWatch | null = null;

/**
 * The box's one watcher. Made on first use and returned unchanged afterwards -- the options of the
 * first caller win, which is correct because every caller passes the same composition's announce.
 */
export function ensureCodeTaskWatch(options: CodeSandboxRuntimeOptions): CodeTaskWatch {
  if (runtime != null) return runtime;
  runtime = new CodeTaskWatch({
    resolveRelay: options.resolveRelay ?? (() => resolveRelayCode()),
    post: options.post ?? postCode,
    rootDir: options.rootDir ?? (() => getSandRootDir()),
    announce: options.announce,
    log: options.log ?? ((line) => { console.info(line); }),
  });
  // A host swap restarts this process mid-task, so the first thing the watcher does is read its own
  // store and pick up whatever was open when the old process went away.
  runtime.resume();
  return runtime;
}

/** The watcher if one was made, without making one. Used by the tool to register a started task. */
export const codeTaskWatch = (): CodeTaskWatch | null => runtime;

/** Host stop, and the seam the tests reset through. */
export function stopCodeTaskWatch(): void {
  runtime?.stop();
  runtime = null;
}
