// ui/subscriptions.mjs -- the AI subscriptions already authenticated on this Mac, found without
// reading secrets we do not need, adopted only where the vendor's own CLI stores tokens for reuse,
// and handed to the box with honest client identification (docs/SUBSCRIPTIONS-CONTRACT.md).
//
// Runs in the relay on the Mac, never in the box: the vendor stores live in the user's home.
// Rules, in code rather than prose:
//   - Claude is asked through `claude auth status --json`; its keychain item and credentials file
//     are never opened. Gemini's credentials file is checked for existence only.
//   - Codex and MiniMax tokens are read from the stores their CLIs keep for reuse, adopted ONCE
//     (bootstrap-only: once this product holds its own refresh token the CLI's state never
//     replaces it), refreshed through the vendor's own token endpoint, and never written back.
//   - Z.AI and Kimi are keys the user pastes. Grok's CLI store is read for presence and email only.
//   - Adopted secrets live in ui/subscriptions.json (0600, gitignored); endpoints.json entries
//     carry `subscription: <id>` and no key. The scan report never contains a secret.
// ponytail: one module, no dependencies; a store abstraction can come when a second consumer does.
import { execFile } from "node:child_process";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateFile } from "./state-dir.mjs";

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The override is for tests; SAND_UI_STATE_DIR is for a tenant, whose ui/ is a release directory
// shared with every other tenant and must not be where its settings land. ui/state-dir.mjs.
// An empty value counts as unset: that is what a compose file produces for a variable declared and
// never given one, and reading it as "the empty path" writes the store to a file called "".
export const STORE_FILE = process.env.GROK_BOT_SUBSCRIPTIONS_FILE?.trim() || stateFile("subscriptions.json", HERE);
export const ORIGINATOR = "grok-bot";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // the Codex CLI's public OAuth client (OpenClaw 2.0, MIT)
const MINIMAX_CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113"; // the MiniMax CLI's public client (OpenClaw 2.0, MIT)
const NEAR_EXPIRY_MS = 10 * 60 * 1000;
const CLAUDE_CLEAR_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];

// MODELS-1. THE CURATED MODEL LIST PER PROVIDER, and what it is for.
//
// A provider's own /models is the live answer and is always preferred: ui/server.mjs's probe()
// already fetches `<baseUrl>/models` on every catalog row and returns `health.models`, and nothing
// read it until this wave. But not every provider has such a list to read -- Codex is transport
// "responses" against chatgpt.com/backend-api/codex and is never probed at all -- and a picker
// with nothing in it is worse than the free-text field it replaces. So each preset carries the
// list we ship for it, the console uses the live one where there is one, and the page says in one
// line WHICH of the two the person is looking at. Never both silently merged: "these are the
// models your provider says it has" and "this is the list we shipped" are different claims and a
// person acts on them differently.
//
// contextWindow is null where we do not know it, and null is honest. endpointEntry below writes
// this number into the box, and a WRONG one is not a cosmetic error: too small compacts the
// conversation before it needed to be, too large builds a prompt the vendor rejects on every turn.
// Before this wave endpointEntry stamped the PRESET's window on whatever model was chosen
// (measured on this Mac 2026-09-08: adopting zai with model "glm-5.3-flash" still wrote
// contextWindow 128000), which is how a guess became a number in somebody's box.
//
// vision is what the model does with an image part. Titan sends screenshots on most turns -- 41
// image parts on Jason's box's last turns -- so a text-only model is not a slower model, it is a
// box that answers 400 on the first real turn. That is PROXY-10, and it cost a day. Measured
// 2026-09-08 01:50 CDT against the Z.AI coding plan endpoint and recorded in
// deploy/coolify/proxy-config/config.yaml: glm-5.3, glm-5, glm-4.7 and glm-4.6 refuse an image
// part with code 1210; glm-5.3-flash and glm-4.6v take one and answer. null means nobody has
// asked that vendor, and the card says nothing rather than guessing.
const model = (id, label, contextWindow = null, vision = null) => ({ id, label, contextWindow, vision });

export const PROVIDERS = {
  codex: {
    name: "ChatGPT / Codex", route: "endpoint", endpointId: "sub-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex", transport: "responses", defaultModel: "gpt-5.6-sol", contextWindow: 272_000,
    posture: "The Codex CLI stores this token for reuse. Adopted once, refreshed through OpenAI's own token endpoint, never written back. Requests identify as grok-bot.",
    // Curated only, always: this transport speaks to the Codex backend, which serves no model
    // list, so probe() never asks it and there is no live answer to prefer. The model the person's
    // own Codex CLI is configured for is added to this list at scan time (codexConfiguredModel).
    models: [model("gpt-5.6-sol", "GPT-5.6 Sol", 272_000)],
  },
  minimax: {
    name: "MiniMax", route: "endpoint", endpointId: "sub-minimax",
    baseUrl: "https://api.minimax.io/v1", transport: "chat", defaultModel: "MiniMax-M3", contextWindow: 1_000_000,
    posture: "The MiniMax CLI stores this token for reuse. Adopted, refreshed through MiniMax's own token endpoint, never written back.",
    models: [model("MiniMax-M3", "MiniMax-M3", 1_000_000)],
  },
  zai: {
    name: "Z.AI GLM (coding plan)", route: "key", endpointId: "sub-zai", env: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/coding/paas/v4", transport: "chat", defaultModel: "glm-5.3", contextWindow: 128_000,
    posture: "API key from your coding plan, pasted once. No discovery: Z.AI keeps no CLI store.",
    // The six measured on 2026-09-08 01:50 CDT. Only the default's context window is a number this
    // repo has ever measured, so the other five carry null rather than a copy of it.
    models: [
      model("glm-5.3", "GLM-5.3", 128_000, false),
      model("glm-5.3-flash", "GLM-5.3 Flash", null, true),
      model("glm-5", "GLM-5", null, false),
      model("glm-4.7", "GLM-4.7", null, false),
      model("glm-4.6", "GLM-4.6", null, false),
      model("glm-4.6v", "GLM-4.6V", null, true),
    ],
  },
  alibaba: {
    name: "Alibaba Model Studio (token plan)", route: "key", endpointId: "sub-alibaba", env: "DASHSCOPE_API_KEY",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", transport: "chat", defaultModel: "qwen3.8-max", contextWindow: 128_000,
    // The five names below used to be a sentence in this string ending "type the model you want",
    // which is the free-text field MODELS-1 replaces. They are structure now, so the card can draw
    // them, and the posture says what the key is rather than reciting a catalogue.
    posture: "API key from your Model Studio token plan, pasted once. Pick the model from the list on this card.",
    models: [
      model("qwen3.8-max", "Qwen3.8 Max", 128_000),
      model("qwen3.8-flash", "Qwen3.8 Flash"),
      model("deepseek-v4-pro", "DeepSeek V4 Pro"),
      model("deepseek-v4-pro-0813", "DeepSeek V4 Pro (0813)"),
      model("deepseek-v4-flash-0731", "DeepSeek V4 Flash (0731)"),
    ],
  },
  "gemini-key": {
    name: "Gemini (API key)", route: "key", endpointId: "sub-gemini-key", env: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", transport: "chat", defaultModel: "gemini-2.5-flash", contextWindow: 1_000_000,
    posture: "An AI Studio API key through Google's OpenAI-compatible endpoint; the free tier works. Your Gemini CLI login stays untouched; that route is the runtime contract.",
    models: [model("gemini-2.5-flash", "Gemini 2.5 Flash", 1_000_000)],
  },
  "minimax-key": {
    name: "MiniMax (API key)", route: "key", endpointId: "sub-minimax-key", env: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/v1", transport: "chat", defaultModel: "MiniMax-M3", contextWindow: 1_000_000,
    posture: "A MiniMax platform API key, pasted once; the alternative to a MiniMax CLI login.",
    models: [model("MiniMax-M3", "MiniMax-M3", 1_000_000)],
  },
  claude: {
    name: "Claude subscription", route: "runtime",
    posture: "Runs your Claude CLI as the agent with box tools over MCP; that is the second contract. Its token is never read.",
  },
  gemini: {
    name: "Gemini subscription", route: "runtime",
    posture: "Runs your Gemini CLI as the agent; second contract. Its credentials file is only checked for existence.",
  },
  grok: {
    name: "Grok CLI", route: "none",
    posture: "A SuperGrok plan has no API and the CLI's chat proxy demands the CLI's own identification. Use an xAI key, already an endpoint here.",
  },
};

const run = (cmd, args, env) => new Promise((resolve) => {
  execFile(cmd, args, { env, timeout: 4_000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)));
});
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const jwtClaims = (token) => {
  try {
    const part = String(token).split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
};
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

// --- the store: adopted secrets, 0600, gitignored ---------------------------------------------
export async function readStore() {
  try { return JSON.parse(await fs.readFile(STORE_FILE, "utf8")); } catch { return {}; }
}
export async function writeStore(store) {
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  // Owned like the directory, for the same reason server.mjs's ownLikeParent gives: the relay is root.
  try { const parent = await fs.stat(path.dirname(STORE_FILE)); await fs.chown(tmp, parent.uid, parent.gid); } catch {}
  await fs.rename(tmp, STORE_FILE);
}
/** Every secret string the store holds, for the leak gate. Never printed by anything else. */
export async function storedSecrets() {
  const store = await readStore();
  const out = [];
  for (const entry of Object.values(store)) for (const key of ["apiKey", "access", "refresh"]) if (typeof entry?.[key] === "string" && entry[key].length >= 16) out.push(entry[key]);
  return out;
}

// --- discovery, per provider: presence, identity, expiry; no secret leaves this module ----------
function scanCodex(env) {
  const home = env.CODEX_HOME?.trim() || path.join(HOME, ".codex");
  const file = path.join(home, "auth.json");
  const auth = readJson(file);
  const tokens = auth?.tokens ?? null;
  if (!tokens?.access_token) return { present: existsSync(file), usable: false, source: file, identity: null, expiresAt: null };
  const claims = jwtClaims(tokens.access_token) ?? {};
  const profile = claims["https://api.openai.com/profile"] ?? {};
  const authClaims = claims["https://api.openai.com/auth"] ?? {};
  const expiresAt = typeof claims.exp === "number" ? claims.exp * 1000 : null;
  return {
    present: true,
    usable: (expiresAt != null && expiresAt > Date.now()) || typeof tokens.refresh_token === "string",
    source: file,
    identity: [profile.email, authClaims.chatgpt_plan_type ? `${authClaims.chatgpt_plan_type} plan` : null].filter(Boolean).join(" · ") || null,
    accountId: tokens.account_id ?? authClaims.chatgpt_account_id ?? null,
    expiresAt: iso(expiresAt),
  };
}
function scanMiniMax() {
  const file = path.join(HOME, ".minimax", "oauth_creds.json");
  const creds = readJson(file);
  const ok = typeof creds?.access_token === "string" && typeof creds?.refresh_token === "string" && Number.isFinite(creds?.expiry_date);
  return { present: existsSync(file), usable: ok, source: file, identity: null, expiresAt: ok ? iso(Number(creds.expiry_date)) : null };
}
async function scanClaude(env) {
  const scrubbed = { ...env };
  for (const name of CLAUDE_CLEAR_ENV) delete scrubbed[name];
  const out = await run("claude", ["auth", "status", "--json"], scrubbed);
  let status = null;
  try { status = out == null ? null : JSON.parse(out); } catch { status = null; }
  const loggedIn = status?.loggedIn === true;
  return {
    present: out != null, usable: loggedIn, source: "claude auth status --json",
    identity: loggedIn ? [status.email, status.subscriptionType ? `${status.subscriptionType} plan` : null].filter(Boolean).join(" · ") || null : null,
    expiresAt: null,
  };
}
async function scanGemini() {
  const file = path.join(HOME, ".gemini", "oauth_creds.json");
  const cli = await run("which", ["gemini"]);
  return { present: existsSync(file), usable: existsSync(file) && cli != null, source: `${file} (existence only)`, identity: null, expiresAt: null };
}
function scanKey(id, env, store) {
  const spec = PROVIDERS[id];
  const fromEnv = typeof env[spec.env] === "string" && env[spec.env].trim().length > 0;
  const fromStore = typeof store[id]?.apiKey === "string" && store[id].apiKey.length > 0;
  const extra = {};
  return { present: fromEnv || fromStore || extra.present === true, usable: fromEnv || fromStore, source: fromStore ? "pasted key" : fromEnv ? `$${spec.env}` : extra.source ?? "none", identity: null, expiresAt: extra.expiresAt ?? null, ...(extra.note ? { note: extra.note } : {}) };
}
function scanKimiCode(env) {
  const home = env.KIMI_CODE_HOME?.trim() || path.join(HOME, ".kimi-code");
  const file = path.join(home, "credentials", "kimi-code.json");
  const creds = readJson(file);
  if (creds == null) return { present: false };
  const expiresAt = Number.isFinite(creds.expires_at) ? Number(creds.expires_at) * 1000 : null;
  return { present: true, source: `${file} (presence only)`, expiresAt: iso(expiresAt), note: expiresAt != null && expiresAt < Date.now() ? "Kimi Code CLI token expired; run kimi to refresh. Not used here." : "Kimi Code CLI signed in. Its token is not used here; paste your API key." };
}
function scanGrok(env) {
  const home = env.GROK_HOME?.trim() || path.join(HOME, ".grok");
  const file = path.join(home, "auth.json");
  const auth = readJson(file);
  if (auth == null || typeof auth !== "object") return { present: existsSync(file), usable: false, source: file, identity: null, expiresAt: null };
  const key = Object.keys(auth).find((k) => k === "https://auth.x.ai" || k.startsWith("https://auth.x.ai::")) ?? Object.keys(auth)[0];
  const entry = key ? auth[key] : null;
  const expiresAt = entry?.expires_at ? Date.parse(entry.expires_at) : NaN;
  return { present: true, usable: false, source: `${file} (presence and email only)`, identity: entry?.email ?? null, expiresAt: iso(expiresAt) };
}

// The curated list for one provider, plus the model the person's own Codex CLI is configured for.
// That last part is the only place a curated list is not a constant, and it is worth the exception:
// a Codex card that cannot offer the model the CLI beside it is set to is a picker that argues with
// the machine it is reading.
function curatedModels(id, env = process.env) {
  const rows = (PROVIDERS[id]?.models ?? []).map((row) => ({ ...row }));
  if (id !== "codex") return rows;
  const configured = codexConfiguredModel(env);
  if (!configured || rows.some((row) => row.id === configured)) return rows;
  return [...rows, { id: configured, label: `${configured} (your Codex CLI is set to this)`, contextWindow: null, vision: null }];
}

// The model the stored catalog row for this provider currently carries, or "" when there is none.
// Read from the catalog the caller already had rather than from the store, because the catalog row
// is what POST /endpoints/use actually points the box at.
function chosenOf(id, catalog) {
  const endpointId = PROVIDERS[id]?.endpointId ?? null;
  if (endpointId == null) return "";
  const row = (catalog?.endpoints ?? []).find((entry) => entry?.id === endpointId);
  return typeof row?.model === "string" ? row.model : "";
}

/** The scan: presence, identity, expiry per provider. No secret appears in the result. */
export async function scanSubscriptions(env = process.env, catalog = null) {
  const store = await readStore();
  const adoptedIds = new Set(Object.keys(store));
  const endpointIds = new Set((catalog?.endpoints ?? []).map((e) => e.id));
  const rows = await Promise.all(Object.entries(PROVIDERS).map(async ([id, spec]) => {
    const found = id === "codex" ? scanCodex(env)
      : id === "minimax" ? scanMiniMax()
      : id === "claude" ? await scanClaude(env)
      : id === "gemini" ? await scanGemini()
      : id === "grok" ? scanGrok(env)
      : scanKey(id, env, store);
    const { accountId: _hidden, ...visible } = found;
    return {
      id, name: spec.name, route: spec.route, posture: spec.posture, ...visible,
      adopted: adoptedIds.has(id), endpointId: spec.endpointId ?? null, endpointReady: spec.endpointId != null && endpointIds.has(spec.endpointId),
      ...(spec.defaultModel ? { defaultModel: spec.defaultModel } : {}),
      // MODELS-1. The list we ship for this provider, so the console can draw a picker for a
      // provider whose own /models cannot be read. The live list, where there is one, reaches the
      // browser on the endpoint row's health.models and the page prefers it -- see the note above
      // PROVIDERS. Absent for a provider with no endpoint at all (claude, gemini, grok), because a
      // card with no endpoint has no model to choose.
      ...(Array.isArray(spec.models) ? { models: curatedModels(id, env) } : {}),
      // Which row of the catalog this provider's model is stored on right now, so the picker opens
      // on what the box would actually use rather than on the preset's default.
      ...(chosenOf(id, catalog) ? { model: chosenOf(id, catalog) } : {}),
    };
  }));
  return rows;
}

// --- adoption: the vendor's store, once; or a pasted key ---------------------------------------
export async function adoptSubscription(id, input = {}, env = process.env) {
  const spec = PROVIDERS[id];
  if (spec == null || (spec.route !== "endpoint" && spec.route !== "key")) throw new Error(`${id} is not adoptable in this contract`);
  const store = await readStore();
  if (spec.route === "key") {
    // A re-adopt without a key (say, to change the model) keeps the stored one.
    const apiKey = String(input.apiKey ?? env[spec.env] ?? store[id]?.apiKey ?? "").trim();
    if (apiKey.length === 0) throw new Error(`${spec.name} needs an API key`);
    store[id] = { ...(store[id] ?? {}), apiKey, adoptedAt: store[id]?.adoptedAt ?? new Date().toISOString(), source: input.apiKey ? "pasted" : store[id]?.source ?? `$${spec.env}` };
  } else if (id === "codex") {
    const home = env.CODEX_HOME?.trim() || path.join(HOME, ".codex");
    const file = path.join(home, "auth.json");
    const tokens = readJson(file)?.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token) throw new Error("no Codex CLI login found; run `codex login` first");
    const claims = jwtClaims(tokens.access_token) ?? {};
    const email = claims["https://api.openai.com/profile"]?.email ?? null;
    const accountId = tokens.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
    const existing = store.codex;
    // Bootstrap-only: once we hold our own refresh token the CLI's state never replaces it, and a
    // CLI re-login under a different account never silently overwrites the adopted one.
    if (existing?.refresh) {
      if ((existing.accountId && accountId && existing.accountId !== accountId) || (existing.email && email && existing.email !== email)) {
        throw new Error(`the Codex CLI is now signed in as ${email ?? accountId}; the adopted profile is ${existing.email ?? existing.accountId}. Forget it first to adopt the new login.`);
      }
    } else {
      store.codex = { access: tokens.access_token, refresh: tokens.refresh_token, accountId, email, expires: typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 60 * 60 * 1000, adoptedAt: new Date().toISOString(), source: file };
    }
  } else if (id === "minimax") {
    const file = path.join(HOME, ".minimax", "oauth_creds.json");
    const creds = readJson(file);
    if (!creds?.access_token || !creds?.refresh_token) throw new Error("no MiniMax CLI login found");
    if (!store.minimax?.refresh) store.minimax = { access: creds.access_token, refresh: creds.refresh_token, expires: Number(creds.expiry_date) || Date.now() + 60 * 60 * 1000, adoptedAt: new Date().toISOString(), source: file };
  }
  await writeStore(store);
  return endpointEntry(id, input.model);
}
export async function forgetSubscription(id) {
  const store = await readStore();
  delete store[id];
  await writeStore(store);
}
/** The model the user's own Codex CLI is configured for, so the adopted row follows their choice. */
function codexConfiguredModel(env = process.env) {
  const home = env.CODEX_HOME?.trim() || path.join(HOME, ".codex");
  try { return /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(home, "config.toml"), "utf8"))?.[1] ?? null; } catch { return null; }
}
/**
 * The endpoints.json row for an adopted subscription: no key, a pointer instead.
 *
 * MODELS-1, the context window rule. This function used to write `spec.contextWindow` on to the row
 * whatever model was chosen, which is right for the preset's default and wrong for every other
 * model the person can now pick. Measured on this Mac 2026-09-08: adopting `zai` with model
 * `glm-5.3-flash` wrote contextWindow 128000, the number that belongs to glm-5.3.
 *
 * The number goes in when the chosen model is one we have measured a window for, and is LEFT OUT
 * otherwise. Left out is not a degraded answer: the host has its own default and takes it, whereas
 * a wrong window is either a conversation compacted before it needed to be or a prompt the vendor
 * rejects on every single turn. A guess that is silently wrong every turn is worse than no guess.
 */
export function endpointEntry(id, model) {
  const spec = PROVIDERS[id];
  const chosen = (model ?? "").trim() || (id === "codex" ? codexConfiguredModel() : null) || spec.defaultModel;
  const known = (spec.models ?? []).find((row) => row.id === chosen) ?? null;
  // The preset's own number still applies to the preset's own default, which is what keeps every
  // row this product has already written byte-identical to what it was.
  const contextWindow = known?.contextWindow ?? (chosen === spec.defaultModel ? spec.contextWindow ?? null : null);
  return {
    id: spec.endpointId, name: spec.name, baseUrl: spec.baseUrl, model: chosen,
    subscription: id, transport: spec.transport,
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
  };
}

// --- resolution at switch time: the live secret, refreshed through the vendor's own endpoint ----
async function refreshCodex(entry) {
  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": `${ORIGINATOR}/1` },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: entry.refresh, client_id: CODEX_CLIENT_ID, scope: "openid profile email" }),
  });
  if (!response.ok) throw new Error(`Codex token refresh failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("Codex token refresh returned no access token");
  const claims = jwtClaims(body.access_token) ?? {};
  return { ...entry, access: body.access_token, refresh: body.refresh_token ?? entry.refresh, expires: typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + Number(body.expires_in ?? 3600) * 1000, refreshedAt: new Date().toISOString() };
}
async function refreshMiniMax(entry) {
  const response = await fetch("https://account.minimax.io/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": `${ORIGINATOR}/1` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: entry.refresh, client_id: MINIMAX_CLIENT_ID }).toString(),
  });
  if (!response.ok) throw new Error(`MiniMax token refresh failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("MiniMax token refresh returned no access token");
  return { ...entry, access: body.access_token, refresh: body.refresh_token ?? entry.refresh, expires: Date.now() + Number(body.expired_in ?? body.expires_in ?? 3600) * 1000, refreshedAt: new Date().toISOString() };
}
export async function resolveSubscription(id, options = {}) {
  const spec = PROVIDERS[id];
  const store = await readStore();
  const entry = store[id];
  if (spec == null || entry == null) throw new Error(`${id} is not adopted`);
  if (spec.route === "key") return { apiKey: entry.apiKey, transport: spec.transport, originator: ORIGINATOR, accountId: null, refreshed: false };
  let live = entry;
  let refreshed = false;
  if (options.forceRefresh || !Number.isFinite(live.expires) || live.expires - Date.now() < NEAR_EXPIRY_MS) {
    live = id === "codex" ? await refreshCodex(entry) : await refreshMiniMax(entry);
    store[id] = live;
    await writeStore(store); // our store only; the vendor's file is never touched
    refreshed = true;
  }
  return { apiKey: live.access, transport: spec.transport, originator: ORIGINATOR, accountId: live.accountId ?? null, refreshed };
}
