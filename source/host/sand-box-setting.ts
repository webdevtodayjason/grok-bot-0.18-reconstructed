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
let cachedSettings: { path: string; mtimeMs: number; size: number; values: Record<string, string> }
  | undefined;

function readSettingsFile(): Record<string, string> {
  const path = getSandHostSettingsPath();
  let stat: { mtimeMs: number; size: number };
  try {
    const stats = statSync(path);
    stat = { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    cachedSettings = undefined;
    return {};
  }
  if (
    cachedSettings != null
    && cachedSettings.path === path
    && cachedSettings.mtimeMs === stat.mtimeMs
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
