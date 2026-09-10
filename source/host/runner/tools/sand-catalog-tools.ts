import { z } from "zod";

import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  CreateAgentArgs,
  CreateAgentError,
  CreateAgentResult,
  CreateAgentSuccess,
  CreateAgentToolCall,
  GetAgentStatusArgs,
  GetAgentStatusError,
  GetAgentStatusResult,
  GetAgentStatusSuccess,
  GetAgentStatusToolCall,
  ReadAgentTranscriptArgs,
  ReadAgentTranscriptError,
  ReadAgentTranscriptResult,
  ReadAgentTranscriptSuccess,
  ReadAgentTranscriptToolCall,
} from "../../../packages/proto/generated/agent/v1/coordinator_tools_pb.js";
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.js";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/common.js";
import type { Context } from "../../../packages/context/core.js";
import {
  MARKETPLACE_BOTS,
  findMarketplaceBot,
  marketplaceBotCardView,
  type MarketplaceBot,
  type MarketplaceBotCard,
} from "../../../shared/marketplace/catalog.js";

/**
 * TITAN-CATALOG-1. The BOTS half of the Marketplace, as tools rather than as a page.
 *
 * Jason, 2026-09-09 17:40: "Titan should be able to see all connectors and all the agents as a
 * catalog. When creating a new agent, it should be able to pull from those templates and ask,
 * 'Would you like to use this template or would you like me to create one from scratch?'" Titan
 * filed the same thing himself two minutes earlier: he could create agents blank and read
 * profile.json files, but "a template system where you pick a pre-built role ... and it comes with
 * a starter persona, memory seeds, and maybe connector configs, that's not here yet."
 *
 * MEASURED BEFORE THIS FILE EXISTED, grok-bot-local-vm, bundle df1300366eb2, 2026-09-09: asked
 * "create me an Instagram marketer", a fresh agent made exactly ONE tool call, CreateAgent, and
 * shipped an agent with a model-invented persona, 0 memories, 0 routines and no template. The
 * catalog was never consulted and no template was ever offered. The plugin half of the same
 * catalog has had eleven tools since MARKET-1 (SearchPlugins, GetPlugin and the nine lifecycle
 * ones in sand-mcp-management-tools.ts); the bot half had none at all.
 *
 * THREE THINGS ABOUT THE SHAPE OF THIS FILE, each one a fact rather than a style choice.
 *
 * 1. THESE ARE PLAIN ZOD TOOLS, NOT `defineCommunicateTool` ONES, and for the same reason
 *    FEEDBACK-1's problem-report-tool.ts is: every communicate-wrapped tool lands in the
 *    conversation outline under the proto case `communicateUpdateToolCall`, and the console's
 *    NOT_A_RECEIPT filter (ui/machine-room/gateway-adapter.js) drops every outline row whose name
 *    matches /communicate|.../ before it renders. A communicate tool therefore draws NO CHIP AT
 *    ALL. The person is supposed to see, in plain words and with no tool name anywhere, that their
 *    bot looked at the catalog and set something up from it. So each tool rides its own proto
 *    case, and the console gives that case a fixed sentence and an empty detail.
 *
 * 2. THE CASES ARE BORROWED, DELIBERATELY. `getAgentStatusToolCall`, `readAgentTranscriptToolCall`
 *    and `createAgentToolCall` are declared in the upstream 0.18 protocol and NOTHING in this
 *    product builds any of them: they are in the unprojected list in
 *    extensions/transcript/client-side-tool-v2-inventory.ts, which means they stay in the ordinary
 *    transcript rather than being relabelled, and the only other mention anywhere is a generic
 *    arg-preservation clone in packages/agent/interaction-handler.ts. Their args carry the string
 *    fields these three tools need, so no proto is regenerated. The console keys its three
 *    sentences off these three names and a test pins both halves, so a rename on either side is a
 *    red test rather than a raw proto name on a customer's screen.
 *
 * 3. NOTHING HERE TRUSTS A ROW THE MODEL HANDS BACK. A card from `listMarketplace` has no
 *    instructions, no memories, no skills, no routines and no apps (BOTS-4's own "what bites"), so
 *    a tool that let the model import from a card would quietly create a description-only agent
 *    with nothing in it. Both the read tool and the setup tool resolve the WHOLE row in process by
 *    id through `findMarketplaceBot`, over a deep-frozen module, with no gateway round trip.
 *
 * TWO ROW SHAPES ARE LIVE AT ONCE and every reader here is defensive about it: the first-party
 * packs (marketing-team and friends) carry `integrations` as bare plugin ids with no `apps` and no
 * `routines` at all, while a generated community row carries both. A missing field is a bot with
 * none of that, never a throw.
 */

// ------------------------------------------------------------------ the names the console keys on

export const CATALOG_SEARCH_TOOL_ID = "CATALOG_SEARCH";
export const CATALOG_SEARCH_TOOL_NAME = "SearchBotCatalog";
/** The name this tool's row carries in the conversation outline. The console keys its label off it. */
export const CATALOG_SEARCH_OUTLINE_NAME = "getAgentStatusToolCall";

export const CATALOG_TEMPLATE_TOOL_ID = "CATALOG_TEMPLATE";
export const CATALOG_TEMPLATE_TOOL_NAME = "GetBotTemplate";
export const CATALOG_TEMPLATE_OUTLINE_NAME = "readAgentTranscriptToolCall";

export const CATALOG_SETUP_TOOL_ID = "CATALOG_SETUP";
export const CATALOG_SETUP_TOOL_NAME = "CreateAgentFromTemplate";
export const CATALOG_SETUP_OUTLINE_NAME = "createAgentToolCall";

/** The one line each tool reads in the dynamic-tool hint table. */
export const CATALOG_SEARCH_TOOL_HINT =
  "Look through the ready-made bots in the Marketplace before building a new bot from nothing.";
export const CATALOG_TEMPLATE_TOOL_HINT =
  "Read one ready-made bot in full: its facts, playbooks, jobs and the apps it wants.";
export const CATALOG_SETUP_TOOL_HINT =
  "Set a new bot up from a ready-made one, with its facts, playbooks and jobs already in place.";

// ------------------------------------------------------------------------------ the dependencies

/** A plugin as the box's own installed-state reader answers it. `McpPluginSummary` satisfies this. */
export interface CatalogPluginRow {
  readonly pluginId: string;
  readonly displayName: string;
  readonly category: string;
  readonly isInstalled: boolean;
  readonly kind?: string;
}

/**
 * What the host verb answers. Read defensively on purpose: the verb and these tools are built by
 * two hands at once, so a count that arrives as a list and a list that arrives as a count both
 * have to read the same to a person.
 */
export interface MarketplaceImportReport {
  /** "done" | "already" | "failed" | "refused" on a current box; absent on an older one. */
  readonly state?: string;
  /** The plain-words sentence the import wrote, which is the whole of a refusal. */
  readonly message?: string;
  readonly agentId?: string;
  readonly name?: string;
  readonly memories?: number | readonly unknown[];
  readonly skills?: number | readonly unknown[];
  readonly routines?: number | readonly unknown[];
  readonly integrations?: {
    readonly connected?: readonly string[];
    readonly offered?: readonly string[];
    readonly unavailable?: readonly string[];
  };
  readonly alreadyExisted?: boolean;
  readonly notCreated?: readonly { readonly name?: string; readonly reason?: string }[];
}

export interface CatalogToolDependencies {
  /**
   * The plugins this box can install, each with whether it already has it. The SAME reader
   * SearchPlugins uses (McpManagementDependencies.listPlugins), because a catalog plugin card
   * carries no installed flag at all and `McpPluginSummary.isInstalled` -- connectors.json for a
   * connector, a binary probe in the box for a shell tool -- is the only honest source.
   */
  listPlugins(): Promise<readonly CatalogPluginRow[]>;
  /**
   * The host-side import. Absent on a box whose bundle predates the verb, and the setup tool is
   * then not built at all rather than offered and made to fail.
   */
  importBot?(args: { readonly id: string; readonly name?: string }): Promise<MarketplaceImportReport>;
}

// ---------------------------------------------------------------------------------- the ranking

export const CATALOG_QUERY_MIN_TOKEN_LENGTH = 3;
/**
 * A query token is matched on its first six characters, not whole. "create me an INSTAGRAM
 * MARKETER" is the request this wave exists for and there is no Instagram bot in the catalog:
 * `marketer` does not appear anywhere, `Marketing` is the category a run of the rows sit under,
 * and a whole-word `includes` returns nothing at all, which leaves the model with nothing to
 * offer and sends it straight back to building blank. Six characters is what makes marketer,
 * marketing and marketers one stem.
 */
export const CATALOG_TOKEN_STEM_LENGTH = 6;

export function tokenizeCatalogQuery(query: string): string[] {
  return [...new Set(String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(
    (token) => token.length >= CATALOG_QUERY_MIN_TOKEN_LENGTH,
  ))];
}

export function catalogTokenStem(token: string): string {
  return token.length > CATALOG_TOKEN_STEM_LENGTH ? token.slice(0, CATALOG_TOKEN_STEM_LENGTH) : token;
}

/** The same shape as `scorePluginForToken`, over the fields a bot card actually carries. */
export function scoreBotForToken(bot: MarketplaceBotCard, token: string): number {
  const stem = catalogTokenStem(token);
  const id = bot.id.toLowerCase();
  const name = bot.name.toLowerCase();
  if (id === token || name === token) return 8;
  if (id.includes(stem) || name.includes(stem)) return 5;
  if ((bot.tags ?? []).some((tag) => String(tag).toLowerCase().includes(stem))) return 3;
  if (bot.category.toLowerCase().includes(stem)) return 2;
  if (bot.description.toLowerCase().includes(stem)) return 1;
  if ((bot.integrations ?? []).some((plugin) => String(plugin).toLowerCase().includes(stem))) return 1;
  return 0;
}

export function rankBotsLexically(
  bots: readonly MarketplaceBotCard[],
  query: string,
): MarketplaceBotCard[] {
  const tokens = tokenizeCatalogQuery(query);
  const byName = (left: MarketplaceBotCard, right: MarketplaceBotCard): number =>
    left.name.localeCompare(right.name);
  if (tokens.length === 0) return [...bots].sort(byName);
  return bots.map((bot) => ({
    bot,
    score: tokens.reduce((sum, token) => sum + scoreBotForToken(bot, token), 0),
  })).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || Number(right.bot.featured) - Number(left.bot.featured)
      || byName(left.bot, right.bot))
    .map((entry) => entry.bot);
}

export function rankCatalogPluginsLexically(
  plugins: readonly CatalogPluginRow[],
  query: string,
): CatalogPluginRow[] {
  const tokens = tokenizeCatalogQuery(query);
  const byName = (left: CatalogPluginRow, right: CatalogPluginRow): number =>
    left.displayName.localeCompare(right.displayName);
  if (tokens.length === 0) return [...plugins].sort(byName);
  return plugins.map((plugin) => {
    const id = plugin.pluginId.toLowerCase();
    const name = plugin.displayName.toLowerCase();
    const score = tokens.reduce((sum, token) => {
      const stem = catalogTokenStem(token);
      if (id === token || name === token) return sum + 8;
      if (id.includes(stem) || name.includes(stem)) return sum + 5;
      if (plugin.category.toLowerCase().includes(stem)) return sum + 2;
      return sum;
    }, 0);
    return { plugin, score };
  }).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || byName(left.plugin, right.plugin))
    .map((entry) => entry.plugin);
}

// ------------------------------------------------------------------------------- reading a row

/** A row's apps, whatever shape the row is in. A pack has none and that is not an error. */
function appsOf(bot: MarketplaceBot): readonly {
  readonly label: string;
  readonly line: string;
  readonly plugin: string | null;
}[] {
  const rows = Array.isArray(bot.apps) ? bot.apps : [];
  return rows.map((app) => ({
    label: String(app?.label ?? app?.name ?? "").trim() || String(app?.plugin ?? "").trim(),
    line: String(app?.line ?? "").trim(),
    plugin: typeof app?.plugin === "string" && app.plugin.trim().length > 0 ? app.plugin.trim() : null,
  })).filter((app) => app.label.length > 0);
}

function memoriesOf(bot: MarketplaceBot): readonly string[] {
  return (Array.isArray(bot.memories) ? bot.memories : [])
    .map((memory) => String(memory?.text ?? "").trim())
    .filter((text) => text.length > 0);
}

function routinesOf(bot: MarketplaceBot): readonly {
  readonly name: string;
  readonly summary: string;
  readonly note: string;
  readonly runs: boolean;
}[] {
  return (Array.isArray(bot.routines) ? bot.routines : []).map((routine) => ({
    name: String(routine?.name ?? "").trim(),
    summary: String(routine?.summary ?? "").trim(),
    note: String(routine?.scheduleNote ?? "").trim(),
    runs: typeof routine?.schedule === "string" && routine.schedule.trim().split(/\s+/).length === 5,
  })).filter((routine) => routine.name.length > 0);
}

function skillsOf(bot: MarketplaceBot): readonly { readonly name: string; readonly description: string }[] {
  return (Array.isArray(bot.skills) ? bot.skills : []).map((skill) => ({
    name: String(skill?.name ?? "").trim(),
    description: String(skill?.description ?? "").trim(),
  })).filter((skill) => skill.name.length > 0);
}

const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

// -------------------------------------------------------------------------------- the answers

function installedLabel(plugin: string | null, installed: ReadonlyMap<string, CatalogPluginRow>): string {
  if (plugin == null || plugin.length === 0) return "no plugin for it yet, so they would bring their own";
  const row = installed.get(plugin);
  if (row == null) return `plugin ${plugin}, which this box's catalog does not carry`;
  return row.isInstalled ? `${row.displayName}, installed here` : `${row.displayName}, not installed yet`;
}

export function describeBotCard(
  card: MarketplaceBotCard,
  plugins: ReadonlyMap<string, CatalogPluginRow>,
): string {
  const counts = card.counts ?? { memories: 0, skills: 0, routines: 0, apps: 0 };
  const brings = [
    `${counts.memories} fact(s) it already knows`,
    `${counts.skills} playbook(s)`,
    `${counts.routines} job(s) that can run on their own`,
  ].join(", ");
  const wants = (card.integrations ?? []).map((id) => {
    const row = plugins.get(id);
    if (row == null) return `${id} (no plugin for it here)`;
    return `${row.displayName}${row.isInstalled ? " (installed)" : ""}`;
  });
  const team = Array.isArray(card.members) && card.members.length > 0
    // MEASURED, grok-bot-local-vm 2026-09-10: with the card saying only "a team of 7", a bot asked
    // for an Instagram marketer offered `marketing-team`, was told "use the template", called the
    // setup tool and was refused -- a team goes on from its own page in the Marketplace, all at
    // once -- and then had nothing true to say. So the card says so before it is offered. It is
    // still OFFERED, not hidden: a team is often the best answer to what the person asked for, and
    // they should hear about it and be told where it is added.
    ? ` · a team of ${card.members.length}, added from its own page in the Marketplace, not by you`
    : "";
  return `- ${card.id} · ${card.name} · ${card.category}${team}\n`
    + `    ${clamp(card.description, 220)}\n`
    + `    brings ${brings}\n`
    + `    apps it wants: ${wants.length === 0 ? "none" : wants.join(", ")}`;
}

export function describeCatalogPlugin(plugin: CatalogPluginRow): string {
  return `- ${plugin.pluginId} · ${plugin.displayName} · ${plugin.category} · `
    + `${plugin.isInstalled ? "installed on this box" : "not installed"}`;
}

/**
 * THE QUESTION, quoted rather than described, and it is the LAST thing either read tool says.
 *
 * Jason, 2026-09-09 17:40, asked for it in these words: "When creating a new agent, it should be
 * able to pull from those templates and ask, 'Would you like to use this template or would you like
 * me to create one from scratch?'"
 *
 * MEASURED on grok-bot-local-vm 2026-09-10: told in prose, in three separate places, to "ask
 * whether they want one of those or one built from scratch", a bot asked for an Instagram marketer
 * looked at the catalog, read two rows in full, named three of them with a line each -- and then
 * stopped. There was no question mark anywhere in the reply. It had offered a choice and never put
 * it to the person, which is the half of Jason's sentence that makes the other half worth anything.
 * A described instruction was not enough; a quoted sentence with "end your message with it" is.
 */
const THE_QUESTION =
  "Now answer the person. Name the two or three closest by name with one line each, and END your"
  + " message with this question, in words as close to these as the conversation allows:"
  + " \"Would you like to use one of these, or would you like me to build one from scratch?\""
  + " Set nothing up until they have answered.";

/** A row that is several bots with a coordinator rather than one bot. */
export function isTeamCard(card: { readonly members?: readonly unknown[] }): boolean {
  return Array.isArray(card.members) && card.members.length > 0;
}

const CATALOG_MAX_MATCHED_BOTS = 15;
const CATALOG_MAX_MATCHED_PLUGINS = 12;
const CATALOG_TEMPLATE_INSTRUCTIONS_CHARS = 1200;
const CATALOG_TEMPLATE_MEMORY_CHARS = 3000;

export function describeCatalogListing(
  query: string,
  bots: readonly MarketplaceBotCard[],
  plugins: readonly CatalogPluginRow[],
): string {
  const byId = new Map(plugins.map((plugin) => [plugin.pluginId, plugin] as const));
  const asked = String(query ?? "").trim();
  const matchedBots = rankBotsLexically(bots, asked);
  const lines: string[] = [];

  if (asked.length === 0) {
    lines.push(`${bots.length} ready-made bot(s) in the catalog, by category. Each one comes with the`
      + " facts it already knows, the playbooks it runs, the jobs it can run on its own and the apps"
      + " it uses.");
    const categories = [...new Set(matchedBots.map((bot) => bot.category))];
    for (const category of categories) {
      lines.push("", `${category}:`);
      for (const bot of matchedBots.filter((bot) => bot.category === category)) {
        lines.push(describeBotCard(bot, byId));
      }
    }
  } else if (matchedBots.length === 0) {
    lines.push(`No ready-made bot matches "${asked}". The catalog carries ${bots.length} of them across`
      + ` these categories: ${[...new Set(bots.map((bot) => bot.category))].join(", ")}. Ask again with a`
      + " category name, or offer to build one from scratch.");
    const featured = bots.filter((bot) => bot.featured).slice(0, 6);
    if (featured.length > 0) {
      lines.push("", "The ones shown first on the Marketplace page:");
      for (const bot of featured) lines.push(describeBotCard(bot, byId));
    }
  } else {
    const shown = matchedBots.slice(0, CATALOG_MAX_MATCHED_BOTS);
    /**
     * THE TEAMS COME LAST AND UNDER THEIR OWN HEADING, because they are the one thing here that is
     * not mine to set up: a team goes on from its own page in the Marketplace, where all of its
     * members arrive at once. MEASURED on grok-bot-local-vm 2026-09-10: ranked in with the rest,
     * `marketing-team` came back FIRST for "create me an Instagram marketer" -- it is the best
     * answer to that sentence -- and a bot offered it first, was told to use it, and could not.
     * They are still shown, because the person should hear a team exists and where to get it.
     */
    const single = shown.filter((bot) => !isTeamCard(bot));
    const teams = shown.filter((bot) => isTeamCard(bot));
    lines.push(`${matchedBots.length} ready-made bot(s) match "${asked}", best first`
      + `${matchedBots.length > shown.length ? `, showing ${shown.length}` : ""}. Each one comes with the`
      + " facts it already knows, the playbooks it runs, the jobs it can run on its own and the apps"
      + " it uses.");
    lines.push("");
    for (const bot of single) lines.push(describeBotCard(bot, byId));
    if (teams.length > 0) {
      lines.push("", `And ${teams.length} team(s) match too. A team is several bots with a coordinator`
        + " and it is NOT one you can set up — it goes on from its own page in the Marketplace, where"
        + " the whole team arrives at once. Mention one if it is the best answer, and say that is"
        + " where it is added:");
      for (const bot of teams) lines.push(describeBotCard(bot, byId));
    }
  }

  const matchedPlugins = asked.length === 0
    ? [...plugins].sort((left, right) => left.displayName.localeCompare(right.displayName))
    : rankCatalogPluginsLexically(plugins, asked).slice(0, CATALOG_MAX_MATCHED_PLUGINS);
  lines.push("", matchedPlugins.length === 0
    ? `No app connector matches "${asked}". ${plugins.length} are in the Marketplace; SearchPlugins lists them.`
    : `App connectors${asked.length === 0 ? "" : ` matching "${asked}"`} (${matchedPlugins.length} of ${plugins.length}):`);
  for (const plugin of matchedPlugins) lines.push(describeCatalogPlugin(plugin));

  lines.push("", "Read one in full before you offer it, and set a bot up from it rather than building"
    + " an empty one. Full detail on a connector is in GetPlugin.");
  lines.push("", THE_QUESTION);
  return lines.join("\n");
}

export function describeBotTemplate(
  bot: MarketplaceBot,
  plugins: ReadonlyMap<string, CatalogPluginRow>,
): string {
  const lines: string[] = [];
  const credit = bot.creatorNote != null && bot.creatorNote.length > 0
    ? bot.creatorNote
    : `by ${bot.creator}`;
  lines.push(`${bot.name} (${bot.id}) · ${bot.category} · ${credit}`);
  lines.push(bot.description);
  lines.push("", "The way it works, which becomes its own description on the roster:");
  lines.push(clamp(String(bot.instructions ?? "").trim(), CATALOG_TEMPLATE_INSTRUCTIONS_CHARS));

  const memories = memoriesOf(bot);
  lines.push("", `Facts it already knows (${memories.length}), written into its memory when it is set up:`);
  let budget = CATALOG_TEMPLATE_MEMORY_CHARS;
  for (const memory of memories) {
    if (budget <= 0) { lines.push("- (the rest are seeded too and are not printed here)"); break; }
    const text = clamp(memory, Math.min(budget, 700));
    budget -= text.length;
    lines.push(`- ${text}`);
  }
  if (memories.length === 0) lines.push("- none");

  const skills = skillsOf(bot);
  lines.push("", `Playbooks it brings (${skills.length}):`);
  for (const skill of skills) {
    lines.push(`- ${skill.name}${skill.description ? ` — ${skill.description}` : ""}`);
  }
  if (skills.length === 0) lines.push("- none");

  const routines = routinesOf(bot);
  lines.push("", `Jobs that run on their own (${routines.length}), every one created switched OFF:`);
  for (const routine of routines) {
    lines.push(`- ${routine.name}${routine.summary ? ` — ${routine.summary}` : ""}`
      + `${routine.note ? ` · ${routine.note}` : ""}`
      + `${routine.runs ? "" : " · no cadence this box can schedule, so it is not created"}`);
  }
  if (routines.length === 0) lines.push("- none");

  const apps = appsOf(bot);
  const appCount = apps.length > 0 ? apps.length : (bot.integrations ?? []).length;
  lines.push("", `Apps it uses (${appCount}), and what it does with each:`);
  if (apps.length > 0) {
    for (const app of apps) {
      lines.push(`- ${app.label} · ${installedLabel(app.plugin, plugins)}`
        + `${app.line ? `\n    ${app.line}` : ""}`);
    }
  } else if ((bot.integrations ?? []).length > 0) {
    for (const id of bot.integrations) lines.push(`- ${installedLabel(id, plugins)}`);
  } else {
    lines.push("- none");
  }

  const members = Array.isArray(bot.members) ? bot.members : [];
  if (members.length > 0) {
    lines.push("", `This one is a team of ${members.length}, not a single bot, and a team is not mine`
      + " to set up: it goes on from its own page in the Marketplace, where the whole team arrives at"
      + " once. Offer it if it is the best fit and say that is where it is added.");
    lines.push("");
    for (const member of members) {
      lines.push(`- ${member.role}${member.summary ? ` — ${member.summary}` : ""}`
        + `${member.reportsTo ? ` · reports to ${member.reportsTo}` : ""}`);
    }
  }

  if (bot.firstRun != null) {
    lines.push("", `Before it is any use: ${bot.firstRun.headline}`);
    for (const need of bot.firstRun.needs ?? []) lines.push(`- ${need}`);
  }

  lines.push("", THE_QUESTION);
  return lines.join("\n");
}

const countOf = (value: number | readonly unknown[] | undefined): number =>
  typeof value === "number" ? value : Array.isArray(value) ? value.length : 0;

const listOf = (value: readonly string[] | undefined): string[] =>
  (Array.isArray(value) ? value : []).map((entry) => String(entry)).filter((entry) => entry.length > 0);

export function describeImportReport(bot: MarketplaceBot, report: MarketplaceImportReport): string {
  const name = String(report.name ?? bot.name);
  if (report.alreadyExisted === true) {
    return `A bot called "${name}" is already on the roster, so nothing was created and nothing was`
      + " changed. Tell the person it is already there and ask whether they want a second one under a"
      + " different name.";
  }
  const lines: string[] = [];
  lines.push(`Set up "${name}"${report.agentId ? ` (id ${report.agentId})` : ""} from the catalog.`);
  lines.push(`It knows ${countOf(report.memories)} fact(s), brings ${countOf(report.skills)} playbook(s)`
    + ` and carries ${countOf(report.routines)} job(s), every one switched OFF until the person turns`
    + " it on.");
  const connected = listOf(report.integrations?.connected);
  const offered = listOf(report.integrations?.offered);
  const unavailable = listOf(report.integrations?.unavailable);
  if (connected.length > 0) lines.push(`Already connected here: ${connected.join(", ")}.`);
  if (offered.length > 0) lines.push(`Ready to add from the Marketplace: ${offered.join(", ")}.`);
  if (unavailable.length > 0) {
    lines.push(`Not something this product carries yet, so they would bring their own: ${unavailable.join(", ")}.`);
  }
  if (connected.length === 0 && offered.length === 0 && unavailable.length === 0) {
    lines.push("It needs no apps connected.");
  }
  for (const missed of report.notCreated ?? []) {
    if (missed?.name == null) continue;
    lines.push(`"${missed.name}" was not created: ${missed.reason ?? "no cadence this box can schedule"}.`);
  }
  lines.push("Tell the person in your own plain words what it came with and what still needs"
    + " connecting. Never name a tool, and do not claim anything is connected that is not.");
  return lines.join("\n");
}

// ------------------------------------------------------------------------------- the three tools

export const catalogSearchParameters = z.object({
  query: z.string().trim().optional().catch(undefined).describe(
    "What the person asked for, in their own words (\"instagram marketer\", \"someone for the books\","
    + " \"research\"). Leave it out to see the whole catalog.",
  ),
});

export const catalogTemplateParameters = z.object({
  template_id: z.string().trim().min(1).describe(
    "The STABLE id of one ready-made bot, from SearchBotCatalog. Not its display name.",
  ),
});

export const catalogSetupParameters = z.object({
  template_id: z.string().trim().min(1).describe(
    "The STABLE id of the ready-made bot to set up, from SearchBotCatalog.",
  ),
  name: z.string().trim().min(1).optional().catch(undefined).describe(
    "A name for the new bot on the roster. Leave it out to use the ready-made bot's own name.",
  ),
});

const SEARCH_DESCRIPTION =
  "The ready-made bots in the Marketplace, and the app connectors this box can install. READ THIS"
  + " FIRST whenever somebody asks for a new bot: each ready-made one arrives already knowing its"
  + " facts, holding its playbooks, carrying its jobs switched off and saying which apps it wants,"
  + " which is everything a bot you create from nothing does not have. Say what the person asked for"
  + " in their own words and the closest ones come back best first, each with its STABLE id; leave"
  + " the query out for the whole catalog. Read one in full with GetBotTemplate before you offer it."
  + " Read-only, and it never needs the user's permission.";

const TEMPLATE_DESCRIPTION =
  "One ready-made bot in full, by its STABLE id from SearchBotCatalog: the way it works, the facts it"
  + " already knows, the playbooks it brings, the jobs it would carry and every app it uses with this"
  + " bot's own sentence about what it does with each and whether this box already has it. Read this"
  + " before you offer a template to somebody, so what you tell them is what they will actually get."
  + " Read-only.";

const SETUP_DESCRIPTION =
  "Set a new bot up from a ready-made one by its STABLE id: it creates the bot, writes the facts into"
  + " its memory, imports its playbooks, creates its jobs SWITCHED OFF, and reports which apps are"
  + " connected here, which can be added, and which this product does not carry. Read the row in full"
  + " with GetBotTemplate first, so what you tell them afterwards is what it actually holds. ONLY call this after"
  + " the person has said which one they want -- offer them the two or three closest by name first and"
  + " ask whether they want one of those or one built from scratch. A bot already on the roster under"
  + " that name is left exactly as it is and nothing is written. Afterwards, tell them what it came"
  + " with and what still needs connecting, in plain words.";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const wrapSearch = (value: GetAgentStatusToolCall): ToolCall =>
  new ToolCall({ tool: { case: "getAgentStatusToolCall", value } });
const wrapTemplate = (value: ReadAgentTranscriptToolCall): ToolCall =>
  new ToolCall({ tool: { case: "readAgentTranscriptToolCall", value } });
const wrapSetup = (value: CreateAgentToolCall): ToolCall =>
  new ToolCall({ tool: { case: "createAgentToolCall", value } });

interface CatalogInteractionHandler<Result> {
  executeToolCall: (
    context: Context,
    toolCall: ToolCall,
    id: string,
    run: (context: Context) => Promise<Result>,
    merge: (result: Result) => ToolCall,
  ) => Promise<Result>;
}

function createCatalogSearchTool(dependencies: CatalogToolDependencies) {
  const execute = async (
    context: Context,
    interactionHandler: CatalogInteractionHandler<GetAgentStatusResult>,
    args: z.infer<typeof catalogSearchParameters>,
    meta: { readonly toolCallId: string },
  ): Promise<GetAgentStatusResult> => {
    const query = (args.query ?? "").trim();
    const protoArgs = new GetAgentStatusArgs({
      toolCallId: meta.toolCallId,
      ...(query.length === 0 ? {} : { agentIds: [query] }),
    });
    const base = new GetAgentStatusToolCall({ args: protoArgs });
    return interactionHandler.executeToolCall(context, wrapSearch(base), meta.toolCallId, async () => {
      try {
        const plugins = await dependencies.listPlugins();
        const cards = MARKETPLACE_BOTS.map(marketplaceBotCardView);
        return new GetAgentStatusResult({
          result: {
            case: "success",
            value: new GetAgentStatusSuccess({ message: describeCatalogListing(query, cards, plugins) }),
          },
        });
      } catch (error) {
        return new GetAgentStatusResult({
          result: { case: "error", value: new GetAgentStatusError({ error: errorMessage(error) }) },
        });
      }
    }, (result) => wrapSearch(new GetAgentStatusToolCall({ args: protoArgs, result })));
  };

  return createZodAgentTool(CATALOG_SEARCH_TOOL_ID, {
    name: CATALOG_SEARCH_TOOL_NAME,
    descriptionGenerator: () => SEARCH_DESCRIPTION,
    parameters: catalogSearchParameters,
    // `emitInitialPartialToolCall: false`, the same as every sand tool: the chip says the catalog
    // was looked at, and a half-built row that changes under the reader is not that.
    execute: withSafeParsedArgs(
      catalogSearchParameters,
      execute,
      wrapSearch(new GetAgentStatusToolCall()),
      { emitInitialPartialToolCall: false },
    ),
    render: async (_context: Context, result: GetAgentStatusResult) => {
      if (result.result.case === "success") return createStringResult(result.result.value.message);
      if (result.result.case === "error") return createStringResult(`The catalog could not be read: ${result.result.value.error}`);
      return createStringResult("The catalog could not be read.");
    },
    serializeError: (error: unknown) => wrapSearch(new GetAgentStatusToolCall({
      result: new GetAgentStatusResult({
        result: { case: "error", value: new GetAgentStatusError({ error: errorMessage(error) }) },
      }),
    })),
  });
}

function createCatalogTemplateTool(dependencies: CatalogToolDependencies) {
  const execute = async (
    context: Context,
    interactionHandler: CatalogInteractionHandler<ReadAgentTranscriptResult>,
    args: z.infer<typeof catalogTemplateParameters>,
    meta: { readonly toolCallId: string },
  ): Promise<ReadAgentTranscriptResult> => {
    const protoArgs = new ReadAgentTranscriptArgs({ toolCallId: meta.toolCallId, agentId: args.template_id });
    const base = new ReadAgentTranscriptToolCall({ args: protoArgs });
    return interactionHandler.executeToolCall(context, wrapTemplate(base), meta.toolCallId, async () => {
      try {
        // The WHOLE row, resolved here by id rather than taken from anything the model handed back:
        // a list card carries no instructions, memories, skills, routines or apps at all.
        const bot = findMarketplaceBot(args.template_id);
        if (bot == null) {
          return new ReadAgentTranscriptResult({
            result: {
              case: "success",
              value: new ReadAgentTranscriptSuccess({
                transcript: `No ready-made bot with id "${args.template_id}". Run SearchBotCatalog and use an id from it.`,
              }),
            },
          });
        }
        const plugins = new Map(
          (await dependencies.listPlugins()).map((plugin) => [plugin.pluginId, plugin] as const),
        );
        return new ReadAgentTranscriptResult({
          result: {
            case: "success",
            value: new ReadAgentTranscriptSuccess({ transcript: describeBotTemplate(bot, plugins) }),
          },
        });
      } catch (error) {
        return new ReadAgentTranscriptResult({
          result: { case: "error", value: new ReadAgentTranscriptError({ error: errorMessage(error) }) },
        });
      }
    }, (result) => wrapTemplate(new ReadAgentTranscriptToolCall({ args: protoArgs, result })));
  };

  return createZodAgentTool(CATALOG_TEMPLATE_TOOL_ID, {
    name: CATALOG_TEMPLATE_TOOL_NAME,
    descriptionGenerator: () => TEMPLATE_DESCRIPTION,
    parameters: catalogTemplateParameters,
    execute: withSafeParsedArgs(
      catalogTemplateParameters,
      execute,
      wrapTemplate(new ReadAgentTranscriptToolCall()),
      { emitInitialPartialToolCall: false },
    ),
    render: async (_context: Context, result: ReadAgentTranscriptResult) => {
      if (result.result.case === "success") return createStringResult(result.result.value.transcript);
      if (result.result.case === "error") return createStringResult(`That template could not be read: ${result.result.value.error}`);
      return createStringResult("That template could not be read.");
    },
    serializeError: (error: unknown) => wrapTemplate(new ReadAgentTranscriptToolCall({
      result: new ReadAgentTranscriptResult({
        result: { case: "error", value: new ReadAgentTranscriptError({ error: errorMessage(error) }) },
      }),
    })),
  });
}

function createCatalogSetupTool(
  dependencies: CatalogToolDependencies & {
    importBot: NonNullable<CatalogToolDependencies["importBot"]>;
  },
) {
  const execute = async (
    context: Context,
    interactionHandler: CatalogInteractionHandler<CreateAgentResult>,
    args: z.infer<typeof catalogSetupParameters>,
    meta: { readonly toolCallId: string },
  ): Promise<CreateAgentResult> => {
    const bot = findMarketplaceBot(args.template_id);
    // The NAME rides in the proto args because the console draws the chip from them: "Set up
    // <name> from the catalog" is the sentence, and the args are the only place the readable name
    // reaches the page (an outline row carries no result a page can read).
    const protoArgs = new CreateAgentArgs({
      toolCallId: meta.toolCallId,
      prompt: args.template_id,
      name: args.name ?? bot?.name ?? args.template_id,
    });
    const base = new CreateAgentToolCall({ args: protoArgs });
    return interactionHandler.executeToolCall(context, wrapSetup(base), meta.toolCallId, async () => {
      if (bot == null) {
        return new CreateAgentResult({
          result: {
            case: "error",
            value: new CreateAgentError({
              error: `No ready-made bot with id "${args.template_id}". Run SearchBotCatalog and use an id from it.`,
            }),
          },
        });
      }
      try {
        const report = await dependencies.importBot({
          id: bot.id,
          ...(args.name == null ? {} : { name: args.name }),
        });
        /**
         * A REFUSAL IS AN ERROR, NOT A SUCCESS CARRYING BAD NEWS.
         *
         * The import refuses a row it cannot honestly make one bot out of -- a team, which goes on
         * from its own page in the Marketplace with all its members at once -- and it says so in
         * plain words. Handed that back as a SUCCESS whose message happened to be a refusal, the
         * model read it as a success: MEASURED on grok-bot-local-vm 2026-09-10, asked to set the
         * Marketing team up, a bot answered "Done -- Marketing team is set up and on your roster"
         * and then invented a reason it was empty ("it arrived as a blank slate"). Nothing had been
         * created. Telling a customer a bot exists when none does is the worst thing in this file,
         * and no wording in a success message fixes it, because the case is what the model reads
         * first. So a report that created no agent comes back as an error.
         */
        const refused = report != null
          && (report.state === "refused" || report.state === "failed"
            || (report.agentId == null && report.alreadyExisted !== true));
        if (refused) {
          return new CreateAgentResult({
            result: {
              case: "error",
              value: new CreateAgentError({
                error: String(report?.message ?? `${bot.name} was not set up.`),
              }),
            },
          });
        }
        return new CreateAgentResult({
          result: {
            case: "success",
            value: new CreateAgentSuccess({
              agentId: String(report?.agentId ?? ""),
              message: describeImportReport(bot, report ?? {}),
            }),
          },
        });
      } catch (error) {
        return new CreateAgentResult({
          result: { case: "error", value: new CreateAgentError({ error: errorMessage(error) }) },
        });
      }
    }, (result) => wrapSetup(new CreateAgentToolCall({ args: protoArgs, result })));
  };

  return createZodAgentTool(CATALOG_SETUP_TOOL_ID, {
    name: CATALOG_SETUP_TOOL_NAME,
    descriptionGenerator: () => SETUP_DESCRIPTION,
    parameters: catalogSetupParameters,
    execute: withSafeParsedArgs(
      catalogSetupParameters,
      execute,
      wrapSetup(new CreateAgentToolCall()),
      { emitInitialPartialToolCall: false },
    ),
    render: async (_context: Context, result: CreateAgentResult) => {
      if (result.result.case === "success") return createStringResult(result.result.value.message);
      if (result.result.case === "error") return createStringResult(`Nothing was set up: ${result.result.value.error}`);
      return createStringResult("Nothing was set up.");
    },
    serializeError: (error: unknown) => wrapSetup(new CreateAgentToolCall({
      result: new CreateAgentResult({
        result: { case: "error", value: new CreateAgentError({ error: errorMessage(error) }) },
      }),
    })),
  });
}

/**
 * The two read-only tools always, and the setup tool only when this box's bundle carries the
 * import. A tool offered against an importer that is not there is a tool that can only fail, and
 * the toolset's trace line names it as withheld with the reason instead.
 */
export function createCatalogTools(dependencies: CatalogToolDependencies) {
  const tools = [
    createCatalogSearchTool(dependencies),
    createCatalogTemplateTool(dependencies),
  ];
  const importBot = dependencies.importBot;
  if (importBot != null) tools.push(createCatalogSetupTool({ ...dependencies, importBot }));
  return tools;
}
