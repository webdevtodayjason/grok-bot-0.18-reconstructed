import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSandRootDir } from "./host-paths.js";
import { SAND_DEFAULT_MAX_AGENTS, SAND_MAX_AGENTS_SETTING } from "../shared/agents/agents.js";

/**
 * Host-side switches an operator has to be able to flip on a *running* box.
 *
 * `process.env` is fixed when the container is created: `docker restart` re-reads the bundle but
 * not the environment, so an env-only override means "recreate the box to try this". The endpoint
 * pin (`SAND_OPENAI_COMPATIBLE_*`) solved that by re-reading `box-secrets.json` per call, but
 * these switches must NOT follow it there. `SAND_` is a reserved box-secret prefix
 * (shared/box-secrets.ts `RESERVED_BOX_SECRET_PREFIXES`), and `BoxSecretsApplier.applyPersisted`
 * bails out silently when the persisted file holds any reserved key -- so parking a switch in
 * that file would stop every real box secret from ever being injected, and the next
 * `setBoxSecrets` (which rewrites the whole file) would wipe the switch back out again.
 *
 * So they live in their own host-owned file next to the rest of the sand data. Nothing else
 * reads or rewrites it, the environment still wins when it is set, and the shape is either a
 * flat `{ "NAME": "value" }` object or `{ "settings": { ... } }`.
 */
export const SAND_HOST_SETTINGS_FILENAME = "sand-host-settings.json";

export function getSandHostSettingsPath(): string {
  return join(getSandRootDir(), SAND_HOST_SETTINGS_FILENAME);
}

/**
 * `readSandBoxSetting` is called from `buildTurnTools` on every tool build and from the prompt
 * assembly on every render, so the parse is cached against the file's mtime and size. The file
 * is small and rewritten wholesale, so a stat per call is the cheap half of the read.
 */
// The key is the nanosecond mtime, not the millisecond one: flipping "1" to "0" keeps the size,
// and two such writes inside one millisecond would otherwise read stale on a security switch.
let cachedSettings: { path: string; mtime: string; size: number; values: Record<string, string> }
  | undefined;

function readSettingsFile(): Record<string, string> {
  const path = getSandHostSettingsPath();
  let stat: { mtime: string; size: number };
  try {
    const stats = statSync(path, { bigint: true });
    stat = { mtime: stats.mtimeNs.toString(), size: Number(stats.size) };
  } catch {
    cachedSettings = undefined;
    return {};
  }
  if (
    cachedSettings != null
    && cachedSettings.path === path
    && cachedSettings.mtime === stat.mtime
    && cachedSettings.size === stat.size
  ) return cachedSettings.values;
  const values: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const nested = record.settings;
      const source = typeof nested === "object" && nested != null && !Array.isArray(nested)
        ? nested as Record<string, unknown>
        : record;
      for (const [name, value] of Object.entries(source)) {
        if (typeof value === "string") values[name] = value;
      }
    }
  } catch { /* an unreadable or half-written file means "no overrides", never a thrown turn */ }
  cachedSettings = { path, ...stat, values };
  return values;
}

export function readSandBoxSetting(name: string): string | undefined {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;
  const value = readSettingsFile()[name]?.trim();
  return value != null && value.length > 0 ? value : undefined;
}

/** The `resolveMultitaskEnabled` truth test, shared so one wording governs every switch. */
export function isSandOverrideTruthy(value: string | undefined): boolean {
  return value != null && value.length > 0 && value !== "0" && value.toLowerCase() !== "false";
}

export function isSandBoxSettingEnabled(name: string): boolean {
  return isSandOverrideTruthy(readSandBoxSetting(name));
}

/**
 * Every value in the file is a string, so a switch that carries a number needs its own reader.
 * Anything that is not a whole number at or above `min` is treated as "no override", because a
 * typo in the settings file must not be able to lower a ceiling to zero and lock a box out.
 */
export function readSandBoxSettingNumber(
  name: string,
  options: { readonly min?: number; readonly max?: number } = {},
): number | undefined {
  const raw = readSandBoxSetting(name);
  if (raw == null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return undefined;
  if (parsed < (options.min ?? 1)) return undefined;
  if (options.max != null && parsed > options.max) return undefined;
  return parsed;
}

/**
 * AGENTS-CAP-2. How many bots one box holds. The default is SAND_DEFAULT_MAX_AGENTS, and an
 * operator moves it with the SAND_MAX_AGENTS setting; this comment used to name a number, and
 * the number went stale the day the default changed. Read per call like every other switch, so
 * a live box can be moved without a recreate, which is what lets the super admin raise a
 * workspace from its row in the admin console, and named nowhere else -- the standing persona
 * section reads it here rather than repeating it.
 *
 * It fails OPEN on purpose and that has a consequence worth naming where the reader is: anything
 * outside 1..1000, and anything that is not a string in the settings file, is ignored in silence
 * and the box drops to the default. So the range is checked BEFORE the write, by whatever offers
 * the control, or a workspace set to 5000 quietly runs at the default with nothing saying why.
 */
export function resolveSandMaxAgents(): number {
  return readSandBoxSettingNumber(SAND_MAX_AGENTS_SETTING, { min: 1, max: 1_000 })
    ?? SAND_DEFAULT_MAX_AGENTS;
}

/**
 * The name an operator writes into sand-host-settings.json (or the container env).
 */
export const SAND_TURN_TOOL_BUDGET_SETTING = "SAND_TURN_TOOL_BUDGET";

/** The standing per-turn tool-call ceiling when SAND_TURN_TOOL_BUDGET is unset or out of range. */
export const SAND_TURN_TOOL_BUDGET_DEFAULT = 150;

/**
 * The ceiling on how many tool calls one turn may make before the host refuses the rest. This is
 * per turn, not per agent, not per skill, and every agent (subagents included) gets the same box:
 * a subagent turn is its own turn with its own counter. SendMessage is the one tool it never
 * counts: a turn told to stop and write its answer has to be able to deliver it, and the send cap
 * bounds that tool already. The research skill asks the
 * model for a budget in prose and the model ignores it, so a hard per-turn cap is the only thing
 * that actually bounds a long turn. The default is SAND_TURN_TOOL_BUDGET_DEFAULT, and an operator
 * moves it with the SAND_TURN_TOOL_BUDGET setting; read per tool build like every other switch, so
 * a live box can be re-bounded without a recreate.
 *
 * It fails CLOSED to the default here on purpose -- unlike resolveSandMaxAgents, which fails OPEN.
 * A research turn with no cap at all ran for an hour, so the safe default when the setting is unset
 * or out of range is the standing one, not "no limit". Anything outside 1..100000, and anything
 * that is not a whole number in the settings file, is ignored in silence and the turn drops to the
 * default. A value of 0 is that ignored case and means the default, never an open box, so a stray
 * "0" in the file cannot turn the cap back off.
 */
export function resolveTurnToolBudget(): number {
  return readSandBoxSettingNumber(SAND_TURN_TOOL_BUDGET_SETTING, { min: 1, max: 100_000 })
    ?? SAND_TURN_TOOL_BUDGET_DEFAULT;
}

/**
 * SUB-1 / TOOLS-03. The browserUse subagent -- and with it the fifteen `browser_*` tools -- sat
 * behind a bare Statsig gate that this deployment can never turn on, so the subagent was
 * unreachable by construction. Same shape as `resolveMultitaskEnabled`: an explicit local
 * override wins, otherwise the gate decides.
 */
export function resolveBrowserUseEnabled(
  envOverride: string | undefined,
  checkStatsigGate: () => boolean,
): boolean {
  if (envOverride != null && envOverride.length > 0) return isSandOverrideTruthy(envOverride);
  return checkStatsigGate();
}

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_BROWSER_USE_SETTING = "SAND_BROWSER_USE";

/**
 * BROWSER-1. Titan's own four browser tools (browser_open, browser_click, browser_type,
 * browser_screenshot), offered to the main agent rather than only to a subagent. Unlike the four
 * switches above there is no Statsig gate behind this one -- nothing upstream ever shipped these
 * tools -- so the default is ON and the setting can only take them away. An operator who wants
 * Titan out of the browser writes "0" here and the next tool build stops offering them, with no
 * recreate; the browserUse subagent and its fifteen page-level tools are a separate switch
 * (SAND_BROWSER_USE) and are not affected either way.
 */
export function resolveBrowserToolsEnabled(envOverride: string | undefined): boolean {
  return envOverride != null && envOverride.length > 0 ? isSandOverrideTruthy(envOverride) : true;
}

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_BROWSER_TOOLS_SETTING = "SAND_BROWSER_TOOLS";

/**
 * Teach by demonstration sat behind a bare Statsig gate too, so on a box with no Cursor
 * login the recorder refused every start and the whole feature was unreachable. Same shape as
 * `resolveBrowserUseEnabled`: an explicit local override wins, otherwise the gate decides.
 */
export function resolveTeachEnabled(
  envOverride: string | undefined,
  checkStatsigGate: () => boolean,
): boolean {
  if (envOverride != null && envOverride.length > 0) return isSandOverrideTruthy(envOverride);
  return checkStatsigGate();
}

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_TEACH_SETTING = "SAND_TEACH";

/**
 * MEMORY-1. Memory synthesis is armed exactly once, from `sand_memory_dreaming`, at an
 * authenticated Statsig bootstrap. That bootstrap never happens without a Cursor login, so the
 * listener never fired here: no turn was ever recorded as evidence and no agent has ever written a
 * memory file. Same shape as `resolveTeachEnabled`: an explicit local override wins, otherwise
 * the gate decides.
 */
export function resolveMemoryDreamingEnabled(
  envOverride: string | undefined,
  checkStatsigGate: () => boolean,
): boolean {
  if (envOverride != null && envOverride.length > 0) return isSandOverrideTruthy(envOverride);
  return checkStatsigGate();
}

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_MEMORY_DREAMING_SETTING = "SAND_MEMORY_DREAMING";

/**
 * REVIEW-1. Auto-review escalates past shadow only when `sand_auto_review` is on, and that gate
 * cannot bootstrap without a Cursor login, so every review on this box was advisory: the tool call
 * went ahead whatever the classifier said. Same shape as `resolveTeachEnabled`: an explicit local
 * override wins, otherwise the gate decides.
 */
export function resolveAutoReviewEnforceEnabled(
  envOverride: string | undefined,
  checkStatsigGate: () => boolean,
): boolean {
  if (envOverride != null && envOverride.length > 0) return isSandOverrideTruthy(envOverride);
  return checkStatsigGate();
}

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_AUTO_REVIEW_SETTING = "SAND_AUTO_REVIEW";

/**
 * The per-surface mode override. It used to be read once from `process.env` when the extension
 * started, which on a running container means "recreate the box to change your mind"; read through
 * `readSandBoxSetting` it is resolved per turn, so an operator can move a live box between off,
 * shadow and enforce. The environment still wins where it is set, so nothing that already exports
 * SAND_AUTO_REVIEW_MODE changes behaviour.
 */
export const SAND_AUTO_REVIEW_MODE_SETTING = "SAND_AUTO_REVIEW_MODE";

/**
 * Gated turn tracing, off unless the operator asks for it. Turns on two things: one host-log
 * line per tool build naming every tool the model was offered (`buildTurnTools` is the only
 * place that knows), and a per-agent report of which sections the assembled system prompt
 * carries. Until this existed both could only be read off the wire with a temporary tap in the
 * inference client (docs/audit-wave3-wire.md).
 */
export const SAND_TOOL_TRACE_SETTING = "SAND_TOOL_TRACE";

/**
 * GC-1. The maintenance switches read `env`; on a running box only the host settings file can
 * change, so an env view with the file's values layered over process.env lets the existing
 * is*Enabled(env) helpers flip without a recreate. Only the named keys are consulted.
 */
export function envWithSandBoxSettings(names: readonly string[], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const layered: NodeJS.ProcessEnv = { ...env };
  for (const name of names) { const value = readSandBoxSetting(name); if (value !== undefined) layered[name] = value; }
  return layered;
}
export const SAND_MAINTENANCE_SETTINGS = ["SAND_STALE_ROOT_GC", "SAND_RETIRE_LEGACY_STORE_BLOBS", "SAND_CONVERSATION_GC"] as const;

/**
 * TOOLS-15. Whether the five host-machine tools (ExternalShell, ExternalRead, AwaitExternalShell,
 * CopyToBox, CopyFromBox) are offered. They all travel the local-exec bridge, so the honest answer
 * is the bridge's own: is a computer announced on it right now. This override exists because that
 * answer cannot be staged -- it is a live 30 s liveness window fed by a daemon the operator runs on
 * their own machine -- and a withhold nobody can force is a withhold nobody can verify.
 *
 * TOOLS-18. The pin can only ever WITHHOLD. It used to be read first and answered on its own, so
 * `SAND_LOCAL_MACHINE=1` offered the five whatever the bridge said -- including on a box with no
 * daemon at all, which is exactly the world TOOLS-15 exists to stop: five tools that block until
 * the response watchdog gives up, plus the prompt paragraphs teaching the model to reach for them.
 * The bridge is now asked on every resolution and the pin is an AND over its answer: "0" withholds
 * the five whatever the bridge says, "1" honours them only while a daemon is answering, and unset
 * (the normal state) is the bridge alone. So the connected world cannot be pinned into existence on
 * a box with nothing on the far end -- a gate that wants it has to attach a daemon.
 */
export function resolveLocalMachineOffered(
  envOverride: string | undefined,
  hasAnnouncedComputer: () => boolean,
): boolean {
  const announced = hasAnnouncedComputer();
  if (envOverride != null && envOverride.length > 0) return announced && isSandOverrideTruthy(envOverride);
  return announced;
}

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_LOCAL_MACHINE_SETTING = "SAND_LOCAL_MACHINE";

/** Whether the five host-machine tools are offered this turn, and what decided it. */
export interface LocalMachineAnswer {
  readonly connected: boolean;
  /** "setting" when a pin is in force (it is an AND over the bridge), "bridge" when it alone decides. */
  readonly source: "bridge" | "setting";
}

/**
 * TOOLS-18. One read per turn, shared. The toolset builder and the system-prompt assembly each
 * asked the bridge for themselves, and the bridge's answer is a 30 s liveness window: a heartbeat
 * that lapsed between the two reads sent a prompt teaching ExternalShell, ExternalRead and the
 * CopyToBox/CopyFromBox pair on a wire that withheld all five (or the reverse -- five tools offered
 * with no paragraph explaining the two machines). The answer is now computed once and held for the
 * turn, so both halves of a turn describe the same world. `beginTurn` is called when a run shell
 * emits "started", which is why a computer that connects mid-conversation is still picked up by the
 * very next turn: the value is per turn, not per session.
 *
 * `beginTurn` takes the conversation whose run started, and only the owner's own start drops the
 * held answer. The reader belongs to one conversation, but every run in that session -- the chief
 * and each subagent it dispatches -- emits "started" through the same lifecycle seam, so an
 * unscoped boundary let a Task dispatch re-read the bridge in the middle of the parent's turn:
 * the parent's prompt stayed frozen on the pre-dispatch answer while its next tool build took a
 * fresh one, which is the split this whole mechanism exists to prevent. A subagent run therefore
 * reads the world its parent turn was built on and never resets it.
 */
export function createTurnLocalMachineReader(deps: {
  readonly readOverride: () => string | undefined;
  readonly hasAnnouncedComputer: () => boolean;
  /** The conversation this reader holds an answer for; a foreign run's start is ignored. */
  readonly ownerConversationId: string;
}): {
  readonly read: () => LocalMachineAnswer;
  readonly beginTurn: (conversationId: string) => void;
} {
  let held: LocalMachineAnswer | undefined;
  return {
    read: (): LocalMachineAnswer => {
      if (held !== undefined) return held;
      const override = deps.readOverride();
      held = {
        connected: resolveLocalMachineOffered(override, deps.hasAnnouncedComputer),
        source: override != null && override.length > 0 ? "setting" : "bridge",
      };
      return held;
    },
    beginTurn: (conversationId: string): void => {
      if (conversationId === deps.ownerConversationId) held = undefined;
    },
  };
}

/**
 * TOOLS-17. Whether a member answering in a shared room keeps the box tools alongside SendMessage.
 * The room's promise is that only SendMessage text crosses to the other members, so with this off a
 * member is offered SendMessage and nothing else; with it on the four box tools ride along as
 * private scratch space. It was read straight from `process.env`, which on a running container
 * means "recreate the box to change your mind" -- and since nothing here ever sets it, the
 * text-only half of the filter had no way to be exercised at all. Read through readSandBoxSetting
 * it is resolved per tool build, so an operator (or a gate) can move a live box between the two
 * rooms. The environment still wins where it is set. Unset means the box tools ride along.
 */
export const SAND_SHARED_ROOM_BOX_TOOLS_SETTING = "SAND_SHARED_ROOM_BOX_TOOLS";

/**
 * JEV-2. The one switch that turns the Jev judgements on. Off unless a box says otherwise, read
 * per turn like every other switch here, so turning it off in sand-host-settings.json stops the
 * next turn making a request without a recreate, a restart or a deploy. It is on only for
 * Titanium staff workspaces; no external tester box gets it.
 */
export const SAND_JEV_SETTING = "SAND_JEV";

export function isJevEnabled(): boolean {
  return isSandBoxSettingEnabled(SAND_JEV_SETTING);
}

/**
 * MEM-2. Three extra lines in the memory prompt, and one in the extraction prompt. Off unless a box
 * sets it, read per turn like every other switch here, so turning it off stops the next turn.
 * Behind a flag because it changes what every agent on a box is told, and the gate that measures
 * whether it helped has to be able to run both ways on the same box within a few minutes.
 */
export const SAND_MEMORY_PROMPT_V2_SETTING = "SAND_MEMORY_PROMPT_V2";

export function isMemoryPromptV2Enabled(): boolean {
  return isSandBoxSettingEnabled(SAND_MEMORY_PROMPT_V2_SETTING);
}
