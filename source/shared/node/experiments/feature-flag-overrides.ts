import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { errorLogTag } from "../../errors.js";
import { FLAGS, type FeatureFlagName } from "./experiment-config.gen.js";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.js";
export const FEATURE_FLAG_OVERRIDES_FILENAME = "sand-feature-flag-overrides.json";
export function isFlagName(name: string): name is FeatureFlagName { return Object.hasOwn(FLAGS, name); }
/**
 * CURSOR-1. Entries no longer expire.
 *
 * They used to carry a 24 hour TTL, and the read dropped anything past it. Measured on
 * grok-bot-local-vm 2026-09-07: this file held
 * `{"sand_teach_by_demonstration":{"value":true,"expiresAtMs":1788238328389}}`, which lapsed on
 * 2026-09-01 at 04:52 UTC. A gate somebody had deliberately pinned on turned itself off with the
 * clock, silently, and the feature only still ran because SAND_TEACH=1 was separately in
 * sand-host-settings.json. A pin is a decision, not an experiment with a shelf life.
 *
 * `expiresAtMs` is still tolerated on read so an existing file loads, and simply ignored.
 */
interface Entry { value: boolean; }
export class SandFeatureFlagOverrideStore {
  private readonly overrides = new Map<FeatureFlagName, Entry>();
  constructor(private readonly getCacheDir: () => string) {}
  getOverridesPath(): string { return join(this.getCacheDir(), FEATURE_FLAG_OVERRIDES_FILENAME); }
  hydrateFromDisk(): void { try { const path = this.getOverridesPath(); if (!existsSync(path)) return; const parsed = JSON.parse(readFileSync(path, "utf8")) as { overrides?: unknown }; if (typeof parsed.overrides !== "object" || parsed.overrides == null) return; for (const [name, raw] of Object.entries(parsed.overrides)) { if (!isFlagName(name) || typeof raw !== "object" || raw == null) continue; const entry = raw as Record<string, unknown>; if (typeof entry.value !== "boolean") continue; this.overrides.set(name, { value: entry.value }); } } catch (error) { reportExperimentsDiagnostic({ kind: "overrides_load_failed", errorClass: errorLogTag(error) }); } }
  async persist(): Promise<void> { try { const path = this.getOverridesPath(); await mkdir(dirname(path), { recursive: true }); const overrides: Record<string, Entry> = {}; for (const [name, entry] of this.overrides) overrides[name] = entry; const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify({ overrides }), "utf8"); await rename(temp, path); } catch (error) { reportExperimentsDiagnostic({ kind: "overrides_persist_failed", errorClass: errorLogTag(error) }); } }
  read(name: FeatureFlagName): boolean | undefined { return this.overrides.get(name)?.value; }
  activeOverrides(): Map<FeatureFlagName, boolean> { const result = new Map<FeatureFlagName, boolean>(); for (const [name, entry] of this.overrides) result.set(name, entry.value); return result; }
  activeRecord(): Partial<Record<FeatureFlagName, boolean>> { return Object.fromEntries(this.activeOverrides()) as Partial<Record<FeatureFlagName, boolean>>; }
  get size(): number { return this.overrides.size; }
  set(name: string, value: boolean): boolean { if (!isFlagName(name)) return false; this.overrides.set(name, { value }); return true; }
  clear(name: FeatureFlagName): boolean { return this.overrides.delete(name); }
  clearAll(): void { this.overrides.clear(); }
  setAllToBundledDefaults(): void { for (const name of Object.keys(FLAGS)) if (isFlagName(name)) this.overrides.set(name, { value: FLAGS[name]?.default ?? false }); }
  replaceAll(overrides: Readonly<Record<string, boolean>>): void { this.overrides.clear(); for (const [name, value] of Object.entries(overrides)) if (typeof value === "boolean" && isFlagName(name)) this.overrides.set(name, { value }); }
}
