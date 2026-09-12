// A workspace's token allowance: five-day cycle math, settings resolution and cached usage reads.

export const CYCLE_MS = 5 * 24 * 60 * 60 * 1000;
export const ALLOWANCE_CACHE_MS = 60 * 1000;
export const DEFAULT_ALLOWANCE_LEVELS = Object.freeze([
  { id: "seed", name: "Seed", tokens: 25_000_000 },
  { id: "sprout", name: "Sprout", tokens: 75_000_000 },
  { id: "grove", name: "Grove", tokens: 200_000_000 },
]);
export const DEFAULT_ALLOWANCE_LEVEL = "sprout";
export const DEFAULT_SPEND_PRICES = Object.freeze([
  { model: "GLM-5.3", input: 1.40, output: 4.40 },
  { model: "GLM-5.3-Flash", input: 0.15, output: 0.50 },
]);

const finiteNonNegative = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

export function cycleOf(tenant, now = Date.now()) {
  const rawCreatedAt = tenant?.createdAt ?? tenant?.created_at;
  const createdAt = Number.isFinite(Number(rawCreatedAt)) ? Number(rawCreatedAt) : Date.parse(String(rawCreatedAt ?? ""));
  if (!Number.isFinite(createdAt)) throw new TypeError("tenant.createdAt must be a date or timestamp");
  const at = Number(now);
  const index = Math.max(0, Math.floor((at - createdAt) / CYCLE_MS));
  const starts = createdAt + index * CYCLE_MS;
  const ends = starts + CYCLE_MS;
  const remaining = Math.max(0, ends - at);
  return {
    index,
    startsAt: new Date(starts).toISOString(),
    endsAt: new Date(ends).toISOString(),
    daysLeft: Math.ceil(remaining / (24 * 60 * 60 * 1000)),
    pct: Math.max(0, Math.min(100, ((at - starts) / CYCLE_MS) * 100)),
  };
}

export function allowanceState(pct) {
  const value = finiteNonNegative(pct);
  return value >= 100 ? "exhausted" : value >= 80 ? "warning" : "ok";
}

export function parseLevels(raw) {
  let value = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { value = null; } }
  if (!Array.isArray(value)) return DEFAULT_ALLOWANCE_LEVELS.map((row) => ({ ...row }));
  const levels = value.map((row) => ({
    id: String(row?.id ?? "").trim(),
    name: String(row?.name ?? "").trim(),
    tokens: Number(row?.tokens),
  })).filter((row) => row.id.length > 0 && row.name.length > 0 && Number.isFinite(row.tokens) && row.tokens > 0);
  return levels.length > 0 ? levels : DEFAULT_ALLOWANCE_LEVELS.map((row) => ({ ...row }));
}

export function usageFor(slug, cycle, rows = []) {
  const from = Date.parse(cycle.startsAt);
  const to = Date.parse(cycle.endsAt);
  const alias = `titanbot-${String(slug)}`;
  const models = new Map();
  let used = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = Date.parse(String(row?.startTime ?? row?.startTimeUtc ?? row?.started_at ?? ""));
    if (!Number.isFinite(at) || at < from || at >= to) continue;
    const rowAlias = String(row?.key_alias ?? row?.metadata?.user_api_key_alias ?? "");
    const rowSlug = String(row?.metadata?.slug ?? "");
    if (rowAlias !== alias && rowSlug !== String(slug)) continue;
    const tokens = finiteNonNegative(row?.prompt_tokens) + finiteNonNegative(row?.completion_tokens);
    used += tokens;
    const model = String(row?.model ?? row?.model_group ?? "").trim() || "not recorded";
    models.set(model, (models.get(model) ?? 0) + tokens);
  }
  return {
    used,
    models: [...models.entries()].map(([model, tokens]) => ({ model, tokens })).filter((row) => row.tokens > 0)
      .sort((a, b) => (b.tokens - a.tokens) || a.model.localeCompare(b.model)).slice(0, 3),
  };
}

export function createAllowanceService({ store, proxy, now = () => Date.now(), cacheMs = ALLOWANCE_CACHE_MS } = {}) {
  if (store.getSetting("allowance.levels", "").length === 0) {
    store.setSetting("allowance.levels", JSON.stringify(DEFAULT_ALLOWANCE_LEVELS), "system default");
  }
  if (store.getSetting("spend.prices", "").length === 0) {
    store.setSetting("spend.prices", JSON.stringify(DEFAULT_SPEND_PRICES), "system default");
  }
  const cache = new Map();
  let sharedRows = { at: 0, rows: null, inFlight: null };

  async function rows() {
    const at = now();
    if (sharedRows.rows != null && at - sharedRows.at < cacheMs) return sharedRows.rows;
    if (sharedRows.inFlight != null) return sharedRows.inFlight;
    const pending = Promise.resolve(proxy?.spendRows?.()).then((answer) => {
      if (answer?.ok !== true) throw new Error(answer?.why || "token usage is not recorded");
      const value = Array.isArray(answer.rows) ? answer.rows : [];
      sharedRows = { at: now(), rows: value, inFlight: null };
      return value;
    }, (error) => { sharedRows = { at: 0, rows: null, inFlight: null }; throw error; });
    sharedRows = { ...sharedRows, inFlight: pending };
    return pending;
  }

  function settings(slug) {
    const levels = parseLevels(store.getSetting("allowance.levels", ""));
    const wanted = String(store.getSetting(`allowance.level.${slug}`, DEFAULT_ALLOWANCE_LEVEL));
    const level = levels.find((row) => row.id === wanted) ?? levels.find((row) => row.id === DEFAULT_ALLOWANCE_LEVEL) ?? levels[0];
    const rawOverride = store.getSetting(`allowance.capOverride.${slug}`, "");
    const override = Number(rawOverride);
    const capOverride = rawOverride.length > 0 && Number.isFinite(override) && override > 0 ? override : null;
    return { levels, level, capOverride, cap: capOverride ?? level.tokens };
  }

  async function get(slug, { fresh = false } = {}) {
    const tenant = store.getTenant(slug);
    if (tenant == null) return null;
    const cycle = cycleOf(tenant, now());
    const key = `${slug}:${cycle.index}`;
    const hit = cache.get(key);
    if (!fresh && hit != null && now() - hit.at < cacheMs) return hit.answer;
    const { level, cap, capOverride } = settings(slug);
    let usage;
    try { usage = usageFor(slug, cycle, await rows()); }
    catch (error) {
      return { level: level.name, levelId: level.id, cap, capOverride, used: null, pct: null, state: "not-recorded", cycle, models: [], why: String(error?.message ?? error) };
    }
    const pct = cap > 0 ? (usage.used / cap) * 100 : 100;
    const answer = { level: level.name, levelId: level.id, cap, capOverride, used: usage.used, pct, state: allowanceState(pct), cycle, models: usage.models };
    cache.set(key, { at: now(), answer });
    return answer;
  }

  function set(slug, { level, capOverride }, actor = "") {
    const tenant = store.getTenant(slug);
    if (tenant == null) return { ok: false, error: "not_found", message: "There is no workspace by that name." };
    const levels = parseLevels(store.getSetting("allowance.levels", ""));
    if (!levels.some((row) => row.id === String(level))) return { ok: false, error: "bad_level", message: "Pick one of the allowance levels shown." };
    const cap = capOverride === "" || capOverride == null ? null : Number(capOverride);
    if (cap != null && (!Number.isInteger(cap) || cap <= 0)) return { ok: false, error: "bad_cap", message: "A cap override is a positive whole number of tokens, or blank." };
    store.setSetting(`allowance.level.${slug}`, String(level), actor);
    store.setSetting(`allowance.capOverride.${slug}`, cap == null ? "" : String(cap), actor);
    for (const key of cache.keys()) if (key.startsWith(`${slug}:`)) cache.delete(key);
    return { ok: true };
  }

  function prices() {
    let parsed;
    try { parsed = JSON.parse(store.getSetting("spend.prices", "")); } catch { parsed = null; }
    return (Array.isArray(parsed) ? parsed : DEFAULT_SPEND_PRICES).map((row) => ({
      model: String(row?.model ?? ""), input: Number(row?.input), output: Number(row?.output),
    })).filter((row) => row.model.length > 0 && Number.isFinite(row.input) && row.input >= 0 && Number.isFinite(row.output) && row.output >= 0);
  }

  return { get, set, settings, prices, clear: () => { cache.clear(); sharedRows = { at: 0, rows: null, inFlight: null }; } };
}
