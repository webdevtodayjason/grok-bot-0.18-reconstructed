// The Titan Job Bus settings file (docs/JOB-BUS.md section 10.7).
//
// The bus has its own settings file rather than a corner of sand-host-settings.json, because the
// console edits these and only these, and because `enabled` defaults to OFF: a bus that could be
// turned on by a stray environment variable is not off. The `SAND_JOB_BUS_*` names section 4 used
// are retired; nothing here reads the environment.
//
// The file is re-read on every use. That is deliberate: an operator who edits it by hand on the box
// (or a second process that writes it) must not have to restart the host, and every read here is a
// few hundred bytes off the data volume.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../../shared/node/atomic-write.js";
import { GatewayCommandError } from "../../gateway-command-error.js";

export const JOB_BUS_DIRNAME = "job-bus";
export const JOB_SETTINGS_FILENAME = "settings.json";

export interface JobBusSettings {
  readonly enabled: boolean;
  /** Job type -> the worker agent's id, or the name it is resolved from on first use. */
  readonly workers: Readonly<Record<string, string>>;
  readonly repos: readonly string[];
  readonly allowedConnectors: readonly string[];
  readonly timeoutMin: number;
  readonly queueTimeoutMin: number;
  readonly maxOpen: number;
}

/** The bootstrap defaults. `enabled` is off until the operator turns the bus on in the console. */
export const DEFAULT_JOB_BUS_SETTINGS: JobBusSettings = Object.freeze({
  enabled: false,
  workers: Object.freeze({ "nextgen.chapter": "Scribe" }),
  repos: Object.freeze(["webdevtodayjason/nextgen-training"]),
  allowedConnectors: Object.freeze(["github"]),
  timeoutMin: 120,
  queueTimeoutMin: 60,
  maxOpen: 20,
});

const SETTING_KEYS = [
  "enabled", "workers", "repos", "allowedConnectors", "timeoutMin", "queueTimeoutMin", "maxOpen",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringMap(value: unknown, fallback: Readonly<Record<string, string>>): Record<string, string> {
  const record = asRecord(value);
  if (record == null) return { ...fallback };
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" && entry.trim().length > 0) map[key] = entry.trim();
  }
  return map;
}

function readStringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function readCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** A malformed or missing file is the defaults, never a thrown command. */
export function normalizeJobBusSettings(raw: unknown): JobBusSettings {
  const record = asRecord(raw);
  if (record == null) return DEFAULT_JOB_BUS_SETTINGS;
  return {
    enabled: record.enabled === true,
    workers: readStringMap(record.workers, DEFAULT_JOB_BUS_SETTINGS.workers),
    repos: readStringList(record.repos, DEFAULT_JOB_BUS_SETTINGS.repos),
    allowedConnectors: readStringList(record.allowedConnectors, DEFAULT_JOB_BUS_SETTINGS.allowedConnectors),
    timeoutMin: readCount(record.timeoutMin, DEFAULT_JOB_BUS_SETTINGS.timeoutMin),
    queueTimeoutMin: readCount(record.queueTimeoutMin, DEFAULT_JOB_BUS_SETTINGS.queueTimeoutMin),
    maxOpen: readCount(record.maxOpen, DEFAULT_JOB_BUS_SETTINGS.maxOpen),
  };
}

export function createJobSettingsStore(rootDir: string) {
  const settingsPath = join(rootDir, JOB_BUS_DIRNAME, JOB_SETTINGS_FILENAME);

  function read(): JobBusSettings {
    try { return normalizeJobBusSettings(JSON.parse(readFileSync(settingsPath, "utf8"))); }
    catch { return DEFAULT_JOB_BUS_SETTINGS; }
  }

  /**
   * A partial write, validated field by field. An unknown key is a 400 rather than a silent drop:
   * the console is the only writer, and a typo there would otherwise look like it saved.
   */
  async function write(partial: unknown): Promise<JobBusSettings> {
    const patch = asRecord(partial);
    if (patch == null) {
      throw new GatewayCommandError(400, { error: "invalid settings", detail: "settings must be an object" });
    }
    for (const key of Object.keys(patch)) {
      if (!(SETTING_KEYS as readonly string[]).includes(key)) {
        throw new GatewayCommandError(400, { error: "invalid settings", detail: `unknown field ${key}` });
      }
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
      throw new GatewayCommandError(400, { error: "invalid settings", detail: "enabled must be a boolean" });
    }
    for (const key of ["timeoutMin", "queueTimeoutMin", "maxOpen"] as const) {
      const value = patch[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
        throw new GatewayCommandError(400, { error: "invalid settings", detail: `${key} must be a positive number` });
      }
    }
    const current = read();
    const next: JobBusSettings = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      workers: patch.workers === undefined ? current.workers : readStringMap(patch.workers, {}),
      repos: patch.repos === undefined ? current.repos : readStringList(patch.repos, []),
      allowedConnectors: patch.allowedConnectors === undefined
        ? current.allowedConnectors
        : readStringList(patch.allowedConnectors, []),
      timeoutMin: readCount(patch.timeoutMin, current.timeoutMin),
      queueTimeoutMin: readCount(patch.queueTimeoutMin, current.queueTimeoutMin),
      maxOpen: readCount(patch.maxOpen, current.maxOpen),
    };
    await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  }

  return { settingsPath, read, write };
}

export type JobSettingsStore = ReturnType<typeof createJobSettingsStore>;
