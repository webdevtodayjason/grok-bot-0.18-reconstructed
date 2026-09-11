/**
 * PERSONA-1. The standing facts an agent states about itself and this workspace.
 *
 * THE BUG THIS EXISTS FOR. Between 22:49 on 2026-09-08 and 06:11 on 2026-09-09 the operator's
 * lead agent told him, in one conversation, that he had no email capability (he does), that the
 * workspace held "up to 12 more agents" (the live setting said 100), that repository work goes to
 * a cloud agent on a dead upstream (that tool is withheld from the same turn's toolset), that the
 * product is called something it is not, and that there is no first-run interview (there is).
 * Every one of those came from a sentence written down once -- in the base prompt, in a profile
 * description, or in a durable memory -- against a fact that is live.
 *
 * So this section is composed at prompt time from what the box says about itself, and every fact
 * in it is a SYNCHRONOUS, BOX-LOCAL read. That is not a preference:
 *
 *   - `getSystemPrompt()` is synchronous (system-prompt-assembly.ts), so nothing here may await
 *     and nothing here may reach the network.
 *   - It is NOT in the base prompt, which is built once and frozen at import
 *     (`DEFAULT_SAND_SYSTEM_PROMPT`) and cached per option pair, so a live fact put there would
 *     be whatever the host process saw at boot for the rest of its life.
 *   - It is NOT in the profile section, which is snapshot-cached per compaction epoch
 *     (sand-agent-profile-prompt.ts), so a live fact put there would be whatever it was at the
 *     last compaction.
 *
 * It is therefore its own `add()` inside `getSystemPrompt`, rendered fresh on every turn.
 *
 * The closing line is load-bearing, not politeness. An agent's profile description and its
 * durable profile-tier memories are injected on every turn too, and on a box this wave does not
 * swap they still carry the old numbers. Saying in words that these facts outrank both is what
 * covers an agent whose stored memory says it has no email.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readAgentMail, type AgentMailFile } from "../extensions/mail/agent-mail-store.js";
import {
  MANAGED_SKILLS_DIRNAME,
  MANAGED_SKILL_FILES_DIRNAME,
} from "../extensions/managed-setup/managed-skills-cache.js";
import {
  boxOnboardingService,
} from "../extensions/onboarding/onboarding-box-store.js";
import type { SandOnboardingRecord } from "../extensions/onboarding/onboarding-state.js";
import { SAND_PRODUCT_NAME } from "../../shared/product-name.js";
import { getSandRootDir, toModelVisiblePath } from "../host-paths.js";
import { resolveSandMaxAgents } from "../sand-box-setting.js";

/** The one name the product answers to in anything a person or a model reads. */
export const SAND_PERSONA_PRODUCT_NAME = SAND_PRODUCT_NAME;

/** The exact words that re-run the first-run interview in chat. Said once, meant literally. */
export const SAND_ONBOARDING_RETRIGGER_PHRASE = "run first-time setup";

/** The id of the seed skill that IS the interview, so the agent can find and follow it. */
export const SAND_ONBOARDING_SKILL_LOOKUP = "onboarding";

/**
 * KB-1. The id of the handbook pack that is the INDEX of the other four, so the section names one
 * path instead of five.
 *
 * Why a path at all. A seeded managed skill costs zero standing prompt bytes and is also named
 * nowhere the model can see: `getSystemPrompt` adds no section listing managed skills, the
 * `agent_skills` catalog section only renders when `resolveAgentSkills` supplies something and
 * nothing in this tree supplies it, and no tool runs a skill. So the two ways a seed reaches a turn
 * are a path written into THIS section and a `workflowReference` node in a dispatched prompt.
 * Seeding guarantees the packs exist; this sentence is what makes them reach an answer.
 */
export const SAND_HANDBOOK_SKILL_LOOKUP = "handbook-what-i-can-do";

export const SAND_LEAD_AGENT_FILENAME = "lead-agent.json";

export interface StandingPersonaAgent {
  readonly id: string;
  readonly name?: string;
}

export interface StandingPersonaInput {
  /** The agent this prompt is for. Null on a runner with no agent identity: no section at all. */
  readonly agentId: string | null | undefined;
  /**
   * The other agents in this workspace, as the assembly already holds them (the agent directory,
   * which excludes this agent and every group). The count in the prompt is this plus one.
   */
  readonly agents: readonly StandingPersonaAgent[];
  readonly sandRoot?: string;
}

// --------------------------------------------------------------------- the lead marker

/**
 * Which agent is the workspace's lead. Written once -- at mint for a genuinely first agent, and
 * at host start for a box that predates this file -- and only READ from the prompt path, because
 * the prompt path is synchronous and must not walk a directory or write to disk.
 */
export function getLeadAgentPath(sandRoot: string = getSandRootDir()): string {
  return join(sandRoot, SAND_LEAD_AGENT_FILENAME);
}

let cachedLead: { path: string; mtime: string; size: number; value: string | null } | undefined;

export function readLeadAgentId(sandRoot: string = getSandRootDir()): string | null {
  const path = getLeadAgentPath(sandRoot);
  let stamp: { mtime: string; size: number };
  try {
    const stats = statSync(path, { bigint: true });
    stamp = { mtime: stats.mtimeNs.toString(), size: Number(stats.size) };
  } catch {
    cachedLead = undefined;
    return null;
  }
  if (
    cachedLead != null
    && cachedLead.path === path
    && cachedLead.mtime === stamp.mtime
    && cachedLead.size === stamp.size
  ) return cachedLead.value;
  let value: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      const agentId = (parsed as Record<string, unknown>).agentId;
      if (typeof agentId === "string" && agentId.trim().length > 0) value = agentId.trim();
    }
  } catch { /* unreadable means "no lead recorded", never a thrown turn */ }
  cachedLead = { path, ...stamp, value };
  return value;
}

/** Writes the marker unless one is already there. Returns the id in force afterwards. */
export function writeLeadAgentId(
  agentId: string,
  sandRoot: string = getSandRootDir(),
): string | null {
  const trimmed = agentId.trim();
  if (trimmed.length === 0) return readLeadAgentId(sandRoot);
  const existing = readLeadAgentId(sandRoot);
  if (existing != null) return existing;
  const path = getLeadAgentPath(sandRoot);
  try {
    mkdirSync(sandRoot, { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ agentId: trimmed }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch { return existing; }
  cachedLead = undefined;
  return trimmed;
}

/**
 * The one-time repair for a box that already had agents before this file existed: the oldest
 * agent directory under <sandRoot>/agents is the workspace's first agent. Runs at host start,
 * where a directory walk costs nothing, and never from the prompt path.
 */
export function ensureLeadAgentMarker(sandRoot: string = getSandRootDir()): string | null {
  const existing = readLeadAgentId(sandRoot);
  if (existing != null) return existing;
  const agentsRoot = join(sandRoot, "agents");
  if (!existsSync(agentsRoot)) return null;
  let oldest: { id: string; born: number } | null = null;
  try {
    for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let born: number;
      try { born = statSync(join(agentsRoot, entry.name)).birthtimeMs; } catch { continue; }
      if (!Number.isFinite(born) || born <= 0) continue;
      if (oldest == null || born < oldest.born) oldest = { id: entry.name, born };
    }
  } catch { return null; }
  return oldest == null ? null : writeLeadAgentId(oldest.id, sandRoot);
}

// --------------------------------------------------------------- the onboarding record

/**
 * `currentRecord()` and never `getState()`: getState is async AND writes the migration record,
 * so calling it from a prompt render would both fail to compile here and decide a box's first
 * run as a side effect of drawing a sentence. Cached against the settings file the same way the
 * toolset caches `isOnboardingActive`, because the parse would otherwise run on every render.
 *
 * `boxOnboardingService()` resolves the sand root through `getSandRootDir()` rather than taking
 * one, so the stat below and the read it guards agree only while `sandRoot` is that same root.
 * In production it always is, and the unit gate repoints SAND_DATA_ROOT around each render for
 * exactly this reason. The cache key is the path that was statted, so two roots never read each
 * other's answer even when they disagree.
 */
let cachedOnboarding:
  | { path: string; mtime: string; size: number; value: SandOnboardingRecord | null }
  | undefined;

function readOnboardingRecord(sandRoot: string): SandOnboardingRecord | null {
  const path = join(sandRoot, "settings.json");
  let stamp: { mtime: string; size: number };
  try {
    const stats = statSync(path, { bigint: true });
    stamp = { mtime: stats.mtimeNs.toString(), size: Number(stats.size) };
  } catch {
    cachedOnboarding = undefined;
    return null;
  }
  if (
    cachedOnboarding != null
    && cachedOnboarding.path === path
    && cachedOnboarding.mtime === stamp.mtime
    && cachedOnboarding.size === stamp.size
  ) return cachedOnboarding.value;
  let value: SandOnboardingRecord | null = null;
  try { value = boxOnboardingService().currentRecord(); }
  catch { /* an unreadable settings file means "nothing recorded", never a thrown turn */ }
  cachedOnboarding = { path, ...stamp, value };
  return value;
}

/**
 * C3. The phrase has to DO something, or it is the same class of bug as the facts being wrong.
 * There is no shipped command that reopens the interview in chat: `resetOnboarding` is 403
 * without SAND_TEST_HOOKS and `startOnboarding` refuses an agent that has already been talked
 * to, and both are console commands anyway -- the person types the phrase at me. So the standing
 * instruction IS the wiring: the interview's recipe is a skill in this box's own library, and
 * this tells me to go read it and run it. The two tools that skill names are offered only while
 * the box's record says setup is open, so the skill itself now says what to do without them.
 */
function onboardingSentences(record: SandOnboardingRecord | null, sandRoot: string): string[] {
  const retrigger = `Say "${SAND_ONBOARDING_RETRIGGER_PHRASE}" and I will run that interview again`
    + " here in the chat; it does not reopen the setup window in the console.";
  // Measured twice on grok-bot-local-vm, at 12:53 and 13:04 UTC on 2026-09-09. Told to open the
  // interview skill -- first by name, then by its exact path -- the agent answered "On it —
  // starting the setup interview now." and the turn ended there, both times. An acknowledgement
  // followed by silence is the worst of the three possible outcomes, worse than a refusal,
  // because the person sits waiting for a question that never comes.
  //
  // The cause is the shape of the instruction, not the path: the prompt's first rule is to open
  // every turn with a plain acknowledgement, so "acknowledge, then go and read a file, then ask"
  // gives the model a turn it can satisfy by acknowledging alone. So the first question is now IN
  // this sentence and goes in the SAME message. Nothing has to be fetched before the interview
  // can start, and the file is where the REST of it comes from.
  const skillPath = toModelVisiblePath(join(
    sandRoot, MANAGED_SKILLS_DIRNAME, MANAGED_SKILL_FILES_DIRNAME,
    SAND_ONBOARDING_SKILL_LOOKUP, "SKILL.md",
  ));
  const how = `When somebody says "${SAND_ONBOARDING_RETRIGGER_PHRASE}", my very next message asks`
    + " them the first question, in the same message as any acknowledgement and never in a message"
    + ' of its own: "What should I call you?" I do not stop at "on it" and I do not end the turn'
    + " without that question, because a person who is told setup is starting and then hears"
    + ` nothing has been left waiting. The rest of the interview is at ${skillPath}: I read it`
    + " while they answer and follow it from its second question on, one question at a time.";
  const state = record == null || record.done !== true
    ? "First-time setup has not finished in this workspace."
    : record.doneReason === "existing-box"
      ? "The first-run interview never ran here, because this workspace was set up before it"
        + " existed."
      : record.doneReason === "skipped"
        ? "The first-run interview was skipped here rather than finished."
        : "The first-run interview ran here and finished.";
  return [`${state} ${retrigger}`, how];
}

/**
 * KB-1. The two sentences that make the handbook reachable, and the only standing spend this wave
 * takes. Both are in the GENERAL block, never behind the lead marker, because every agent here
 * answers an owner's question sooner or later.
 *
 * One path, not five ids: the first pack is the index and names the other four, so the section pays
 * for one file name rather than five. Nothing of the handbook's own content is pasted here -- a
 * glossary or a guardrail list in this section would be paid for on every turn of every agent
 * forever, while a file costs nothing until a question needs it.
 *
 * The second sentence is DELIBERATELY REDUNDANT with the guardrail pack. A turn where no file was
 * read still has to be safe, and this is the sentence that makes the refusal true with nothing
 * fetched. The combined budget is pinned by tests/handbook-seeds.test.mjs.
 */
function handbookSentences(sandRoot: string): string[] {
  const handbook = toModelVisiblePath(join(
    sandRoot, MANAGED_SKILLS_DIRNAME, MANAGED_SKILL_FILES_DIRNAME,
    SAND_HANDBOOK_SKILL_LOOKUP, "SKILL.md",
  ));
  return [
    "What this product can really do, the words used here, and what I must never ask for are"
      + ` written down for me at ${handbook}. It names the other handbook files; I read whichever`
      + " fits before answering what I can do, how to connect something, or what a word means, and"
      + " I would rather say a thing is not here yet than describe what we do not have.",
    "I never ask anybody to type a password, a card number or any credential to me in chat: those"
      + " go in the masked box on that app's own page in the Marketplace, or a secure card I raise."
      + " If one is pasted anyway I do not repeat it, I say where it goes and to change it at the"
      + " app if it was real.",
  ];
}

// ------------------------------------------------------------------------ the section

function mailSentences(agentId: string, mail: AgentMailFile | null): string[] {
  const own = mail?.addresses[agentId] ?? null;
  const lines: string[] = [];
  lines.push(own == null
    ? "I do not have an email address of my own yet. When one is minted for me it appears here,"
      + " and until then I say I have none rather than guessing at one."
    : `My own email address is ${own.address}. Mail sent there arrives in this conversation as a`
      + " message I can act on, and that address is the only one I claim as mine.");
  lines.push("Email is built into this product, not a connector somebody has to install, so it is"
    + " never something I say I cannot do.");
  if (own != null) {
    lines.push(mail?.canSend === true
      ? "I can send from that address as well as receive at it."
      : "Sending from that address is not wired up yet on this workspace, so today I can receive"
        + " mail but not send it, and I say so plainly rather than pretending a send worked.");
  }
  return lines;
}

/**
 * The facts block every agent gets, plus the lead paragraph for the workspace's lead only.
 * Returns null when there is no agent identity to speak for.
 */
export function renderStandingPersonaSection(input: StandingPersonaInput): string | null {
  const agentId = typeof input.agentId === "string" && input.agentId.trim().length > 0
    ? input.agentId.trim()
    : null;
  if (agentId == null) return null;
  const sandRoot = input.sandRoot ?? getSandRootDir();

  const ceiling = resolveSandMaxAgents();
  // The directory the assembly holds excludes this agent and every group, so the workspace's
  // count is that list plus me. Never a literal: the ceiling moved from 13 to 100 on these boxes
  // and every hardcoded sentence in the product went stale the same day.
  const existing = input.agents.length + 1;
  const mail = readAgentMail(sandRoot);
  const record = readOnboardingRecord(sandRoot);
  const isLead = readLeadAgentId(sandRoot) === agentId;

  const lines: string[] = [
    "## What is true of me and this workspace",
    "These facts are read off this box as this message is being written, so they are current"
      + " whatever anything older says.",
    "",
    `This product is called ${SAND_PERSONA_PRODUCT_NAME}. That is the name I use for it.`,
    `This workspace holds up to ${ceiling} bots including me, and ${existing} `
      + `${existing === 1 ? "exists" : "exist"} today.`,
    ...mailSentences(agentId, mail),
    "Work in a repository happens here, on this box, in the workspace, with my own shell and my"
      + " own editor: I clone it here, read it here, change it here and push from here. Where an"
      + " E2B sandbox is configured for this workspace I can run the work there instead. There is"
      + " no other machine I hand coding to.",
    ...onboardingSentences(record, sandRoot),
    "",
    ...handbookSentences(sandRoot),
    "",
    // TITAN-CATALOG-1. Jason, 2026-09-09 17:40, and Titan's own report two minutes before it: a bot
    // asked for a new bot built one from nothing every time. MEASURED on grok-bot-local-vm, bundle
    // df1300366eb2: asked "create me an Instagram marketer" a fresh agent made one call, created an
    // agent with a persona it invented, no facts, no jobs and no template, and never mentioned that
    // ready-made ones exist. This paragraph is in the general block and not behind `isLead` because
    // the tools behind it are offered to every top-level agent, on the same predicate CreateAgent
    // has always used. The sentence and the tools travel together on purpose: this whole section is
    // withheld from a subagent runner and a box-scoped one (system-prompt-assembly.ts), which is
    // the same test buildTurnTools withholds the tools on, so no agent ever reads this about itself
    // while holding none of it -- which is the PERSONA-1 failure this file exists to stop.
    // No tool is named here; naming one is what puts a tool name on a screen.
    "When somebody asks me for a new bot, I look first at what the Marketplace already carries."
      + " The ready-made ones arrive already knowing the facts of the job, holding their playbooks,"
      + " carrying their scheduled jobs switched off and saying which apps they use, which is"
      + " everything a bot I build from nothing does not have. I name the two or three closest ones"
      + " with a line each and, in that same message, ask whether they want one of those or one"
      + " built from scratch. The names and the question always travel together, because a list with"
      + " no question at the end of it leaves the person waiting on me. If they pick one I set it up"
      + " and then tell them plainly what it came with and what still needs connecting; if they want"
      + " it from scratch I build it the way I always have.",
    "",
    // CONSOLE-5. A habit, not a fact, which is why it sits beside the marketplace paragraph rather
    // than up in the facts block. The console paints a backticked span as a chip a person can click
    // to copy, so this sentence is what fills those chips -- but nothing here names the console, the
    // chip or a colour: the model needs the habit, and naming the surface is how a tool name ends up
    // on somebody's screen.
    "Identifiers, addresses, channels, hostnames, file names and any draft I am quoting back go in"
      + " backticks, so they stand out from what I am saying and copy clean; ordinary prose stays"
      + " plain.",
    "",
    "If my profile description, my stored memory, or anything I have said before contradicts the"
      + " facts above, the facts above are the live ones and those are out of date.",
  ];

  if (isLead) {
    lines.push(
      "",
      "I am the lead of the crew in this workspace: the owner's main assistant, the one they talk"
        + " to, and the one who runs and watches the other bots here. Work that belongs to another"
        + " bot I hand to it and bring the answer back, so the owner only has to talk to me.",
    );
  }

  return lines.join("\n");
}
