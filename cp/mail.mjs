// cp/mail.mjs -- the per-bot address directory (MAIL-2, docs/MAIL.md).
//
// WHAT THIS SERVICE OWNS, and it is only this: which six digit code belongs to which bot in which
// workspace. It mints a code, it answers a lookup, and it holds the approved-senders switch. It
// makes no Resend call, it holds no Resend key, and it has no webhook route.
//
// WHY THE WEBHOOK DID NOT MOVE HERE, measured 2026-09-09 before a line of this was written. The
// plan sentence said Resend's email.received should hit the control plane. Against the live system
// that costs: a flip of the only enabled myagents.email hook (which points at the relay and has
// since 2026-09-08 03:04:03Z) with a window where mail drops; surgery on cp/server.mjs's
// readJsonBody, because handle() reads and discards the raw body before any route sees it and a
// Svix signature over a re-serialized parse never verifies; a brand new delivery door on the relay
// anyway, since only the relay holds the gateway bearers; and a hard new dependency where this
// service being down stops mail for every customer. It buys nothing the directory alone does not
// buy. So Resend keeps hitting the relay, which already verifies Svix by hand, already dispatches
// per tenant, already writes a ledger and already delivers -- and this service answers lookups.
//
// The address shape and the code regex are ui/mail-svix.mjs, shared with the relay rather than
// written twice. Two readers of "what is a localpart" is how two halves come to disagree about
// whose mail a message is.
import { MAIL_CODE_RE, codeAddress, domainOf, localpartOf, mailCodeOf } from "../ui/mail-svix.mjs";

/** The product domain every bot's address is at. One environment variable, one default. */
export const MAIL_DOMAIN_DEFAULT = "myagents.email";
export const mailDomain = (env = process.env) =>
  String(env?.CP_MAIL_DOMAIN ?? "").trim().toLowerCase() || MAIL_DOMAIN_DEFAULT;

/** The admin_settings row that holds one workspace's approved-senders switch. */
export const approvedSendersSetting = (slug) => `mail.approvedSenders.${String(slug ?? "")}`;

/**
 * A roster as this service is willing to read it. The relay sends whatever listAgents answered, so
 * this is the narrowing: a GROUP CHAT is on that roster and is not something that can hold an email
 * address, and an entry with no id is not an agent at all.
 */
export function normalizeAgents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (entry?.isGroup === true) continue;
    const id = String(entry?.id ?? entry?.agentId ?? "").trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(entry?.name ?? entry?.agentName ?? "").trim() });
  }
  return out;
}

/**
 * The directory, over a store.
 *
 * Every answer carries the domain, because the relay refuses a recipient at any OTHER domain before
 * it looks anything up: Resend's webhook is account-wide rather than domain-scoped, and this
 * account also receives anvilmail.io.
 */
export function createMailDirectory({ store, domain = mailDomain(), now = () => Date.now() } = {}) {
  const at = String(domain ?? "").trim().toLowerCase();

  /** One row as the relay reads it. The store's row minus the columns nothing outside needs. */
  const row = (record) => (record == null ? null : {
    agentId: record.agentId,
    code: record.code,
    address: record.address,
    agentName: record.agentName,
    state: record.state,
  });

  /** Whether this workspace only takes mail from addresses somebody has allowed. Off by default. */
  const approvedSendersOnly = (slug) => store.getSetting(approvedSendersSetting(slug), "") === "on";

  const tenantAnswer = (slug) => ({
    addresses: store.listMailAddresses(slug).map(row),
    approvedSendersOnly: approvedSendersOnly(slug),
    senders: approvedSendersOnly(slug) ? store.listSenders(slug).map((entry) => entry.sender) : [],
  });

  return {
    domain: at,

    /**
     * Every code this workspace's bots hold, or every workspace's when no slug is given. Retired
     * rows are in the answer and say so: the relay refuses them, and the operator's list has to
     * show that an address is dead rather than that it never existed.
     */
    directory(slug = null) {
      const tenants = {};
      if (slug != null && String(slug).length > 0) {
        tenants[String(slug)] = tenantAnswer(String(slug));
      } else {
        for (const record of store.listMailAddresses()) {
          if (tenants[record.tenant] == null) tenants[record.tenant] = tenantAnswer(record.tenant);
        }
      }
      return { domain: at, tenants, measuredAt: new Date(now()).toISOString() };
    },

    /**
     * Mint whatever this workspace's roster is missing, and answer with the whole of it.
     *
     * Safe to run every five minutes for ever: a bot that already has a code gets its own code back
     * and no second row is written. That is what gets a bot created at 08:00 a working address by
     * 08:05 with nobody touching the box it lives in.
     */
    mint(slug, agents) {
      const tenant = String(slug ?? "").trim();
      if (tenant.length === 0) return { error: "bad_request", message: "Name the workspace these agents belong to." };
      // NOTHING MINTS FOR A WORKSPACE THAT IS GONE, OR GOING.
      //
      // Measured on the R750 2026-09-10: a removal retires every active address at its second step
      // and keeps serving the tenant row to the relay until its eighth, so the five minute sweep ran
      // 28.7 s into the teardown, read a roster off a box that was still alive, posted here, and this
      // wrote agent218973@myagents.email ACTIVE for a customer who no longer existed. The row
      // outlived the tenant, the ledger, the accounts and the slug, and nothing would ever have
      // retired it: the sweep only retires codes for a roster it can READ, and that box is gone.
      //
      // One read of the tenant table closes that window for ever, wherever the mint comes from. The
      // operator's own workspace is adopted and carries a row like any other, so it is unaffected.
      if (typeof store.getTenant === "function" && store.getTenant(tenant) == null) {
        return {
          error: "no_such_workspace",
          message: `There is no workspace called ${tenant}, so no address was minted.`,
          domain: at, slug: tenant, minted: 0, retired: 0, addresses: [], approvedSendersOnly: false, senders: [],
        };
      }
      // What this workspace already held, so `minted` counts the addresses this pass actually made
      // rather than the bots it looked at. The relay logs that number every five minutes for ever,
      // and a number that never falls to zero is a number nobody reads.
      //
      // ACTIVE rows only, and measured 2026-09-09 that this matters: a bot whose address has been
      // retired gets a fresh one on the next sweep, and counting its gravestone as "already held"
      // reported "0 minted" on the pass that minted it.
      const before = new Set(store.listMailAddresses(tenant).filter((row) => row.state === "active").map((row) => row.agentId));
      const roster = normalizeAgents(agents);
      let minted = 0;
      for (const agent of roster) {
        const record = store.mintMailCode({ tenant, agentId: agent.id, agentName: agent.name, domain: at });
        if (record != null && !before.has(record.agentId)) minted += 1;
      }
      // AND THE OTHER HALF. Minting alone leaves a deleted bot's address active and routable for
      // ever: measured on the R750 on 2026-09-09, two throwaway gate probes deleted hours earlier
      // still held live addresses, and mail to one of them was accepted, resolved and pushed at a
      // box that has no such bot, ending as send_failed instead of the no_route the design
      // promises for an address belonging to nobody. The roster is already in hand, so the diff
      // costs nothing.
      //
      // ONLY ON A ROSTER THAT SAYS SOMETHING. An empty list is what a box that would not answer
      // looks like from here, and retiring a whole workspace because one gateway call hiccuped is
      // far worse than an address living a few minutes too long.
      let retired = 0;
      if (roster.length > 0) {
        const live = new Set(roster.map((agent) => agent.id));
        for (const record of store.listMailAddresses(tenant)) {
          if (record.state !== "active" || live.has(record.agentId)) continue;
          store.retireMailAddress(record.code);
          retired += 1;
        }
      }
      return { domain: at, slug: tenant, minted, retired, ...tenantAnswer(tenant), measuredAt: new Date(now()).toISOString() };
    },

    /**
     * Whose address this is. The localpart has to BE a code -- agent then six digits and nothing
     * else -- so a name can never resolve here however it is spelled.
     */
    lookup(localpart) {
      const code = mailCodeOf(String(localpart ?? "").toLowerCase());
      if (code.length === 0) return null;
      const record = store.getMailAddressByCode(code);
      if (record == null) return null;
      return { slug: record.tenant, ...row(record) };
    },

    /** The same lookup from a whole address, with the domain checked first. */
    lookupAddress(address) {
      if (domainOf(address) !== at) return null;
      return this.lookup(localpartOf(address));
    },

    /** agent123456@myagents.email for a code this directory would mint. */
    address(code) { return codeAddress(code, at); },

    approvedSendersOnly,
    setApprovedSendersOnly(slug, on, actor = "") {
      store.setSetting(approvedSendersSetting(slug), on ? "on" : "off", actor);
      return approvedSendersOnly(slug);
    },
  };
}

export { MAIL_CODE_RE };

// ---- the send log and its caps (MAIL-3, docs/MAIL.md) -------------------------------------------
//
// WHAT THIS OWNS: the record that a bot sent a mail, and the two numbers that say how many more it
// may send. It still holds no Resend key and makes no Resend call -- the relay does the sending and
// this service says whether it may and writes down that it did.
//
// WHY THE COUNT IS HERE AND NOT IN THE RELAY OR THE BOX. A limit a box counts is a limit a box can
// reset by restarting, and an in-process limiter (ui/job-bus-edge.mjs createRateLimiter) is
// forgiven by a relay restart, which is a thing that happens on every ship. Counting rows in this
// table is the only version of the number that survives both.

/** Thirty an hour for one bot. A bot sends tens of mails a day, not thousands. */
export const SEND_CAP_HOURLY_AGENT = 30;
/** Two hundred a day for a whole workspace. */
export const SEND_CAP_DAILY_WORKSPACE = 200;

export const SEND_HOURLY_SETTING = "mail.send.hourlyPerAgent";
export const SEND_DAILY_SETTING = "mail.send.dailyPerWorkspace";
/**
 * Either cap, for one workspace, when the operator wants a different number for that customer:
 * `mail.send.hourlyPerAgent.<slug>` and `mail.send.dailyPerWorkspace.<slug>`. The per-workspace row
 * wins over the global one, and neither exists until somebody writes it.
 */
export const sendCapSetting = (name, slug) => `${name}.${String(slug ?? "")}`;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** "in 12 minutes". Plain words, because a bot reads this sentence out to a person. */
function inWords(seconds) {
  const whole = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (whole < 60) return "in under a minute";
  if (whole < 3600) { const n = Math.ceil(whole / 60); return `in ${n} minute${n === 1 ? "" : "s"}`; }
  const n = Math.ceil(whole / 3600);
  return `in ${n} hour${n === 1 ? "" : "s"}`;
}

/**
 * The send log, over a store.
 *
 * openSend is a CLAIM and not a note taken afterwards: it checks both caps and inserts the row
 * reading `sending` before the relay has called Resend at all. An unsent mail is recoverable and an
 * unlogged send is not, and "every send is on the record" is the whole justification for the relay's
 * send route existing.
 */
export function createMailSends({ store, now = () => Date.now() } = {}) {
  const capOf = (name, slug, fallback) => {
    for (const value of [store.getSetting(sendCapSetting(name, slug), ""), store.getSetting(name, "")]) {
      const asked = Number.parseInt(String(value ?? "").trim(), 10);
      // A row that is not a positive number falls back rather than uncapping anybody: a typo in a
      // settings row must never be the thing that takes a limit off.
      if (Number.isFinite(asked) && asked > 0) return asked;
    }
    return fallback;
  };

  /**
   * What this workspace may send. Jason's own workspace gets the same numbers as a customer: a cap
   * that exempted the operator would hide its own bugs from the only person who would notice.
   */
  const sendCaps = (slug) => ({
    hourlyPerAgent: capOf(SEND_HOURLY_SETTING, slug, SEND_CAP_HOURLY_AGENT),
    dailyPerWorkspace: capOf(SEND_DAILY_SETTING, slug, SEND_CAP_DAILY_WORKSPACE),
  });

  const refusal = (scope, cap, window, what, oldest, at) => {
    // When the next one can go: the oldest send in the window leaves it one window after it went.
    const leaves = Date.parse(oldest);
    const seconds = Number.isFinite(leaves) ? Math.max(1, Math.round((leaves + window - at) / 1000)) : Math.round(window / 1000);
    return {
      ok: false,
      error: "rate_limited",
      scope,
      cap,
      retryAfterSeconds: seconds,
      message: `${what} ${cap} email${cap === 1 ? "" : "s"} for ${scope === "agent" ? "this hour" : "today"}, `
        + `so nothing was sent. The next one can go ${inWords(seconds)}.`,
    };
  };

  return {
    sendCaps,

    /**
     * Both caps, then the row. The order matters only in what it says: an over-cap call writes no
     * row at all, so a workspace cannot be pushed further over its limit by being refused.
     */
    openSend({ slug, agentId, code = "", to = "", idem = "" } = {}) {
      const tenant = String(slug ?? "").trim();
      const agent = String(agentId ?? "").trim();
      if (tenant.length === 0 || agent.length === 0) {
        return { ok: false, error: "bad_request", message: "Name the workspace and the bot this send is from." };
      }
      const caps = sendCaps(tenant);
      const at = now();
      const perAgent = store.agentMailSendWindow(tenant, agent, new Date(at - HOUR_MS).toISOString());
      if (perAgent.count >= caps.hourlyPerAgent) {
        return refusal("agent", caps.hourlyPerAgent, HOUR_MS, "That bot has sent its", perAgent.oldest, at);
      }
      const perWorkspace = store.tenantMailSendWindow(tenant, new Date(at - DAY_MS).toISOString());
      if (perWorkspace.count >= caps.dailyPerWorkspace) {
        return refusal("workspace", caps.dailyPerWorkspace, DAY_MS, "This workspace has sent its", perWorkspace.oldest, at);
      }
      const id = store.claimMailSend({ tenant, agentId: agent, code, to, at: new Date(at).toISOString() });
      // `idem` is the relay's business and Resend's; it is not written down, because it is derived
      // from a tool call id and says nothing an operator reading this table would want.
      void idem;
      return { ok: true, id, caps };
    },

    /** What happened to a claimed row: `sent`, `failed`, `no_key` or `key_unreachable`, with the
     *  provider's id when there is one. KEYS-1 added the last: the sending key is the operator's and
     *  lives here now, so "nobody pasted one" and "the relay could not read it" are different rows. */
    closeSend(id, outcome = "", resendId = "", detail = "") {
      const row = Number(id);
      if (!Number.isFinite(row) || row <= 0) return { ok: false, error: "bad_request", message: "Name the row to settle." };
      store.settleMailSend(row, { outcome, resendId, detail });
      return { ok: true, id: row };
    },

    /** The operator's list for one workspace, newest first. */
    listSends(slug, limit = 50) { return store.listMailSends(String(slug ?? ""), limit); },
  };
}
