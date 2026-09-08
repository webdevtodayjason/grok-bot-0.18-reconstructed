/**
 * CURSOR-1 / FLAGS-3. Where a feature gate's value comes from on a box we ship.
 *
 * The measured problem: on 2026-09-07 three boxes on the R750 ran ONE bundle and printed three
 * different gate tables. On the demo box `sand_auto_review` read true (bundled default: false), and
 * on that box every Shell command and browser navigation answered "Rejected: An error occured while
 * classifying this action. Please review manually." -- the upstream smart-mode classifier, an RPC
 * we cannot call. A remote rollout, evaluated for somebody else's product, decided whether a
 * customer's agent could run a command.
 *
 * Two things caused that and both are closed here:
 *   1. `SandExperimentService.start()` hydrated a StatsigClient from a cached bootstrap file on
 *      disk before any network call, so a box that once saw a Cursor login kept evaluating Cursor's
 *      rollout offline forever. That hydrate is now gated on `getSandBackendMode()`.
 *   2. Nothing local outranked the rollout. This file is that layer.
 *
 * Precedence, highest first:
 *   local pin (file)   gates.json in the sand data root -- the operator's word, no expiry
 *   override store     sand-feature-flag-overrides.json -- the dev panel's writes
 *   env                SAND_FEATURE_GATE_OVERRIDES
 *   local pin (host)   PRODUCT_GATE_PINS below -- the product's decisions, baked into the bundle
 *   statsig            a live evaluation, which on our boxes can no longer happen at all
 *   bundled default    FLAGS[name].default, Cursor's rollout position for Cursor's product
 *
 * The product's decisions sit BELOW the operator layers on purpose: a pin nobody can move is a
 * rollout with our name on it, and that is the thing being fixed. They sit ABOVE Statsig so that no
 * box can ever differ from another because of a remote flag.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FLAGS, type FeatureFlagName } from "./experiment-config.gen.js";

/** The file an operator writes, next to the rest of the sand data. */
export const GATE_PIN_FILENAME = "gates.json";

/**
 * The product's positions, shipped in the bundle so a box with no gates.json still starts on our
 * settings rather than Cursor's. Each one is a decision, and the reason is the comment.
 *
 * These are compared against the bundled defaults in docs/CURSOR-CALLS.md; where a row below
 * matches the bundled default it is still pinned, because "off because the rollout says off today"
 * and "off because we decided" are not the same guarantee.
 */
export const PRODUCT_GATE_PINS: Readonly<Partial<Record<FeatureFlagName, boolean>>> = {
  // The review classifier behind this gate is an upstream RPC we cannot call, and when the gate is
  // on and the RPC fails the agent is refused every command. REVIEW-1's local classifier stays
  // available and is reached through the SAND_AUTO_REVIEW_MODE operator setting instead.
  sand_auto_review: false,
  // BROWSER-1. Titan holds the browser himself. The web-fetch failure text tells a person to open
  // the page in their browser, which is only honest if the agent can hold one.
  sand_browser_use_subagent: true,
  // It gates a DynamicToolRegistry and tool placement for the main agent only; MCP tools already
  // reach the model without it. With 26 tools offered and local models breaking above 6 schemas, a
  // placement change is a fleet measurement, not a rollout.
  grok_bot_dynamic_tools: false,
  // Product analytics to a third party's AnalyticsService.
  sand_product_analytics: false,
  // Ships codebase snapshots off the box. Off by decision, not by a missing binary.
  sand_codebase_telemetry: false,
  codebase_telemetry_v2: false,
  codebase_telemetry_v2_git_history: false,
  codebase_telemetry_v2_agent_dot_dirs: false,
  // Forwards the action-audit ledger to the backend.
  sand_action_audit_logs: false,
  // A push bus and its poll fallback, both on the backend.
  sand_notify_bus: false,
  sand_notify_safety_poll: false,
  // CPU profiles collected for upload with the structured logs.
  sand_enable_pressure_cpu_profiler: false,
  sand_box_egress_tunnel: false,
  // Updates are ours (docs/OPERATOR-RUNBOOK.md), not an upstream idle check.
  sand_auto_update_when_idle: false,
  // Load-bearing product features. Pinned ON so a live evaluation can never turn one off.
  sand_multitask: true,
  sand_spotlight: true,
  sand_global_search: true,
  sand_computer_use_playwright: true,
};

export type GatePinOrigin = "file" | "host";
export interface GatePin { readonly value: boolean; readonly origin: GatePinOrigin }

export function getGatePinPath(dataRoot: string): string { return join(dataRoot, GATE_PIN_FILENAME); }

/**
 * `readGatePin` is called per gate read, which is per tool build and per prompt render, so the
 * parse is cached against the file's mtime and size exactly as `readSandBoxSetting` does. The key
 * is the NANOSECOND mtime: flipping true to false keeps the size, and two writes inside one
 * millisecond would otherwise read stale on a gate that governs whether commands run.
 */
let cached: { path: string; mtime: string; size: number; values: Record<string, boolean> } | undefined;

/** Exported for tests, which write the same path repeatedly inside one process. */
export function clearGatePinCacheForTests(): void { cached = undefined; }

/**
 * Liberal in what it accepts, because an operator editing JSON by hand under pressure writes
 * `"0"` as often as `false`. Anything that is neither a boolean nor a recognised word is ignored
 * rather than guessed at: a typo must not be able to arm a gate.
 */
function coerce(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "off" || value === "no") return false;
  return undefined;
}

/** Either a flat `{ "gate": true }` object or `{ "gates": { ... } }`, same as the settings file. */
export function readGatePinFile(dataRoot: string): Readonly<Record<string, boolean>> {
  const path = getGatePinPath(dataRoot);
  let stat: { mtime: string; size: number };
  try {
    const stats = statSync(path, { bigint: true });
    stat = { mtime: stats.mtimeNs.toString(), size: Number(stats.size) };
  } catch {
    cached = undefined;
    return {};
  }
  if (cached != null && cached.path === path && cached.mtime === stat.mtime && cached.size === stat.size) return cached.values;
  const values: Record<string, boolean> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const nested = record.gates;
      const table = typeof nested === "object" && nested != null && !Array.isArray(nested)
        ? nested as Record<string, unknown>
        : record;
      for (const [name, raw] of Object.entries(table)) {
        // An unknown name is dropped: the pin file is not a place to invent gates, and a
        // misspelling that silently did nothing would read as "the pin is not working".
        if (!Object.hasOwn(FLAGS, name)) continue;
        const value = coerce(raw);
        if (value !== undefined) values[name] = value;
      }
    }
  } catch { /* an unreadable or half-written file means "no pins", never a thrown turn */ }
  cached = { path, ...stat, values };
  return values;
}

/** The operator's file only. The product's own table is a separate, lower layer. */
export function readGatePin(name: string, dataRoot: string): boolean | undefined {
  return readGatePinFile(dataRoot)[name];
}

/** Both pin layers in one answer, for the gates table and for anything reporting on a box. */
export function resolveGatePin(name: string, dataRoot: string): GatePin | undefined {
  const fromFile = readGatePin(name, dataRoot);
  if (fromFile !== undefined) return { value: fromFile, origin: "file" };
  const fromHost = PRODUCT_GATE_PINS[name as FeatureFlagName];
  return fromHost === undefined ? undefined : { value: fromHost, origin: "host" };
}

/** Every gate this product has an opinion about, for the boot-time table and for the docs. */
export function pinnedGateNames(): readonly FeatureFlagName[] {
  return Object.keys(PRODUCT_GATE_PINS) as FeatureFlagName[];
}
