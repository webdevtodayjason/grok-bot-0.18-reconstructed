/*
 * BOTS-4 — what one click on Add actually does.
 * --------------------------------------------
 * A person clicks the round Add on a catalog row and a few seconds later has an agent that greets
 * them in its own voice, already knowing its operating rules, holding its playbooks, carrying its
 * jobs switched off, and saying which apps it still needs. This file is that sequence and nothing
 * else: it draws no markup and touches no DOM. marketplace-bots.js owns the page, app.js owns the
 * panel, and the two reach this through window.__botSetup alone.
 *
 * It is a separate module for the same reason gateway-adapter.js is: the ORDER of the gateway calls
 * IS the contract, and the only honest place to pin an order is a unit test driving a fake gateway.
 * A click in a browser proves a person can start it; it proves nothing about what ran in between.
 *
 * THE ORDER, and why each step sits where it does:
 *
 *   1  listAgents            An agent already carrying this bot's exact name means the bot is on
 *                            the roster. Answer "already", write NOTHING, and offer Open. A second
 *                            deliberate copy is still reachable, behind { duplicate: true }, which
 *                            is the " copy" behaviour the six first-party packs rely on.
 *   2  createAgent           isKickstartRequested is never true. The host would otherwise write the
 *                            introduction immediately, before the agent knows anything, and the
 *                            introduction is written once.
 *   3  addAgentMemories      The bot's operating rules, seeded as the agent's own remembered facts.
 *                            The host refuses anything over its cap rather than storing it short,
 *                            and names it under `rejected` so the card can say which one did not fit.
 *   4  getAgentWorkflows     ONE library read, BEFORE the first import. The library is shared across
 *                            the box: measured on grok-bot-local-vm 2026-09-09 it held
 *                            web-research-pass, -2 and -3, three copies of one skill left by three
 *                            imports, because the host suffixes on a name collision and never
 *                            dedupes. So every skill is namespaced by the bot and a document the box
 *                            already holds is reused rather than written again.
 *   5  importAgentWorkflowText  One per skill the library does not already hold.
 *   6  createAgentAutomation One per routine that resolved to a real cron, always isEnabled false.
 *                            A routine with no schedule is NOT created: automation-store.upsert
 *                            writes nothing when a trigger will not normalise and the gateway still
 *                            answers 200, so a made-up trigger would be a routine that silently is
 *                            not there. It is reported under notCreated with the reason instead.
 *   7  the read-backs        getAgentMemories, getAgentWorkflows, getAgentAutomations. addMemory
 *                            answers null on a duplicate and upsert answers null at the cap, both
 *                            silently, so what the box HOLDS is what gets reported — never the wish.
 *   8  kickstartAgent        LAST, so the agent writing the introduction already remembers
 *                            everything. Nothing else produces that first message: sendPrompt writes
 *                            a user entry which permanently suppresses the agent's own introduction,
 *                            and appendConnectorCard renders as an empty bubble in this console.
 *
 * On a failure part way, the agent and the namespaced skills THIS run created are taken back and
 * the report says what was taken back. Nothing the run merely found is touched.
 *
 * The report is the authoritative receipt. A box with no model configured gives a silent agent and
 * no first message at all, so the panel card — not the conversation — is what says what happened.
 */
(function attachBotSetup(global) {
  "use strict";

  const text = (value) => String(value ?? "").trim();
  const listOf = (value) => (Array.isArray(value) ? value : []);
  const agentRecords = (answer) => listOf(answer).filter((a) => a && typeof a === "object");

  // ------------------------------------------------------------------ the row, read defensively
  // Every one of these fields is optional on a row: the six first-party bots predate memories,
  // routines and apps, and a host older than this wave serves rows without them. A missing field is
  // an empty list, never a throw.

  const memoriesOf = (bot) => listOf(bot && bot.memories).filter((m) => m != null && typeof m === "object");

  /**
   * The facts seeded into the store. A generated row splits each memory paragraph at sentence
   * boundaries into `facts` that fit the host's cap; a row with no split is seeded as its own text
   * and the host refuses it if it is too long, which is the point of the refusal.
   */
  function factsOf(bot) {
    const facts = [];
    for (const memory of memoriesOf(bot)) {
      const split = listOf(memory.facts).map(text).filter(Boolean);
      if (split.length > 0) facts.push(...split);
      else if (text(memory.text)) facts.push(text(memory.text));
    }
    return facts;
  }

  const skillsOf = (bot) => listOf(bot && bot.skills).filter((s) => s != null && typeof s === "object" && text(s.name));
  const routinesOf = (bot) => listOf(bot && bot.routines).filter((r) => r != null && typeof r === "object" && text(r.name));
  const appsOf = (bot) => listOf(bot && bot.apps).filter((a) => a != null && typeof a === "object");

  /**
   * The identity the agent runs with. The host has ONE identity field — the agent's description —
   * and personaFor in marketplace-bots.js is already the rule for composing it: the row's
   * description, a blank line, then its instructions. It is read off that module when the page is
   * loaded so there is one composition in the console rather than two that drift; the local copy
   * below is the same two lines, for the unit test and for a build where the page half is absent.
   */
  function localPersona(bot) {
    const description = text(bot && bot.description);
    const instructions = text(bot && bot.instructions);
    if (!instructions) return description;
    if (!description) return instructions;
    return `${description}\n\n${instructions}`;
  }
  function personaFor(bot) {
    const page = global.__marketplaceBots;
    return page && typeof page.personaFor === "function" ? page.personaFor(bot) : localPersona(bot);
  }

  // ------------------------------------------------------------------ skills
  // Namespaced by the bot, the way the Marketing pack namespaces its own. Without the namespace the
  // reuse check below would happily adopt a stranger's document because it shares a name.
  const slug = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  function skillPrefixOf(bot) {
    const declared = (bot && bot.packaging) || {};
    if (typeof declared.skillPrefix === "string" && declared.skillPrefix) return declared.skillPrefix;
    const id = slug(bot && bot.id) || slug(bot && bot.name) || "bot";
    return `${id}-`;
  }
  // MEASURED ON grok-bot-local-vm, 2026-09-09. The `name` argument to importAgentWorkflowText is
  // NOT what the box files the document under: it reads the name out of the document's own YAML
  // frontmatter, and with no frontmatter it falls back to the first heading. A body headed
  // "# Probe playbook" landed in that box's shared library as "Probe playbook" while this file was
  // asking for "bots1-probe-probe-playbook" -- so the namespace was decoration, the reuse check
  // could never match it, and a second Add would have written a second copy of every document,
  // which is precisely the doubling the namespace exists to prevent. Every skill this file imports
  // therefore carries frontmatter naming it, and that name is what the reuse check and the
  // read-back both use.
  const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
  function frontmatterName(body) {
    const found = FRONTMATTER.exec(typeof body === "string" ? body : "");
    if (found == null) return "";
    const line = found[1].split(/\r?\n/).find((row) => /^name\s*:/.test(row));
    return line == null ? "" : line.replace(/^name\s*:/, "").trim().replace(/^["']|["']$/g, "").trim();
  }
  /** The name the box will file the document under, which is the only name worth checking against. */
  const skillNameFor = (bot, skill) => frontmatterName(skill && skill.body)
    || `${skillPrefixOf(bot)}${slug(skill && skill.name) || "skill"}`;

  // One line, quoted, so a description carrying a colon cannot break the frontmatter it sits in.
  const yamlLine = (value) => JSON.stringify(text(value).replace(/\s+/g, " "));
  function withFrontmatterName(body, name, description) {
    const raw = typeof body === "string" ? body : "";
    const found = FRONTMATTER.exec(raw);
    if (found == null) return `---\nname: ${name}\ndescription: ${yamlLine(description)}\n---\n\n${raw.replace(/^\s+/, "")}`;
    if (frontmatterName(raw)) return raw;
    return raw.replace(FRONTMATTER, `---\nname: ${name}\n${found[1]}\n---`);
  }

  /**
   * The SKILL.md that gets imported. A generated row carries a real body; the scraped catalog
   * carries a one-line description and nothing else for 54 of its bots, and an empty document is
   * not a playbook. So a body is written from the description AND SAYS SO, because a playbook the
   * agent believes was authored would be followed as though somebody had thought it through.
   */
  function skillBody(bot, skill) {
    // The authored document goes in AS WRITTEN apart from the name the box files it under: a
    // SKILL.md is a file, and quietly reshaping one is the same class of thing as quietly
    // shortening a memory.
    const body = typeof (skill && skill.body) === "string" ? skill.body : "";
    const name = text(skill && skill.name);
    const description = text(skill && skill.description);
    if (body.trim()) return withFrontmatterName(body, skillNameFor(bot, skill), description);
    return withFrontmatterName([
      `# ${name}`,
      "",
      description || "No description came with this playbook.",
      "",
      "## Where this came from",
      "",
      "This playbook was written from a one-line summary in the bot catalog, not from a worked",
      "procedure. Treat the line above as the intent and nothing more. After you run it once,",
      "rewrite this document with the steps you actually took, what you needed, and what went",
      "wrong, so the next run follows a real procedure instead of a summary.",
      "",
    ].join("\n"), skillNameFor(bot, skill), description);
  }

  // ------------------------------------------------------------------ routines
  // A five-field cron or nothing. normalizeSchedule accepts the bare word "weekly", stores it,
  // describes it as "weekly" and never computes a next run, which is a dead routine the day
  // somebody switches it on. So a schedule that is not five fields is treated as no schedule.
  const CRON_FIELDS = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
  function cronOf(routine) {
    const schedule = text(routine && routine.schedule);
    return CRON_FIELDS.test(schedule) ? schedule : "";
  }
  function whyNotCreated(routine) {
    const stated = text(routine && routine.scheduleNote);
    if (stated) return stated;
    const schedule = text(routine && routine.schedule);
    if (schedule) return `it asks to run "${schedule}", which is not a clock this box can hold`;
    return "it waits on something happening rather than on a clock, so there is nothing to schedule";
  }
  const routinePrompt = (routine) => text(routine && routine.prompt)
    || text(routine && routine.summary)
    || text(routine && routine.name);

  // ------------------------------------------------------------------ apps
  // What the bot wants to reach, split four ways so the page draws the right control for each and
  // the report can say, in plain words, what is still missing.
  //
  //   connected      the plugin is installed on this box already
  //   addable        we have the plugin and it is not installed: the page offers Add
  //   informational  we have no install path (a page-only row); an Add button here would be a
  //                  button that does nothing, which commit 1694a3f already ruled out
  //   byo            nothing of ours matches: the add-your-own door
  const idSet = (value) => (value == null
    ? new Set()
    : typeof value.has === "function" ? value : new Set(listOf(value).map(String)));
  function planApps(bot, installedPluginIds) {
    const installed = idSet(installedPluginIds);
    const connected = [], addable = [], informational = [], byo = [];
    const declared = appsOf(bot);
    const rows = declared.length > 0
      ? declared
      // A row from before the `apps` field carries plugin ids alone, so the id is the label too.
      : listOf(bot && bot.integrations).map((id) => ({ name: text(id), label: text(id), pluginId: text(id), offer: "connect" }));
    for (const row of rows) {
      const app = {
        name: text(row.name) || text(row.label) || text(row.pluginId),
        label: text(row.label) || text(row.name) || text(row.pluginId),
        description: text(row.description),
        pluginId: text(row.pluginId),
      };
      if (app.pluginId && installed.has(app.pluginId)) connected.push(app);
      else if (text(row.offer) === "page") informational.push(app);
      else if (app.pluginId && text(row.offer) !== "byo") addable.push(app);
      else byo.push(app);
    }
    return { connected, addable, informational, byo };
  }

  // ------------------------------------------------------------------ the plan
  /**
   * What an Add WOULD do, with nothing written and no gateway needed. The page shows this before
   * the click; the setup below follows exactly the same rules, and the unit test pins them equal.
   */
  function planFor(bot, installedPluginIds) {
    const routines = { create: [], skip: [] };
    for (const routine of routinesOf(bot)) {
      const schedule = cronOf(routine);
      if (schedule) routines.create.push({ name: text(routine.name), schedule, describes: text(routine.scheduleNote) || text(routine.summary) });
      else routines.skip.push({ name: text(routine.name), why: whyNotCreated(routine) });
    }
    return {
      name: text(bot && bot.name),
      description: personaFor(bot),
      memories: { paragraphs: memoriesOf(bot).length, facts: factsOf(bot).length },
      skills: skillsOf(bot).map((skill) => ({ name: text(skill.name), as: skillNameFor(bot, skill) })),
      routines,
      apps: planApps(bot, installedPluginIds),
    };
  }

  // ------------------------------------------------------------------ the roster check
  /**
   * The agent already carrying this bot's name, or null. Read-only, and the only thing a second
   * click has to do.
   */
  async function alreadyOnRoster(gateway, bot) {
    const name = text(bot && bot.name);
    if (!name) return null;
    const roster = agentRecords(await gateway.call("listAgents", {}));
    return roster.find((agent) => text(agent.name) === name) ?? null;
  }

  /**
   * Every workflow the box holds. The library is shared, so any agent answers with the same list —
   * but ONE agent failing to answer must not read as an empty library, because an empty library is
   * the answer that makes the setup write every document again and leave doubles behind. So it walks
   * the roster until one answers, the same way the team import does.
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

  // ------------------------------------------------------------------ the message
  // One plain sentence. No tool names, no field names, nothing an operator would have to translate.
  const countOf = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function messageFor(bot, report) {
    const name = text(bot && bot.name) || "the bot";
    const parts = [];
    if (report.memories.added > 0) parts.push(countOf(report.memories.added, "fact it now remembers", "facts it now remembers"));
    if (report.skills.imported.length + report.skills.reused.length > 0) {
      parts.push(countOf(report.skills.imported.length + report.skills.reused.length, "playbook", "playbooks"));
    }
    if (report.routines.created.length > 0) {
      const jobs = report.routines.created.length;
      parts.push(jobs === 1
        ? "1 job that stays switched off until you turn it on"
        : `${jobs} jobs that stay switched off until you turn them on`);
    }
    const set = parts.length > 0 ? `${name} is on your roster with ${parts.join(", ")}.` : `${name} is on your roster.`;

    const missing = [];
    if (report.apps.addable.length > 0) missing.push(`${report.apps.addable.map((a) => a.label).join(", ")} still need connecting`);
    if (report.apps.byo.length > 0) missing.push(`${report.apps.byo.map((a) => a.label).join(", ")} ${report.apps.byo.length === 1 ? "is" : "are"} not something we carry yet, so you would add your own`);
    if (report.routines.notCreated.length > 0) {
      missing.push(`${countOf(report.routines.notCreated.length, "job", "jobs")} could not be set up because ${report.routines.notCreated.length === 1 ? "it waits" : "they wait"} on something rather than a clock`);
    }
    if (report.memories.rejected.length > 0) {
      missing.push(`${countOf(report.memories.rejected.length, "fact was", "facts were")} too long to store and ${report.memories.rejected.length === 1 ? "was" : "were"} left out rather than cut short`);
    }
    return missing.length > 0 ? `${set} ${missing.join("; ")}.` : set;
  }

  const emptyReport = () => ({
    memories: { added: 0, duplicates: 0, rejected: [] },
    skills: { imported: [], reused: [], skipped: [] },
    routines: { created: [], notCreated: [] },
    apps: { connected: [], addable: [], informational: [], byo: [] },
  });

  // ------------------------------------------------------------------ the setup
  /**
   * Add one bot. Options: { onProgress, installedPluginIds, duplicate }.
   *
   * `duplicate` is the deliberate second copy — the page asks for it behind its own button, so the
   * documented "<name> copy" behaviour stays reachable without a first click silently making a
   * second agent.
   */
  async function setUpBot(gateway, bot, options) {
    const opts = options || {};
    const report = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    if (bot == null) throw new Error("there is no bot to set up");
    const wanted = text(bot.name);
    if (!wanted) throw new Error("that catalog row has no name");

    const roster = agentRecords(await gateway.call("listAgents", {}));
    const taken = new Set(roster.map((agent) => text(agent.name)));
    const standing = roster.find((agent) => text(agent.name) === wanted) ?? null;
    if (standing != null && opts.duplicate !== true) {
      return {
        state: "already",
        agent: { id: text(standing.id), name: wanted },
        ...emptyReport(),
        message: `${wanted} is already on your roster. Open it, or add another copy if you want a second one.`,
      };
    }
    let name = wanted;
    while (taken.has(name)) name = `${name} copy`;

    const description = personaFor(bot);
    const created = [];
    const madeSkills = new Set();
    let agentId = null;
    const out = emptyReport();

    try {
      report({ phase: "creating", name });
      const answer = await gateway.call("createAgent", { name, description, isKickstartRequested: false });
      agentId = text(answer?.agent?.id ?? answer?.id);
      if (!agentId) {
        // An older host answers the mint with no envelope; the roster diff is the fallback the
        // adapter already uses for duplicateAgent.
        const known = new Set(roster.map((agent) => text(agent.id)));
        agentId = text(agentRecords(await gateway.call("listAgents", {})).find((agent) => !known.has(text(agent.id)))?.id);
      }
      if (!agentId) throw new Error("the host took the request and reported no bot");
      created.push(agentId);

      // ---- memories
      const facts = factsOf(bot);
      if (facts.length > 0) {
        report({ phase: "remembering", name, count: facts.length });
        const seeded = await gateway.call("addAgentMemories", { id: agentId, memories: facts });
        out.memories.rejected = listOf(seeded?.rejected).map((row) => ({ text: text(row?.text), why: text(row?.why) }));
      }

      // ---- skills, against ONE library read taken before the first write
      const held = new Set((await sharedLibrary(gateway, agentId, roster)).map((row) => text(row.name)).filter(Boolean));
      for (const skill of skillsOf(bot)) {
        const as = skillNameFor(bot, skill);
        if (held.has(as)) { out.skills.reused.push(as); continue; }
        report({ phase: "installing", name, skill: text(skill.name) });
        const answer = await gateway.call("importAgentWorkflowText", { id: agentId, markdown: skillBody(bot, skill), name: as });
        // The host's OWN ledger of what it declined, with the host's own reason. A throw is a
        // different thing entirely and is not caught here: it rolls the whole setup back.
        for (const row of listOf(answer?.result?.skipped)) {
          out.skills.skipped.push({ source: text(row?.source) || text(skill.name), reason: text(row?.reason) || "no reason given" });
        }
        held.add(as);
        madeSkills.add(as);
      }

      // ---- routines, switched off
      for (const routine of routinesOf(bot)) {
        const schedule = cronOf(routine);
        const routineName = text(routine.name);
        if (!schedule) {
          out.routines.notCreated.push({ name: routineName, why: whyNotCreated(routine) });
          continue;
        }
        report({ phase: "scheduling", name, routine: routineName });
        await gateway.call("createAgentAutomation", {
          id: agentId,
          spec: {
            name: routineName,
            prompt: routinePrompt(routine),
            trigger: { type: "cron", schedule },
            isEnabled: false,
          },
        });
      }
    } catch (error) {
      // Take back exactly what this run made. Skills first, while an agent to ask through is alive.
      const takenBack = { skills: 0, agents: 0 };
      if (madeSkills.size > 0) {
        for (const row of await sharedLibrary(gateway, agentId, roster).catch(() => [])) {
          if (!madeSkills.has(text(row.name))) continue;
          try { await gateway.call("deleteAgentWorkflow", { id: agentId, workflowId: text(row.id) }); takenBack.skills += 1; } catch {}
        }
      }
      for (const id of created) {
        try { await gateway.call("deleteAgent", { id }); takenBack.agents += 1; } catch {}
      }
      const undone = takenBack.agents > 0 || takenBack.skills > 0
        ? ` Nothing was left behind: the bot and ${countOf(takenBack.skills, "playbook", "playbooks")} it had added were taken back.`
        : "";
      return {
        state: "failed",
        agent: null,
        ...emptyReport(),
        message: `Setting up ${wanted} stopped: ${String(error?.message ?? error)}.${undone}`,
      };
    }

    // ---- what the box HOLDS, read back before anything is reported
    const [memoryRows, workflowRows, automationRows] = await Promise.all([
      gateway.call("getAgentMemories", { id: agentId }).catch(() => null),
      gateway.call("getAgentWorkflows", { id: agentId }).catch(() => null),
      gateway.call("getAgentAutomations", { id: agentId }).catch(() => null),
    ]);
    const heldFacts = new Set(listOf(memoryRows).map((row) => text(row && row.content)).filter(Boolean));
    const seededFacts = factsOf(bot).map((fact) => fact.replace(/\s+/g, " ").trim());
    out.memories.added = seededFacts.filter((fact) => heldFacts.has(fact)).length;
    out.memories.duplicates = Math.max(0, seededFacts.length - out.memories.added - out.memories.rejected.length);

    const heldNames = new Set(listOf(workflowRows).filter((row) => row && row.source !== "automation")
      .map((row) => text(row.name) || text(row.id)).filter(Boolean));
    const wantedSkills = skillsOf(bot).map((skill) => ({ source: text(skill.name), as: skillNameFor(bot, skill) }));
    out.skills.imported = wantedSkills.filter((row) => madeSkills.has(row.as) && heldNames.has(row.as)).map((row) => row.as);
    out.skills.reused = wantedSkills.filter((row) => !madeSkills.has(row.as) && heldNames.has(row.as)).map((row) => row.as);
    for (const row of wantedSkills) {
      if (heldNames.has(row.as) || out.skills.skipped.some((s) => s.source === row.source)) continue;
      out.skills.skipped.push({ source: row.source, reason: "the box took the document and is not listing it" });
    }

    const heldRoutines = listOf(automationRows).filter((row) => row && typeof row === "object");
    for (const routine of routinesOf(bot)) {
      const schedule = cronOf(routine);
      if (!schedule) continue;
      const routineName = text(routine.name);
      if (out.routines.notCreated.some((row) => row.name === routineName)) continue;
      // clampAutomationName collapses whitespace, trims, then cuts at 80. Matching on the asked-for
      // name would miss a long one and report a routine that IS there as missing.
      const clamped = routineName.replace(/\s+/g, " ").trim().slice(0, 80);
      const stored = heldRoutines.find((row) => text(row.name) === clamped);
      if (stored == null) {
        out.routines.notCreated.push({ name: routineName, why: "the box took the request and is not listing the job" });
        continue;
      }
      out.routines.created.push({
        name: routineName,
        schedule,
        describes: text(routine.scheduleNote) || text(routine.summary),
        isEnabled: stored.isEnabled === true,
      });
    }

    out.apps = planApps(bot, opts.installedPluginIds);

    // ---- the agent's own introduction, last, so it is written by an agent that already remembers
    report({ phase: "introducing", name });
    await gateway.call("kickstartAgent", { id: agentId }).catch(() => null);

    return { state: "done", agent: { id: agentId, name }, ...out, message: messageFor({ ...bot, name }, out) };
  }

  global.__botSetup = {
    setUpBot,
    planFor,
    alreadyOnRoster,
    // The pure pieces, exported for the gate and the unit test rather than re-implemented there.
    personaFor,
    factsOf,
    skillNameFor,
    skillBody,
    frontmatterName,
    cronOf,
    whyNotCreated,
    planApps,
    messageFor,
  };
})(typeof window !== "undefined" ? window : globalThis);
