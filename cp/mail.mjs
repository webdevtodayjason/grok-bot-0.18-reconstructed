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
