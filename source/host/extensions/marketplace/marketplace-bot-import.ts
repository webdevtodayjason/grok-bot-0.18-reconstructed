/*
 * TITAN-CATALOG-1 — one import, two doors.
 * ----------------------------------------
 * Setting a catalog bot up used to live in the console: ui/machine-room/bot-setup.js ran eight
 * gateway calls in a fixed order and a person got an agent that greets them in its own voice,
 * already knowing its operating rules, holding its playbooks, carrying its jobs switched off and
 * saying which apps it still needs. Titan could not do any of that. He could create a blank agent
 * and read a profile, and when a person asked him for an Instagram marketer he invented a persona
 * and shipped an agent with no memories, no playbooks and no jobs — measured on grok-bot-local-vm
 * 2026-09-09, one tool call in the whole turn.
 *
 * The answer is not a second copy of the sequence for the agent to run. It is this module: the
 * sequence moves into the host, the console calls it through a gateway verb, and the agent calls
 * the same verb. One implementation, two doors, and no way for the two to drift.
 *
 * THE ORDER, which IS the contract, unchanged from the console's:
 *
 *   1  listAgents            An agent already carrying this bot's exact name means the bot is on
 *                            the roster. Answer alreadyExisted, write NOTHING. A second deliberate
 *                            copy stays reachable behind `duplicate`, which is the " copy"
 *                            behaviour the packs rely on.
 *   2  createAgent           isKickstartRequested is never true. The host would otherwise write the
 *                            introduction immediately, before the agent knows anything, and the
 *                            introduction is written once.
 *   3  addAgentMemories      The bot's operating rules as the agent's own remembered facts. The
 *                            store refuses anything over its cap rather than writing it short, and
 *                            names it under `rejected` so the receipt can say which one did not fit.
 *   4  getAgentWorkflows     ONE library read, BEFORE the first import, walked across the roster
 *                            until an agent answers. The library is shared across the box and one
 *                            silent agent reading as an empty library would double every document.
 *   5  importAgentWorkflowText  One per skill the library does not already hold.
 *   6  createAgentAutomation One per routine that resolved to a real cron, always switched off. A
 *                            routine with no cron is NOT created: automation-store.upsert writes
 *                            nothing when a trigger will not normalise and still answers 200, so a
 *                            made-up trigger would be a job that silently is not there.
 *   7  the read-backs        What the box HOLDS is what gets reported, never the wish.
 *   8  kickstartAgent        LAST, so the agent writing the introduction already remembers
 *                            everything.
 *
 * On a failure part way the agent and the documents THIS run created are taken back and the report
 * says what was taken back. Nothing the run merely found is touched.
 *
 * WHAT THIS FIXES ON THE WAY IN, rather than porting. The console's `planApps` read `row.pluginId`
 * and `row.description`; a catalog app row carries `plugin` and `line` (catalog.ts:373). Measured
 * against the live host's own answer for `account-book` on grok-bot-local-vm 2026-09-09: all 11 of
 * its apps — Slack, Notion, Linear, Gmail, Google Calendar, Google Drive, Google Sheets included —
 * fell into the add-your-own bucket, so the receipt told a customer that Slack "is not something we
 * carry yet". About 177 of the 244 app entries across the community rows carry a plugin id and
 * every one of them was misreported. The unit test was green over it because its fixture was
 * written in the report's internal vocabulary rather than the catalog's row shape. So this module
 * reads `plugin` and `line` first, keeps `pluginId`/`description` as fallbacks so an older row and
 * the existing fixture still resolve, and one of its tests is driven straight off
 * findMarketplaceBot("account-book") so the fixture cannot drift from the data again.
 *
 * The second half of the same defect: no caller in the product ever passed `installedPluginIds`, so
 * `connected` was always empty even on the rows whose path worked. This verb takes no such
 * argument. It asks the box itself, through the same reader the plugin tools use — connectors.json
 * for a connector, a binary probe for a shell tool — so the omission cannot recur. Only names and
 * booleans leave that module; no stored value is read here.
 */
import { getSandRootDir } from "../../host-paths.js";
import { marketplacePluginIsInstalled } from "../mcp/marketplace-plugins.js";
import {
  findMarketplaceBot,
  findMarketplacePlugin,
  type MarketplaceBot,
} from "../../../shared/marketplace/catalog.js";

// ------------------------------------------------------------------ the box, as this needs it
/**
 * The eleven host calls the sequence makes, each one the door the gateway command already goes
 * through. The port exists so the order can be pinned by a test against a fake box rather than
 * against a real one, which is the only honest place to pin an order.
 */
export interface MarketplaceImportBox {
  listAgents(): Promise<unknown>;
  createAgent(args: { name: string; description: string; isKickstartRequested: false }): Promise<unknown>;
  deleteAgent(id: string): Promise<unknown>;
  addAgentMemories(id: string, memories: readonly string[]): Promise<unknown>;
  getAgentMemories(id: string): Promise<unknown>;
  getAgentWorkflows(id: string): Promise<unknown>;
  importAgentWorkflowText(id: string, markdown: string, name: string): Promise<unknown>;
  deleteAgentWorkflow(id: string, workflowId: string): Promise<unknown>;
  createAgentAutomation(id: string, spec: MarketplaceRoutineSpec): Promise<unknown>;
  getAgentAutomations(id: string): Promise<unknown>;
  kickstartAgent(id: string): Promise<unknown>;
  /**
   * Whether this box can already reach a plugin. Optional, and absent everywhere in the product:
   * the default below asks the box itself. A test overrides it so a machine that happens to carry
   * a binary on its PATH does not decide the assertion.
   */
  isPluginInstalled?(pluginId: string): Promise<boolean>;
}

export interface MarketplaceRoutineSpec {
  readonly name: string;
  readonly prompt: string;
  readonly trigger: { readonly type: "cron"; readonly schedule: string };
  readonly isEnabled: false;
}

export interface MarketplaceImportRequest {
  readonly id?: unknown;
  /** A name of the operator's choosing. Absent means the row's own name. */
  readonly name?: unknown;
  /** A deliberate second copy, which is the only way a bot already on the roster is added again. */
  readonly duplicate?: unknown;
}

/** One app the bot wants to reach, in the vocabulary the console's receipt already renders. */
export interface MarketplaceImportApp {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly pluginId: string;
}

export interface MarketplaceImportApps {
  readonly connected: readonly MarketplaceImportApp[];
  readonly addable: readonly MarketplaceImportApp[];
  readonly informational: readonly MarketplaceImportApp[];
  readonly byo: readonly MarketplaceImportApp[];
}

/** The same four buckets as plain names, which is what a person is read back. */
export interface MarketplaceImportIntegrations {
  readonly connected: readonly string[];
  readonly offered: readonly string[];
  readonly informational: readonly string[];
  readonly unavailable: readonly string[];
}

export interface MarketplaceImportReport {
  readonly state: "done" | "already" | "failed" | "refused";
  readonly alreadyExisted: boolean;
  readonly agent: { readonly id: string; readonly name: string } | null;
  readonly agentId: string | null;
  readonly name: string;
  readonly memories: {
    readonly added: number;
    readonly duplicates: number;
    readonly rejected: readonly { readonly text: string; readonly why: string }[];
  };
  readonly skills: {
    readonly imported: readonly string[];
    readonly reused: readonly string[];
    readonly skipped: readonly { readonly source: string; readonly reason: string }[];
  };
  readonly routines: {
    readonly created: readonly {
      readonly name: string;
      readonly schedule: string;
      readonly describes: string;
      readonly isEnabled: boolean;
    }[];
    readonly notCreated: readonly { readonly name: string; readonly why: string }[];
  };
  readonly apps: MarketplaceImportApps;
  readonly integrations: MarketplaceImportIntegrations;
  /**
   * Whether the box took the request to write the bot's own first message. BOX-7 is measured: some
   * boxes start no introduction for ANY new agent and say so by answering false, and the agent then
   * sits in an empty conversation. Reported rather than assumed, so a caller waiting for words can
   * tell a box that declined from a box that is merely slow.
   */
  readonly introduction: { readonly started: boolean };
  readonly message: string;
  readonly rolledBack?: string;
}

// ------------------------------------------------------------------ the row, read defensively
// Every one of these fields is optional on a row: the first-party bots predate memories, routines
// and apps, and a pack carries members and neither. A missing field is an empty list, never a throw.

type Row = Record<string, unknown>;

const text = (value: unknown): string => String(value ?? "").trim();
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const rowsOf = (value: unknown): readonly Row[] =>
  listOf(value).filter((row): row is Row => row != null && typeof row === "object");

const memoriesOf = (bot: Row): readonly Row[] => rowsOf(bot["memories"]);
const skillsOf = (bot: Row): readonly Row[] => rowsOf(bot["skills"]).filter((skill) => text(skill["name"]).length > 0);
const routinesOf = (bot: Row): readonly Row[] => rowsOf(bot["routines"]).filter((row) => text(row["name"]).length > 0);
const appsOf = (bot: Row): readonly Row[] => rowsOf(bot["apps"]);

/**
 * The facts seeded into the store. A generated row splits each memory paragraph at sentence
 * boundaries into `facts` that each fit the store's cap; a row with no split is seeded as its own
 * text and the store refuses it if it is too long, which is the point of the refusal.
 */
export function factsOf(bot: Row): string[] {
  const facts: string[] = [];
  for (const memory of memoriesOf(bot)) {
    const split = listOf(memory["facts"]).map(text).filter(Boolean);
    if (split.length > 0) facts.push(...split);
    else if (text(memory["text"])) facts.push(text(memory["text"]));
  }
  return facts;
}

/**
 * The identity the agent runs with. The host has ONE identity field — the agent's description —
 * and BOTS-1 is the rule for composing it: the row's description, a blank line, then its
 * instructions. The console composes it the same way, and the equivalence test pins them equal.
 */
export function personaFor(bot: Row): string {
  const description = text(bot["description"]);
  const instructions = text(bot["instructions"]);
  if (!instructions) return description;
  if (!description) return instructions;
  return `${description}\n\n${instructions}`;
}

// ------------------------------------------------------------------ skills
const slug = (value: unknown): string =>
  text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function skillPrefixOf(bot: Row): string {
  const declared = (bot["packaging"] ?? {}) as Row;
  const declaredPrefix = declared["skillPrefix"];
  if (typeof declaredPrefix === "string" && declaredPrefix.length > 0) return declaredPrefix;
  const id = slug(bot["id"]) || slug(bot["name"]) || "bot";
  return `${id}-`;
}

// MEASURED ON grok-bot-local-vm, 2026-09-09. The `name` argument to importAgentWorkflowText is NOT
// what the box files the document under: it reads the name out of the document's own YAML
// frontmatter, and with no frontmatter it falls back to the first heading. So a namespace that
// lives only in the argument is decoration, the reuse check can never match it, and a second import
// writes a second copy of every document. Every document this module imports names itself.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export function frontmatterName(body: unknown): string {
  const found = FRONTMATTER.exec(typeof body === "string" ? body : "");
  if (found == null) return "";
  const block = found[1] ?? "";
  const line = block.split(/\r?\n/).find((row) => /^name\s*:/.test(row));
  return line == null ? "" : line.replace(/^name\s*:/, "").trim().replace(/^["']|["']$/g, "").trim();
}

/** The name the box will file the document under, which is the only name worth checking against. */
export function skillNameFor(bot: Row, skill: Row): string {
  return frontmatterName(skill["body"]) || `${skillPrefixOf(bot)}${slug(skill["name"]) || "skill"}`;
}

// One line, quoted, so a description carrying a colon cannot break the frontmatter it sits in.
const yamlLine = (value: unknown): string => JSON.stringify(text(value).replace(/\s+/g, " "));

function withFrontmatterName(body: string, name: string, description: string): string {
  const found = FRONTMATTER.exec(body);
  if (found == null) {
    return `---\nname: ${name}\ndescription: ${yamlLine(description)}\n---\n\n${body.replace(/^\s+/, "")}`;
  }
  if (frontmatterName(body)) return body;
  return body.replace(FRONTMATTER, `---\nname: ${name}\n${found[1] ?? ""}\n---`);
}

/**
 * The SKILL.md that gets imported. A generated row carries a real body; a scraped row carries a
 * one-line description and nothing else, and an empty document is not a playbook. So a body is
 * written from the description AND SAYS SO, because a playbook the agent believes was authored
 * would be followed as though somebody had thought it through.
 */
export function skillBody(bot: Row, skill: Row): string {
  // The authored document goes in AS WRITTEN apart from the name the box files it under: a SKILL.md
  // is a file, and quietly reshaping one is the same class of thing as quietly shortening a memory.
  const body = typeof skill["body"] === "string" ? skill["body"] : "";
  const name = text(skill["name"]);
  const description = text(skill["description"]);
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
// describes it as "weekly" and never computes a next run, which is a dead job the day somebody
// switches it on. So a schedule that is not five fields is treated as no schedule.
const CRON_FIELDS = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

export function cronOf(routine: Row): string {
  const schedule = text(routine["schedule"]);
  return CRON_FIELDS.test(schedule) ? schedule : "";
}

export function whyNotCreated(routine: Row): string {
  const stated = text(routine["scheduleNote"]);
  if (stated) return stated;
  const schedule = text(routine["schedule"]);
  if (schedule) return `it asks to run "${schedule}", which is not a clock this box can hold`;
  return "it waits on something happening rather than on a clock, so there is nothing to schedule";
}

const routinePrompt = (routine: Row): string =>
  text(routine["prompt"]) || text(routine["summary"]) || text(routine["name"]);

// ------------------------------------------------------------------ apps
/**
 * The plugin id an app row names.
 *
 * THE FIELD NAMES ARE THE FIX. A catalog app row carries `plugin` (a plugin id or null) and `line`
 * (this bot's own sentence about it). The console read `pluginId` and `description`, which no
 * catalog row has ever carried, so every app fell through to the add-your-own bucket. The old
 * spellings stay as fallbacks: an older host serves rows without an `apps` field at all and this
 * module builds those rows itself from `integrations`, in the old vocabulary.
 */
const appPluginId = (row: Row): string => text(row["plugin"]) || text(row["pluginId"]);
const appLine = (row: Row): string => text(row["line"]) || text(row["description"]);

/** Every plugin id this row could possibly need, so installed state is asked once per plugin. */
function pluginIdsWanted(bot: Row): string[] {
  const ids = new Set<string>();
  for (const row of appRowsOf(bot)) {
    const id = appPluginId(row);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The app rows, or the pre-`apps` fallback where a plugin id is its own label. */
function appRowsOf(bot: Row): readonly Row[] {
  const declared = appsOf(bot);
  if (declared.length > 0) return declared;
  return listOf(bot["integrations"])
    .map(text)
    .filter(Boolean)
    .map((id) => ({ name: id, label: id, plugin: id, offer: "connect" }));
}

/**
 * What the box can already reach, what it could add, what has a page and nothing to install, and
 * what we carry nothing for.
 *
 *   connected      the plugin is installed on this box already
 *   addable        we have the plugin and it is not installed
 *   informational  we have no install path (a page-only row); an Add here would do nothing
 *   byo            nothing of ours matches: the add-your-own door
 */
export function planApps(bot: Row, installedPluginIds: Iterable<string>): MarketplaceImportApps {
  const installed = new Set(installedPluginIds);
  const connected: MarketplaceImportApp[] = [];
  const addable: MarketplaceImportApp[] = [];
  const informational: MarketplaceImportApp[] = [];
  const byo: MarketplaceImportApp[] = [];
  for (const row of appRowsOf(bot)) {
    const pluginId = appPluginId(row);
    const app: MarketplaceImportApp = {
      name: text(row["name"]) || text(row["label"]) || pluginId,
      label: text(row["label"]) || text(row["name"]) || pluginId,
      description: appLine(row),
      pluginId,
    };
    if (pluginId && installed.has(pluginId)) connected.push(app);
    else if (text(row["offer"]) === "page") informational.push(app);
    else if (pluginId && text(row["offer"]) !== "byo") addable.push(app);
    else byo.push(app);
  }
  return { connected, addable, informational, byo };
}

const labelsOf = (apps: readonly MarketplaceImportApp[]): string[] => apps.map((app) => app.label);

const readableIntegrations = (apps: MarketplaceImportApps): MarketplaceImportIntegrations => ({
  connected: labelsOf(apps.connected),
  offered: labelsOf(apps.addable),
  informational: labelsOf(apps.informational),
  unavailable: labelsOf(apps.byo),
});

/**
 * Which of the plugins this row names the box already carries. Derived here and never accepted from
 * a caller: the console silently stopped passing it the day the field was added, and the receipt
 * quietly said nothing was connected on every box.
 */
async function installedPluginIdsFor(box: MarketplaceImportBox, bot: Row): Promise<string[]> {
  const probe = box.isPluginInstalled ?? defaultPluginProbe;
  const installed: string[] = [];
  for (const id of pluginIdsWanted(bot)) {
    // A plugin the box cannot answer for is not installed; the whole import must not stop because
    // one binary probe threw.
    const yes = await probe(id).catch(() => false);
    if (yes) installed.push(id);
  }
  return installed;
}

async function defaultPluginProbe(pluginId: string): Promise<boolean> {
  const plugin = findMarketplacePlugin(pluginId);
  if (plugin == null) return false;
  return marketplacePluginIsInstalled({ rootDir: () => getSandRootDir() }, plugin);
}

// ------------------------------------------------------------------ the message
// One plain sentence. No tool names, no field names, nothing an operator has to translate.
const countOf = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function messageFor(name: string, report: {
  memories: { added: number; rejected: readonly unknown[] };
  skills: { imported: readonly string[]; reused: readonly string[] };
  routines: { created: readonly unknown[]; notCreated: readonly unknown[] };
  apps: MarketplaceImportApps;
}): string {
  const who = name || "the bot";
  const parts: string[] = [];
  if (report.memories.added > 0) {
    parts.push(countOf(report.memories.added, "fact it now remembers", "facts it now remembers"));
  }
  const playbooks = report.skills.imported.length + report.skills.reused.length;
  if (playbooks > 0) parts.push(countOf(playbooks, "playbook", "playbooks"));
  const jobs = report.routines.created.length;
  if (jobs > 0) {
    parts.push(jobs === 1
      ? "1 job that stays switched off until you turn it on"
      : `${jobs} jobs that stay switched off until you turn them on`);
  }
  const set = parts.length > 0 ? `${who} is on your roster with ${parts.join(", ")}.` : `${who} is on your roster.`;

  const missing: string[] = [];
  if (report.apps.addable.length > 0) {
    missing.push(`${labelsOf(report.apps.addable).join(", ")} still need connecting`);
  }
  if (report.apps.byo.length > 0) {
    missing.push(`${labelsOf(report.apps.byo).join(", ")} ${report.apps.byo.length === 1 ? "is" : "are"} not something we carry yet, so you would add your own`);
  }
  if (report.routines.notCreated.length > 0) {
    missing.push(`${countOf(report.routines.notCreated.length, "job", "jobs")} could not be set up because ${report.routines.notCreated.length === 1 ? "it waits" : "they wait"} on something rather than a clock`);
  }
  if (report.memories.rejected.length > 0) {
    missing.push(`${countOf(report.memories.rejected.length, "fact was", "facts were")} too long to store and ${report.memories.rejected.length === 1 ? "was" : "were"} left out rather than cut short`);
  }
  return missing.length > 0 ? `${set} ${missing.join("; ")}.` : set;
}

// ------------------------------------------------------------------ the plan
export interface MarketplaceImportPlan {
  readonly name: string;
  readonly description: string;
  readonly memories: { readonly paragraphs: number; readonly facts: number };
  readonly skills: readonly { readonly name: string; readonly as: string }[];
  readonly routines: {
    readonly create: readonly { readonly name: string; readonly schedule: string; readonly describes: string }[];
    readonly skip: readonly { readonly name: string; readonly why: string }[];
  };
  readonly apps: MarketplaceImportApps;
}

/** What an import WOULD do, with nothing written. The console shows the same plan before the press. */
export function planFor(bot: Row, installedPluginIds: Iterable<string> = []): MarketplaceImportPlan {
  const create: { name: string; schedule: string; describes: string }[] = [];
  const skip: { name: string; why: string }[] = [];
  for (const routine of routinesOf(bot)) {
    const schedule = cronOf(routine);
    if (schedule) {
      create.push({
        name: text(routine["name"]),
        schedule,
        describes: text(routine["scheduleNote"]) || text(routine["summary"]),
      });
    } else skip.push({ name: text(routine["name"]), why: whyNotCreated(routine) });
  }
  return {
    name: text(bot["name"]),
    description: personaFor(bot),
    memories: { paragraphs: memoriesOf(bot).length, facts: factsOf(bot).length },
    skills: skillsOf(bot).map((skill) => ({ name: text(skill["name"]), as: skillNameFor(bot, skill) })),
    routines: { create, skip },
    apps: planApps(bot, installedPluginIds),
  };
}

// ------------------------------------------------------------------ the roster and the library
const agentRecords = (answer: unknown): readonly Row[] => rowsOf(answer);

/**
 * Every document the box holds. The library is shared, so any agent answers with the same list —
 * but ONE agent failing to answer must not read as an empty library, because an empty library is
 * the answer that makes the import write every document again and leave doubles behind. So it walks
 * the roster until one answers.
 */
async function sharedLibrary(box: MarketplaceImportBox, agentId: string, roster: readonly Row[]): Promise<readonly Row[]> {
  const ids: string[] = [];
  for (const id of [text(agentId), ...roster.map((agent) => text(agent["id"]))]) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  for (const id of ids) {
    let rows: unknown;
    try { rows = await box.getAgentWorkflows(id); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    return rowsOf(rows).filter((row) => row["source"] !== "automation");
  }
  return [];
}

// ------------------------------------------------------------------ the import
const emptyApps = (): MarketplaceImportApps => ({ connected: [], addable: [], informational: [], byo: [] });

function refusal(name: string, message: string): MarketplaceImportReport {
  return {
    state: "refused",
    alreadyExisted: false,
    agent: null,
    agentId: null,
    name,
    memories: { added: 0, duplicates: 0, rejected: [] },
    skills: { imported: [], reused: [], skipped: [] },
    routines: { created: [], notCreated: [] },
    apps: emptyApps(),
    integrations: readableIntegrations(emptyApps()),
    introduction: { started: false },
    message,
  };
}

/**
 * Set one catalog bot up on this box, by catalog id.
 *
 * The row is resolved HERE, out of the bundled catalog — never taken from the caller. A model
 * handed a list card and asked to pass the row back would pass a card, which carries no
 * instructions, memories, skills, routines or apps, and the import would quietly create a
 * description-only agent holding nothing. That is the whole reason this takes an id.
 */
export async function importMarketplaceBot(
  box: MarketplaceImportBox,
  request: MarketplaceImportRequest,
): Promise<MarketplaceImportReport> {
  const id = text(request?.id);
  if (!id) throw new TypeError("importMarketplaceBot needs the catalog id of a bot");
  const found: MarketplaceBot | undefined = findMarketplaceBot(id);
  if (found == null) throw new Error(`no marketplace bot "${id}"`);
  return setUpMarketplaceBot(box, found as unknown as Row, request);
}

/**
 * The sequence itself, against a row already resolved. It is separate from the lookup above for
 * one reason: the catalog is deep-frozen, so a test cannot put a row in front of the lookup, and a
 * suite that could only drive real rows could not pin the cases that matter — a job whose schedule
 * is the word "weekly", a fact over the store's cap, a box that takes a document and does not list
 * it. Nothing in the product calls this directly; both doors go through the id.
 */
export async function setUpMarketplaceBot(
  box: MarketplaceImportBox,
  bot: Row,
  request: MarketplaceImportRequest = {},
): Promise<MarketplaceImportReport> {
  const id = text(bot["id"]);
  const wanted = text(request?.name) || text(bot["name"]);
  if (!wanted) throw new Error(`the catalog row "${id}" has no name`);

  // A pack is several agents with a coordinator and a reporting line, and that sequence lives in
  // the Bots tab's team import. Setting one up through this door would make ONE agent carrying the
  // pack's name and none of its members, which looks like it worked.
  if (listOf(bot["members"]).length > 0) {
    return refusal(wanted, `${wanted} is a team of several bots rather than one, so it is added from its own page in the Marketplace, where the whole team goes on at once.`);
  }

  const roster = agentRecords(await box.listAgents());
  const taken = new Set(roster.map((agent) => text(agent["name"])));
  const standing = roster.find((agent) => text(agent["name"]) === wanted) ?? null;
  if (standing != null && request?.duplicate !== true) {
    return {
      state: "already",
      alreadyExisted: true,
      agent: { id: text(standing["id"]), name: wanted },
      agentId: text(standing["id"]),
      name: wanted,
      memories: { added: 0, duplicates: 0, rejected: [] },
      skills: { imported: [], reused: [], skipped: [] },
      routines: { created: [], notCreated: [] },
      apps: emptyApps(),
      integrations: readableIntegrations(emptyApps()),
      introduction: { started: false },
      message: `${wanted} is already on your roster. Open it, or add another copy if you want a second one.`,
    };
  }

  let name = wanted;
  while (taken.has(name)) name = `${name} copy`;

  const description = personaFor(bot);
  const created: string[] = [];
  const madeSkills = new Set<string>();
  let agentId = "";
  const rejected: { text: string; why: string }[] = [];
  const skipped: { source: string; reason: string }[] = [];
  const notCreated: { name: string; why: string }[] = [];

  try {
    const answer = await box.createAgent({ name, description, isKickstartRequested: false }) as Row | null;
    const envelope = (answer?.["agent"] ?? null) as Row | null;
    agentId = text(envelope?.["id"] ?? answer?.["id"]);
    if (!agentId) {
      // An older host answers the mint with no envelope; the roster diff is the fallback the
      // console's adapter already uses for duplicateAgent.
      const known = new Set(roster.map((agent) => text(agent["id"])));
      const minted = agentRecords(await box.listAgents()).find((agent) => !known.has(text(agent["id"])));
      agentId = text(minted?.["id"]);
    }
    if (!agentId) throw new Error("the host took the request and reported no bot");
    created.push(agentId);

    // ---- memories
    const facts = factsOf(bot);
    if (facts.length > 0) {
      const seeded = await box.addAgentMemories(agentId, facts) as Row | null;
      for (const row of rowsOf(seeded?.["rejected"])) {
        rejected.push({ text: text(row["text"]), why: text(row["why"]) });
      }
    }

    // ---- skills, against ONE library read taken before the first write
    const held = new Set((await sharedLibrary(box, agentId, roster)).map((row) => text(row["name"])).filter(Boolean));
    for (const skill of skillsOf(bot)) {
      const as = skillNameFor(bot, skill);
      if (held.has(as)) continue;
      const answer = await box.importAgentWorkflowText(agentId, skillBody(bot, skill), as) as Row | null;
      // The host's OWN ledger of what it declined, with the host's own reason. A throw is a
      // different thing entirely and is not caught here: it rolls the whole import back.
      const result = (answer?.["result"] ?? null) as Row | null;
      for (const row of rowsOf(result?.["skipped"])) {
        skipped.push({
          source: text(row["source"]) || text(skill["name"]),
          reason: text(row["reason"]) || "no reason given",
        });
      }
      held.add(as);
      madeSkills.add(as);
    }

    // ---- routines, switched off
    for (const routine of routinesOf(bot)) {
      const schedule = cronOf(routine);
      const routineName = text(routine["name"]);
      if (!schedule) {
        notCreated.push({ name: routineName, why: whyNotCreated(routine) });
        continue;
      }
      await box.createAgentAutomation(agentId, {
        name: routineName,
        prompt: routinePrompt(routine),
        trigger: { type: "cron", schedule },
        isEnabled: false,
      });
    }
  } catch (error) {
    // Take back exactly what this run made. Documents first, while an agent to ask through is alive.
    const takenBack = { skills: 0, agents: 0 };
    if (madeSkills.size > 0) {
      const library = await sharedLibrary(box, agentId, roster).catch(() => [] as readonly Row[]);
      for (const row of library) {
        if (!madeSkills.has(text(row["name"]))) continue;
        try { await box.deleteAgentWorkflow(agentId, text(row["id"])); takenBack.skills += 1; } catch { /* nothing to take back */ }
      }
    }
    for (const one of created) {
      try { await box.deleteAgent(one); takenBack.agents += 1; } catch { /* nothing to take back */ }
    }
    const undone = takenBack.agents > 0 || takenBack.skills > 0
      ? ` Nothing was left behind: the bot and ${countOf(takenBack.skills, "playbook", "playbooks")} it had added were taken back.`
      : "";
    return {
      ...refusal(wanted, `Setting up ${wanted} stopped: ${String((error as { message?: unknown })?.message ?? error)}.${undone}`),
      state: "failed",
      rolledBack: undone.trim() || "Anything this run had already created was taken back, so the roster is as you found it.",
    };
  }

  // ---- what the box HOLDS, read back before anything is reported
  const [memoryRows, workflowRows, automationRows] = await Promise.all([
    box.getAgentMemories(agentId).catch(() => null),
    box.getAgentWorkflows(agentId).catch(() => null),
    box.getAgentAutomations(agentId).catch(() => null),
  ]);

  const heldFacts = new Set(rowsOf(memoryRows).map((row) => text(row["content"])).filter(Boolean));
  const seededFacts = factsOf(bot).map((fact) => fact.replace(/\s+/g, " ").trim());
  const added = seededFacts.filter((fact) => heldFacts.has(fact)).length;
  const duplicates = Math.max(0, seededFacts.length - added - rejected.length);

  const heldNames = new Set(rowsOf(workflowRows)
    .filter((row) => row["source"] !== "automation")
    .map((row) => text(row["name"]) || text(row["id"]))
    .filter(Boolean));
  const wantedSkills = skillsOf(bot).map((skill) => ({ source: text(skill["name"]), as: skillNameFor(bot, skill) }));
  const imported = wantedSkills.filter((row) => madeSkills.has(row.as) && heldNames.has(row.as)).map((row) => row.as);
  const reused = wantedSkills.filter((row) => !madeSkills.has(row.as) && heldNames.has(row.as)).map((row) => row.as);
  for (const row of wantedSkills) {
    if (heldNames.has(row.as) || skipped.some((one) => one.source === row.source)) continue;
    skipped.push({ source: row.source, reason: "the box took the document and is not listing it" });
  }

  const heldRoutines = rowsOf(automationRows);
  const createdRoutines: { name: string; schedule: string; describes: string; isEnabled: boolean }[] = [];
  for (const routine of routinesOf(bot)) {
    const schedule = cronOf(routine);
    if (!schedule) continue;
    const routineName = text(routine["name"]);
    if (notCreated.some((row) => row.name === routineName)) continue;
    // clampAutomationName collapses whitespace, trims, then cuts at 80. Matching on the asked-for
    // name would miss a long one and report a job that IS there as missing.
    const clamped = routineName.replace(/\s+/g, " ").trim().slice(0, 80);
    const stored = heldRoutines.find((row) => text(row["name"]) === clamped);
    if (stored == null) {
      notCreated.push({ name: routineName, why: "the box took the request and is not listing the job" });
      continue;
    }
    createdRoutines.push({
      name: routineName,
      schedule,
      describes: text(routine["scheduleNote"]) || text(routine["summary"]),
      isEnabled: stored["isEnabled"] === true,
    });
  }

  const apps = planApps(bot, await installedPluginIdsFor(box, bot));
  const report = {
    memories: { added, duplicates, rejected },
    skills: { imported, reused, skipped },
    routines: { created: createdRoutines, notCreated },
    apps,
  };

  // ---- the agent's own introduction, LAST, so it is written by an agent that already remembers
  const kickstart = await box.kickstartAgent(agentId).catch(() => null) as Row | null;

  return {
    state: "done",
    alreadyExisted: false,
    agent: { id: agentId, name },
    agentId,
    name,
    ...report,
    integrations: readableIntegrations(apps),
    introduction: { started: kickstart?.["isIntroductionInFlight"] === true },
    message: messageFor(name, report),
  };
}
