import { createHash } from "node:crypto";

import { readSandBoxSetting } from "../../host/sand-box-setting.js";

export const DEFAULT_CURSOR_BACKEND_URL = "https://api2.cursor.sh";
export const PROD_AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const DEV_AUTH_CLIENT_ID = "OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE";
export const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

export interface JwtPayload { readonly email?: string; readonly exp?: number; readonly sub?: string; readonly [key: string]: unknown; }

export function parseJwtPayload(token: string): JwtPayload | null {
  const [, payload] = token.split(".");
  if (payload == null || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.email !== undefined && typeof record.email !== "string") return null;
    if (record.exp !== undefined && typeof record.exp !== "number") return null;
    if (record.sub !== undefined && typeof record.sub !== "string") return null;
    return record as JwtPayload;
  } catch { return null; }
}

export function accountCacheScope(accessToken: string): string {
  return createHash("sha256").update(parseJwtPayload(accessToken)?.sub ?? accessToken).digest("hex");
}

export function isTokenExpiringSoon(token: string, now = Date.now()): boolean {
  const payload = parseJwtPayload(token);
  return payload?.exp == null || payload.exp * 1_000 - now < TOKEN_REFRESH_LEEWAY_MS;
}

export function getAccessTokenExpiryMs(token: string): number | null {
  const exp = parseJwtPayload(token)?.exp;
  return exp == null || !Number.isFinite(exp) ? null : exp * 1_000;
}

/**
 * CURSOR-4. The URL every backend client dials, and until now it was read from the environment
 * only. `getSandBackendMode` reads the same name through `readSandBoxSetting`, which falls back to
 * sand-host-settings.json, so the two disagreed: an operator could point a running box at their own
 * backend in the file, the box would answer "ours" to the mode question, and every client would
 * still dial the last-resort constant. The file is now the same fallback here.
 *
 * An empty value is ignored rather than parsed, because `new URL("")` throws and a switch nobody
 * filled in must never be able to take a box down.
 */
export function getConfiguredBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const named = (value: string | undefined) => (value != null && value.trim().length > 0 ? value.trim() : undefined);
  const configured = named(env.SAND_BACKEND_URL) ?? named(env.CURSOR_API_BASE_URL) ?? named(readSandBoxSetting("SAND_BACKEND_URL"));
  try { return new URL(configured ?? DEFAULT_CURSOR_BACKEND_URL).toString(); }
  catch { return new URL(DEFAULT_CURSOR_BACKEND_URL).toString(); }
}

export function getAuthClientId(backendUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_AUTH_CLIENT_ID;
  if (configured != null && configured.length > 0) return configured;
  const hostname = new URL(backendUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".lclhst.build") || hostname === "dev-staging.cursor.sh" ? DEV_AUTH_CLIENT_ID : PROD_AUTH_CLIENT_ID;
}

export function isDevAuthBackend(backendUrl: string): boolean { return getAuthClientId(backendUrl) !== PROD_AUTH_CLIENT_ID; }
export function shouldRefreshAccessToken(backendUrl: string, accessToken: string): boolean { return isTokenExpiringSoon(accessToken) || isDevAuthBackend(backendUrl); }
