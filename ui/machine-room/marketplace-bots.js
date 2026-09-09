/*
 * Marketplace — the Bots tab, the bot page, and Import Bot.
 * ---------------------------------------------------------
 * The Marketplace panel owns the two pill tabs (Plugins and Bots); this file owns everything
 * inside the Bots one. It is loaded by index.html before app.js and attaches
 * window.__marketplaceBots = { render(container) }, which the panel calls with the element the
 * Bots tab should fill. Nothing here reaches into app.js: the two touch only through that call
 * and the small set of optional globals documented below.
 *
 * Three rules this file holds to, for the same reason gateway-adapter.js holds to its own:
 *
 *   - The catalog is read through the gateway, never from a JSON file beside this page. One
 *     catalog (source/shared/marketplace/catalog.ts, bundled into the host and served by
 *     listMarketplace) is what the console and the agents' own SearchPlugins both see; a second
 *     copy here would drift within a week and the two surfaces would disagree about what exists.
 *
 *   - A control that cannot work is not drawn. Import Bot needs createAgent and
 *     importAgentWorkflowText; an Add button on a missing integration needs an install path. Where
 *     one is absent the page says so in place of the button rather than offering a click that
 *     silently does nothing.
 *
 *   - The import reports what the HOST did, not what was asked for. Every skill is read back
 *     through getAgentWorkflows and a skill the host skipped is named with the host's own reason.
 *
 * The persona field: the host stores an agent as { name, description, title } (profile.json,
 * source/host/agents/agent-profile.ts) and the only text that reaches the model as the agent's
 * identity is name + description (renderAgentProfileUpdate in sand-agent-profile-prompt.ts, and
 * the CreateAgent tool's own parameter description calls `description` "the new agent's persona /
 * instructions"). There is no separate persona or systemPrompt field. So an imported bot's
 * description is the template's description followed by its instructions, in that order, and
 * docs say so. `title` is the operator-facing Role and is left for the operator.
 *
 * BOTS-4, and what changed on this page: a bot is now FOUR blocks, in this order and these words --
 * Memories "Facts it already knows", Skills "Playbooks it can run", Routines "Jobs that run on
 * their own", Integrations "Apps it can use". Memories replaced Instructions as the first block
 * because the 65 community rows carry no instructions at all: their operating rules ARE their
 * memories, the generator makes the first one the row's `instructions` (so the identity rule above
 * is unchanged), and adding the bot seeds every one of them into its own memory store. The rail's
 * words are pinned by tests/machine-room-bots-tab.test.mjs, because "Facts it already knows" is
 * what a person was shown and a paraphrase of it is a different product.
 *
 * THE LIST IS CARDS. listMarketplace answers a card projection -- no memory text, no skill bodies,
 * no routine summaries -- because the full 72 rows are several hundred kilobytes on a relay that
 * buffers each body whole. Opening a bot fetches its own row through getMarketplaceItem, which the
 * host has always served and this console had never called, and the fetched row is what Add works
 * from, for a pack as much as for a single bot. A row that cannot be fetched refuses the import in
 * one sentence rather than importing the half of it the list happened to carry.
 *
 * Optional globals, all of them degradable:
 *   window.__machineRoomAdapter    — the live adapter app.js built (addConnector, installShellTool,
 *                                    selectContext). Absent offline; the page then says which
 *                                    controls are not available rather than drawing dead ones.
 *   window.__marketplacePlugins    — the Plugins tab's own surface, when that half is loaded:
 *                                    { install(pluginId), open(pluginId), installedIds() }. When
 *                                    it is there an Add button on this page goes through it, so
 *                                    both tabs install by exactly one path; when it is not, the
 *                                    fallback is adapter.addConnector / adapter.installShellTool,
 *                                    which IS the connector editor's path (POST /connectors +
 *                                    refreshMcp).
 *   window.__botSetup              — BOTS-4's setup sequence, in its own file so that the page and
 *                                    the sequence are not one file two builders share:
 *                                    { alreadyOnRoster(gateway, bot), setUpBot(gateway, bot, opts) }.
 *                                    Absent on a build that does not carry it, and the page then
 *                                    falls back to importBot below and says so in plain words:
 *                                    the agent and its playbooks land, its memories and its
 *                                    routines do not.
 */
(function attachMarketplaceBots(global) {
  "use strict";

  // ------------------------------------------------------------------ the gateway
  // The same route gateway-adapter.js uses for every command: the relay holds the gateway token
  // and proxies /api/<method>. A command this host has never heard of answers
  // {"error":"unknown gateway method: ..."} and nothing else does, so that one string is the
  // difference between "this box is older than the catalog" and "the host refused".
  const UNKNOWN_COMMAND = /unknown gateway method/i;
  function relayGateway() {
    return {
      async call(method, args) {
        const response = await global.fetch(`/api/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args == null ? {} : args),
        });
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        if (!response.ok) throw new Error((body && body.error) || `${method} failed (${response.status})`);
        return body;
      },
    };
  }

  const adapterOf = () => global.__machineRoomAdapter ?? null;
  const pluginsTabOf = () => global.__marketplacePlugins ?? null;
  const botSetupOf = () => global.__botSetup ?? null;

  // ------------------------------------------------------------------ small helpers
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const text = (value) => String(value ?? "").trim();
  const listOf = (value) => (Array.isArray(value) ? value : []);

  // ------------------------------------------------------------------ the four blocks, read off a row
  //
  // A community row carries `memories`, `routines` and `apps`; the seven first-party rows carry
  // none of the three and the catalog derives a single memory from their `instructions`, so both
  // shapes read the same here and the page has no "is this one of ours" branch in it.
  //
  // `counts` is what the CARD carries in place of the arrays. The list draws from it; the page
  // draws from the fetched row. Where a card is all the page has -- a detail fetch that failed --
  // the block says the row could not be read rather than "this bot has no memories", which is a
  // different and untrue sentence.
  const memoriesOf = (bot) => listOf(bot && bot.memories)
    .map((row) => (typeof row === "string" ? { text: row } : row))
    .filter((row) => row != null && text(row.text ?? row.description).length > 0);
  const routinesOf = (bot) => listOf(bot && bot.routines).filter((row) => row != null && typeof row === "object");
  const countOf = (bot, field, rows) => {
    if (rows.length > 0) return rows.length;
    const declared = Number((bot && bot.counts && bot.counts[field]));
    return Number.isFinite(declared) && declared > 0 ? Math.trunc(declared) : 0;
  };
  /** True when the row is the list's card projection rather than the whole thing. */
  const isCardOnly = (bot) => bot != null && bot.counts != null && memoriesOf(bot).length === 0 && countOf(bot, "memories", []) > 0;

  /**
   * MEASURED ON grok-bot-local-vm, 2026-09-09: opening a bot drew "This bot's own row could not be
   * read from the host" for as long as getMarketplaceItem was in flight, because the page paints
   * the card first and only knows a fetch FAILED, never that one is still running. On a catalog of
   * seven rows nobody saw it; on 72 it is the first thing a person reads on the page, and it is not
   * true. A read that has not answered yet says so, in its own words, and never tells somebody to
   * close a page that is about to fill itself in.
   */
  const isDetailPending = (bot) => bot != null && detailReads.has(text(bot.id));
  const cardOnlyLine = (bot, whatFailed, whatIsComing) => (isDetailPending(bot)
    ? `Reading this bot's own row from the host, so ${whatIsComing} will be here in a moment.`
    : `This bot's own row could not be read from the host, so ${whatFailed}. Close it and open it again.`);

  /**
   * The apps block, in the upstream's own vocabulary where the row carries one.
   *
   * `apps` is what the community rows carry: the name as written on the source page, the label a
   * person reads, the sentence THIS bot wrote about what it does with that app, the plugin id when
   * we carry one, and how it is offered. `integrations` (plugin ids, which the validator checks and
   * SearchPlugins reads) is unchanged and is what a row without `apps` is drawn from, so the seven
   * first-party rows are untouched.
   */
  function appsOf(bot) {
    const declared = listOf(bot && bot.apps).filter((row) => row != null && typeof row === "object");
    if (declared.length > 0) {
      return declared.map((row) => ({
        name: text(row.name),
        label: text(row.label) || text(row.name),
        line: text(row.line ?? row.description),
        // The sentence this bot wrote about the app, kept by the generator even when another bot
        // wrote the same one. `line` is the sentence that is this row's alone; this is the shared
        // one, and it is still the bot's own words about the app, so it is drawn rather than
        // leaving a row with a name and nothing under it.
        fallbackLine: text(row.fallbackLine),
        pluginId: text(row.pluginId ?? row.plugin),
        offer: text(row.offer) || (text(row.pluginId ?? row.plugin) ? "connect" : "byo"),
      }));
    }
    return listOf(bot && bot.integrations).map(text).filter(Boolean)
      .map((id) => ({ name: id, label: id, line: "", pluginId: id, offer: "connect" }));
  }

  // The cron the generator emits is one of a handful of shapes, and every one of them carries a
  // `scheduleNote` in plain words beside it. This is the fallback for a row that carries the
  // expression and no words: a person reads "Every weekday at 9:00", never "0 9 * * 1-5".
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function scheduleWords(routine) {
    const note = text(routine && routine.scheduleNote);
    if (note) return note;
    const cron = text(routine && routine.schedule);
    if (!cron) return "";
    const [minute, hour, day, month, weekday] = cron.split(/\s+/);
    const at = /^\d+$/.test(hour) && /^\d+$/.test(minute)
      ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      : "";
    const clock = at ? ` at ${at}` : "";
    if (weekday === "1-5") return `Every weekday${clock}`;
    if (/^\d$/.test(weekday ?? "")) return `Every ${DAYS[Number(weekday)] ?? "week"}${clock}`;
    if (day === "1" && month !== "*") return `Once a quarter${clock}`;
    if (day === "1") return `Once a month${clock}`;
    if (day === "*" && weekday === "*") return `Every day${clock}`;
    return `On the schedule this bot names${clock}`;
  }

  // The tile is drawn, never fetched: the catalog carries { color, shape } and no image URL, so a
  // box with no network still paints the whole Bots tab. The face is two eyes and a mouth in
  // characters for the same reason.
  const SHAPES = { circle: "50%", squircle: "30%", rounded: "18%", square: "8%" };
  const FACES = ["◕ ◡ ◕", "• ᴗ •", "◠ ‿ ◠", "◔ ◡ ◔", "> ◡ <", "◉ ‿ ◉"];
  const faceFor = (id) => FACES[[...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0) % FACES.length];
  // QOL-LOGOS: a template may carry a tile FILE beside its colour and shape -- a path relative to
  // /machine-room/, which the relay serves out of ui/machine-room/ the same way it serves this
  // script. It is never a URL: nothing on this page is fetched from the internet, so the drawn
  // face below is what a template with no file (or a file that will not load) still gets.
  const LOGO_PREFIX = "marketplace/logos/";
  const logoSrc = (file) => {
    const value = text(file);
    if (!value.startsWith(LOGO_PREFIX) || value.split("/").includes("..")) return "";
    return /^[\w./-]+\.(svg|png)$/i.test(value) ? value : "";
  };
  function tileMarkup(bot, size) {
    const tile = (bot && bot.tile) || {};
    const color = text(tile.color) || "#8b69ea";
    const radius = SHAPES[text(tile.shape)] ?? SHAPES.squircle;
    const px = size === "large" ? 56 : 34;
    const src = logoSrc(tile.file);
    const face = src
      ? `<img class="marketplace-tile-img" src="${escapeHtml(src)}" alt="" data-marketplace-logo="${escapeHtml(src)}" data-marketplace-letter="${escapeHtml(faceFor(bot && bot.id))}" style="width:100%;height:100%;object-fit:contain;border-radius:${radius === "50%" ? "50%" : "18%"}" />`
      : escapeHtml(faceFor(bot && bot.id));
    const padding = src ? "padding:5px;" : "";
    return `<span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;box-sizing:border-box;${padding}width:${px}px;height:${px}px;border-radius:${radius};background:${escapeHtml(color)};color:#0d0f14;font-size:${size === "large" ? 13 : 8}px;letter-spacing:-0.5px;font-weight:700">${face}</span>`;
  }

  // ------------------------------------------------------------------ the import sequence
  // Exported on the namespace so it can be driven by a fake gateway in tests: the order of the
  // calls and the text handed to each one IS the contract, and a click in a browser is no place
  // to pin it.
  //
  // createAgent, then one importAgentWorkflowText per skill, then one getAgentWorkflows read-back.
  // Importing the same bot twice makes a second agent with " copy" appended, the way
  // duplicateAgent does (cloneAgentDisplayName in source/host/agents/agent-clone.ts).
  function personaFor(bot) {
    const description = text(bot && bot.description);
    const instructions = text(bot && bot.instructions);
    if (!instructions) return description;
    if (!description) return instructions;
    return `${description}\n\n${instructions}`;
  }

  const agentRecords = (answer) => listOf(answer).filter((a) => a && typeof a === "object");

  async function importBot(gateway, bot) {
    if (bot == null) throw new Error("no bot to import");
    const before = agentRecords(await gateway.call("listAgents", {}));
    const taken = new Set(before.map((a) => text(a.name)));
    let name = text(bot.name) || "Imported bot";
    // A while, not an if: a third import of the same template lands on "<name> copy copy", which
    // is what duplicating a duplicate does on this host too.
    while (taken.has(name)) name = `${name} copy`;

    const description = personaFor(bot);
    const created = await gateway.call("createAgent", { name, description });
    let agentId = created?.agent?.id ?? created?.id ?? null;
    if (agentId == null) {
      // Older hosts answer the mint with no envelope. The roster diff is what duplicateAgent
      // falls back to in the adapter, so it is what this falls back to as well.
      const known = new Set(before.map((a) => a.id));
      agentId = agentRecords(await gateway.call("listAgents", {})).find((a) => !known.has(a.id))?.id ?? null;
    }
    if (agentId == null) throw new Error("the host accepted createAgent and reported no agent");

    const imported = [];
    const skipped = [];
    for (const skill of listOf(bot.skills)) {
      const skillName = text(skill && skill.name);
      const body = text(skill && skill.body);
      if (!body) {
        skipped.push({ source: skillName || "(unnamed skill)", reason: "the template carries no SKILL.md text for it" });
        continue;
      }
      try {
        const answer = await gateway.call("importAgentWorkflowText", { id: agentId, markdown: body, name: skillName });
        for (const row of listOf(answer?.result?.imported)) {
          imported.push(typeof row === "string" ? row : text(row?.name) || text(row?.id));
        }
        for (const row of listOf(answer?.result?.skipped)) {
          skipped.push({ source: text(row?.source) || skillName, reason: text(row?.reason) || "no reason given" });
        }
        // A host that answers the import with no ledger at all still imported something; the
        // read-back below is what decides, so the asked-for name stands in until then.
        if (answer?.result == null) imported.push(skillName);
      } catch (error) {
        skipped.push({ source: skillName || "(unnamed skill)", reason: String(error?.message ?? error) });
      }
    }

    // What the host actually holds, which is the only honest answer. A name in `imported` that is
    // not in the read-back is reported as missing rather than as a success.
    const workflows = await gateway.call("getAgentWorkflows", { id: agentId }).catch(() => null);
    const held = listOf(workflows).filter((w) => w && w.source !== "automation").map((w) => text(w.name) || text(w.id)).filter(Boolean);
    const wanted = imported.filter(Boolean);
    return {
      agent: { id: agentId, name, description },
      skills: held.filter((n) => wanted.includes(n)),
      allSkills: held,
      imported: wanted,
      skipped,
      missing: wanted.filter((n) => !held.includes(n)),
    };
  }

  // ------------------------------------------------------------------ a TEAM, not a bot
  // TEAMS-1's first slice. A pack row carries `members`, and importing one is a different sequence
  // from importing a bot: the cap is read before anything is written, seven agents are created
  // under names Remove team can find again, and a skill the box's shared library already holds is
  // reused rather than imported a second time.
  //
  // It does NOT reuse importBot above. That function appends " copy" to a name already taken,
  // which is right for a template somebody deliberately imports twice and exactly wrong for a
  // team: a second import must land on the same seven bots, not on seven more called "copy".
  //
  // Three things this fixes, all measured on grok-bot-local-vm on 2026-09-09:
  //   - the shared library on that box holds web-research-pass, -2 and -3, three copies of one
  //     skill left by three imports, because the host suffixes on a name collision and never
  //     dedupes. So every pack skill is namespaced and the library is read BEFORE the first write.
  //   - deleting an agent leaves its skills behind, and there is no undo on the roster. So the
  //     pack has a Remove team that takes back both, found by the two prefixes the catalog row
  //     declares rather than by a manifest a different browser would not have.
  //   - a half-imported team cannot be undone by hand, so a member that fails rolls back every
  //     agent and every skill THIS import created, and nothing it merely found.

  const packMembersOf = (bot) => listOf(bot && bot.members).filter((m) => m != null && typeof m === "object");
  const isTeamPack = (bot) => packMembersOf(bot).length > 0;

  // The prefixes and the refusal come off the catalog row (marketing-team.ts's `packaging`),
  // because this file is served to a browser and cannot import that module. The fallbacks are for
  // a host older than the field, where a pack simply does not draw.
  function packagingOf(bot) {
    const declared = (bot && bot.packaging) || {};
    // NOT text(): the roster prefix is "Marketing \u00b7 " and its trailing space is load-bearing.
    // Trimming it produced "Marketing \u00b7Coordinator" on the roster, which Remove team still
    // matched but no person would have written.
    const raw = (value) => (typeof value === "string" ? value : "");
    return {
      agentPrefix: raw(declared.agentPrefix),
      skillPrefix: raw(declared.skillPrefix),
      capacityRefusal: raw(declared.capacityRefusal),
    };
  }

  /** The same two substitutions renderCapacityRefusal does in the catalog. Pinned equal by the unit test. */
  function renderRefusal(template, remaining, needed) {
    const room = Math.max(0, Math.trunc(Number(remaining) || 0));
    const want = Math.max(0, Math.trunc(Number(needed) || 0));
    return String(template || "")
      .replace("{room}", String(room))
      .replace("{bots}", room === 1 ? "bot" : "bots")
      .replace("{needed}", String(want))
      .replace("{short}", String(Math.max(0, want - room)));
  }

  const memberAgentName = (bot, member) => `${packagingOf(bot).agentPrefix}${text(member && member.role)}`;
  const memberPersona = (member) => {
    const summary = text(member && member.summary);
    const instructions = text(member && member.instructions);
    if (!instructions) return summary;
    if (!summary) return instructions;
    return `${summary}\n\n${instructions}`;
  };

  /**
   * Every workflow the box holds. The library is shared, so any agent answers with the same list --
   * but ONE agent failing to answer must not read as an empty library, because an empty library is
   * exactly the answer that makes the import re-write all ten documents and leave doubles behind.
   * Measured on grok-bot-local-vm 2026-09-09: a single anchor agent stopped answering mid-run and
   * the read came back empty on a box holding 55 rows. So it walks the roster until one answers.
   */
  async function sharedLibrary(gateway, agentId, roster) {
    const ids = [];
    for (const id of [text(agentId), ...listOf(roster).map((agent) => text(agent && agent.id))]) {
      if (id && !ids.includes(id)) ids.push(id);
    }
    for (const id of ids) {
      let rows;
      try { rows = await gateway.call("getAgentWorkflows", { id }); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      return rows.filter((row) => row != null && row.source !== "automation");
    }
    return [];
  }

  /** Delete named rows out of the shared library. Used by the rollback and by Remove team. */
  async function deleteSkillsNamed(gateway, agentId, names, failures, roster) {
    if (!agentId || names.size === 0) return 0;
    let removed = 0;
    for (const row of await sharedLibrary(gateway, agentId, roster)) {
      if (!names.has(text(row.name))) continue;
      try {
        await gateway.call("deleteAgentWorkflow", { id: agentId, workflowId: text(row.id) });
        removed += 1;
      } catch (error) {
        if (failures != null) failures.push(`${text(row.name)}: ${String(error?.message ?? error)}`);
      }
    }
    return removed;
  }

  /**
   * Import a team. Exported on the namespace and driven by a fake gateway in the unit test,
   * because the ORDER of these calls is the contract and a click in a browser is no place to pin
   * it: capacity, roster, library, then one createAgent per member that is missing.
   */
  async function importMarketingTeam(gateway, bot, onProgress) {
    const report = typeof onProgress === "function" ? onProgress : () => {};
    const members = packMembersOf(bot);
    if (members.length === 0) throw new Error("this template carries no team members");
    const { agentPrefix, capacityRefusal } = packagingOf(bot);
    if (!agentPrefix) throw new Error("this template does not say what to call its bots on the roster");

    // FIRST, before a single write. A team that half-fits is worse than one that is refused,
    // because the roster has no undo and nobody can tell which four of seven arrived.
    const capacity = await gateway.call("getAgentCapacity", {}).catch(() => null);
    const roster = agentRecords(await gateway.call("listAgents", {}));
    const byName = new Map(roster.map((agent) => [text(agent.name), agent]));
    const plan = members.map((member) => ({ member, name: memberAgentName(bot, member) }));
    const toCreate = plan.filter((row) => !byName.has(row.name));
    const remaining = Number(capacity && capacity.remaining);
    if (Number.isFinite(remaining) && remaining < toCreate.length) {
      return { state: "refused", message: renderRefusal(capacityRefusal, remaining, toCreate.length), members: [] };
    }

    // The library is read once, through whatever agent already exists. On an empty box there is
    // nothing to ask through and nothing to collide with, so an empty list is the right answer.
    const held = new Set((await sharedLibrary(gateway, text(roster[0] && roster[0].id), roster))
      .map((row) => text(row.name)).filter(Boolean));

    const createdAgents = [];
    const createdSkills = new Set();
    const done = [];
    try {
      let at = 0;
      for (const row of plan) {
        at += 1;
        report({ at, total: plan.length, role: text(row.member.role), phase: "creating" });
        let agent = byName.get(row.name) ?? null;
        const reused = agent != null;
        if (agent == null) {
          const created = await gateway.call("createAgent", { name: row.name, description: memberPersona(row.member) });
          const id = text(created?.agent?.id ?? created?.id);
          if (!id) throw new Error(`the host accepted ${row.name} and reported no bot`);
          agent = { id, name: row.name };
          createdAgents.push(id);
        }
        const skills = [];
        for (const skill of listOf(row.member.skills)) {
          const name = text(skill && skill.name);
          const body = text(skill && skill.body);
          if (!name || !body) continue;
          // Namespaced, so a name already in the library IS this pack's own and reusing it is
          // right. Without the namespace this read would happily adopt a stranger's skill.
          if (held.has(name)) { skills.push({ name, reused: true }); continue; }
          report({ at, total: plan.length, role: text(row.member.role), phase: "importing", skill: name });
          await gateway.call("importAgentWorkflowText", { id: text(agent.id), markdown: body, name });
          held.add(name);
          createdSkills.add(name);
          skills.push({ name, reused: false });
        }
        done.push({ id: text(row.member.id), role: text(row.member.role), agentId: text(agent.id), name: row.name, reused, skills });
      }
    } catch (error) {
      // Roll back exactly what this run made. Skills first, while an agent it can be asked
      // through is still alive.
      const anchor = createdAgents[0] ?? text(roster[0] && roster[0].id);
      await deleteSkillsNamed(gateway, anchor, createdSkills, null, roster).catch(() => {});
      for (const id of createdAgents) await gateway.call("deleteAgent", { id }).catch(() => {});
      return { state: "failed", message: String(error?.message ?? error), members: [] };
    }
    return { state: "done", members: done, created: createdAgents.length, imported: createdSkills.size };
  }

  /**
   * Take a team back: the bots AND the documents. Found from the two prefixes the row declares, so
   * this works in a browser that never ran the import, which is the case a stored manifest fails.
   */
  async function removeMarketingTeam(gateway, bot) {
    const { agentPrefix, skillPrefix } = packagingOf(bot);
    const failures = [];
    if (!agentPrefix || !skillPrefix) return { agents: 0, skills: 0, failures };
    const roster = agentRecords(await gateway.call("listAgents", {}));
    const mine = roster.filter((agent) => text(agent.name).startsWith(agentPrefix));

    // Skills first, while one of this pack's own bots is still there to ask through. They outlive
    // their bot, so a sweep runs even when the roster holds none: a previous removal that deleted
    // the bots and failed on the documents left exactly that.
    const anchor = text((mine[0] ?? roster[0] ?? {}).id);
    const names = new Set((await sharedLibrary(gateway, anchor, roster))
      .map((row) => text(row.name)).filter((name) => name.startsWith(skillPrefix)));
    const skills = await deleteSkillsNamed(gateway, anchor, names, failures, roster);

    let agents = 0;
    for (const agent of mine) {
      try { await gateway.call("deleteAgent", { id: text(agent.id) }); agents += 1; }
      catch (error) { failures.push(`${text(agent.name)}: ${String(error?.message ?? error)}`); }
    }
    return { agents, skills, failures };
  }

  // ------------------------------------------------------------------ installed state
  // The contract's rule, read from the box rather than remembered: a plugin is installed when its
  // connector name -- the catalog's own `connectorName` field -- is a key in connectors.json; a
  // shell tool when the box's own shell can find its program, which is what `listShellTools`
  // answers in `installed`. Its `stored` is the other fact -- whether the host holds the key --
  // and a key is not an install.
  const connectorNameOf = (plugin) => text(plugin?.connectorName) || text(plugin?.install?.name) || text(plugin?.connector) || text(plugin?.id);
  const shellToolIdOf = (plugin) => (typeof plugin?.install === "string" ? text(plugin.install) : text(plugin?.install?.id) || text(plugin?.id));

  async function readInstalledIds(gateway, plugins) {
    const shared = pluginsTabOf();
    if (shared && typeof shared.installedIds === "function") {
      return new Set(listOf(await shared.installedIds()).map(String));
    }
    const installed = new Set();
    const config = await global.fetch("/connectors").then((r) => r.json()).catch(() => null);
    const servers = config && typeof config.mcpServers === "object" && config.mcpServers != null ? config.mcpServers : null;
    const shellRows = await gateway.call("listShellTools", {}).catch(() => null);
    const shellInstalled = new Set(listOf(shellRows).filter((t) => t && t.installed === true).map((t) => text(t.id)));
    for (const plugin of plugins) {
      if (plugin?.kind === "shell-tool") {
        if (shellInstalled.has(shellToolIdOf(plugin))) installed.add(text(plugin.id));
      } else if (servers != null && servers[connectorNameOf(plugin)] != null) {
        installed.add(text(plugin.id));
      }
    }
    return installed;
  }

  // Add on a missing integration. The Plugins tab's own install is preferred so the two tabs share
  // one path; without it this is the connector editor's path, which is the same POST /connectors +
  // refreshMcp the contract names.
  async function installPlugin(plugin) {
    const shared = pluginsTabOf();
    if (shared && typeof shared.install === "function") return shared.install(text(plugin.id));
    const adapter = adapterOf();
    if (plugin.kind === "shell-tool") {
      if (adapter == null || typeof adapter.installShellTool !== "function") {
        return { accepted: false, message: "This console has no shell-tool installer behind it; install it from the Plugins tab." };
      }
      return adapter.installShellTool(shellToolIdOf(plugin));
    }
    if (adapter == null || typeof adapter.addConnector !== "function") {
      return { accepted: false, message: "This console cannot write connectors.json; add it from the Plugins tab." };
    }
    const entry = (plugin.install && typeof plugin.install === "object") ? plugin.install : {};
    if (!text(entry.command)) {
      return { accepted: false, message: `${text(plugin.name) || text(plugin.id)} carries no connector entry in the catalog; add it from the Plugins tab.` };
    }
    return adapter.addConnector({
      name: connectorNameOf(plugin),
      command: text(entry.command),
      args: listOf(entry.args).map(String),
      envNames: Object.keys(entry.env ?? {}),
      replace: plugin.replaces === true || entry.replaces === true,
    });
  }

  // ------------------------------------------------------------------ view state
  // One module-level view, because the panel re-renders the whole tab on every tab switch and a
  // half-read bot page that forgot which tab was open reads as a bug.
  /** The BOT category list a listMarketplace answer carries, or null when it carries none of its own. */
  function botCategoriesOf(answer) {
    const raw = answer && answer.categories;
    if (raw == null || Array.isArray(raw)) return null;
    const declared = listOf(raw.bots).map((entry) => (typeof entry === "string" ? entry : text(entry && entry.name))).filter(Boolean);
    return declared.length ? declared : null;
  }

  const view = { botId: null, page: "memories", query: "", category: "All", notice: "" };
  const imports = new Map();  // bot id -> { state: "running" | "done" | "already" | "failed", ... }
  // The full row for each bot the operator has opened, fetched once through getMarketplaceItem.
  // The in-flight promise is what is cached, not only the settled answer: opening a bot paints
  // twice in quick succession and caching the answer alone fetches the row twice.
  const details = new Map();   // bot id -> the whole row
  const detailReads = new Map();  // bot id -> the promise in flight
  const detailErrors = new Map();  // bot id -> why the row could not be read
  let catalog = null;
  let catalogError = null;
  let installed = new Set();
  // THE NAMES ALREADY ON THIS BOX, read once when the tab opens.
  //
  // "On the roster" used to be derived from `imports` alone -- this browser session's own Add
  // outcomes -- so a reload drew a round "+" on all 72 rows and "Add bot" on every page, and the
  // only way to find out was to press one and read the refusal. MEASURED ON THE R750 demo tenant
  // 2026-09-09 after Recruiting Coordinator was added and confirmed on the roster. It is the same
  // match the setup's own roster check uses: the agent's name equals the bot's.
  let rosterNames = new Set();
  let container = null;
  let loading = false;

  const botsOf = () => listOf(catalog && catalog.bots);
  const pluginsOf = () => listOf(catalog && catalog.plugins);
  // The fetched row wins over the card: the card carries counts and the row carries the text.
  const botById = (id) => details.get(text(id)) ?? botsOf().find((b) => text(b.id) === text(id)) ?? null;
  const pluginById = (id) => pluginsOf().find((p) => text(p.id) === text(id)) ?? null;
  const tagsOf = (bot) => listOf(bot && bot.tags).map(text).filter(Boolean);

  // The catalog's own category list where it carries one (either a flat array or { bots, plugins }),
  // and the categories the bots themselves name where it does not. "All" always leads and
  // "Featured" is only offered when a bot is actually flagged featured.
  function categories() {
    const raw = catalog && catalog.categories;
    const declared = Array.isArray(raw) ? raw : listOf(raw && raw.bots);
    const named = declared.map((c) => (typeof c === "string" ? c : text(c && c.name))).filter(Boolean);
    const fromBots = botsOf().flatMap((b) => [text(b.category), ...tagsOf(b)]).filter(Boolean);
    const featured = botsOf().some((b) => b.featured === true);
    const ordered = [];
    for (const name of [...(named.length ? named : []), ...fromBots]) {
      if (name === "All") continue;
      if (name === "Featured" && !featured) continue;
      if (!ordered.includes(name)) ordered.push(name);
    }
    if (featured && !ordered.includes("Featured")) ordered.unshift("Featured");
    // A CHIP WITH NO MEMBERS IS NOT DRAWN. The host's declared list is a superset of what any one
    // box serves -- "From Titanbot team" and "Sales" both filtered to nothing on 2026-09-09 -- and
    // a chip that empties the page is a control that cannot work, which this file does not draw.
    return ["All", ...ordered.filter((name) => botsOf().some((bot) => inCategory(bot, name)))];
  }

  function matches(bot) {
    const query = view.query.trim().toLowerCase();
    if (!query) return true;
    return [bot.name, bot.description, bot.category, bot.creator, ...tagsOf(bot)]
      .map((v) => String(v ?? "").toLowerCase())
      .some((v) => v.includes(query));
  }

  // A community bot carried up to two categories upstream: the first is its own, the second rides
  // in `tags` so nothing is lost, and the chip reads both -- otherwise a bot filed under Sales and
  // Marketing would be missing from one of the two chips a person tries.
  function inCategory(bot, category) {
    if (category === "All") return true;
    if (category === "Featured") return bot.featured === true;
    return text(bot.category) === category || tagsOf(bot).includes(category);
  }

  // ------------------------------------------------------------------ list view
  const oneLine = (value) => {
    const flat = text(value).replace(/\s+/g, " ");
    return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  };

  function chipsMarkup() {
    // CHIPS, NOT TABS. This row drew `.roster-tab` -- the big underlined pill the panel's own
    // Plugins/Bots switch uses -- while the Plugins half of the SAME panel drew `.tag` inside
    // `.marketplace-chips`, against CSS that has been in styles.css since MARKET-1 (3422). With
    // eight bot categories that read as a run-on line of small caps rather than a filter.
    return `<div class="palette-chips marketplace-chips" role="group" aria-label="Bot categories" data-bot-chips>${categories().map((name) => {
      const active = view.category === name;
      return `<button class="tag${active ? " is-active" : ""}" type="button" data-bot-category="${escapeHtml(name)}" aria-pressed="${active}">${escapeHtml(name)}</button>`;
    }).join("")}</div>`;
  }

  /**
   * A featured bot is a card rather than a row, and it gets the SAME Add.
   *
   * Measured on grok-bot-local-vm 2026-09-09: four of the seven rows this box serves are featured,
   * so they were drawn as cards -- and the Add this wave adds was on none of them. The card is
   * therefore the same shape as a row: a wrapper that is not a button, the open control, and the
   * Add as its sibling.
   */
  function featuredCardMarkup(bot) {
    const id = text(bot.id);
    const onRoster = isOnRoster(bot);
    const skills = countOf(bot, "skills", listOf(bot.skills));
    const add = onRoster
      ? `<span class="status-pill success marketplace-bot-add-state" data-bot-added="${escapeHtml(id)}">on the roster</span>`
      : `<button class="marketplace-bot-add" type="button" data-add-bot="${escapeHtml(id)}"`
        + ` aria-label="Add ${escapeHtml(text(bot.name))} to this box"`
        + ` title="Add ${escapeHtml(text(bot.name))}: it lands on the roster and starts talking">+</button>`;
    return `<div class="plugin-card marketplace-bot-card" data-bot-row="${escapeHtml(id)}">`
      + `<button class="marketplace-bot-card-open" type="button" data-bot-id="${escapeHtml(id)}">`
      + `<span style="display:flex;align-items:center;gap:10px">${tileMarkup(bot, "large")}<span style="display:grid;gap:2px;min-width:0"><strong style="font-size:13px">${escapeHtml(text(bot.name))}</strong><small>${escapeHtml(creditLine(bot))}</small></span></span>`
      + `<p style="margin:0">${escapeHtml(oneLine(bot.description))}</p>`
      + `<span class="tag-list" style="margin:0"><span class="tag">${escapeHtml(text(bot.category) || "Bots")}</span><span class="tag">${skills} skill${skills === 1 ? "" : "s"}</span></span>`
      + `</button>${add}</div>`;
  }

  /**
   * Already here? Either this session added it, or the box was carrying it when the tab opened.
   *
   * A team pack is never one agent -- its members carry the pack's own prefix and its page counts
   * them itself -- so the roster names are not consulted for one.
   */
  function isOnRoster(bot) {
    const outcome = imports.get(text(bot && bot.id));
    if (outcome != null && (outcome.state === "done" || outcome.state === "already")) return true;
    if (isTeamPack(bot)) return false;
    const name = text(bot && bot.name);
    return name !== "" && rosterNames.has(name);
  }

  /** "by Anoop Baliga, from the community" on a community row; our own rows say only the team. */
  function creditLine(bot) {
    const creator = text(bot && bot.creator) || "Titanbot team";
    const note = text(bot && bot.creatorNote);
    return note ? `by ${creator}, ${note}` : `by ${creator}`;
  }

  /**
   * A row is a DIV with two sibling buttons, never a button inside a button.
   *
   * Chrome honours a click on a nested button and fires BOTH handlers, so a nested Add would open
   * the bot page and start the setup on one press -- and a page.click() on it would pass, which is
   * exactly why the gate measures the rectangle instead. The wrapper is a grid: tile, copy, Add.
   */
  function rowMarkup(bot) {
    const id = text(bot.id);
    const onRoster = isOnRoster(bot);
    const add = onRoster
      ? `<span class="status-pill success marketplace-bot-add-state" data-bot-added="${escapeHtml(id)}">on the roster</span>`
      : `<button class="marketplace-bot-add" type="button" data-add-bot="${escapeHtml(id)}"`
        + ` aria-label="Add ${escapeHtml(text(bot.name))} to this box"`
        + ` title="Add ${escapeHtml(text(bot.name))}: it lands on the roster and starts talking">+</button>`;
    return `<div class="marketplace-bot-row" data-bot-row="${escapeHtml(id)}">`
      + `<button class="marketplace-bot-open" type="button" data-bot-id="${escapeHtml(id)}">`
      + tileMarkup(bot, "small")
      + `<span class="marketplace-bot-copy"><strong>${escapeHtml(text(bot.name))} <span class="marketplace-bot-by">${escapeHtml(creditLine(bot))}</span></strong>`
      + `<small>${escapeHtml(oneLine(bot.description))}</small></span></button>`
      + add
      + `</div>`;
  }

  /** A row somebody else wrote. The catalog says so with a credit note; ours carry none. */
  const isCommunity = (bot) => bot != null && (bot.community === true || text(bot.creatorNote).length > 0);

  /** How many rows a topical section shows in the All view before it offers its own chip. */
  const SECTION_CAP = 6;

  function sectionMarkup(name, members, { capped = false, label = null } = {}) {
    if (!members.length) return "";
    const shown = capped && members.length > SECTION_CAP ? members.slice(0, SECTION_CAP) : members;
    const more = shown.length < members.length
      ? `<button class="quiet-button" type="button" data-bot-category="${escapeHtml(name)}">See all ${members.length} in ${escapeHtml(label ?? name)}</button>`
      : "";
    return `<div class="plugin-section-title"><span>${escapeHtml(label ?? name)}</span><span>${members.length}</span></div>`
      + `<div class="plugin-list marketplace-bot-list">${shown.map(rowMarkup).join("")}</div>`
      + (more ? `<div class="marketplace-bot-more">${more}</div>` : "");
  }

  function listMarkup() {
    const bots = botsOf().filter((b) => matches(b) && inCategory(b, view.category));
    const total = botsOf().length;
    const intro = `<div class="panel-intro"><p>A Bot is a ready-made agent: the facts it already knows, the playbooks it can run, the jobs it can run on its own, and the apps it uses. The round Add on a row, or Import Bot on the bot's own page, puts one on this box with all of that in place and it says hello in its own conversation. Its jobs arrive switched off, and nothing it needs is installed without you.</p><span class="status-pill">${total} bot${total === 1 ? "" : "s"}</span></div>`;
    const search = `<div class="field" style="margin:0 0 12px"><label class="sr-only" for="marketplace-bot-search">Search bots</label><input id="marketplace-bot-search" class="search-input" type="search" data-bot-search autocomplete="off" placeholder="Search bots" value="${escapeHtml(view.query)}" /></div>`;

    if (bots.length === 0) {
      const why = total === 0
        ? "This host serves no bots yet. listMarketplace is what carries them, and this box answered with none."
        : "No bot matches that search in this category.";
      return `${intro}${search}${chipsMarkup()}<div class="empty-state">${escapeHtml(why)}</div>`;
    }

    const community = bots.some(isCommunity);
    const featured = view.category === "All" ? bots.filter((b) => b.featured === true) : [];
    const featuredSection = featured.length
      ? `<div class="plugin-section-title"><span>Featured</span></div><div class="panel-grid" style="margin-bottom:18px">${featured.map(featuredCardMarkup).join("")}</div>`
      : "";
    const shown = new Set(featured.map((b) => text(b.id)));
    // OURS FIRST, and only where there is somebody else's row to be first of. On a box whose
    // catalog is still only the seven, this section would be the whole page under a heading, so
    // the ordinary category grouping below is what draws them.
    const ours = view.category === "All" && community
      ? bots.filter((b) => !isCommunity(b) && !shown.has(text(b.id)))
      : [];
    for (const bot of ours) shown.add(text(bot.id));
    const oursSection = sectionMarkup("All", ours, { label: "From the Titanium Bot team" });

    // Sections per category, in the catalog's own order, so the page reads the way the chips do.
    const groups = view.category === "All"
      ? categories().filter((c) => c !== "All" && c !== "Featured")
      : [view.category];
    const sections = groups.map((name) => {
      const members = bots.filter((b) => inCategory(b, name) && !shown.has(text(b.id)));
      for (const bot of members) shown.add(text(bot.id));
      return sectionMarkup(name, members, { capped: view.category === "All" });
    }).join("");
    // A bot whose category is not in the chip list would otherwise vanish from the page entirely
    // -- including one whose category IS "Featured", which no group section covers.
    const rest = bots.filter((b) => !shown.has(text(b.id)));
    const restSection = sectionMarkup("All", rest, { label: "More" });
    // Its own scroll box. 72 rows in an 810px modal column push the search field and the chips off
    // the top of the panel, so the filter a person is using scrolls away from them.
    return `${intro}${search}${chipsMarkup()}<div class="marketplace-bots-scroll" data-bot-scroll>${featuredSection}${oursSection}${sections}${restSection}</div>`;
  }

  // ------------------------------------------------------------------ the bot page
  function instructionsMarkup(bot) {
    const instructions = text(bot.instructions);
    if (!instructions) return `<div class="empty-state">This template carries no instructions, so an import would create an agent with no persona.</div>`;
    return `<div class="panel-card"><h3>How this Bot should work</h3><p style="white-space:pre-wrap;margin-top:8px">${escapeHtml(instructions)}</p></div>`
      + `<span class="field-hint">This text becomes the imported agent's description, which is the only field this host feeds the model as an agent's identity. You can edit it afterwards in the agent's own details panel.</span>`;
  }

  /**
   * MEMORIES: prose, one paragraph after another, no bullets and no headings.
   *
   * The upstream memory NAME is the placeholder "memory 1" on all 444 of them, so it is dropped
   * rather than drawn -- a heading that says "memory 1" is furniture that tells a person nothing.
   * The footnote says what adding the bot actually does with these, because it is the one thing
   * on this page that writes to the agent's own store.
   */
  function memoriesMarkup(bot) {
    const memories = memoriesOf(bot);
    if (!memories.length) {
      const why = isCardOnly(bot)
        ? cardOnlyLine(bot, "its memories are not on this page", "its memories")
        : "This bot knows nothing in advance: it starts with its description and learns as you work with it.";
      return `<div class="empty-state">${escapeHtml(why)}</div>`;
    }
    const paragraphs = memories
      .map((memory) => `<p class="marketplace-memory">${escapeHtml(text(memory.text ?? memory.description))}</p>`)
      .join("");
    // A TEAM PACK SEEDS NOTHING. Its import creates one bot per member with the member's own
    // written brief as its identity and never touches a memory store, so the footnote a single bot
    // carries would be a promise the press does not keep. MEASURED ON THE R750 demo tenant
    // 2026-09-09: the pack's Coordinator holds 0 memories after an import that reported done.
    const hint = isTeamPack(bot)
      ? "This is what the team is for. Adding it creates one bot per member, each with its own written brief as its identity; nothing here is written to a bot's memory."
      : "These are seeded as the bot's own remembered facts when you add it, the first one is also what the bot is told it is, and you can edit or delete any of them from its Memory panel afterwards.";
    return `<div class="panel-card" data-bot-memories>${paragraphs}</div>`
      + `<span class="field-hint">${hint}</span>`;
  }

  function skillsMarkup(bot) {
    const skills = listOf(bot.skills);
    if (!skills.length) {
      const why = isCardOnly(bot)
        ? cardOnlyLine(bot, "its playbooks are not on this page", "its playbooks")
        : "This bot has no playbooks; adding it creates the bot and nothing else.";
      return `<div class="empty-state">${escapeHtml(why)}</div>`;
    }
    // NOT oneLine. This block is where the "Use when…" sentence is the whole point, and oneLine cuts
    // at 140 characters IN THE STRING, so a wider window never recovers it. MEASURED over the
    // shipped catalog on this Mac 2026-09-09: 108 of 263 skill descriptions are longer than that,
    // the longest 436, and six of Recruiting Coordinator's eight ended mid-sentence on the R750.
    // oneLine still belongs on the list rows and the cards, where one line is the promise.
    return `<div class="plugin-list" data-bot-skills>${skills.map((skill) => `<div class="setting-row"><div><strong>${escapeHtml(text(skill.name))}</strong><small>${escapeHtml(text(skill.description))}</small></div></div>`).join("")}</div>`
      + `<span class="field-hint">Each one is written into the box's shared library as its own playbook. The library is shared, so a playbook added here is offered to every bot on this box.</span>`;
  }

  /**
   * ROUTINES: what it does on its own, when, and that it arrives switched off.
   *
   * A routine whose cadence is an event ("when a deal moves", "continuously") gets no schedule from
   * the generator and is NOT created by Add: the host's automations are cron and nothing else, and
   * a routine stored with a trigger it cannot compute a next run for is a job that never runs and
   * looks like one that does. The page says that here rather than after the click.
   */
  function routinesMarkup(bot) {
    const routines = routinesOf(bot);
    if (!routines.length) {
      const why = isCardOnly(bot)
        ? cardOnlyLine(bot, "its jobs are not on this page", "its jobs")
        : "This bot runs nothing on its own: it works when you ask it to.";
      return `<div class="empty-state">${escapeHtml(why)}</div>`;
    }
    const rows = routines.map((routine) => {
      // "Disabled by default." leads a lot of the source summaries, and the line under it says so
      // in our own words, so the sentence would be on the row twice.
      // Whole, for the same reason the skill line is: 19 of the pack's 104 routine summaries are
      // longer than a truncated line and the cadence is often in the tail.
      const summary = text(routine.summary).replace(/^disabled by default\.?\s*/i, "").replace(/\s+/g, " ");
      const words = scheduleWords(routine);
      const when = text(routine.schedule)
        ? `${words || "On a schedule"} — off until you switch it on`
        : words || "This one waits on something this box cannot watch, so adding the bot does not create it.";
      return `<div class="setting-row" data-bot-routine="${escapeHtml(text(routine.name))}"><div>`
        + `<strong>${escapeHtml(text(routine.name))}</strong>`
        + (summary ? `<small>${escapeHtml(summary)}</small>` : "")
        + `<small class="marketplace-routine-when">${escapeHtml(when)}</small>`
        + `</div></div>`;
    }).join("");
    const created = routines.filter((routine) => text(routine.schedule)).length;
    return `<div class="plugin-list" data-bot-routines>${rows}</div>`
      + `<span class="field-hint">${created === routines.length
        ? "All of these are created switched off. Nothing runs until you turn one on from the bot's own Routines panel."
        : `${created} of ${routines.length} are created, switched off; the rest wait on something this box cannot watch, so they are not created at all.`}</span>`;
  }

  /**
   * INTEGRATIONS: the app as the bot names it, what THIS bot does with it, and one of three
   * controls -- installed, Add, or a line and no button at all.
   *
   * The third is the rule commit 1694a3f already set on the Plugins half: a row that installs
   * nothing (X, Meta, LinkedIn, Browserbase) gets no Add anywhere, because there is nothing to
   * add and the press would open a door that writes an entry nothing connects to. An app we carry
   * no plugin for at all is the same shape with different words: it is named as the bot wrote it,
   * said to be unavailable, and the door to adding your own server is named in words rather than
   * drawn as a button this tab cannot open.
   */
  function integrationsMarkup(bot, only = null) {
    const wanted = only == null ? null : new Set(listOf(only).map(text));
    const apps = appsOf(bot).filter((app) => wanted == null || wanted.has(app.pluginId) || wanted.has(app.name));
    if (!apps.length) {
      const why = only != null
        ? "Nothing else is needed."
        : isCardOnly(bot)
          ? cardOnlyLine(bot, "its apps are not on this page", "its apps")
          : "This bot needs no apps: it runs on the box's own built-in tools.";
      return `<div class="empty-state">${escapeHtml(why)}</div>`;
    }
    let byo = 0;
    // THE APP THE BOT NAMES IS THE TITLE, NOT THE PLUGIN THAT COVERS IT.
    //
    // One plugin covers several apps -- Gmail, Google Calendar, Google Sheets and Google Drive are
    // all the Google Workspace connector -- and titling each row with the PLUGIN drew three rows
    // that were the same string end to end, with an Add on each. MEASURED ON THE R750 demo tenant
    // 2026-09-09: Account Research Desk drew four Google rows, three of them identical; 23 of 65
    // community bots draw 2-4. So the title is the surface the bot asked for, the plugin is named
    // under it, and only the first row for a plugin carries the Add -- the second press would
    // install what the first already did.
    const offered = new Set();
    const rows = apps.map((app) => {
      const plugin = app.pluginId ? pluginById(app.pluginId) : null;
      const label = app.label || app.name || (plugin ? text(plugin.name) : "");
      const line = app.line || app.fallbackLine || (plugin ? oneLine(plugin.tagline || plugin.description) : "");
      const through = plugin != null && text(plugin.name) && text(plugin.name) !== label
        ? `through ${text(plugin.name)}`
        : "";
      const here = plugin != null && installed.has(text(plugin.id));
      const already = plugin != null && offered.has(text(plugin.id));
      let control;
      if (here) {
        control = `<span class="status-pill success">installed</span>`;
      } else if (already) {
        control = `<span class="marketplace-app-note">the same connection as above</span>`;
      } else if (plugin != null && plugin.installsNothing !== true && app.offer !== "page") {
        offered.add(text(plugin.id));
        control = `<button class="ghost-button" type="button" data-add-integration="${escapeHtml(text(plugin.id))}">Add</button>`;
      } else if (plugin != null) {
        // Nothing to install, so no Add and no pill pretending there is a state to reach.
        control = `<span class="marketplace-app-note">nothing to install — open its card under Plugins</span>`;
      } else {
        byo += 1;
        control = `<span class="status-pill attention">not available yet</span>`;
      }
      // data-integration stays the PLUGIN this row offers, which is what the Add is about; the app
      // the bot named is carried beside it so a gate can tell three Google rows apart.
      const key = text(plugin ? plugin.id : app.name);
      return `<div class="setting-row" data-integration="${escapeHtml(key)}" data-app="${escapeHtml(text(app.name) || label)}" data-app-offer="${escapeHtml(plugin ? (plugin.installsNothing === true || app.offer === "page" ? "page" : "connect") : "byo")}"><div>`
        + `<strong>${escapeHtml(label)}</strong>`
        + (line ? `<small>${escapeHtml(line)}</small>` : "")
        + (through ? `<small class="marketplace-app-through">${escapeHtml(through)}</small>` : "")
        + `</div>${control}</div>`;
    }).join("");
    const hint = byo > 0
      ? `Add writes the plugin's entry the way the Plugins tab does — the box's connector list, then a refresh — and the key still goes in the form on that plugin's own card afterwards. ${byo === 1 ? "The one this box has no plugin for" : `The ${byo} this box has no plugin for`} can still be connected: Plugins, Add your own, and give it the server's link or command.`
      : "Add writes the plugin's entry the way the Plugins tab does — the box's connector list, then a refresh — and the key still goes in the form on that plugin's own card afterwards.";
    return `<div class="plugin-list" data-bot-apps>${rows}</div><span class="field-hint">${escapeHtml(hint)}</span>`;
  }

  /**
   * THE OUTCOME CARD: what actually landed, and what could not be connected.
   *
   * It is the authoritative receipt. The bot writes its own first message in its own conversation,
   * but a box with no model configured writes nothing at all -- so what was set up has to be
   * readable here as well, or a person on such a box sees a silent bot and no record of the work.
   *
   * Every number on it comes from the setup's read-back, never from the row that was asked for:
   * addMemory answers null on a duplicate and the automation store answers 200 on a write it
   * dropped, so "what we asked for" and "what the box holds" are different lists.
   */
  const openControl = (agent) => (adapterOf() != null && typeof adapterOf().selectContext === "function" && text(agent && agent.id)
    ? `<button class="ghost-button" type="button" data-open-agent="${escapeHtml(text(agent.id))}">Open ${escapeHtml(text(agent.name) || "the bot")}</button>`
    : "");

  function outcomeMarkup(bot) {
    const outcome = imports.get(text(bot.id));
    if (outcome == null) return "";
    if (outcome.state === "running") {
      const step = text(outcome.step) || "Creating the bot, then its memories, its playbooks and its jobs.";
      return `<div class="panel-card" data-bot-setup-running><h3>Adding ${escapeHtml(text(bot.name))}…</h3><p>${escapeHtml(step)}</p></div>`;
    }
    if (outcome.state === "failed") {
      return `<div class="panel-card" style="outline:1px solid var(--amber-500)" data-bot-setup-failed><h3>Not added</h3><p>${escapeHtml(text(outcome.message))}</p>`
        + `<p>${escapeHtml(text(outcome.rolledBack) || "Anything this run had already created was taken back, so the roster is as you found it.")}</p></div>`;
    }
    const agent = outcome.agent ?? {};
    if (outcome.state === "already") {
      // The six packs rely on a deliberate second copy ("<name> copy"), so it stays reachable --
      // behind its own press, which is the difference between a duplicate somebody chose and one
      // they got by clicking Add twice.
      return `<div class="panel-card" data-bot-already="${escapeHtml(text(agent.id))}"><h3>Already on the roster</h3>`
        + `<p>${escapeHtml(text(agent.name) || text(bot.name))} is already on this box, so nothing was created and nothing was changed.</p>`
        + `${openControl(agent)}<button class="quiet-button" type="button" data-add-copy="${escapeHtml(text(bot.id))}">Add another copy</button></div>`;
    }

    const memories = outcome.memories ?? {};
    const skills = outcome.skills ?? {};
    const routines = outcome.routines ?? {};
    const apps = outcome.apps ?? {};
    const line = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const parts = [];
    // FACTS, NOT MEMORIES. The block above shows the catalog's memory PARAGRAPHS; the store holds
    // the facts those paragraphs were split into, and this number is the store's. Saying "8
    // memories" under a page that drew 5 paragraphs is a card disagreeing with the page it sits on,
    // and with its own sentence below, which has always said facts.
    const memoriesAdded = Number(memories.added ?? 0);
    if (memoriesAdded > 0) parts.push(line(memoriesAdded, "fact it remembers", "facts it remembers"));
    // `imported` and `reused` are LISTS, the shape bot-setup.js returns. Number([...]) is NaN, so
    // the playbook clause was dropped on every import of every bot while the sentence underneath it
    // -- built by the setup, which counts the lists -- named the same documents. MEASURED ON THE
    // R750 demo tenant 2026-09-09: "It has 8 memories, 4 jobs" over "8 playbooks" in one card.
    // Lists, the shape both setup paths return. A count is still accepted so an outcome written by
    // an older build is read rather than silently dropped -- which is exactly what Number([...])
    // did to every import until this line was fixed.
    const countOfEither = (value) => (Array.isArray(value) ? value.length : (Number.isFinite(Number(value)) ? Number(value) : 0));
    const skillsImported = countOfEither(skills.imported) + countOfEither(skills.reused);
    if (skillsImported > 0) parts.push(line(skillsImported, "playbook", "playbooks"));
    const created = listOf(routines.created).length;
    if (created > 0) parts.push(`${line(created, "job", "jobs")}, switched off`);
    const summary = parts.length ? `It has ${parts.join(", ")}.` : "It was created with nothing else.";

    const trouble = [];
    for (const row of listOf(memories.rejected)) trouble.push(`a memory was not stored: ${text(row.why) || "the host refused it"}`);
    for (const row of listOf(skills.skipped)) trouble.push(`${text(row.source) || "a playbook"} was skipped: ${text(row.reason) || "no reason given"}`);
    for (const row of listOf(routines.notCreated)) trouble.push(`${text(row.name) || "a job"} was not created: ${text(row.why) || "it names no schedule this box can run"}`);
    const troubleLine = trouble.length ? `<p data-bot-setup-trouble>${escapeHtml(trouble.join("; "))}</p>` : "";

    // What it still cannot reach, named here as well as in its own first message, because the
    // first message needs a model behind it and this card does not.
    // Each bucket holds an APP, not a name: { name, label, description, pluginId }. Mapping those
    // through text() gave "[object Object]" for every one of them, which is what the receipt read
    // on grok-bot-local-vm on 2026-09-09 -- eleven of them in one line, on the one card that is
    // meant to tell a person what still needs connecting.
    const appName = (row) => (row != null && typeof row === "object" ? text(row.label) || text(row.name) || text(row.pluginId) : text(row));
    const notConnected = [...listOf(apps.addable), ...listOf(apps.byo), ...listOf(apps.informational)].map(appName).filter(Boolean);
    const appsLine = notConnected.length
      ? `<p data-bot-setup-apps>Not connected yet: ${escapeHtml(notConnected.join(", "))}. It will ask you for the ones it needs.</p>`
      : `<p data-bot-setup-apps>Every app it uses is already on this box.</p>`;
    const said = text(outcome.message);
    return `<div class="panel-card" data-imported-agent="${escapeHtml(text(agent.id))}" data-bot-setup-done><h3>${escapeHtml(text(agent.name) || text(bot.name))} is on this box</h3>`
      + `<p>${escapeHtml(summary)}</p>${troubleLine}${appsLine}`
      + (said ? `<p>${escapeHtml(said)}</p>` : "")
      + `${openControl(agent)}</div>`;
  }

  // ------------------------------------------------------------------ the team pages
  // A pack gets two pages the six single-bot templates do not have: who the seven are, and what
  // the operator has to provide. Both are read BEFORE the Import button, which is the whole point:
  // the two prerequisites below take days of somebody else\'s time and finding that out afterwards
  // is what strands people.

  function membersMarkup(bot) {
    const members = packMembersOf(bot);
    if (!members.length) return `<div class="empty-state">This template is a single bot, not a team.</div>`;
    const outcome = imports.get(text(bot.id));
    const byId = new Map(listOf(outcome && outcome.members).map((row) => [text(row.id), row]));
    const rows = members.map((member) => {
      const landed = byId.get(text(member.id)) ?? null;
      const reports = member.reportsTo == null
        ? "Reports to Titan"
        : `Reports to the ${text((members.find((other) => other.id === member.reportsTo) || {}).role || member.reportsTo).toLowerCase()}`;
      const skills = listOf(member.skills).map((skill) => `<span class="tag">${escapeHtml(text(skill.name))}</span>`).join("");
      const tools = listOf(member.integrations).map((id) => {
        const plugin = pluginById(id);
        return `<span class="tag">${escapeHtml(plugin ? text(plugin.name) : text(id))}</span>`;
      }).join("");
      const state = landed == null
        ? ""
        : `<span class="status-pill ${landed.reused ? "" : "success"}">${landed.reused ? "already here" : "created"}</span>`;
      return `<div class="setting-row" data-team-member="${escapeHtml(text(member.id))}" style="align-items:flex-start">`
        + `<div style="min-width:0"><strong>${escapeHtml(text(member.role))}</strong><small>${escapeHtml(oneLine(member.summary))}</small>`
        + `<small style="opacity:0.75">${escapeHtml(reports)}</small>`
        + `<span class="tag-list" style="margin:6px 0 0">${skills}${tools}</span></div>${state}</div>`;
    }).join("");
    return `<div class="panel-card"><h3>The team</h3><p>Import creates ${members.length} bots on this box, each with its own instructions and its own playbooks. They are shared across every client you run; what changes per client is a brand profile.</p></div>`
      + `<div class="plugin-list" data-team-members>${rows}</div>`
      + `<span class="field-hint">Every one of them stops at a decision card before anything is posted, sent or published. Remove team on the Instructions page takes back the bots and their documents together.</span>`;
  }

  function firstRunMarkup(bot) {
    const firstRun = (bot && bot.firstRun) || null;
    if (firstRun == null) return `<div class="empty-state">This template says nothing about what it needs first.</div>`;
    const needs = listOf(firstRun.needs).map((line) => `<li>${escapeHtml(text(line))}</li>`).join("");
    const before = listOf(firstRun.prerequisites).map((line) => `<li>${escapeHtml(text(line))}</li>`).join("");
    const beforeCard = before
      ? `<div class="panel-card" style="outline:1px solid var(--amber-500)"><h3>Do these first, they are not quick</h3><ul style="margin:8px 0 0;padding-left:18px">${before}</ul></div>`
      : "";
    return `<div class="panel-card"><h3>${escapeHtml(text(firstRun.headline) || "Before you import")}</h3><ul style="margin:8px 0 0;padding-left:18px">${needs}</ul></div>`
      + beforeCard
      + `<div class="panel-card"><p style="white-space:pre-wrap;margin:0">${escapeHtml(text(firstRun.body))}</p></div>`;
  }

  // THE FOUR BLOCKS, in this order and these words. Jason wrote them; the unit test pins them as
  // strings, because a paraphrase is a different promise to the person reading the page.
  const PAGES = [
    { id: "memories", label: "Memories", hint: "Facts it already knows", icon: "◆" },
    { id: "skills", label: "Skills", hint: "Playbooks it can run", icon: "▤" },
    { id: "routines", label: "Routines", hint: "Jobs that run on their own", icon: "◷" },
    { id: "integrations", label: "Integrations", hint: "Apps it can use", icon: "✦" },
  ];

  const TEAM_PAGES = [
    { id: "memories", label: "Memories", hint: "Facts it already knows", icon: "◆" },
    { id: "members", label: "The team", hint: "Who you get, and what each one does", icon: "☰" },
    { id: "firstrun", label: "What you provide", hint: "Keys, adds, and the two slow ones", icon: "！" },
    { id: "instructions", label: "How it works", hint: "The team, and the approval rule", icon: "✎" },
    { id: "skills", label: "Documents", hint: "Playbooks and brand profiles", icon: "▤" },
    { id: "integrations", label: "Integrations", hint: "Tools the team uses", icon: "✦" },
  ];

  /** What Remove team offers, and what it just did. Only on a pack, and only once one is drawn. */
  function teamControlsMarkup(bot) {
    const outcome = imports.get(text(bot.id));
    if (outcome == null) return "";
    if (outcome.state === "running") {
      return `<div class="panel-card"><h3>Importing the team…</h3><p>${escapeHtml(text(outcome.step) || "Reading this workspace's limit before anything is created.")}</p></div>`;
    }
    if (outcome.state === "refused") {
      // One plain sentence, and it is the catalog\'s own. Nothing was created.
      return `<div class="panel-card" style="outline:1px solid var(--amber-500)"><h3>Not imported</h3><p data-team-refusal>${escapeHtml(outcome.message)}</p></div>`;
    }
    if (outcome.state === "failed") {
      return `<div class="panel-card" style="outline:1px solid var(--amber-500)"><h3>Not imported</h3><p data-team-failure>${escapeHtml(outcome.message)}</p><p>Everything this import had created was taken back, so the roster is as you found it.</p></div>`;
    }
    if (outcome.state === "removed") {
      return `<div class="panel-card" data-team-removed><h3>Team removed</h3><p>${escapeHtml(outcome.message)}</p></div>`;
    }
    if (outcome.state === "confirm") {
      // Asked out loud, before anything is written: what will be created, and what will NOT be
      // installed. A team that quietly added six connectors would be the CONNECT-13 defect with
      // more moving parts.
      const missing = listOf(outcome.missing);
      const keys = listOf(outcome.keys);
      return `<div class="panel-card" data-team-confirm><h3>Press Import team again to go ahead</h3>`
        + `<p>This creates ${outcome.members} bots and imports ${outcome.skills} documents into this box's shared library.</p>`
        + (missing.length
          ? `<p>It installs nothing. ${escapeHtml(missing.join(", "))} ${missing.length === 1 ? "is" : "are"} not on this box yet, and you add ${missing.length === 1 ? "it" : "them"} yourself from ${missing.length === 1 ? "its" : "their"} own card.</p>`
          : `<p>It installs nothing, and every plugin the team needs is already on this box.</p>`)
        + (keys.length ? `<p>No key is written either. ${escapeHtml(keys.join(", "))} stay yours to enter.</p>` : "")
        + `</div>`;
    }
    const created = listOf(outcome.members).filter((row) => row.reused !== true).length;
    const reused = listOf(outcome.members).length - created;
    const skills = listOf(outcome.members).reduce((n, row) => n + listOf(row.skills).filter((s) => s.reused !== true).length, 0);
    const line = `${created} bot${created === 1 ? "" : "s"} created${reused ? `, ${reused} already here` : ""}, ${skills} document${skills === 1 ? "" : "s"} imported.`;
    return `<div class="panel-card" data-team-imported><h3>The team is on this box</h3><p>${escapeHtml(line)}</p>`
      + `<p>Nothing of theirs runs until you message one. Give the brand profile keeper a client and it will interview you.</p>`
      + `<button class="ghost-button" type="button" data-remove-team="${escapeHtml(text(bot.id))}">Remove team</button></div>`;
  }

  function teamPageMarkup(bot) {
    const outcome = imports.get(text(bot.id));
    const busy = outcome != null && outcome.state === "running";
    const canImport = global.__machineRoomLive !== false;
    const pages = TEAM_PAGES;
    const page = pages.some((entry) => entry.id === view.page) ? view.page : "members";
    const nav = pages.map((entry) => `<button class="plugin-nav-button${page === entry.id ? " is-active" : ""}" type="button" data-bot-tab="${entry.id}"><span class="plugin-icon">${entry.icon}</span><span><strong>${entry.label}</strong><small>${entry.hint}</small></span></button>`).join("");
    const body = page === "members" ? membersMarkup(bot)
      : page === "firstrun" ? firstRunMarkup(bot)
        : page === "skills" ? skillsMarkup(bot)
          : page === "integrations" ? integrationsMarkup(bot)
            : page === "memories" ? memoriesMarkup(bot)
              : instructionsMarkup(bot);
    const members = packMembersOf(bot);
    // The button is deliberately the same primary-button every other Import is, at the same size,
    // in the same place. The gate measures the rectangle a person has to hit.
    const importButton = canImport
      ? `<button class="primary-button" type="button" data-import-bot="${escapeHtml(text(bot.id))}"${busy ? " disabled" : ""}>${busy ? "Importing…" : `Import team (${members.length})`}</button>`
      : `<span class="status-pill">offline — no gateway to import through</span>`;
    return `<div data-bot-page="${escapeHtml(text(bot.id))}" data-team-page="${escapeHtml(text(bot.id))}">`
      + `<button class="quiet-button" type="button" data-bots-back style="margin-bottom:12px">← All bots</button>`
      + `<div class="plugin-hero">${tileMarkup(bot, "large")}<div class="plugin-hero-copy"><h3>${escapeHtml(text(bot.name))}</h3><p>By ${escapeHtml(text(bot.creator) || "Titanbot team")} · ${escapeHtml(text(bot.category) || "Bots")} · ${members.length} bots</p><p>${escapeHtml(text(bot.description))}</p></div><div style="display:grid;gap:6px;align-content:start">${importButton}</div></div>`
      + `<div class="plugin-browser" style="min-height:300px;margin-top:16px"><aside class="plugin-sidebar">${nav}</aside><section class="plugin-detail"><div class="plugin-sections">${body}${teamControlsMarkup(bot)}</div></section></div>`
      + `</div>`;
  }

  function botPageMarkup(bot) {
    if (isTeamPack(bot)) return teamPageMarkup(bot);
    const outcome = imports.get(text(bot.id));
    const busy = outcome != null && outcome.state === "running";
    const onRoster = isOnRoster(bot);
    // Offline (index.html fell back to the demo factory) there is no gateway behind this page, so
    // createAgent would fail after the click rather than before it. A button that cannot work is
    // not drawn; the pill says why in its place.
    const canImport = global.__machineRoomLive !== false;
    const page = PAGES.some((entry) => entry.id === view.page) ? view.page : "memories";
    const nav = PAGES.map((entry) => `<button class="plugin-nav-button${page === entry.id ? " is-active" : ""}" type="button" data-bot-tab="${entry.id}"><span class="plugin-icon">${entry.icon}</span><span><strong>${entry.label}</strong><small>${entry.hint}</small></span></button>`).join("");
    const body = page === "skills" ? skillsMarkup(bot)
      : page === "routines" ? routinesMarkup(bot)
        : page === "integrations" ? integrationsMarkup(bot)
          : memoriesMarkup(bot);
    const importButton = !canImport
      ? `<span class="status-pill">offline — no gateway to add through</span>`
      : onRoster
        ? `<span class="status-pill success" data-bot-on-roster="${escapeHtml(text(bot.id))}">on the roster</span>`
        // IMPORT BOT, the words on Jason's screenshot 3, and the same verb the pack beside it uses
        // for Import team -- the tab had drawn "Add bot" here and "Import team" there, two words for
        // one gesture. The round control on a list row stays "+", which is what screenshot 2 draws;
        // the intro sentence names both, and docs/BOTS.md says why the two differ.
        : `<button class="primary-button" type="button" data-import-bot="${escapeHtml(text(bot.id))}"${busy ? " disabled" : ""}>${busy ? "Importing…" : "Import Bot"}</button>`;
    const detailError = detailErrors.get(text(bot.id));
    const detailNote = detailError
      ? `<div class="panel-card" style="outline:1px solid var(--amber-500)" data-bot-detail-error><p>${escapeHtml(`This bot's own row could not be read from the host, so what is below is only what the list carries and adding it is refused: ${detailError}`)}</p></div>`
      : "";
    return `<div data-bot-page="${escapeHtml(text(bot.id))}">`
      + `<button class="quiet-button" type="button" data-bots-back style="margin-bottom:12px">← All bots</button>`
      + `<div class="plugin-hero">${tileMarkup(bot, "large")}<div class="plugin-hero-copy"><h3>${escapeHtml(text(bot.name))}</h3><p>${escapeHtml(creditLine(bot))} · ${escapeHtml(text(bot.category) || "Bots")}</p><p>${escapeHtml(text(bot.description))}</p></div><div style="display:grid;gap:6px;align-content:start">${importButton}</div></div>`
      + detailNote
      + `<div class="plugin-browser" style="min-height:300px;margin-top:16px"><aside class="plugin-sidebar">${nav}</aside><section class="plugin-detail"><div class="plugin-sections">${body}${outcomeMarkup(bot)}</div></section></div>`
      + `</div>`;
  }

  // ------------------------------------------------------------------ paint
  function markup() {
    if (catalogError != null) {
      return `<div class="empty-state"><div><strong>The bot catalog could not be read</strong><p>${escapeHtml(catalogError)}</p></div></div>`;
    }
    if (catalog == null) return `<div class="empty-state">Reading the catalog from the host…</div>`;
    const notice = view.notice ? `<div class="panel-card" style="margin-bottom:12px"><p>${escapeHtml(view.notice)}</p></div>` : "";
    const bot = view.botId ? botById(view.botId) : null;
    return `<div data-marketplace-bots>${notice}${bot ? botPageMarkup(bot) : listMarkup()}</div>`;
  }

  function paint() {
    if (container == null) return;
    // The search keeps focus and caret across a repaint; without this, typing a second character
    // into the field puts the caret back at the start of the box.
    const active = container.ownerDocument?.activeElement ?? null;
    const wasSearch = active != null && active.hasAttribute?.("data-bot-search");
    const caret = wasSearch ? active.selectionStart : null;
    container.innerHTML = markup();
    if (wasSearch) {
      const field = container.querySelector("[data-bot-search]");
      if (field != null) {
        field.focus();
        if (caret != null) { try { field.setSelectionRange(caret, caret); } catch { /* a search input may refuse */ } }
      }
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    const gateway = relayGateway();
    try {
      const adapter = adapterOf();
      const answer = adapter != null && typeof adapter.listMarketplace === "function"
        ? await adapter.listMarketplace()
        : await gateway.call("listMarketplace", {});
      // THE CHIP DEFECT. The host serves categories as { plugins, bots }; the adapter's cache is
      // built for the Plugins tab and flattens that to the PLUGIN list, which arrives here as a
      // flat array and drew "Development", "Code review" and "Shell tools" as bot categories on
      // screen. A flat array is therefore not trusted as this tab's own list: one gateway read
      // gets the shape the host actually serves. Once the adapter stops flattening, the fallback
      // never fires and this costs nothing.
      let categories = botCategoriesOf(answer);
      // The fallback costs a SECOND whole catalog body, which is the larger half of what one
      // Marketplace open transfers now that the catalog carries 72 rows. So it fires only when
      // there is nothing else to build a chip row from: where the bots name their own categories,
      // categories() below reads them off the rows and no second fetch happens at all.
      if (categories == null && !listOf(answer && answer.bots).some((bot) => text(bot && bot.category))) {
        categories = botCategoriesOf(await gateway.call("listMarketplace", {}).catch(() => null)) ?? [];
      }
      if (categories == null) categories = [];
      catalog = {
        plugins: listOf(answer && answer.plugins),
        bots: listOf(answer && answer.bots),
        categories,
      };
      catalogError = null;
      installed = await readInstalledIds(gateway, catalog.plugins).catch(() => new Set());
      rosterNames = await readRosterNames(gateway).catch(() => rosterNames);
    } catch (error) {
      const message = String(error?.message ?? error);
      catalogError = UNKNOWN_COMMAND.test(message)
        ? "This box's host is older than the Marketplace: it serves no listMarketplace command, so there is no catalog to show. Deploy the host bundle that carries it."
        : message;
    } finally {
      loading = false;
      paint();
    }
  }

  /**
   * The names on the box, for the "on the roster" pill. One read per tab open; a box with a
   * hundred agents answers it in one call, and a failure leaves the previous answer alone rather
   * than drawing every bot as unadded.
   */
  async function readRosterNames(gateway) {
    const roster = agentRecords(await gateway.call("listAgents", {}));
    return new Set(roster.map((agent) => text(agent && agent.name)).filter(Boolean));
  }

  async function refreshInstalled() {
    if (catalog == null) return;
    installed = await readInstalledIds(relayGateway(), catalog.plugins).catch(() => installed);
  }

  // ------------------------------------------------------------------ the row behind the card
  /**
   * The whole row for one bot, through getMarketplaceItem -- a command the host has served since
   * MARKET-1 and this console had never called. The list answer is a card projection now (no
   * memory text, no skill bodies, no routine summaries), so this is where the page's four blocks
   * and every Add get their material.
   *
   * The PROMISE is cached, not only the answer: opening a bot paints immediately and again when
   * the row lands, and caching the settled answer alone fetches the row twice on one open.
   */
  async function readDetail(id) {
    const key = text(id);
    if (details.has(key)) return details.get(key);
    if (detailReads.has(key)) return detailReads.get(key);
    const adapter = adapterOf();
    // The stored promise NEVER rejects: a second opener is handed this same promise and awaits it
    // outside any try of its own, so a rejecting one here is an unhandled rejection in the page.
    // It resolves to the row, or to null with the reason kept for the page to say.
    const read = (async () => {
      const answer = adapter != null && typeof adapter.getMarketplaceItem === "function"
        ? await adapter.getMarketplaceItem("bot", key)
        : await relayGateway().call("getMarketplaceItem", { kind: "bot", id: key });
      if (answer == null || typeof answer !== "object" || text(answer.id) === "") {
        throw new Error("this host served no row for it");
      }
      return answer;
    })()
      .then((row) => { details.set(key, row); detailErrors.delete(key); return row; })
      .catch((error) => { detailErrors.set(key, String(error?.message ?? error)); return null; })
      .then((row) => { detailReads.delete(key); return row; });
    detailReads.set(key, read);
    return read;
  }

  async function openBot(id) {
    const key = text(id);
    view.botId = key;
    view.page = isTeamPack(botById(key)) ? "members" : "memories";
    view.notice = "";
    paint();
    if (details.has(key)) return;
    await readDetail(key);
    paint();
  }

  // ------------------------------------------------------------------ what Add does, and by whom
  /** The roster row that already carries this bot's exact name, or null. */
  async function findOnRoster(gateway, bot) {
    const name = text(bot && bot.name);
    if (!name) return null;
    const roster = agentRecords(await gateway.call("listAgents", {}));
    return roster.find((agent) => text(agent.name) === name) ?? null;
  }

  /** Which apps this box can already reach, which it could add, and which it has no plugin for. */
  function appReport(bot) {
    const report = { connected: [], addable: [], byo: [], informational: [] };
    for (const app of appsOf(bot)) {
      const plugin = app.pluginId ? pluginById(app.pluginId) : null;
      const label = plugin ? text(plugin.name) : (app.label || app.name);
      if (plugin != null && installed.has(text(plugin.id))) report.connected.push(label);
      else if (plugin != null && (plugin.installsNothing === true || app.offer === "page")) report.informational.push(label);
      else if (plugin != null) report.addable.push(label);
      else report.byo.push(label);
    }
    return report;
  }

  /**
   * The setup, when this build carries no bot-setup module.
   *
   * It creates the bot and its playbooks -- which is what this page has always done -- and says
   * plainly, in the receipt, that the memories were not seeded and the jobs were not created.
   * Silence there would be the worse failure: a bot that looks added and knows nothing.
   */
  async function fallbackSetUp(gateway, bot) {
    const result = await importBot(gateway, bot);
    const missing = [];
    if (memoriesOf(bot).length > 0) missing.push(`its ${memoriesOf(bot).length} memories were not seeded`);
    if (routinesOf(bot).length > 0) missing.push(`its ${routinesOf(bot).length} jobs were not created`);
    return {
      state: "done",
      agent: result.agent,
      memories: { added: 0, duplicates: 0, rejected: [] },
      // The names THIS run asked for that the read-back confirmed. Not `result.skills`, which is
      // the shared library filtered by those names: this box holds several rows under one name,
      // left by earlier imports, and the receipt read "13 playbooks" for a bot carrying one.
      // Lists, the same shape bot-setup.js returns, so the receipt has one shape to read rather
      // than two that look alike.
      skills: {
        imported: listOf(result.imported).filter((name) => !listOf(result.missing).includes(name)),
        reused: [],
        skipped: listOf(result.skipped),
      },
      routines: { created: [], notCreated: [] },
      apps: appReport(bot),
      message: missing.length
        ? `This build does not carry the bot setup module, so ${missing.join(" and ")}. The bot and its playbooks are on the box.`
        : "",
    };
  }

  // ------------------------------------------------------------------ events
  /**
   * Importing a team never installs a connector and never writes a key: it lists what is missing
   * and the operator adds each one on its own card. So the click asks once, out loud, naming every
   * plugin it will NOT install, before it creates anything.
   */
  function teamConfirmation(bot) {
    const need = listOf(bot.integrations).map(text).filter(Boolean);
    const missing = need.filter((id) => !installed.has(id));
    const names = missing.map((id) => { const plugin = pluginById(id); return plugin ? text(plugin.name) : id; });
    const keys = [];
    for (const id of need) {
      const plugin = pluginById(id);
      for (const credential of listOf(plugin && plugin.credentials)) {
        const field = text(credential.field);
        if (field && !keys.includes(field)) keys.push(field);
      }
    }
    return {
      members: packMembersOf(bot).length,
      skills: listOf(bot.skills).length,
      missing: names,
      keys,
    };
  }

  async function onImportTeamClick(listRow) {
    const id = text(listRow.id);
    imports.set(id, { state: "running", step: "Reading this workspace\'s limit before anything is created." });
    view.notice = "";
    paint();
    // A pack is imported from its DETAIL row, exactly as a single bot is: the list answer is a card
    // projection and a pack's members carry their own instructions and their own skill bodies,
    // which the card does not. Importing off the card would create seven bots with no persona.
    const bot = details.get(id) ?? await readDetail(id);
    if (bot == null) {
      imports.set(id, {
        state: "failed",
        message: `This team's own row could not be read from the host, so nothing was created: ${detailErrors.get(id) ?? "the read failed"}.`,
        members: [],
      });
      paint();
      return;
    }
    let outcome;
    try {
      outcome = await importMarketingTeam(relayGateway(), bot, (progress) => {
        const step = progress.phase === "importing"
          ? `${progress.role}: ${progress.skill}`
          : `${progress.role} (${progress.at} of ${progress.total})`;
        imports.set(id, { state: "running", step });
        paint();
      });
    } catch (error) {
      outcome = { state: "failed", message: String(error?.message ?? error), members: [] };
    }
    imports.set(id, outcome);
    paint();
    const adapter = adapterOf();
    if (adapter != null && typeof adapter.refresh === "function") await adapter.refresh().catch(() => {});
    await refreshInstalled();
    paint();
  }

  async function onRemoveTeamClick(botId) {
    const bot = botById(botId);
    if (bot == null) return;
    const id = text(bot.id);
    imports.set(id, { state: "running", step: "Taking back the bots and their documents." });
    paint();
    let message;
    try {
      const removed = await removeMarketingTeam(relayGateway(), bot);
      message = `${removed.agents} bot${removed.agents === 1 ? "" : "s"} and ${removed.skills} document${removed.skills === 1 ? "" : "s"} taken back.`
        + (removed.failures.length ? ` ${removed.failures.length} could not be removed: ${removed.failures.join("; ")}` : "");
    } catch (error) {
      message = String(error?.message ?? error);
    }
    imports.set(id, { state: "removed", message, members: [] });
    paint();
    const adapter = adapterOf();
    if (adapter != null && typeof adapter.refresh === "function") await adapter.refresh().catch(() => {});
    paint();
  }

  /**
   * ADD, from the round button on a row or the button on the bot page. One press.
   *
   * The order matters and is the reason this is not four lines: the detail row is read first
   * (nothing is created off a card projection), the roster is read next (a second press must not
   * make a second bot), and the setup itself belongs to window.__botSetup so that the page and the
   * sequence are not one file two people are editing. When that module is absent the old
   * importBot still runs and the receipt says which half of the work did not happen.
   */
  async function onAddBotClick(botId, options = {}) {
    const id = text(botId);
    view.notice = "";
    imports.set(id, { state: "running", step: "Reading this bot's own row from the host." });
    paint();

    const bot = details.get(id) ?? await readDetail(id);
    if (bot == null) {
      imports.set(id, {
        state: "failed",
        message: `This bot's own row could not be read from the host, so nothing was created: ${detailErrors.get(id) ?? "the read failed"}.`,
        rolledBack: "Nothing was created.",
      });
      paint();
      return;
    }
    if (isTeamPack(bot)) { await onImportClick(id); return; }

    const gateway = relayGateway();
    const setup = botSetupOf();
    const duplicate = options.duplicate === true;
    try {
      if (!duplicate) {
        const already = typeof setup?.alreadyOnRoster === "function"
          ? await setup.alreadyOnRoster(gateway, bot)
          : await findOnRoster(gateway, bot);
        if (already != null) {
          imports.set(id, { state: "already", agent: { id: text(already.id), name: text(already.name) } });
          // Said out loud as well as on the card: the press may have come from the list, where the
          // card is not on screen and the row alone would just quietly change shape.
          view.notice = `${text(already.name) || text(bot.name)} is already on the roster, so nothing was created. Open it, or add another copy from its own page.`;
          paint();
          return;
        }
      }
      imports.set(id, { state: "running", step: "Creating the bot, then its memories, its playbooks and its jobs." });
      paint();
      const outcome = typeof setup?.setUpBot === "function"
        ? await setup.setUpBot(gateway, bot, {
          duplicate,
          onProgress: (progress) => {
            const step = text(progress && (progress.step ?? progress.phase));
            imports.set(id, { state: "running", step: step || "Setting it up." });
            paint();
          },
        })
        : await fallbackSetUp(gateway, bot);
      imports.set(id, outcome && typeof outcome === "object" ? outcome : { state: "failed", message: "the setup answered with nothing" });
      // The list behind this page has to agree with the card in front of it, including after a
      // reload, so the name goes into the roster set the moment the box confirms it.
      const landed = text(outcome && outcome.agent && outcome.agent.name) || text(bot.name);
      if (outcome && (outcome.state === "done" || outcome.state === "already") && landed) rosterNames.add(landed);
      // On screen first: the adapter refresh and the connector re-read below are both round trips
      // to the box, and the new bot must not wait behind them to be drawn.
      paint();
      const adapter = adapterOf();
      if (adapter != null && typeof adapter.refresh === "function") await adapter.refresh().catch(() => {});
    } catch (error) {
      imports.set(id, { state: "failed", message: String(error?.message ?? error) });
    }
    await refreshInstalled();
    paint();
  }

  async function onImportClick(botId) {
    const bot = botById(botId);
    if (bot == null) return;
    if (isTeamPack(bot)) {
      // The confirmation is a step, not a modal: the notice names every plugin the import will not
      // install and every key it will not write, and a second press goes ahead. A team that
      // silently added six connectors would be the CONNECT-13 failure with more moving parts.
      const state = imports.get(text(bot.id));
      if (state == null || state.state !== "confirm") {
        const summary = teamConfirmation(bot);
        imports.set(text(bot.id), { state: "confirm", ...summary });
        view.notice = `Import creates ${summary.members} bots and imports ${summary.skills} documents. It installs nothing`
          + (summary.missing.length ? `: ${summary.missing.join(", ")} ${summary.missing.length === 1 ? "is" : "are"} not on this box yet and you add ${summary.missing.length === 1 ? "it" : "them"} yourself` : " and every plugin it needs is already here")
          + (summary.keys.length ? `. No key is written either; ${summary.keys.join(", ")} stay yours to enter.` : ".")
          + " Press Import team again to go ahead.";
        paint();
        return;
      }
      await onImportTeamClick(bot);
      return;
    }
    // A single bot is the setup sequence above, whichever control was pressed.
    await onAddBotClick(text(bot.id));
  }

  async function onAddClick(pluginId) {
    const plugin = pluginById(pluginId);
    if (plugin == null) return;
    view.notice = `Adding ${text(plugin.name) || pluginId}…`;
    paint();
    let answer = null;
    try {
      answer = await installPlugin(plugin);
    } catch (error) {
      answer = { accepted: false, message: String(error?.message ?? error) };
    }
    view.notice = text(answer && answer.message) || (answer && answer.accepted ? `${text(plugin.name)} added.` : `${text(plugin.name)} was not added.`);
    await refreshInstalled();
    paint();
    // The plugin page is where the credential goes, so a successful Add opens it when the Plugins
    // tab is there to open one.
    const shared = pluginsTabOf();
    if (answer && answer.accepted === true && shared != null && typeof shared.open === "function") shared.open(text(plugin.id));
  }

  function onClick(event) {
    const target = event.target instanceof global.Element ? event.target : null;
    if (target == null) return;
    const back = target.closest("[data-bots-back]");
    if (back != null) { view.botId = null; view.notice = ""; paint(); return; }
    const tab = target.closest("[data-bot-tab]");
    if (tab != null) { view.page = tab.dataset.botTab; paint(); return; }
    const chip = target.closest("[data-bot-category]");
    if (chip != null) { view.category = chip.dataset.botCategory; paint(); return; }
    const importer = target.closest("[data-import-bot]");
    if (importer != null) { void onImportClick(importer.dataset.importBot); return; }
    // The round Add on a list row. Its own handler and its own element -- a sibling of the row's
    // open button, never inside it -- so one press is one action.
    const addBot = target.closest("[data-add-bot]");
    if (addBot != null) { void onAddBotClick(addBot.dataset.addBot); return; }
    const addCopy = target.closest("[data-add-copy]");
    if (addCopy != null) { void onAddBotClick(addCopy.dataset.addCopy, { duplicate: true }); return; }
    const add = target.closest("[data-add-integration]");
    if (add != null) { void onAddClick(add.dataset.addIntegration); return; }
    const remove = target.closest("[data-remove-team]");
    if (remove != null) { void onRemoveTeamClick(remove.dataset.removeTeam); return; }
    const open = target.closest("[data-open-agent]");
    if (open != null) {
      const adapter = adapterOf();
      if (adapter != null && typeof adapter.selectContext === "function") adapter.selectContext({ kind: "worker", id: open.dataset.openAgent });
      return;
    }
    const card = target.closest("[data-bot-id]");
    if (card != null) {
      // A bot opens on its Memories and a team on its members. Measured on screen 2026-09-09: the
      // team opened on "How it works" like a single bot does, so the seven a person is meant to
      // read BEFORE importing were behind a click nobody is told to make.
      void openBot(card.dataset.botId);
    }
  }

  function onInput(event) {
    const target = event.target instanceof global.Element ? event.target : null;
    if (target == null || !target.hasAttribute("data-bot-search")) return;
    view.query = target.value ?? "";
    paint();
  }

  // ------------------------------------------------------------------ the panel's entry point
  function render(node) {
    if (node == null) return;
    container = node;
    if (node.dataset != null && node.dataset.marketplaceBotsWired !== "1") {
      node.addEventListener("click", onClick);
      node.addEventListener("input", onInput);
      node.dataset.marketplaceBotsWired = "1";
    }
    paint();
    if (catalog == null && catalogError == null) void load();
  }

  global.__marketplaceBots = {
    render,
    // The import sequence, and the pure pieces behind the page, exported for the gate and the
    // unit test rather than re-implemented there.
    importBot,
    personaFor,
    // TEAMS-1. The team sequence, for the same reason: the ORDER of the calls is the contract.
    importMarketingTeam,
    removeMarketingTeam,
    renderRefusal,
    packMembersOf,
    memberAgentName,
    // The pack page's own markup, so the states the gate cannot reach in one run -- a failed
    // import, a removal -- are still rendered by something before they are rendered at a person.
    renderTeamState(bot, outcome) {
      const previous = imports.get(text(bot && bot.id));
      if (outcome == null) imports.delete(text(bot && bot.id)); else imports.set(text(bot && bot.id), outcome);
      try { return teamControlsMarkup(bot); }
      finally { if (previous == null) imports.delete(text(bot && bot.id)); else imports.set(text(bot && bot.id), previous); }
    },
    renderTeamMembers: (bot) => membersMarkup(bot),
    renderFirstRun: (bot) => firstRunMarkup(bot),
    reload() { catalog = null; catalogError = null; details.clear(); detailErrors.clear(); return load(); },

    // BOTS-4. The four blocks as data, so the unit test pins the words a person reads rather than
    // a copy of them, and the pure render paths, so every state the gate cannot reach in one run
    // is still rendered by something before it is rendered at a person.
    BOT_PAGES: PAGES,
    TEAM_PAGES,
    scheduleWords,
    appsOf,
    findOnRoster,
    /**
     * Draw the list or one bot page against a catalog handed in, with nothing kept afterwards.
     * state: { bots, plugins, categories, installed, category, query, botId, page, outcome }
     */
    preview(state, what) {
      const kept = {
        catalog, installed, roster: rosterNames, view: { ...view },
        imports: new Map(imports), details: new Map(details), errors: new Map(detailErrors),
      };
      try {
        catalog = {
          plugins: listOf(state && state.plugins),
          bots: listOf(state && state.bots),
          categories: listOf(state && state.categories),
        };
        installed = new Set(listOf(state && state.installed).map(text));
        rosterNames = new Set(listOf(state && state.roster).map(text).filter(Boolean));
        view.category = text(state && state.category) || "All";
        view.query = String((state && state.query) ?? "");
        view.botId = text(state && state.botId) || null;
        view.page = text(state && state.page) || "memories";
        imports.clear();
        details.clear();
        detailErrors.clear();
        if (state && state.outcome != null) imports.set(view.botId, state.outcome);
        if (state && state.detailError != null) detailErrors.set(view.botId, String(state.detailError));
        if (what === "page" || (what == null && view.botId)) {
          const bot = botById(view.botId);
          return bot == null ? "" : botPageMarkup(bot);
        }
        return listMarkup();
      } finally {
        catalog = kept.catalog;
        installed = kept.installed;
        rosterNames = kept.roster;
        Object.assign(view, kept.view);
        imports.clear(); for (const [k, v] of kept.imports) imports.set(k, v);
        details.clear(); for (const [k, v] of kept.details) details.set(k, v);
        detailErrors.clear(); for (const [k, v] of kept.errors) detailErrors.set(k, v);
      }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
