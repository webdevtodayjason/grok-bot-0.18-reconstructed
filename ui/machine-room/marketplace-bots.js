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

  // ------------------------------------------------------------------ small helpers
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const text = (value) => String(value ?? "").trim();
  const listOf = (value) => (Array.isArray(value) ? value : []);

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
  const view = { botId: null, page: "instructions", query: "", category: "All", notice: "" };
  const imports = new Map();  // bot id -> { state: "running" | "done" | "failed", ... }
  let catalog = null;
  let catalogError = null;
  let installed = new Set();
  let container = null;
  let loading = false;

  const botsOf = () => listOf(catalog && catalog.bots);
  const pluginsOf = () => listOf(catalog && catalog.plugins);
  const botById = (id) => botsOf().find((b) => text(b.id) === text(id)) ?? null;
  const pluginById = (id) => pluginsOf().find((p) => text(p.id) === text(id)) ?? null;

  // The catalog's own category list where it carries one (either a flat array or { bots, plugins }),
  // and the categories the bots themselves name where it does not. "All" always leads and
  // "Featured" is only offered when a bot is actually flagged featured.
  function categories() {
    const raw = catalog && catalog.categories;
    const declared = Array.isArray(raw) ? raw : listOf(raw && raw.bots);
    const named = declared.map((c) => (typeof c === "string" ? c : text(c && c.name))).filter(Boolean);
    const fromBots = botsOf().map((b) => text(b.category)).filter(Boolean);
    const featured = botsOf().some((b) => b.featured === true);
    const ordered = [];
    for (const name of [...(named.length ? named : []), ...fromBots]) {
      if (name === "All") continue;
      if (name === "Featured" && !featured) continue;
      if (!ordered.includes(name)) ordered.push(name);
    }
    if (featured && !ordered.includes("Featured")) ordered.unshift("Featured");
    return ["All", ...ordered];
  }

  function matches(bot) {
    const query = view.query.trim().toLowerCase();
    if (!query) return true;
    return [bot.name, bot.description, bot.category, bot.creator]
      .map((v) => String(v ?? "").toLowerCase())
      .some((v) => v.includes(query));
  }

  function inCategory(bot, category) {
    if (category === "All") return true;
    if (category === "Featured") return bot.featured === true;
    return text(bot.category) === category;
  }

  // ------------------------------------------------------------------ list view
  const oneLine = (value) => {
    const flat = text(value).replace(/\s+/g, " ");
    return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  };

  function chipsMarkup() {
    // .palette-chips is a bare flex row with no wrap; six categories plus All need one.
    return `<div class="palette-chips" role="group" aria-label="Bot categories" style="margin:0 0 14px;flex-wrap:wrap">${categories().map((name) => {
      const active = view.category === name;
      return `<button class="roster-tab${active ? " is-active" : ""}" type="button" data-bot-category="${escapeHtml(name)}" aria-pressed="${active}">${escapeHtml(name)}</button>`;
    }).join("")}</div>`;
  }

  function featuredCardMarkup(bot) {
    return `<button class="plugin-card" type="button" data-bot-id="${escapeHtml(bot.id)}" style="display:grid;gap:10px;text-align:left;cursor:pointer;color:inherit;font:inherit">`
      + `<span style="display:flex;align-items:center;gap:10px">${tileMarkup(bot, "large")}<span style="display:grid;gap:2px;min-width:0"><strong style="font-size:13px">${escapeHtml(bot.name)}</strong><small>${escapeHtml(text(bot.creator) || "Titanbot team")}’s Bot</small></span></span>`
      + `<p style="margin:0">${escapeHtml(oneLine(bot.description))}</p>`
      + `<span class="tag-list" style="margin:0"><span class="tag">${escapeHtml(text(bot.category) || "Bots")}</span><span class="tag">${listOf(bot.skills).length} skill${listOf(bot.skills).length === 1 ? "" : "s"}</span></span>`
      + `</button>`;
  }

  function rowMarkup(bot) {
    const need = listOf(bot.integrations);
    const missing = need.filter((id) => !installed.has(text(id))).length;
    return `<button class="plugin-nav-button" type="button" data-bot-id="${escapeHtml(bot.id)}">`
      + tileMarkup(bot, "small")
      + `<span><strong>${escapeHtml(bot.name)} by ${escapeHtml(text(bot.creator) || "Titanbot team")}</strong><small>${escapeHtml(oneLine(bot.description))}</small></span>`
      + `<span class="status-dot ${missing === 0 && need.length > 0 ? "success" : ""}"></span>`
      + `</button>`;
  }

  function listMarkup() {
    const bots = botsOf().filter((b) => matches(b) && inCategory(b, view.category));
    const intro = `<div class="panel-intro"><p>A Bot is a template for an agent on this box: a persona, the playbooks it can run, and the plugins those playbooks need. Import Bot creates a NEW agent here with that persona and imports each skill into the box's shared library. Nothing runs until you message it.</p><span class="status-pill">${botsOf().length} template${botsOf().length === 1 ? "" : "s"}</span></div>`;
    const search = `<div class="field" style="margin:0 0 12px"><label class="sr-only" for="marketplace-bot-search">Search bots</label><input id="marketplace-bot-search" class="search-input" type="search" data-bot-search autocomplete="off" placeholder="Search bots" value="${escapeHtml(view.query)}" /></div>`;

    if (bots.length === 0) {
      const why = botsOf().length === 0
        ? "This host serves no bot templates yet. listMarketplace is what carries them, and this box answered with none."
        : "No template matches that search in this category.";
      return `${intro}${search}${chipsMarkup()}<div class="empty-state">${escapeHtml(why)}</div>`;
    }

    const featured = view.category === "All" ? bots.filter((b) => b.featured === true) : [];
    const featuredSection = featured.length
      ? `<div class="plugin-section-title"><span>Featured</span></div><div class="panel-grid" style="margin-bottom:18px">${featured.map(featuredCardMarkup).join("")}</div>`
      : "";
    // Sections per category, in the catalog's own order, so the page reads the way the chips do.
    const groups = view.category === "All"
      ? categories().filter((c) => c !== "All" && c !== "Featured")
      : [view.category];
    const sections = groups.map((name) => {
      const members = bots.filter((b) => inCategory(b, name));
      if (!members.length) return "";
      return `<div class="plugin-section-title"><span>${escapeHtml(name)}</span><span>${members.length}</span></div><div class="plugin-list" style="margin-bottom:16px">${members.map(rowMarkup).join("")}</div>`;
    }).join("");
    // A bot whose category is not in the chip list would otherwise vanish from the page entirely
    // -- including one whose category IS "Featured", which no group section covers.
    const shown = new Set(groups.flatMap((name) => bots.filter((b) => inCategory(b, name)).map((b) => text(b.id))));
    for (const bot of featured) shown.add(text(bot.id));
    const rest = bots.filter((b) => !shown.has(text(b.id)));
    const restSection = rest.length
      ? `<div class="plugin-section-title"><span>More</span><span>${rest.length}</span></div><div class="plugin-list">${rest.map(rowMarkup).join("")}</div>`
      : "";
    return `${intro}${search}${chipsMarkup()}${featuredSection}${sections}${restSection}`;
  }

  // ------------------------------------------------------------------ the bot page
  function instructionsMarkup(bot) {
    const instructions = text(bot.instructions);
    if (!instructions) return `<div class="empty-state">This template carries no instructions, so an import would create an agent with no persona.</div>`;
    return `<div class="panel-card"><h3>How this Bot should work</h3><p style="white-space:pre-wrap;margin-top:8px">${escapeHtml(instructions)}</p></div>`
      + `<span class="field-hint">This text becomes the imported agent's description, which is the only field this host feeds the model as an agent's identity. You can edit it afterwards in the agent's own details panel.</span>`;
  }

  function skillsMarkup(bot) {
    const skills = listOf(bot.skills);
    if (!skills.length) return `<div class="empty-state">This template has no playbooks; importing it creates the agent and nothing else.</div>`;
    return `<div class="plugin-list">${skills.map((skill) => `<div class="setting-row"><div><strong>${escapeHtml(text(skill.name))}</strong><small>${escapeHtml(oneLine(skill.description))}</small></div><span class="tag">${text(skill.body).length} chars</span></div>`).join("")}</div>`
      + `<span class="field-hint">Each is imported as its own SKILL.md through importAgentWorkflowText. The host's workflow library is shared across the box, so a skill imported here is offered to every agent on it.</span>`;
  }

  function integrationsMarkup(bot, ids = null) {
    const need = (ids ?? listOf(bot.integrations)).map(text).filter(Boolean);
    if (!need.length) return `<div class="empty-state">This template needs no plugins: it runs on the box's own built-in tools.</div>`;
    const rows = need.map((id) => {
      const plugin = pluginById(id);
      const name = plugin ? text(plugin.name) : id;
      const line = plugin ? oneLine(plugin.tagline || plugin.description) : "This plugin is not in the catalog this host serves.";
      const here = installed.has(id);
      const control = here
        ? `<span class="status-pill success">installed</span>`
        : plugin
          ? `<button class="ghost-button" type="button" data-add-integration="${escapeHtml(id)}">Add</button>`
          : `<span class="status-pill attention">not in this catalog</span>`;
      return `<div class="setting-row" data-integration="${escapeHtml(id)}"><div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(line)}</small></div>${control}</div>`;
    }).join("");
    return `<div class="plugin-list">${rows}</div><span class="field-hint">Add writes the plugin's entry the way the Plugins tab does — connectors.json on the box, then refreshMcp — and the credential still goes in the key form on that plugin's own card afterwards.</span>`;
  }

  function importedMarkup(bot) {
    const outcome = imports.get(text(bot.id));
    if (outcome == null) return "";
    if (outcome.state === "running") return `<div class="panel-card"><h3>Importing…</h3><p>Creating the agent, then importing ${listOf(bot.skills).length} skill${listOf(bot.skills).length === 1 ? "" : "s"}.</p></div>`;
    if (outcome.state === "failed") return `<div class="panel-card" style="outline:1px solid var(--amber-500)"><h3>Not imported</h3><p>${escapeHtml(outcome.message)}</p></div>`;
    const agent = outcome.agent ?? {};
    const skills = listOf(outcome.skills);
    const skipped = listOf(outcome.skipped);
    const missing = listOf(bot.integrations).map(text).filter((id) => !installed.has(id));
    const open = adapterOf() != null && typeof adapterOf().selectContext === "function"
      ? `<button class="ghost-button" type="button" data-open-agent="${escapeHtml(agent.id)}">Open ${escapeHtml(agent.name)}</button>`
      : "";
    const skillTags = skills.length
      ? `<div class="tag-list">${skills.map((name) => `<span class="tag">skill · ${escapeHtml(name)}</span>`).join("")}</div>`
      : `<p>The host imported no skill for this agent.</p>`;
    const skippedNote = skipped.length
      ? `<p style="margin-top:8px">Skipped by the host: ${escapeHtml(skipped.map((s) => `${s.source} (${s.reason})`).join("; "))}</p>`
      : "";
    // On the Integrations tab those very rows are already on the page above this card, so a
    // "Still needed" block there would draw every row -- and its Add button -- a second time.
    const missingRows = view.page === "integrations"
      ? ""
      : missing.length
        ? `<div class="plugin-section-title" style="margin-top:14px"><span>Still needed</span></div>${integrationsMarkup(bot, missing)}`
        : `<p style="margin-top:8px">Every plugin this Bot needs is already installed on this box.</p>`;
    return `<div class="panel-card" data-imported-agent="${escapeHtml(agent.id)}"><h3>Imported as “${escapeHtml(agent.name)}”</h3><p>${escapeHtml(oneLine(agent.description))}</p>${skillTags}${skippedNote}${open}</div>${missingRows}`;
  }

  const PAGES = [
    { id: "instructions", label: "Instructions", hint: "How this Bot should work", icon: "✎" },
    { id: "skills", label: "Skills", hint: "Playbooks it can run", icon: "▤" },
    { id: "integrations", label: "Integrations", hint: "Tools it can use", icon: "✦" },
  ];

  function botPageMarkup(bot) {
    const outcome = imports.get(text(bot.id));
    const busy = outcome != null && outcome.state === "running";
    // Offline (index.html fell back to the demo factory) there is no gateway behind this page, so
    // createAgent would fail after the click rather than before it. A button that cannot work is
    // not drawn; the pill says why in its place.
    const canImport = global.__machineRoomLive !== false;
    const nav = PAGES.map((page) => `<button class="plugin-nav-button${view.page === page.id ? " is-active" : ""}" type="button" data-bot-tab="${page.id}"><span class="plugin-icon">${page.icon}</span><span><strong>${page.label}</strong><small>${page.hint}</small></span></button>`).join("");
    const body = view.page === "skills" ? skillsMarkup(bot)
      : view.page === "integrations" ? integrationsMarkup(bot)
        : instructionsMarkup(bot);
    const importButton = canImport
      ? `<button class="primary-button" type="button" data-import-bot="${escapeHtml(bot.id)}"${busy ? " disabled" : ""}>${busy ? "Importing…" : "Import Bot"}</button>`
      : `<span class="status-pill">offline — no gateway to import through</span>`;
    return `<div data-bot-page="${escapeHtml(bot.id)}">`
      + `<button class="quiet-button" type="button" data-bots-back style="margin-bottom:12px">← All bots</button>`
      + `<div class="plugin-hero">${tileMarkup(bot, "large")}<div class="plugin-hero-copy"><h3>${escapeHtml(bot.name)}</h3><p>By ${escapeHtml(text(bot.creator) || "Titanbot team")} · ${escapeHtml(text(bot.category) || "Bots")}</p><p>${escapeHtml(bot.description)}</p></div><div style="display:grid;gap:6px;align-content:start">${importButton}</div></div>`
      + `<div class="plugin-browser" style="min-height:300px;margin-top:16px"><aside class="plugin-sidebar">${nav}</aside><section class="plugin-detail"><div class="plugin-sections">${body}${importedMarkup(bot)}</div></section></div>`
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
      catalog = {
        plugins: listOf(answer && answer.plugins),
        bots: listOf(answer && answer.bots),
        categories: (answer && answer.categories) ?? [],
      };
      catalogError = null;
      installed = await readInstalledIds(gateway, catalog.plugins).catch(() => new Set());
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

  async function refreshInstalled() {
    if (catalog == null) return;
    installed = await readInstalledIds(relayGateway(), catalog.plugins).catch(() => installed);
  }

  // ------------------------------------------------------------------ events
  async function onImportClick(botId) {
    const bot = botById(botId);
    if (bot == null) return;
    imports.set(text(bot.id), { state: "running" });
    view.notice = "";
    paint();
    try {
      const result = await importBot(relayGateway(), bot);
      imports.set(text(bot.id), { state: "done", ...result });
      // On screen first: the adapter refresh and the connectors re-read below are both round trips
      // to the box, and the imported agent must not wait behind them to be drawn.
      paint();
      // The roster on the page behind the panel is stale until the adapter re-reads it, and an
      // agent the operator cannot see is what "the page shows the new agent" is there to prevent.
      const adapter = adapterOf();
      if (adapter != null && typeof adapter.refresh === "function") await adapter.refresh().catch(() => {});
    } catch (error) {
      imports.set(text(bot.id), { state: "failed", message: String(error?.message ?? error) });
    }
    await refreshInstalled();
    paint();
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
    const add = target.closest("[data-add-integration]");
    if (add != null) { void onAddClick(add.dataset.addIntegration); return; }
    const open = target.closest("[data-open-agent]");
    if (open != null) {
      const adapter = adapterOf();
      if (adapter != null && typeof adapter.selectContext === "function") adapter.selectContext({ kind: "worker", id: open.dataset.openAgent });
      return;
    }
    const card = target.closest("[data-bot-id]");
    if (card != null) { view.botId = card.dataset.botId; view.page = "instructions"; view.notice = ""; paint(); }
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
    reload() { catalog = null; catalogError = null; return load(); },
  };
})(typeof window !== "undefined" ? window : globalThis);
