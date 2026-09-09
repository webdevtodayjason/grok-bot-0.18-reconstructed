/*
 * TITAN-CATALOG-1 — one click on Add, and where the sequence went.
 * ----------------------------------------------------------------
 * A person clicks the round Add on a catalog row and a few seconds later has an agent that greets
 * them in its own voice, already knowing its operating rules, holding its playbooks, carrying its
 * jobs switched off, and saying which apps it still needs.
 *
 * That sequence used to live HERE, as eight gateway calls in a fixed order, and it was the only
 * place it lived. Titan could not do any of it: asked for an Instagram marketer he created a blank
 * agent with an invented persona, no memories, no playbooks and no jobs (measured on
 * grok-bot-local-vm 2026-09-09, one tool call in the whole turn). Writing the sequence a second
 * time for the agent would have given the product two imports that drift within a month, so the
 * sequence moved into the box instead — source/host/extensions/marketplace/marketplace-bot-import.ts
 * — behind the gateway verb `importMarketplaceBot`. The console's Add and the agent's request are
 * two doors onto ONE import, and the receipt a person reads is the same either way.
 *
 * What is left in this file is the console's half and nothing else: the roster read the page does
 * before it offers Add, the one call, and the two sentences a browser has to be able to say for
 * itself. The ORDER, the persona composition, the fact splitting, the document naming, the cron
 * rule, the app buckets and the plain-words receipt are all in the host module now, pinned by
 * tests/host-marketplace-bot-import.test.mjs. There is no second copy here to disagree with them.
 *
 * The bot's ID is what gets sent, never the row. The host resolves the row out of its own bundled
 * catalog, so a page holding a LIST CARD — which carries no instructions, memories, skills,
 * routines or apps — cannot quietly import an empty bot.
 *
 * The report is still the authoritative receipt. A box with no model configured gives a silent
 * agent and no first message at all, so the panel card, not the conversation, is what says what
 * happened.
 */
(function attachBotSetup(global) {
  "use strict";

  const text = (value) => String(value ?? "").trim();
  const listOf = (value) => (Array.isArray(value) ? value : []);
  const agentRecords = (answer) => listOf(answer).filter((a) => a && typeof a === "object");

  /**
   * The roster row that already carries this bot's exact name, or null. Read-only, and the only
   * thing a second click has to do: the page asks this before it offers Add so the card can say
   * "already on the roster" without the box writing anything. The import checks the same thing
   * again on its own side, because a caller that skips this must not be able to make a double.
   */
  async function alreadyOnRoster(gateway, bot) {
    const name = text(bot && bot.name);
    if (!name) return null;
    const roster = agentRecords(await gateway.call("listAgents", {}));
    return roster.find((agent) => text(agent.name) === name) ?? null;
  }

  const emptyReport = () => ({
    alreadyExisted: false,
    agent: null,
    agentId: null,
    memories: { added: 0, duplicates: 0, rejected: [] },
    skills: { imported: [], reused: [], skipped: [] },
    routines: { created: [], notCreated: [] },
    apps: { connected: [], addable: [], informational: [], byo: [] },
    integrations: { connected: [], offered: [], informational: [], unavailable: [] },
  });

  const failed = (name, message) => ({
    state: "failed",
    name,
    ...emptyReport(),
    message,
    rolledBack: "Nothing was created, so the roster is as you found it.",
  });

  // A box older than this console does not carry the import verb, and the relay answers 404 with
  // the host's own words. That is one specific thing and it deserves one specific sentence: a bare
  // "unknown gateway method" on the card would read as a bug in the page. It happens on a workspace
  // whose box has not been updated yet while the console it loads has, which is every workspace for
  // the few minutes between the two, and any workspace deliberately left on an older box.
  const BOX_IS_OLDER = /unknown gateway method/i;

  /**
   * Add one bot. Options: { onProgress, duplicate }.
   *
   * `duplicate` is the deliberate second copy — the page asks for it behind its own button, so the
   * documented "<name> copy" behaviour stays reachable without a first click silently making a
   * second agent.
   *
   * `installedPluginIds` is gone from the options on purpose. It was never once passed by the
   * product, so every receipt this console ever drew said nothing was connected. The box works out
   * what it already carries for itself now, and there is no argument left for a caller to forget.
   */
  async function setUpBot(gateway, bot, options) {
    const opts = options || {};
    const progress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    if (bot == null) throw new Error("there is no bot to set up");
    const wanted = text(bot.name);
    if (!wanted) throw new Error("that catalog row has no name");
    const id = text(bot.id);
    if (!id) throw new Error("that catalog row has no id, so the box cannot look it up");

    // One round trip, so the phases are the two a browser can honestly report: it started, and it
    // is done. The step text the page shows while it waits is the page's own.
    progress({ phase: "creating", name: wanted });

    let report;
    try {
      report = await gateway.call("importMarketplaceBot", {
        id,
        ...(opts.duplicate === true ? { duplicate: true } : {}),
      });
    } catch (error) {
      const said = String((error && error.message) ?? error);
      if (BOX_IS_OLDER.test(said)) {
        return failed(wanted, `This workspace's box is older than the console and does not know how to set a bot up yet. Nothing was created. It will work once the box has been updated.`);
      }
      return failed(wanted, `Setting up ${wanted} stopped: ${said}.`);
    }

    if (report == null || typeof report !== "object") {
      return failed(wanted, `Setting up ${wanted} stopped: the box answered with nothing.`);
    }

    progress({ phase: "introducing", name: text(report.name) || wanted });
    return report;
  }

  global.__botSetup = { setUpBot, alreadyOnRoster };
})(typeof window !== "undefined" ? window : globalThis);
