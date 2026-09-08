/**
 * CURSOR-1. Whether this box has a backend of OURS, and nothing else.
 *
 * Every background loop in the host resolved its base URL through `getConfiguredBackendUrl`, whose
 * last resort is `https://api2.cursor.sh`. That is a competitor's API, and it answers: measured
 * from inside grok-bot-local-vm on 2026-09-07, `GET https://api2.cursor.sh/` is HTTP 200 in 0.20 s
 * and `POST aiserver.v1.DashboardService/GetUserPrivacyMode` is HTTP 401. So "is a backend
 * configured" was never the right question -- a URL is always configured. The question is whether
 * the configured host is one we own.
 *
 * `getSandBackendMode` answers that and only that:
 *   - "none" when SAND_BACKEND_URL is unset, empty, unparseable, or points at a Cursor/Anysphere
 *     host. This is the normal state of every box we ship.
 *   - "ours" when it names some other host.
 *
 * Unset means "none", never Cursor. A caller that reads this instead of guessing from a URL or from
 * the presence of a credential file cannot be tricked into dialling out: `deploy/r750/install.sh`
 * writes a placeholder credential so a copy-in does not throw, and on the boxes where that
 * placeholder was live, code asking "do we have a credential" answered yes and reached for a
 * backend that refuses us.
 *
 * It reads through `readSandBoxSetting`, so the container env wins and `sand-host-settings.json` is
 * the fallback. That matters under BOX-6: `docker restart` re-reads the bundle but not the
 * environment, so a compose change would need a container recreate, which BOX-6 forbids on a live
 * instance. A settings-file write plus a relay restart moves a running box instead.
 */
import { readSandBoxSetting } from "../../host/sand-box-setting.js";

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_BACKEND_URL_SETTING = "SAND_BACKEND_URL";

export type SandBackendMode = "none" | "ours";

/**
 * Thrown instead of dialling a backend we do not own. Callers fail fast and locally rather than
 * spending a request timeout on a host that will answer 401.
 */
export class SandBackendDisabledError extends Error {
  constructor(what: string) {
    super(`${what} is off on this box: no backend of ours is configured.`);
    this.name = "SandBackendDisabledError";
  }
}

/**
 * Hosts that are somebody else's product. A box pointed at one of these is in mode "none" however
 * explicitly it was pointed there, because the compose files we shipped set
 * SAND_BACKEND_URL=https://api2.cursor.sh/ on every box -- so "the operator set it deliberately"
 * cannot be inferred from the value being present.
 */
export const FOREIGN_BACKEND_HOSTS = ["cursor.sh", "cursor.com", "anysphere.co", "anysphere.dev"] as const;

export function isForeignBackendHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return FOREIGN_BACKEND_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Exported for the unit tests, which must be able to judge a URL without touching the environment. */
export function getSandBackendModeForUrl(raw: string | undefined): SandBackendMode {
  const trimmed = raw?.trim();
  if (trimmed == null || trimmed.length === 0) return "none";
  let hostname: string;
  try { hostname = new URL(trimmed).hostname; }
  catch { return "none"; }
  if (hostname.length === 0) return "none";
  return isForeignBackendHost(hostname) ? "none" : "ours";
}

export function getSandBackendMode(read: (name: string) => string | undefined = readSandBoxSetting): SandBackendMode {
  return getSandBackendModeForUrl(read(SAND_BACKEND_URL_SETTING));
}

export function isSandBackendOurs(read: (name: string) => string | undefined = readSandBoxSetting): boolean {
  return getSandBackendMode(read) === "ours";
}

/**
 * The one telemetry test, shared so every exporter answers the same way. SAND_DISABLE_TELEMETRY
 * was already honoured in four places and ignored in a fifth (the OTLP tracer was constructed
 * before the check ran); backend mode is the second half, because an exporter pointed at a host
 * that refuses us is not telemetry, it is a retry loop with a log line in it.
 */
export function isSandTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAND_DISABLE_TELEMETRY !== "1" && getSandBackendMode() === "ours";
}
