/**
 * CODE-1. The part that makes a long coding task not block the conversation.
 *
 * A coding task runs for minutes, sometimes half an hour. `start` therefore returns at once with an
 * id, and the agent is told when the task finishes -- NOT by a new user message, which would read to
 * the person like the bot talking to itself, but the way a hand-off resume already works: one hidden
 * bracketed sentence into the agent's own conversation, which becomes an entry it reads on its next
 * turn and may act on immediately.
 *
 * WHY FIRE AND FORGET, measured: HANDBACK-1 found that AWAITING a revived turn made the command that
 * triggered it answer 58,917 ms late, because the resume takes the session's exclusive run lane and
 * the caller sits behind it. So `announce` is called and never awaited, and a rejection is swallowed
 * -- `resumeWithHiddenPrompt` reports its own failures to the tray, which is where an operator reads
 * them. A watcher that can stall a poll loop for a minute is a watcher that stops being a watcher.
 *
 * WHY THERE IS A STORE FILE. `updateHostNow` restarts this process mid-task: the swap is the normal
 * way a box gets a new bundle, and a task started two minutes before one would otherwise be orphaned
 * (nobody polling, so the agent is never told) or announced twice (a fresh watcher re-discovers a
 * finished task it has no memory of). The file holds the open task ids and the announced task ids,
 * so the answer to both is the same two lines of bookkeeping.
 *
 * WHY IT POLLS NOTHING WHEN NOTHING IS OPEN. A timer ticking every 15 s on a box with no coding task
 * is a box paying for a feature it is not using, forever, and the relay answering /code/list to a
 * hundred idle boxes is the same bill on the other side. The timer is armed by the first open task
 * and disarmed by the last one.
 *
 * IT IS SILENT ON AN UNREACHABLE RELAY. `postCode` never throws and a failed poll is simply skipped:
 * a relay restart is a normal event (it is the LAST step of every ship), and an agent must not be
 * told a task failed because the machine in front of it was being restarted.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CODE_LIST_ROUTE,
  CODE_POLL_TIMEOUT_MS,
  type CodeRelayAnswer,
  type CodeRoute,
  type RelayCodeTarget,
  isTerminalCodeState,
} from "./relay-code-client.js";

/** 15 s, the beat the console's own rail runs at. A person does not look up faster than that. */
export const CODE_WATCH_INTERVAL_MS = 15_000;

/**
 * The ceiling on how long one task is watched, whatever the relay says about it. The relay's own
 * wall-clock limit is 30 minutes by default and the operator may raise it, so this is deliberately
 * far above any sane setting: it exists so a task the relay has FORGOTTEN (a row lost to a redeploy,
 * a container swept by hand) eventually stops being polled for, rather than keeping a timer alive on
 * a box until somebody notices. Two hours, and the drop is silent -- an agent is not told a task
 * failed on the strength of this host's own bookkeeping.
 */
export const CODE_WATCH_MAX_MS = 2 * 60 * 60 * 1000;

/** The file, under the sand root beside the other per-box host state. */
export const CODE_WATCH_FILE = "code-task-watch.json";

interface OpenTask {
  readonly taskId: string;
  readonly title: string;
  readonly startedAtMs: number;
}

interface WatchStore {
  /** agentId -> taskId -> the little we need to announce it without asking the relay twice. */
  open: Record<string, Record<string, OpenTask>>;
  /** Task ids already announced. Bounded below so this file cannot grow without end. */
  announced: string[];
}

/** How many announced ids are kept. Past this the oldest are dropped: a task id that old cannot
 * still be open, because CODE_WATCH_MAX_MS retired it hours ago. */
const ANNOUNCED_KEEP = 200;

const emptyStore = (): WatchStore => ({ open: {}, announced: [] });

export interface CodeTaskWatchDependencies {
  /** Where the relay is, re-read every tick: a relay appears and disappears across a host swap. */
  resolveRelay(): RelayCodeTarget | undefined;
  post(
    target: RelayCodeTarget,
    route: CodeRoute,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CodeRelayAnswer>;
  /** The sand root. The store file is `<root>/code-task-watch.json`. */
  rootDir(): string;
  /**
   * One hidden bracketed sentence into that agent's own conversation. CALLED AND NEVER AWAITED by
   * this module; an implementation that throws synchronously is still caught.
   */
  announce(agentId: string, prompt: string): void;
  now?(): number;
  /** Injected in tests so a tick can be driven without a real 15 s wait. */
  setInterval?(handler: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
  intervalMs?: number;
  /**
   * One line in the host log per watched, finished and woken task, on the `[sand][toolset]`
   * convention. It exists because the wake is otherwise the one step in this whole path with no
   * trace: the container is gone, the relay's row is closed, and an agent that was never told looks
   * exactly like an agent that was told and said nothing. An operator has to be able to tell those
   * two apart, and so does the gate.
   */
  log?(line: string): void;
}

/**
 * The sentence the agent reads when a task finishes.
 *
 * It is bracketed, like every other hidden resume prompt in this product, and it says the ONE thing
 * the agent must do next: read the result before saying anything about it. The outcome is in plain
 * words and the tool is never named, because this sentence is the agent's cue for what it then tells
 * the person, and a tool name in the cue is a tool name on a customer's screen one hop later.
 */
export function codeFinishedPrompt(task: {
  readonly taskId: string;
  readonly title: string;
  readonly state: string;
}): string {
  const title = task.title.trim();
  const named = title.length > 0 ? ` ("${title}")` : "";
  const outcome = task.state === "done"
    ? "has finished"
    : task.state === "timed_out"
      ? "ran out of time and was stopped"
      : task.state === "spend_cap"
        ? "reached the spending limit set for it and was stopped"
        : task.state === "stopped"
          ? "was stopped"
          : "did not finish";
  return `[The coding task you started${named} ${outcome}. Read its result now -- the summary and the`
    + ` files it wrote -- before you say anything about it, using the task id ${task.taskId}. Then`
    + " tell the person in plain words what it did and where the files are, or what went wrong if it"
    + " did not finish. Do not describe work you have not read. Remember: nothing reaches the user"
    + " unless it is inside a SendMessage.]";
}

export class CodeTaskWatch {
  private readonly deps: CodeTaskWatchDependencies;
  private readonly intervalMs: number;
  private store: WatchStore = emptyStore();
  private handle: unknown = null;
  private ticking = false;
  private stopped = false;
  private loaded = false;

  constructor(deps: CodeTaskWatchDependencies) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? CODE_WATCH_INTERVAL_MS;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Never the title, never a path: a task id and a state, which is all an operator needs. */
  private say(line: string): void {
    try { this.deps.log?.(`[sand][code] ${line}`); } catch { /* a log is never worth a throw */ }
  }

  private storePath(): string {
    return join(this.deps.rootDir(), CODE_WATCH_FILE);
  }

  /**
   * Read the store once per process. A missing or unreadable file is an empty store, never a throw:
   * this is bookkeeping about tasks, and losing it costs at most one un-announced finish, while a
   * throw here would take the watcher out on every box whose disk hiccupped.
   */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.storePath(), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return;
      const raw = parsed as Partial<WatchStore>;
      const open: WatchStore["open"] = {};
      for (const [agentId, tasks] of Object.entries(raw.open ?? {})) {
        if (typeof tasks !== "object" || tasks == null) continue;
        const kept: Record<string, OpenTask> = {};
        for (const [taskId, task] of Object.entries(tasks as Record<string, unknown>)) {
          const value = task as Partial<OpenTask> | null;
          if (value == null || typeof value !== "object") continue;
          kept[taskId] = {
            taskId,
            title: typeof value.title === "string" ? value.title : "",
            startedAtMs: typeof value.startedAtMs === "number" && Number.isFinite(value.startedAtMs)
              ? value.startedAtMs
              : this.now(),
          };
        }
        if (Object.keys(kept).length > 0) open[agentId] = kept;
      }
      this.store = {
        open,
        announced: (Array.isArray(raw.announced) ? raw.announced : [])
          .filter((id): id is string => typeof id === "string"),
      };
    } catch { /* no file yet, or one this version cannot read: start empty */ }
  }

  /** Write through a temp file and a rename, so a host killed mid-write leaves the old store, not
   * half of a new one. A failed write is swallowed for the same reason `load` swallows a failed read. */
  private save(): void {
    const path = this.storePath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.store), "utf8");
      renameSync(temp, path);
    } catch { /* bookkeeping, not the task */ }
  }

  private arm(): void {
    if (this.stopped || this.handle != null) return;
    if (Object.keys(this.store.open).length === 0) return;
    const set = this.deps.setInterval ?? ((handler, ms) => setInterval(handler, ms).unref?.());
    this.handle = set(() => { void this.tick(); }, this.intervalMs) ?? true;
  }

  private disarm(): void {
    if (this.handle == null) return;
    const clear = this.deps.clearInterval ?? ((handle: unknown) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });
    try { clear(this.handle); } catch { /* an already-dead timer is not an error */ }
    this.handle = null;
  }

  /** True while any task is open. Exported through the extension so a test can assert the beat. */
  get polling(): boolean {
    return this.handle != null;
  }

  get openCount(): number {
    return Object.values(this.store.open).reduce((sum, tasks) => sum + Object.keys(tasks).length, 0);
  }

  /**
   * Called from the tool the moment the relay says a task started, and from `resume` at host start
   * for every task the store already holds. Idempotent on the task id.
   */
  watch(agentId: string, taskId: string, title: string): void {
    if (this.stopped) return;
    const id = taskId.trim();
    const agent = agentId.trim();
    if (id.length === 0 || agent.length === 0) return;
    this.load();
    // A task already announced is never re-watched. Without this, an agent that calls `status` on a
    // finished task and gets it back in /code/list would be told again that it finished.
    if (this.store.announced.includes(id)) return;
    const tasks = this.store.open[agent] ?? {};
    if (tasks[id] != null) return;
    tasks[id] = { taskId: id, title: title.trim(), startedAtMs: this.now() };
    this.store.open[agent] = tasks;
    this.save();
    this.arm();
    this.say(`watching ${id} for ${agent}`);
  }

  /**
   * Re-arm after a host start. Reads the store and starts polling if anything was open when this
   * process (or the one before it) went away. Safe to call more than once.
   */
  resume(): void {
    if (this.stopped) return;
    this.load();
    this.arm();
  }

  /** Host stop. The timer goes; the store stays, so the next host start picks the tasks back up. */
  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  private markAnnounced(taskId: string): void {
    if (!this.store.announced.includes(taskId)) this.store.announced.push(taskId);
    if (this.store.announced.length > ANNOUNCED_KEEP) {
      this.store.announced = this.store.announced.slice(-ANNOUNCED_KEEP);
    }
  }

  private forget(agentId: string, taskId: string): void {
    const tasks = this.store.open[agentId];
    if (tasks == null) return;
    delete tasks[taskId];
    if (Object.keys(tasks).length === 0) delete this.store.open[agentId];
  }

  /**
   * One pass. Exported for the gate and the tests: a 15 s timer is no place to pin behaviour.
   *
   * Re-entrancy matters here. A poll to a slow relay can outlive its own interval, and two passes
   * announcing the same finish is exactly the double-announce the store exists to prevent, so a tick
   * that finds one already running returns immediately.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.load();
      const target = this.deps.resolveRelay();
      // No relay right now: silent, and the timer stays armed. A relay restart is the last step of
      // every ship, so "cannot reach it for twenty seconds" is a normal event on a healthy box.
      if (target == null) return;
      const cutoff = this.now() - CODE_WATCH_MAX_MS;
      let changed = false;
      for (const agentId of Object.keys(this.store.open)) {
        const mine = this.store.open[agentId];
        if (mine == null) continue;
        // Retire anything past the ceiling before asking, so a relay that has forgotten a task
        // cannot keep this box polling for it forever.
        for (const task of Object.values(mine)) {
          if (task.startedAtMs <= cutoff) { this.forget(agentId, task.taskId); changed = true; }
        }
        if (this.store.open[agentId] == null) continue;
        const answer = await this.deps.post(
          target,
          CODE_LIST_ROUTE,
          { agentId },
          CODE_POLL_TIMEOUT_MS,
        );
        if (!answer.ok) continue;
        const rows = Array.isArray(answer.body.tasks) ? answer.body.tasks : [];
        const byId = new Map<string, Record<string, unknown>>();
        for (const row of rows) {
          if (typeof row !== "object" || row == null) continue;
          const record = row as Record<string, unknown>;
          const id = typeof record.taskId === "string" ? record.taskId : "";
          if (id.length > 0) byId.set(id, record);
        }
        for (const task of Object.values(this.store.open[agentId] ?? {})) {
          const row = byId.get(task.taskId);
          // A task the relay does not list at all is left alone. It may be a /code/list the relay
          // answered from a cold cache; the ceiling above is what eventually retires it.
          if (row == null) continue;
          const state = typeof row.state === "string" ? row.state : "";
          if (!isTerminalCodeState(state)) continue;
          const title = typeof row.title === "string" && row.title.trim().length > 0
            ? row.title.trim()
            : task.title;
          this.forget(agentId, task.taskId);
          this.markAnnounced(task.taskId);
          changed = true;
          // NEVER AWAITED. See the header: awaiting a revived turn cost 58,917 ms in HANDBACK-1, and
          // the resume reports its own failures to the tray.
          this.say(`${task.taskId} is ${state}; waking ${agentId}`);
          try {
            this.deps.announce(agentId, codeFinishedPrompt({ taskId: task.taskId, title, state }));
          } catch (error) {
            // The resume path owns its own error reporting, but a wake that never happened is the one
            // failure that looks identical to a bot choosing not to mention its own work.
            this.say(`${task.taskId} could not wake ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (changed) {
        this.save();
        if (Object.keys(this.store.open).length === 0) this.disarm();
      }
    } finally {
      this.ticking = false;
    }
  }
}
