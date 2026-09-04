import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSandRootDir } from "./host-paths.js";

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
 * their own machine -- and a withhold nobody can force is a withhold nobody can verify. Written to
 * the host settings file it pins either world on a running box: "0" withholds the five whatever the
 * bridge says, "1" offers them whatever the bridge says. "1" with no daemon attached restores the
 * behaviour this change removed (each call blocks until the response watchdog gives up), so it is
 * for a gate pinning the connected leg, not for daily operation. Unset, which is the normal state,
 * means the bridge decides.
 */
export function resolveLocalMachineOffered(
  envOverride: string | undefined,
  hasAnnouncedComputer: () => boolean,
): boolean {
  if (envOverride != null && envOverride.length > 0) return isSandOverrideTruthy(envOverride);
  return hasAnnouncedComputer();
}

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_LOCAL_MACHINE_SETTING = "SAND_LOCAL_MACHINE";

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
