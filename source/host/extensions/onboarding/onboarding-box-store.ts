/**
 * ONBOARD-1. The box's own settings document, reached without a SettingsService instance.
 *
 * The gateway holds a SettingsService; a turn tool does not, and threading one down through the
 * toolset factories would mean four new plumbing seams for a tool with no per-turn dependencies.
 * Both ends therefore address the same file, <sandRoot>/settings.json, through the same
 * `SandSettingsStore` -- whose writes are whole-document tmp-plus-rename, so neither end can leave
 * the other half a file.
 *
 * The store is built per call rather than cached: `getSandRootDir()` is a function of the
 * environment, and a test that repoints SAND_DATA_ROOT must be looking at its own box.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getSandRootDir } from "../../host-paths.js";
import { resolveSandMaxAgents } from "../../sand-box-setting.js";
import { createHostBoxUseProbe, type BoxUseProbe } from "./onboarding-probe.js";
import { createOnboardingService, type OnboardingRecordStore, type OnboardingService } from "./onboarding-service.js";

export function boxSettingsStore(): SandSettingsStore {
  return new SandSettingsStore(join(getSandRootDir(), "settings.json"));
}

export function boxOnboardingRecordStore(): OnboardingRecordStore {
  return {
    read: () => boxSettingsStore().getOnboarding(),
    write: (value) => boxSettingsStore().setOnboarding(value),
  };
}

/** `Intl` is the only authority on an IANA zone, and it is the one the settings service uses. */
export function isValidIanaTimeZoneName(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * A probe that answers "no bots, nothing prompted". The turn tool never needs the migration rule
 * -- it only ever writes into a record the console's first read already created -- so it is given
 * this rather than a probe that would open agent databases from inside a turn.
 */
const inertProbe: BoxUseProbe = {
  listBotIds: async () => [],
  hasPromptedConversation: async () => false,
};

/**
 * The service a turn tool uses: the box's settings file for the record, the box's settings file
 * for the time zone, and no probe.
 */
export function boxOnboardingService(): OnboardingService {
  return createOnboardingService({
    store: boxOnboardingRecordStore(),
    probe: inertProbe,
    maxAgents: resolveSandMaxAgents,
    isValidTimeZone: isValidIanaTimeZoneName,
    applyTimeZone: (zone) => boxSettingsStore().setUserTimeZone(zone),
  });
}

/**
 * Whether Titan is mid-interview on this box, which is what offers the answer-saving tool.
 *
 * `buildTurnTools` calls this on every tool build, so the answer is cached against the settings
 * file's mtime and size -- the same discipline `readSandBoxSetting` uses for the operator
 * switches, and for the same reason: a stat per call is the cheap half of a read. The key is the
 * nanosecond mtime, because closing setup flips one boolean without changing the file's length.
 *
 * The default is FALSE. A settings file that cannot be read must not hand a finished box an extra
 * tool, and on a genuinely fresh box the console's first `getOnboardingState` writes the record
 * before Titan's first turn is ever dispatched.
 */
let cachedActive: { path: string; mtime: string; size: number; value: boolean } | undefined;

export function isOnboardingActive(): boolean {
  const path = join(getSandRootDir(), "settings.json");
  let stamp: { mtime: string; size: number };
  try {
    const stats = statSync(path, { bigint: true });
    stamp = { mtime: stats.mtimeNs.toString(), size: Number(stats.size) };
  } catch {
    cachedActive = undefined;
    return false;
  }
  if (
    cachedActive != null
    && cachedActive.path === path
    && cachedActive.mtime === stamp.mtime
    && cachedActive.size === stamp.size
  ) return cachedActive.value;
  let value = false;
  try {
    const record = new SandSettingsStore(path).getOnboarding();
    value = record != null && record.done === false;
  } catch { /* an unreadable or half-written file means "not in setup", never a thrown turn */ }
  cachedActive = { path, ...stamp, value };
  return value;
}

export { createHostBoxUseProbe };
