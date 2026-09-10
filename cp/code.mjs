// cp/code.mjs -- the money side of a coding task (CODE-1, docs/CODE.md).
//
// WHAT THIS FILE OWNS, and nothing in the relay or the host owns any of it: the per-task credential,
// the caps that say whether a task may start at all, the hidden deployment a coding agent runs on,
// and the ledger row that says what a task cost. The relay creates containers and the host offers a
// tool; both of them ASK THIS, and neither of them mints, revokes or bills.
//
// WHY THE CLAIM IS TAKEN BEFORE THE CONTAINER EXISTS. The same reasoning cp/mail.mjs writes over
// openSend, and it is stronger here: an unstarted task is recoverable and an unbilled container-hour
// is not. So `openTask` checks the caps, writes the row, mints the key and answers once; the relay
// only then creates anything. A crash between the two leaves a row reading `running` that the sweep
// closes as lost, which is the honest state and is a state an operator can see.
//
// WHY THE TABLE IS HERE AND NOT IN cp/store.mjs SCHEMA. Two reasons and they are both measurements
// rather than taste. db.exec(SCHEMA) runs on EVERY open and `CREATE TABLE IF NOT EXISTS` makes a
// table that is not there, so a whole new table needs no entry in TENANT_MIGRATIONS and no edit to
// that file -- only a new COLUMN on an existing table does. And keeping the DDL beside the code that
// reads it means this wave edits no file another wave is editing this week, which is the difference
// between a merge and a merge conflict in a 1,200-line file three waves share.
//
// WHAT IS NOT IN THE ROW: the task's TITLE and the task's INSTRUCTIONS. That is the rule
// mail_send_log holds about subjects, for the same reason. The customer's own words are the
// customer's; they stay in the tenant's own tasks file on the relay, beside the task directory they
// describe. This table is who ran what, for how long, on whose subscription, and what happened.
import { SECRET_SETTINGS } from "./store.mjs";
import { PLAN_MODEL_PREFIX } from "./proxy.mjs";

// ---- the two aliases, frozen --------------------------------------------------------------------
//
// The deployment a coding agent runs on, and the one it is derived from. Both are contracts: the
// first is what a per-task key is minted against and what a task's ledger row records, and renaming
// it would orphan every row already written.
export const CODING_ALIAS = "plan-zai-code";
export const CODING_SOURCE_ALIAS = "plan-zai";

/**
 * THE VENDOR PREFIX IS LOAD BEARING AND IT IS NOT A TYPO.
 *
 * MEASURED against LiteLLM v1.100.0, which is the build the R750 runs: the proxy registers
 * /v1/messages, but on an `openai/` deployment it drives the VENDOR's /responses endpoint, and the
 * Anthropic surface comes back as an HTTP 200 carrying an error body -- which a model narrates as
 * itself refusing. Declared `hosted_vllm/<model>` against the SAME api_base and the SAME credential
 * it bridges to upstream chat/completions instead, and the whole Anthropic surface round trips:
 * text, system, tools, tool_use and tool_result, the full SSE sequence and count_tokens.
 *
 * So this prefix is a LiteLLM ROUTING CHOICE made for its translation behaviour. It says nothing
 * about the upstream, which is the same Z.AI endpoint plan-zai uses. Tidying it to `openai/` to
 * match the row it was derived from turns every coding task into a 200 with an error inside it, and
 * nothing would go red: that is why tests/cp-code.test.mjs asserts this string.
 */
export const CODING_VENDOR_PREFIX = "hosted_vllm/";

/**
 * A coding task's own key at the proxy, per task and never per tenant.
 *
 * THE SHAPE IS WHAT MAKES A REVOKE SAFE. cp/proxy.mjs derives a tenant's alias from the slug alone
 * (`titanbot-<slug>`) and `deleteKeyByAlias` posts exactly that string, so a task key that wore the
 * tenant's alias would be taken down by a tenant revoke -- or worse, a task revoke would take the
 * box's own key with it and the customer's agents would stop answering mid-turn. This alias can
 * never collide with that one, because `titanbot-<slug>` is not a prefix any `/key/delete` call in
 * this tree matches loosely.
 */
export const codeTaskKeyAlias = (slug, taskId) => `titanbot-${String(slug ?? "").trim()}-code-${String(taskId ?? "").trim()}`;

/**
 * Whether an alias at the proxy is SOME coding task's, whoever's.
 *
 * Across every tenant rather than per slug, deliberately. A per-slug prefix only finds keys for
 * workspaces that are still in the ledger, and the orphan this sweep exists for is the one whose row
 * or whose whole tenant is gone. `titanbot-<slug>` can never match this, so a tenant's own box key is
 * never in the set.
 */
export const isCodeTaskAlias = (alias) => {
  const name = String(alias ?? "");
  return name.startsWith("titanbot-") && name.includes("-code-");
};

/**
 * THE DOORS A TASK KEY CARRIES, WRITTEN OUT ONE BY ONE.
 *
 * /v1/messages and /v1/messages/count_tokens are deliberately ABSENT from TENANT_ALLOWED_ROUTES in
 * cp/proxy.mjs and they stay absent: putting them there would hand every box on the bridge an
 * Anthropic door on the operator's own subscriptions, which is a door nothing in the product needs
 * and a door nobody would notice being used. They ride a per-task key, which exists for minutes and
 * is revoked at the end of the task.
 *
 * THE TENANT LIST IS DELIBERATELY NOT REUSED, and this is the whole reason the list is a literal.
 * It used to be spread in here so the two could not drift, and what came with it was egress: the
 * tenant list carries the proxy's /tinyfish/fetch and /tinyfish/search pass-throughs and the /mcp
 * mount. MEASURED INSIDE A LIVE SANDBOX ON THE R750 2026-09-10: on a task key, the proxy's refusal
 * for a disallowed route enumerated the tinyfish paths as allowed, and POST /tinyfish/fetch was not
 * refused at all -- it was relayed upstream and came back with that service's own request id. The
 * only thing between the sandbox and arbitrary web fetches was an operator step nobody had finished.
 * A sandbox is sold to the customer and described to the agent as a machine with no internet access
 * at all, so every route that can reach the web is a route this key must not have. A route the
 * providers wave adds for a customer is therefore NOT added here: if a coding task ever needs one,
 * it is named on this list on purpose, by somebody who has read what it reaches.
 */
export const CODE_TASK_ROUTES = Object.freeze([
  // The Anthropic wire, which is the wire the coding agent speaks.
  "/v1/messages",
  "/v1/messages/count_tokens",
  // And the OpenAI-shaped pair plus the model list, for an agent that speaks that one instead.
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/models",
  "/models",
]);

// ---- the settings, with a global form and a per-workspace one -----------------------------------
//
// Every one of these is an admin_settings row. `code.capUsd` is the global, `code.capUsd.<slug>` is
// that one workspace's, and the per-workspace row wins. Neither exists until somebody writes one,
// and the defaults below are what a workspace that has never been touched gets.
export const CODE_PROVIDER_SETTING = "code.provider";
export const CODE_MODEL_SETTING = "code.model";
export const CODE_CAP_USD_SETTING = "code.capUsd";
export const CODE_MINUTES_SETTING = "code.wallClockMinutes";
export const CODE_CONCURRENT_SETTING = "code.concurrent";
export const CODE_DAILY_SETTING = "code.daily";
export const CODE_CPUS_SETTING = "code.cpus";
export const CODE_MEMORY_GB_SETTING = "code.memoryGb";
/** The operator's E2B key. WRITE ONLY: see the note over SECRET_SETTINGS.add below. */
export const CODE_E2B_KEY_SETTING = "code.e2bKey";

/** The per-workspace form of any of the names above. */
export const codeSetting = (name, slug) => `${name}.${String(slug ?? "")}`;

export const CODE_DEFAULTS = Object.freeze({
  // Local Docker, because a local task reaches the proxy and so its model spend is attributable,
  // and because it costs the operator nothing but the machine he already owns. E2B is opt in per
  // workspace.
  provider: "local",
  model: CODING_ALIAS,
  // SIZED FOR UNCACHED PRICING ON PURPOSE. LiteLLM drops cache_control on the way to
  // chat/completions, so a coding turn re-bills the whole context every time round; a cap sized for
  // cached pricing would be reached in four turns and read as the model giving up. CODE-6.
  capUsd: 2.0,
  wallClockMinutes: 30,
  concurrent: 2,
  daily: 20,
  cpus: 2,
  memoryGb: 2,
  // HOW LONG A CLOSE WAITS FOR THE PROXY TO BOOK THE SPEND. Measured at about 15 seconds on the
  // build the R750 runs, so twenty gives it room without a close hanging on a person. See readSpend.
  spendWaitMs: 20_000,
});

export const CODE_PROVIDERS = Object.freeze(["local", "e2b"]);

/**
 * THE E2B KEY NEVER COMES BACK OUT OF A ROUTE, and this line is what makes that true of the routes
 * this wave did not write.
 *
 * cp/store.mjs listSettings hands every value back except the names in SECRET_SETTINGS, and that Set
 * is exported and mutable. Adding the name here rather than editing that file keeps this wave out of
 * a file two other waves are in this week and gets the same guarantee: the operator's E2B key is a
 * row whose value no listing, no panel and no CLI verb can read. It is handed out in exactly one
 * place, inside an openTask answer for a workspace set to E2B, and it is never written relay-side.
 */
SECRET_SETTINGS.add(CODE_E2B_KEY_SETTING);

const DAY_MS = 24 * 60 * 60_000;

/** "two" up to twenty, then the digits. A refusal a bot reads out to a person says two, not 2. */
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty"];
const inWords = (n) => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n));

/** A number out of an untyped body, or null. Never NaN and never a zero standing in for nothing. */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The table.
 *
 * minutes and spend_usd are NULLABLE and that is the whole point of them: NULL means NOT MEASURED,
 * and a panel that drew a zero there would report a task that ran for twenty minutes on somebody's
 * subscription as a task that cost nothing. Every reader of this table has to carry the null
 * through.
 *
 * Two columns beyond the thirteen the design named, and both earn their place:
 *
 *   key_id   the proxy's HASHED handle for the task key (never the key). It is what /key/info is
 *            asked with after a control plane restart has lost the in-memory copy, and it is the
 *            only thing an operator can match a row against in the proxy's own log.
 *   revoked  whether the revoke LANDED. A failed revoke is a live credential on the operator's own
 *            subscriptions; a boolean here is what lets the sweep retry it instead of it being
 *            logged once and forgotten.
 */
export const CODE_TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS code_task (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT NOT NULL,
  agent_id    TEXT NOT NULL DEFAULT '',
  task_id     TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  key_alias   TEXT NOT NULL DEFAULT '',
  key_id      TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL DEFAULT '',
  minutes     REAL,
  spend_usd   REAL,
  outcome     TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS code_task_tenant ON code_task (tenant, id);
`;

/** One row as everything above this file reads it. No title and no instructions, because there are none. */
const taskRow = (record) => (record == null ? null : {
  id: Number(record.id),
  tenant: String(record.tenant ?? ""),
  agentId: String(record.agent_id ?? ""),
  taskId: String(record.task_id ?? ""),
  provider: String(record.provider ?? ""),
  model: String(record.model ?? ""),
  keyAlias: String(record.key_alias ?? ""),
  keyId: String(record.key_id ?? ""),
  startedAt: String(record.started_at ?? ""),
  endedAt: String(record.ended_at ?? ""),
  minutes: numberOrNull(record.minutes),
  spendUsd: numberOrNull(record.spend_usd),
  outcome: String(record.outcome ?? ""),
  detail: String(record.detail ?? ""),
  revoked: Number(record.revoked ?? 0) === 1,
});

/**
 * The task ledger, the per-task credential and the coding deployment, over a store and a proxy
 * client.
 *
 * `proxy` is cp/proxy.mjs's client. It is CALLED and never edited: the mint goes through its raw
 * `call` rather than through `mintKey`, for the reason written over THE MINT below.
 */
export function createCodeTasks({ store, proxy, now = () => Date.now(), spendWaitMs = CODE_DEFAULTS.spendWaitMs } = {}) {
  const db = store?.db;
  if (db == null) throw new Error("the code ledger needs the store's sqlite handle");
  db.exec(CODE_TASK_SCHEMA);

  const insertClaim = db.prepare(
    "INSERT INTO code_task (tenant, agent_id, task_id, provider, model, key_alias, key_id, started_at, outcome) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')");
  const selectRow = db.prepare("SELECT * FROM code_task WHERE id = ?");
  const selectByTask = db.prepare("SELECT * FROM code_task WHERE tenant = ? AND task_id = ? ORDER BY id DESC");
  const selectForTenant = db.prepare("SELECT * FROM code_task WHERE tenant = ? ORDER BY id DESC LIMIT ?");
  const selectAll = db.prepare("SELECT * FROM code_task ORDER BY id DESC LIMIT ?");
  // The rollup, in one pass. COUNT(minutes) and COUNT(spend_usd) count the rows that HAVE one, which
  // is where minutesUnmeasured and spendUnmeasured come from; SUM over all NULLs answers NULL rather
  // than 0, which is the distinction this whole file exists to keep.
  //
  // THE OPERATOR'S OWN SELFTEST IS NOT ONE OF THE CUSTOMER'S TASKS. `code selftest` mints a real key,
  // runs one real turn and leaves a real row, which is the point of it -- but the line Jason bills a
  // customer from must not carry engineering's own runs. MEASURED ON THE R750 2026-09-10: `code spend`
  // read "demo 8 task(s)" and one of the eight was `cp-selftest`. The detail listings still show it,
  // because there it is the truth about what ran; only the per-tenant rollup leaves it out.
  const ROLLUP = "SELECT tenant, COUNT(*) AS tasks,"
    + " SUM(CASE WHEN ended_at = '' THEN 1 ELSE 0 END) AS running,"
    + " SUM(minutes) AS minutes, COUNT(minutes) AS minutes_measured,"
    + " SUM(spend_usd) AS spend_usd, COUNT(spend_usd) AS spend_measured,"
    + " SUM(CASE WHEN provider = 'e2b' THEN 1 ELSE 0 END) AS e2b_tasks,"
    + " GROUP_CONCAT(DISTINCT provider) AS providers"
    + " FROM code_task WHERE outcome != 'selftest'";
  const rollupAll = db.prepare(`${ROLLUP} GROUP BY tenant ORDER BY tenant`);
  const rollupForTenant = db.prepare(`${ROLLUP} AND tenant = ? GROUP BY tenant`);
  const selectOpen = db.prepare("SELECT * FROM code_task WHERE tenant = ? AND ended_at = ''");
  const selectOpenAll = db.prepare("SELECT * FROM code_task WHERE ended_at = ''");
  const countToday = db.prepare("SELECT COUNT(*) AS n FROM code_task WHERE tenant = ? AND started_at >= ?");
  const settleRow = db.prepare(
    "UPDATE code_task SET ended_at = ?, minutes = ?, spend_usd = ?, outcome = ?, revoked = ?, "
    + "detail = CASE WHEN ? = '' THEN detail WHEN detail = '' THEN ? ELSE detail || '; ' || ? END WHERE id = ?");
  const markRevoked = db.prepare("UPDATE code_task SET revoked = 1 WHERE id = ?");
  const setKeyId = db.prepare("UPDATE code_task SET key_id = ? WHERE id = ?");
  const selectAliasRows = db.prepare("SELECT key_alias, id, ended_at, revoked FROM code_task WHERE key_alias != ''");

  /**
   * THE KEY VALUE, IN MEMORY, FOR THE LIFE OF THE TASK AND NOWHERE ELSE.
   *
   * /key/info is asked for a key's spend BY the key, which is the number LiteLLM itself compares a
   * budget against. So closing a task needs the key -- and the key must not be on disk, in a label,
   * in an env field or in this table. It is held here, keyed by row id, dropped the moment the row
   * is closed, and lost on a restart: a restart then leaves spend_usd NULL, which says "not
   * measured" and is the true answer rather than a zero. The fallback read, by the hashed handle in
   * key_id, is tried first in that case and is measured in tests/cp-code-key.test.mjs.
   */
  const liveKeys = new Map();

  // ---- the settings ------------------------------------------------------------------------------

  /**
   * One number, per workspace then globally then the default. The capOf shape cp/mail.mjs uses, and
   * the same refusal to let a typo uncap anybody: a row that is not a positive number falls through
   * rather than being believed.
   */
  const numberOf = (name, slug, fallback) => {
    for (const raw of [store.getSetting(codeSetting(name, slug), ""), store.getSetting(name, "")]) {
      const asked = Number(String(raw ?? "").trim());
      if (Number.isFinite(asked) && asked > 0) return asked;
    }
    return fallback;
  };

  const providerOf = (slug) => {
    for (const raw of [store.getSetting(codeSetting(CODE_PROVIDER_SETTING, slug), ""), store.getSetting(CODE_PROVIDER_SETTING, "")]) {
      const asked = String(raw ?? "").trim().toLowerCase();
      if (CODE_PROVIDERS.includes(asked)) return asked;
    }
    return CODE_DEFAULTS.provider;
  };

  const modelOf = (slug) => {
    for (const raw of [store.getSetting(codeSetting(CODE_MODEL_SETTING, slug), ""), store.getSetting(CODE_MODEL_SETTING, "")]) {
      const asked = String(raw ?? "").trim();
      if (asked.length > 0) return asked;
    }
    return CODE_DEFAULTS.model;
  };

  /** Everything a workspace's tasks run under. `e2bKeySet` is a boolean, and never the key. */
  const settings = (slug = "") => ({
    slug: String(slug ?? ""),
    provider: providerOf(slug),
    model: modelOf(slug),
    capUsd: numberOf(CODE_CAP_USD_SETTING, slug, CODE_DEFAULTS.capUsd),
    wallClockMinutes: numberOf(CODE_MINUTES_SETTING, slug, CODE_DEFAULTS.wallClockMinutes),
    concurrent: numberOf(CODE_CONCURRENT_SETTING, slug, CODE_DEFAULTS.concurrent),
    daily: numberOf(CODE_DAILY_SETTING, slug, CODE_DEFAULTS.daily),
    cpus: numberOf(CODE_CPUS_SETTING, slug, CODE_DEFAULTS.cpus),
    memoryGb: numberOf(CODE_MEMORY_GB_SETTING, slug, CODE_DEFAULTS.memoryGb),
    e2bKeySet: store.getSetting(CODE_E2B_KEY_SETTING, "").length > 0,
  });

  // ---- the mint ----------------------------------------------------------------------------------

  /**
   * THE MINT GOES THROUGH proxy.call AND NOT proxy.mintKey, and that is not a style choice.
   *
   * mintKey derives the alias from the slug (cp/proxy.mjs proxyKeyAlias) and hardcodes the tenant's
   * MCP grant. A task key minted through it would wear `titanbot-<slug>` -- the BOX's own alias --
   * so the second task would collide with the first, and revoking either would take the customer's
   * box key down with it and stop every agent in that workspace mid-turn.
   *
   * max_budget ALWAYS, and never soft_budget, whatever CP_PROXY_ENFORCE says. A soft budget by
   * LiteLLM's own definition never fails a request: it produces a number and stops nothing. A cap
   * that cannot stop a runaway coding agent is not a cap, it is a reading, and the whole reason this
   * key exists is that it can be made to stop.
   *
   * No MCP grant and no rpm limit: a sandbox has no egress, so it has no use for a web tool, and a
   * coding agent that cannot reach the proxy quickly is a coding agent that times out.
   */
  async function mintTaskKey({ slug, agentId, taskId, model, capUsd }) {
    const alias = codeTaskKeyAlias(slug, taskId);
    const answer = await proxy.call("POST", "/key/generate", {
      body: {
        key_alias: alias,
        models: [String(model)],
        allowed_routes: [...CODE_TASK_ROUTES],
        max_budget: Number(capUsd),
        metadata: { slug: String(slug), taskId: String(taskId), agentId: String(agentId) },
      },
    });
    if (!answer.ok) return { ok: false, why: answer.why ?? "the proxy would not mint a key for this task" };
    const key = String(answer.body?.key ?? "");
    if (key.length === 0) return { ok: false, why: "the proxy made a key for this task and did not answer with it" };
    return {
      ok: true,
      key,
      alias,
      keyId: String(answer.body?.token_id ?? answer.body?.token ?? answer.body?.key_name ?? ""),
    };
  }

  /** One task key gone, by alias. Never by value, and never the tenant's alias. */
  async function revokeTaskKey(alias) {
    const name = String(alias ?? "");
    // THE GUARD THAT STOPS THIS FUNCTION EVER TAKING A BOX'S KEY. Every /key/delete in this file goes
    // through here, and an alias that is not a coding task's cannot get past it.
    if (!isCodeTaskAlias(name)) {
      return { ok: false, why: "that is not a coding task's alias, so nothing was revoked" };
    }
    const answer = await proxy.call("POST", "/key/delete", { body: { key_aliases: [name] } });
    if (!answer.ok) return { ok: false, why: answer.why ?? "the proxy would not revoke that key" };
    return { ok: true, alias: name };
  }

  /**
   * A key's spend to date, read BEFORE the revoke.
   *
   * THE READ HAS TO WAIT, AND A ZERO IS NOT AN ANSWER. MEASURED on this Mac against
   * docker.litellm.ai/berriai/litellm-database:v1.100.0, which is the build the R750 runs: a turn
   * that the per-token prices say cost $0.1211 read back as spend 0 on /key/info at +7 ms, +1 s,
   * +2 s, +3 s, +4 s, +5 s, +8 s and +12 s, and came back as exactly 0.1211 at +15 s. The proxy
   * books a key's spend from the same batch writer /spend/logs is filled from, so /key/info is
   * CORRECT and it is NOT IMMEDIATE -- which the design of this wave had the wrong way round.
   *
   * A close that read once would therefore write 0 into the ledger for every task, and a zero is the
   * one answer that must never be written: on a screen it is indistinguishable from a task that cost
   * nothing. So this polls to a bounded budget, stops at the first figure above zero, and on timeout
   * answers NULL with the reason. Null reads as "not measured" everywhere above this line; a zero
   * would read as free.
   *
   * A task that really made no model call also reads zero for ever and also ends as null. That is the
   * honest answer: from here those two are the same observation.
   */
  async function readSpend(row, { waitMs, pollMs = 2000 } = {}) {
    const candidates = [liveKeys.get(Number(row.id)), row.keyId].filter((one) => String(one ?? "").length > 0);
    if (candidates.length === 0) {
      return { spend: null, why: "this control plane was restarted while the task was running, so its key was no longer in hand to ask about" };
    }
    const budget = Number.isFinite(Number(waitMs)) && Number(waitMs) >= 0 ? Number(waitMs) : Number(spendWaitMs);
    const until = now() + budget;
    let lastWhy = "";
    let sawZero = false;
    let settled = false;
    for (;;) {
      for (const handle of candidates) {
        const answer = await proxy.call("GET", "/key/info", { query: { key: String(handle) } });
        if (!answer.ok) {
          lastWhy = answer.why ?? "the proxy would not answer";
          // A PROXY THAT SAYS THE KEY IS NOT THERE WILL GO ON SAYING IT. 400 and 404 are terminal and
          // waiting twenty seconds for them changes nothing; a 5xx or a timeout is the kind of thing
          // that comes back, so those keep polling.
          if (answer.status === 400 || answer.status === 404) settled = true;
          continue;
        }
        const info = answer.body?.info ?? answer.body ?? {};
        const spend = numberOrNull(info?.spend ?? info?.total_spend ?? info?.spend_usd);
        if (spend === null) { lastWhy = "the proxy answered about this key and said nothing about its spend"; continue; }
        if (spend > 0) return { spend, why: "" };
        sawZero = true;
      }
      if (settled || now() >= until) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, until - now()))));
    }
    return {
      spend: null,
      why: sawZero
        ? `the proxy had still not booked this task's spend ${Math.round(budget / 1000)} seconds after it ended, so how much it cost is not known`
        : `the proxy would not say what this task's key had spent (${lastWhy})`,
    };
  }

  // ---- the ledger --------------------------------------------------------------------------------

  const openRows = (slug) => selectOpen.all(String(slug)).map(taskRow);

  /**
   * A task CLAIMED: the caps, the row, then the key.
   *
   * The order is the whole contract. A refusal writes NO ROW, so a workspace cannot be pushed
   * further over its limit by being refused; a claim that is allowed exists before any container
   * does, so nothing can run un-ledgered; and the key is minted last, so a proxy that will not
   * answer leaves a closed row saying so rather than a live credential nobody wrote down.
   */
  async function openTask({ slug, agentId, taskId, provider = "" } = {}) {
    const tenant = String(slug ?? "").trim();
    const agent = String(agentId ?? "").trim();
    const task = String(taskId ?? "").trim();
    if (tenant.length === 0 || agent.length === 0 || task.length === 0) {
      return { ok: false, error: "bad_request", message: "Name the workspace, the bot and the task this is for." };
    }
    const conf = settings(tenant);
    const chosen = CODE_PROVIDERS.includes(String(provider ?? "").trim().toLowerCase())
      ? String(provider).trim().toLowerCase()
      : conf.provider;

    // Already running, per workspace. The sentence is the one the relay reads back word for word, so
    // it carries the number and says plainly that nothing was started.
    const running = openRows(tenant);
    if (running.length >= conf.concurrent) {
      return {
        ok: false,
        error: "rate_limited",
        scope: "concurrent",
        cap: conf.concurrent,
        message: `This workspace already has ${inWords(conf.concurrent)} coding task${conf.concurrent === 1 ? "" : "s"} running, `
          + "so nothing was started. Try again when one finishes.",
      };
    }
    const at = now();
    const today = Number(countToday.get(tenant, new Date(at - DAY_MS).toISOString())?.n ?? 0);
    if (today >= conf.daily) {
      return {
        ok: false,
        error: "rate_limited",
        scope: "daily",
        cap: conf.daily,
        message: `This workspace has started its ${inWords(conf.daily)} coding tasks for today, `
          + "so nothing was started. The next one can go tomorrow.",
      };
    }

    // The same task id twice would mint a second key under the same alias, which the proxy refuses
    // and which would leave two rows for one container. A repeat is the relay retrying, and the
    // honest answer is the refusal rather than a second claim.
    if (selectByTask.all(tenant, task).length > 0) {
      return { ok: false, error: "bad_request", message: "That coding task has already been claimed once, so nothing was started." };
    }

    // THERE IS NO await BETWEEN THE CAP CHECKS ABOVE AND THIS INSERT, and that is what makes the
    // concurrency cap a cap rather than a suggestion. Two relays asking at the same millisecond run
    // as two turns of one event loop, so the second one sees the first one's row. An await slipped in
    // above this line would put the check and the claim on either side of a yield point and let both
    // through, which is how a "two at a time" limit becomes "as many as arrive together".
    const startedAt = new Date(at).toISOString();
    const alias = codeTaskKeyAlias(tenant, task);
    const id = Number(insertClaim.run(tenant, agent, task, chosen, conf.model, alias, "", startedAt).lastInsertRowid);

    const minted = await mintTaskKey({ slug: tenant, agentId: agent, taskId: task, model: conf.model, capUsd: conf.capUsd });
    if (!minted.ok) {
      // The claim stands and is closed, because a row that says a task could not be started is worth
      // more to whoever reads this table than no row at all. No container exists, so the minutes are
      // zero and they are measured rather than unknown, and `revoked` reads 1 because there is no
      // outstanding credential for the sweep to chase -- the mint is what failed.
      settleRow.run(startedAt, 0, null, "failed", 1, minted.why, minted.why, minted.why, id);
      return {
        ok: false,
        error: "no_credential",
        message: "The part of this system that hands out a coding task's own credential did not answer, so nothing was started.",
        detail: minted.why,
      };
    }
    setKeyId.run(String(minted.keyId), id);
    liveKeys.set(id, minted.key);

    const answer = {
      ok: true,
      id,
      key: minted.key,
      alias: minted.alias,
      model: conf.model,
      provider: chosen,
      capUsd: conf.capUsd,
      minutesCap: conf.wallClockMinutes,
      cpus: conf.cpus,
      memoryGb: conf.memoryGb,
    };
    // THE ONLY PLACE THE E2B KEY LEAVES THIS SERVICE, and only for a workspace actually set to E2B.
    // It is never persisted relay-side and never read from any file of the operator's: the row is
    // typed in once through the CLI and lives in admin_settings, write only.
    if (chosen === "e2b") {
      const e2bKey = store.getSetting(CODE_E2B_KEY_SETTING, "");
      if (e2bKey.length === 0) {
        // THE MODEL KEY IS GIVEN BACK, and whether that landed is what the row records. A task that
        // never ran must not leave a live credential behind it, and a revoke this path reported as
        // done when it failed is exactly the row the sweep would then never look at.
        const given = await revokeTaskKey(minted.alias);
        const note = given.ok
          ? "this workspace runs on a cloud sandbox and there is no account for one"
          : `this workspace runs on a cloud sandbox and there is no account for one; the task key was not revoked: ${given.why}`;
        settleRow.run(startedAt, 0, null, "failed", given.ok ? 1 : 0, note, note, note, id);
        liveKeys.delete(id);
        return {
          ok: false,
          error: "no_provider",
          message: "This workspace is set to run coding tasks on a cloud sandbox and nobody has given this system the account for it yet, so nothing was started.",
        };
      }
      answer.e2bKey = e2bKey;
    }
    return answer;
  }

  /**
   * A task CLOSED: the spend read, the row written, then the revoke.
   *
   * THE SPEND IS READ BEFORE THE REVOKE, because a deleted key has no record to ask about. And it is
   * read from GET /key/info and deliberately NOT from /spend/logs: that table is batch written every
   * ten seconds on this install and, measured against the real image, carried no rows at all for
   * priced /v1/messages calls through three minutes of polling, and no key alias on the rows it did
   * hold. The read WAITS -- see readSpend for why and for how long.
   */
  async function closeTask({ id, outcome = "", minutes = null, detail = "", spendWaitMs } = {}) {
    const rowId = Number(id);
    if (!Number.isFinite(rowId) || rowId <= 0) {
      return { ok: false, error: "bad_request", message: "Name the task to settle." };
    }
    const row = taskRow(selectRow.get(rowId));
    if (row == null) return { ok: false, error: "not_found", message: "There is no coding task with that number." };
    if (row.endedAt.length > 0) {
      // Settled twice is the relay retrying a close it did not see answered. The row stands as it
      // is: overwriting a measured outcome with a second one would lose whichever was true.
      return { ok: true, id: rowId, already: true, spendUsd: row.spendUsd, revoked: row.revoked };
    }

    // THE ROW IS CLOSED FIRST AND THE SPEND IS FILLED IN AFTER, and that order is what makes the wait
    // inside readSpend safe. That read can take twenty seconds, which is longer than the relay will
    // hold a request open, so the relay retries -- and a retry has to be a no-op rather than a second
    // twenty-second read against the same key. Writing ended_at now means the retry hits the guard
    // above. And if this process dies mid-wait, the row is a CLOSED one with spend null and revoked 0,
    // which is exactly the shape sweepTaskKeys picks up and finishes.
    const measuredMinutes = numberOrNull(minutes);
    const asked = String(detail ?? "").trim();
    const outcomeWord = String(outcome ?? "").trim() || "unknown";
    settleRow.run(new Date(now()).toISOString(), measuredMinutes, null, outcomeWord, 0, asked, asked, asked, rowId);

    const read = await readSpend(row, { waitMs: spendWaitMs });
    const revoke = await revokeTaskKey(row.keyAlias);
    // ONLY WHAT IS NEW. `asked` is already in detail from the close above, and the SQL appends, so
    // passing it again would write the caller's own sentence into the row twice.
    const notes = [read.why, revoke.ok ? "" : `the task key was not revoked: ${revoke.why}`]
      .filter((one) => one.length > 0).join("; ");
    settleRow.run(
      new Date(now()).toISOString(), measuredMinutes, read.spend, outcomeWord,
      revoke.ok ? 1 : 0, notes, notes, notes, rowId,
    );
    liveKeys.delete(rowId);
    return { ok: true, id: rowId, spendUsd: read.spend, spendWhy: read.why, revoked: revoke.ok, revokeWhy: revoke.ok ? "" : revoke.why };
  }

  /**
   * THE SWEEP, which is the only thing standing between a crash and a live credential.
   *
   * Two halves, and they are different failures. A key at the proxy whose row is CLOSED or ABSENT is
   * a credential on the operator's own subscriptions that nothing is watching, and it is deleted. A
   * row still reading `running` long after the longest deadline could have expired is a task whose
   * relay died; it is closed as lost and its key revoked, because the alternative is a row that
   * holds a concurrency slot for ever and a workspace that can never start another task.
   */
  async function sweepTaskKeys({ dryRun = false, graceMinutes = 10 } = {}) {
    const answer = { ok: true, deleted: [], closed: [], orphans: [], why: "", pages: 0 };

    // Every row that still has a key, by alias, so an alias can be matched to the row that made it.
    const byAlias = new Map();
    for (const record of selectAliasRows.all()) {
      byAlias.set(String(record.key_alias), {
        id: Number(record.id),
        closed: String(record.ended_at ?? "").length > 0,
        revoked: Number(record.revoked ?? 0) === 1,
      });
    }

    // THE LISTING IS PAGED AND THE PAGE SIZE HAS A CEILING. MEASURED on this Mac against
    // docker.litellm.ai/berriai/litellm-database:v1.100.0: GET /key/list?size=1000 answers 422, and
    // the first cut of this asked for exactly that -- so the sweep came back ok:false and reported
    // nothing orphaned on a proxy that was holding an orphan. size=100 with page=1 answers 200 and
    // the body carries total_pages, so the pages are walked.
    //
    // return_full_object is REQUIRED. Without it `keys` is a list of bare token strings with no alias
    // on them at all (measured in the same run), and an alias is the only thing this sweep can match.
    // EVERY PAGE IS READ BEFORE ANYTHING IS DELETED. Revoking inside the walk shifts the pages under
    // it: the first hundred go, the set shrinks, and page two is now empty -- so with a hundred and
    // one orphans exactly one survived every sweep for ever. Found by the paging test, which is why
    // that test plants a hundred and one rather than two.
    for (let page = 1; page <= Math.max(1, answer.pages || 1) && page <= 500; page += 1) {
      const listed = await proxy.call("GET", "/key/list", { query: { return_full_object: "true", size: "100", page: String(page) } });
      if (!listed.ok) {
        answer.ok = false;
        answer.why = listed.why ?? "the proxy would not list its keys";
        break;
      }
      answer.pages = Math.max(answer.pages, Number(listed.body?.total_pages ?? 1) || 1);
      const rows = Array.isArray(listed.body?.keys) ? listed.body.keys : [];
      for (const entry of rows) {
        // A bare string here means the proxy answered the short shape after all, which carries no
        // alias: it is skipped rather than guessed at, because an alias is the only thing this sweep
        // can match and a token hash it guessed at would be the wrong key deleted.
        const alias = typeof entry === "string" ? "" : String(entry?.key_alias ?? "");
        if (!isCodeTaskAlias(alias)) continue;
        const known = byAlias.get(alias);
        if (known != null && !known.closed) continue;
        if (!answer.orphans.includes(alias)) answer.orphans.push(alias);
      }
      if (rows.length === 0) break;
    }
    if (!dryRun) {
      for (const alias of answer.orphans) {
        const gone = await revokeTaskKey(alias);
        if (!gone.ok) continue;
        answer.deleted.push(alias);
        const known = byAlias.get(alias);
        if (known != null) markRevoked.run(known.id);
      }
    }

    // And the rows nothing ever came back about.
    const at = now();
    for (const row of selectOpenAll.all().map(taskRow)) {
      const conf = settings(row.tenant);
      const deadline = Date.parse(row.startedAt) + (conf.wallClockMinutes + graceMinutes) * 60_000;
      if (!Number.isFinite(deadline) || at < deadline) continue;
      answer.closed.push({ id: row.id, tenant: row.tenant, taskId: row.taskId });
      if (dryRun) continue;
      await closeTask({
        id: row.id, outcome: "lost", minutes: null,
        detail: "nothing came back about this task before its deadline had passed, so it was closed as lost",
        // NO WAIT ON THIS PATH. A lost task's key has been idle for longer than its whole deadline, so
        // the proxy has had many minutes to book whatever it spent: one read is the whole answer, and
        // a sweep over five lost tasks must not take a hundred seconds.
        spendWaitMs: 0,
      });
    }
    return answer;
  }

  // ---- the hidden deployment ---------------------------------------------------------------------

  /**
   * plan-zai-code, derived from plan-zai and hidden from every customer.
   *
   * WHAT IS COPIED AND WHY: the api_base, the credential NAME and the per-token prices, because a
   * coding task runs on the same subscription the plan runs on and a deployment with no price turns
   * every dollar figure downstream into a zero that looks like a measurement. What is NOT copied is
   * the vendor prefix: see CODING_VENDOR_PREFIX.
   *
   * ITS OWN TIMEOUT, because the proxy's global request_timeout is 60 (deploy/coolify/proxy-config/
   * config.yaml) and NOBODY MAY RESTART THE PROXY to change it. A coding turn longer than a minute
   * would otherwise come back as a provider error, which Claude Code narrates as the model failing.
   *
   * AND NO tb_customer_visible KEY, so it can never appear in a customer's Settings: cp/proxy.mjs
   * normalizeDeployment defaults an unknown row to NOT visible on purpose, and leaving the flag off
   * is how this alias stays out of a page a customer can open.
   */
  async function ensureCodingDeployment({ dryRun = false, alias = CODING_ALIAS, from = CODING_SOURCE_ALIAS } = {}) {
    const listed = await proxy.listModels();
    if (!listed.ok) return { ok: false, why: listed.why ?? "the proxy would not say what it serves" };
    const rows = Array.isArray(listed.rows) ? listed.rows : [];

    const existing = rows.filter((row) => row.alias === alias);
    if (existing.length > 0) {
      return {
        ok: false,
        exists: true,
        why: `${alias} is already on the proxy, so nothing was created. Delete it first if it needs rebuilding.`,
        deployments: existing.map((row) => row.id),
      };
    }

    const pool = rows.filter((row) => row.alias === from);
    if (pool.length === 0) {
      return { ok: false, why: `${from} is not on this proxy, so there is nothing to derive a coding deployment from.` };
    }
    // The FIRST row that carries both an api_base and a credential name. A pool is two
    // subscriptions under one name; the coding alias rides one of them, which is said out loud in
    // the answer rather than left for somebody to notice on the spend panel.
    const source = pool.find((row) => row.baseUrl.length > 0 && row.credentialName.length > 0) ?? pool[0];
    if (source.baseUrl.length === 0) {
      return { ok: false, why: `${from} carries no api_base on this proxy, so a coding deployment derived from it would not know where to send anything.` };
    }
    // WHICH HALF IS MISSING, NAMED. MEASURED on this Mac against the real image: a plan model the
    // proxy read out of its CONFIG FILE has its key inline as litellm_params.api_key and carries no
    // litellm_credential_name at all, while one created the way the providers panel creates it -- a
    // /credentials row plus /model/new naming it -- carries the name and reads back through
    // /model/info. This file writes no key anywhere by rule, so it can only point the new deployment
    // at a NAMED credential; a config-file row leaves it nothing to point at. That is a precise
    // sentence and a fixable one, which is why it is not folded into the api_base refusal.
    if (source.credentialName.length === 0) {
      return {
        ok: false,
        why: `${from} on this proxy carries its key inline rather than as a named credential, which happens when it came out of the proxy's config file. `
          + "A coding deployment can only be pointed at a named credential, so add that plan model through the providers panel first and run this again.",
      };
    }

    // openai/glm-5.3 -> hosted_vllm/glm-5.3. The bare model name, whatever prefix the source wore.
    const bare = source.vendorModel.includes("/") ? source.vendorModel.slice(source.vendorModel.indexOf("/") + 1) : source.vendorModel;
    if (bare.length === 0) {
      return { ok: false, why: `${from} does not say which vendor model it runs, so a coding deployment could not be derived from it.` };
    }
    const vendorModel = `${CODING_VENDOR_PREFIX}${bare}`;

    const params = {
      api_base: source.baseUrl,
      // Ten minutes, its own, for the reason above. Both names, because LiteLLM reads the streaming
      // one separately and a coding agent streams.
      timeout: 600,
      stream_timeout: 600,
    };
    if (source.inputCostPerToken !== null) params.input_cost_per_token = source.inputCostPerToken;
    if (source.outputCostPerToken !== null) params.output_cost_per_token = source.outputCostPerToken;

    const plan = {
      alias,
      vendorModel,
      credentialName: source.credentialName,
      params,
      from: { alias: from, id: source.id, provider: source.provider, poolSize: pool.length },
      priced: source.inputCostPerToken !== null && source.outputCostPerToken !== null,
    };
    if (dryRun) return { ok: true, dryRun: true, plan };

    const made = await proxy.addModel({
      alias,
      vendorModel,
      credentialName: source.credentialName,
      params,
      // tb_provider so the providers panel can see whose subscription this is. No customer-facing
      // key of any sort.
      info: { tb_provider: source.provider, tb_key_slot: source.keySlot },
    });
    if (!made.ok) return { ok: false, why: made.why ?? `the proxy would not create ${alias}`, plan };
    return { ok: true, id: made.id, plan };
  }

  /** The coding deployment gone, and plan-zai untouched. The rollback leg of the ship plan. */
  async function removeCodingDeployment({ alias = CODING_ALIAS } = {}) {
    const listed = await proxy.listModels();
    if (!listed.ok) return { ok: false, why: listed.why ?? "the proxy would not say what it serves" };
    const rows = (Array.isArray(listed.rows) ? listed.rows : []).filter((row) => row.alias === alias);
    if (rows.length === 0) return { ok: false, why: `${alias} is not on this proxy, so there was nothing to remove.` };
    const removed = [];
    for (const row of rows) {
      const gone = await proxy.deleteModel(row.id);
      if (!gone.ok) return { ok: false, why: gone.why ?? `the proxy would not remove ${alias}`, removed };
      removed.push(row.id);
    }
    return { ok: true, alias, removed };
  }

  // ---- what the operator reads -------------------------------------------------------------------

  /**
   * The per-workspace rollup the admin Spend panel draws one quiet line from.
   *
   * NOTHING IS SUMMED THROUGH A NULL. `minutesUnmeasured` and `spendUnmeasured` carry the COUNT of
   * rows that were not measured, so a line can say "38 minutes across 4 tasks, two not measured"
   * instead of quietly reporting a smaller number as the whole. That is the Spend panel's own
   * written rule and it is the reason these are counts rather than a boolean.
   */
  function rollup(slug = "") {
    // IN SQL AND NOT IN A LOOP OVER EVERY ROW, because the admin panel calls this on every refresh
    // and this table only grows. COUNT(minutes) counts the rows that HAVE one, which is how the
    // unmeasured count comes out of the same pass as the total -- and SUM ignores a NULL rather than
    // treating it as a zero, which is the arithmetic this whole file is careful about.
    const rows = (String(slug ?? "").length > 0 ? rollupForTenant.all(String(slug)) : rollupAll.all());
    return rows.map((record) => ({
      slug: String(record.tenant ?? ""),
      tasks: Number(record.tasks ?? 0),
      running: Number(record.running ?? 0),
      minutes: Math.round((Number(record.minutes ?? 0)) * 10) / 10,
      minutesUnmeasured: Number(record.tasks ?? 0) - Number(record.minutes_measured ?? 0),
      // NULL WHEN NOTHING WAS MEASURED, not zero. SUM over all-NULLs is NULL, and that is the answer
      // the panel and the CLI both need to be able to tell from "this workspace spent nothing".
      spendUsd: numberOrNull(record.spend_usd),
      spendUnmeasured: Number(record.tasks ?? 0) - Number(record.spend_measured ?? 0),
      e2bTasks: Number(record.e2b_tasks ?? 0),
      providers: String(record.providers ?? "").split(",").filter((one) => one.length > 0).sort(),
      // AN E2B TASK'S MODEL SPEND IS NOT METERED HERE AND THE LINE SAYS SO. An E2B microVM cannot
      // reach titanbot-proxy, so its model calls go straight to a vendor on whatever credential the
      // template carries. Minutes are real; dollars are E2B's own bill. CODE-3.
      e2bNote: Number(record.e2b_tasks ?? 0) > 0
        ? `${Number(record.e2b_tasks)} of these ran on a cloud sandbox, whose model spend is not metered through this system`
        : "",
    })).sort((left, right) => left.slug.localeCompare(right.slug));
  }

  return {
    settings,
    openTask,
    closeTask,
    sweepTaskKeys,
    ensureCodingDeployment,
    removeCodingDeployment,
    rollup,

    /** One workspace's rows, newest first, for the operator's list. */
    listTasks(slug = "", limit = 50) {
      const capped = Math.max(1, Math.min(Number(limit) || 50, 500));
      return (String(slug ?? "").length > 0 ? selectForTenant.all(String(slug), capped) : selectAll.all(capped)).map(taskRow);
    },

    /** One row by its number, for a close that wants to know what it is closing. */
    task(id) { return taskRow(selectRow.get(Number(id))); },

    /** What is running in one workspace right now, which is what the concurrency cap counts. */
    running(slug) { return openRows(slug); },

    /**
     * A setting written. The numbers are validated here rather than at the route, so the CLI and the
     * panel cannot disagree about what a legal cap is.
     */
    setSettings({ slug = "", actor = "", ...asked } = {}) {
      const target = String(slug ?? "").trim();
      const name = (base) => (target.length > 0 ? codeSetting(base, target) : base);
      const written = [];
      if (asked.provider !== undefined) {
        const provider = String(asked.provider ?? "").trim().toLowerCase();
        if (!CODE_PROVIDERS.includes(provider)) {
          return { ok: false, error: "bad_request", message: `A coding task runs either on this system's own computer or on a cloud sandbox, so name one of: ${CODE_PROVIDERS.join(", ")}.` };
        }
        store.setSetting(name(CODE_PROVIDER_SETTING), provider, actor);
        written.push("provider");
      }
      if (asked.model !== undefined) {
        const model = String(asked.model ?? "").trim();
        if (!model.startsWith(PLAN_MODEL_PREFIX)) {
          return { ok: false, error: "bad_request", message: "A coding task runs on one of this system's own plan models, so the name has to start with plan-." };
        }
        store.setSetting(name(CODE_MODEL_SETTING), model, actor);
        written.push("model");
      }
      for (const [field, setting] of [
        ["capUsd", CODE_CAP_USD_SETTING], ["wallClockMinutes", CODE_MINUTES_SETTING],
        ["concurrent", CODE_CONCURRENT_SETTING], ["daily", CODE_DAILY_SETTING],
        ["cpus", CODE_CPUS_SETTING], ["memoryGb", CODE_MEMORY_GB_SETTING],
      ]) {
        if (asked[field] === undefined) continue;
        const value = Number(asked[field]);
        if (!Number.isFinite(value) || value <= 0) {
          return { ok: false, error: "bad_request", message: `${field} has to be a number greater than zero, so nothing was changed.` };
        }
        store.setSetting(name(setting), String(value), actor);
        written.push(field);
      }
      // WRITE ONLY, BOTH WAYS. Setting it answers a length and never the value; clearing it is the
      // only other thing that can be done to it.
      if (asked.e2bKey !== undefined) {
        const value = String(asked.e2bKey ?? "").trim();
        if (value.length === 0) {
          return { ok: false, error: "bad_request", message: "A cloud sandbox account was not given, so nothing was changed." };
        }
        store.setSetting(CODE_E2B_KEY_SETTING, value, actor);
        written.push("e2bKey");
      }
      if (asked.clearE2bKey === true) {
        store.setSetting(CODE_E2B_KEY_SETTING, "", actor);
        written.push("clearE2bKey");
      }
      return { ok: true, written, settings: settings(target) };
    },

    /**
     * The E2B key, for the ONE caller that may have it: the open path, for a workspace set to E2B.
     * It is not on any route and not in any listing; SECRET_SETTINGS keeps it out of the second.
     */
    e2bKeySet() { return store.getSetting(CODE_E2B_KEY_SETTING, "").length > 0; },
  };
}
