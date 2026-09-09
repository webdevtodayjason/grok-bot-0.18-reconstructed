/**
 * The Marketplace catalog: the plugins this box can install and the bot templates it can import.
 *
 * ONE catalog, in the repo, bundled into the host. The console never reads a static JSON: it asks
 * the gateway (`listMarketplace`, `getMarketplaceItem`), which serves exactly this module. That is
 * what makes the agent's SearchPlugins and the operator's Marketplace panel the same catalog
 * rather than two lists that drift.
 *
 * A PLUGIN is one installable thing, and it declares WHAT it is rather than how this box happens to
 * run it. `install.connector` is a `ConnectorSpec` (source/shared/marketplace/connector-spec.ts):
 * a program the box runs, or an endpoint it talks to. `connectorEntryFromSpec` is the only place
 * that turns one into a connectors.json entry, so the day a remote endpoint stops being bridged by
 * mcp-remote, one function changes and not one row. `install.shellTool` is a CLI the agent runs
 * from its own shell, named by its id in shell-tool-catalog.ts. A row may declare both: TinyFish is
 * one product with a connector AND a CLI, and MARKET-5 is the rule that it therefore has ONE place
 * to put a key rather than two forms that each warn the other's value does not reach it.
 *
 * A CREDENTIAL is declared once and names its CONSUMERS. One masked box on the page, one write,
 * and the host fans the value out to every consumer that asked for it -- the connector's process
 * environment, a request header, the agent's shell. That is why `credentials` replaced the old
 * `credentialHints` map: a hint keyed by env name could only ever describe one destination, so a
 * product with two destinations had to be two cards, which is the complaint MARKET-5 is.
 *
 * VERIFICATION is a stamp, not a promise. Every row carries `verification {checkedOn, proof, how}`,
 * `validateMarketplaceCatalog` REFUSES `proof: "documented"`, and tests/marketplace-catalog.test.mjs
 * is the enforcement -- so "do not ship an unverified preset as if it worked" stops being
 * discipline and becomes a failing test. `tools-listed` means the spec was spawned or called on a
 * box and tools/list came back. `endpoint-answered` means it answered and named its refusal (a 401
 * against a key we do not own) -- a real fact, weaker than the first, and the plugin page draws a
 * quiet line saying so.
 *
 * NOTHING in this file is a credential. Every credential env value is the empty string (which is
 * exactly how the host recognises a credential field, CONNECT-4), every header value is a
 * `${FIELD}` placeholder, and `validateMarketplaceCatalog` refuses a literal in either position.
 */

import {
  type ConnectorEntry,
  type ConnectorSpec,
  type RemoteConnectorMode,
  DEFAULT_REMOTE_CONNECTOR_MODE,
  connectorEntryFromSpec,
  connectorSpecCredentialFields,
  connectorSpecProblems,
  headerPlaceholderField,
  isRemoteSpec,
} from "./connector-spec.js";

export type {
  ConnectorEntry,
  ConnectorSpec,
  RemoteConnectorMode,
} from "./connector-spec.js";

// The Marketing team pack is its own module: seven personas and ten SKILL.md bodies are more text
// than the six rows below put together, and a member list is a shape they do not have. It spreads
// into BOTS as ordinary bot rows (MarketingTeamBot extends MarketplaceBot), so the validator, the
// wire view and every existing reader are unchanged.
import { MARKETING_TEAM_BOTS } from "./marketing-team.js";

// BOTS-1. The 65 community rows, GENERATED from the scrape checked in under bots/ by
// scripts/build-bot-catalog.mjs. It is its own module for the same reason the Marketing pack is:
// 444 paragraphs of operating rules and 263 skill bodies are more text than everything else in this
// file put together, and a generated file nobody hand-edits should not sit inside one people do.
// The rows are ordinary MarketplaceBot rows, so the validator, the wire view and every reader below
// are unchanged; `origin: "community"` is the only thing that distinguishes them, and the two rules
// it relaxes are named at the point they are relaxed.
import { COMMUNITY_BOTS } from "./community-bots.js";

/** Kept as the wire's word for what a row is, derived from `install` rather than declared. */
export type MarketplacePluginKind = "connector" | "shell-tool";

/**
 * A letter on a colour, and optionally a logo file that sits on top of it.
 *
 * `file` is a path RELATIVE TO `/machine-room/` -- the console's own document root, which the relay
 * serves out of `ui/machine-room/`. It is never a URL: the console fetches nothing from the
 * internet, so every image it draws is a file in this repo under `ui/machine-room/marketplace/logos/`,
 * named in that directory's NOTICE.md with its source and licence. `letter` and `color` stay
 * REQUIRED and are the fallback: a plugin with no logo, or one whose image fails to load, is drawn
 * as the letter tile it has always been. A vendor mark ships only when that vendor's own brand
 * terms have been read and the permission quoted in NOTICE.md; the letter tile is the default.
 */
export interface MarketplaceIcon {
  readonly letter: string;
  readonly color: string;
  readonly file?: string;
}

/** A bot template's face: the drawn tile, and optionally the same kind of local logo file. */
export interface MarketplaceBotTile {
  readonly color: string;
  readonly shape: string;
  readonly file?: string;
}

/** The connectors.json entry, exactly as it lands on the box. */
export interface MarketplaceConnectorEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Where one stored value is USED. A credential is written once, under `field`, and the host pushes
 * it to each of these:
 *   connector  the connector process's environment, under `env`
 *   header     a request header on a remote endpoint, under `name`
 *   shell      the agent's own shell environment, under `env`
 *
 * GitHub is why the shape is a list rather than a name: one fine-grained token is
 * GITHUB_PERSONAL_ACCESS_TOKEN to the connector and GITHUB_TOKEN to `gh` in the shell, and the old
 * one-hint-per-env-name map could only ever have drawn that as two boxes to fill with the same
 * string.
 */
export type MarketplaceCredentialConsumer =
  | { readonly kind: "connector"; readonly env: string }
  | { readonly kind: "header"; readonly name: string }
  | { readonly kind: "shell"; readonly env: string }
  // CLOUD-BROWSER-1's fourth destination. The cloud leg behind the four browser_* tools reads its
  // vendor key in the HOST PROCESS ALONE, out of the `cloudBrowser` section of
  // connector-env-secrets.json, and merges it into no child environment ever -- which is exactly
  // why it is not a `shell` consumer: shell-secrets values are merged into the environment of the
  // box exec-daemon, the process that spawns every /bin/sh the agent's shell tool runs, and an
  // agent's shell can read its own environment. One masked box on the plugin page still fans out
  // the way GitHub's one token already fans out to a connector and to `gh`.
  | { readonly kind: "cloud-browser"; readonly engine: string };

export interface MarketplaceCredential {
  /** The name the value is stored under. */
  readonly field: string;
  /** What the operator is being asked for, in their words. */
  readonly label: string;
  /** Where it is minted, and the least permission that works. Never empty. */
  readonly hint: string;
  /** Every place one write has to reach. Never empty. */
  readonly consumers: readonly MarketplaceCredentialConsumer[];
}

/** What installing this row does. At least one of the two, and a row may carry both. */
export interface MarketplaceInstall {
  readonly connector?: ConnectorSpec;
  readonly shellTool?: string;
}

/**
 * How we know this row works, and when we last knew it.
 *
 * `documented` exists in the type ONLY so the validator can name it in a refusal: a row that has
 * been read about but not run does not reach a card. There is no fourth "trust me".
 */
export interface MarketplaceVerification {
  /** ISO date, the day the check below was run. */
  readonly checkedOn: string;
  readonly proof:
    | "tools-listed"
    | "endpoint-answered"
    | "vendor-installer"
    | "documented";
  /** One sentence: what was done, on which machine, and what came back. */
  readonly how: string;
}

/**
 * MARKET-26. ONE NAMED FACT this row depends on, and where the vendor publishes it today.
 *
 * This block is NOT `verification` and must never be allowed to become it. `verification` is "we
 * ran this on a box on this date"; a doc fact is "the vendor still documents what this row
 * assumes". Meta, X and LinkedIn move app-review tiers, scope names, endpoint versions and rate
 * tiers between our releases, so a row that passed in September sends a person down a dead sign-up
 * path in November -- and re-reading a doc page produces only doc-grade evidence, which is exactly
 * the `proof: "documented"` the validator has always refused. So the two dated facts live in two
 * separate blocks and `validateMarketplaceCatalog` refuses a row that lets one raise the other.
 *
 * `expected` is a LITERAL the vendor's page has to keep saying, and the differ compares that named
 * fact -- never page text. Every vendor page carries boilerplate that changes without the facts
 * changing: every LinkedIn Marketing page still renders a deprecation banner for a sunset date
 * three weeks in the past, every canva.dev page prepends an identical left nav, and Meta's pages
 * carry an "Updated:" date that moves on its own. cp/verification.mjs strips those before it looks.
 *
 * `anchor` is where to look: a machine-readable path (`$.info.version` against a JSON surface) or a
 * literal heading, so the differ reads the section the fact is in rather than the whole page.
 *
 * `state`:
 *   verified       the fact was found on `checkedOn`
 *   not-published  the vendor states it does not publish this, so there is nothing to re-read and
 *                  the weekly run must not flip the row every week over its absence. LinkedIn's
 *                  rate limits are the case this exists for.
 *   changed        the last run could not find it. The console says the row is under review.
 */
export interface MarketplaceDocFact {
  /** Stable within the row. The differ names it, so renaming one loses its history. */
  readonly id: string;
  /** What this fact IS, in the words an operator reads on the admin screen. */
  readonly what: string;
  /** The vendor's own page. https, always: a doc fact read over plain http is not evidence. */
  readonly url: string;
  /** Where in it: `$.a.b` against JSON, or a literal heading on an HTML page. */
  readonly anchor: string;
  /** The literal the page has to keep saying. Empty only where `state` is not-published. */
  readonly expected: string;
  /** ISO date this fact was last read on the vendor's page. */
  readonly checkedOn: string;
  readonly state: "verified" | "not-published" | "changed";
  /**
   * The origin's own validator from the last read, replayed as If-None-Match so a weekly run
   * extracts only what changed. Absent where the origin publishes none, which is most of them:
   * measured 2026-09-09, none of Meta's, X's, Buffer's or Browserbase's doc pages returned one.
   */
  readonly etag?: string;
  /**
   * Where the vendor's URL lands after its own redirects, when that is not `url`. Recorded rather
   * than treated as a change: developers.facebook.com/docs/... moves to /documentation/... and
   * LinkedIn appends ?view=li-lms-YYYY-MM, both today, and a row that called those a change would
   * cry wolf on every run. A landing that matches NEITHER is a change.
   */
  readonly finalUrl?: string;
}

export interface MarketplacePlugin {
  readonly id: string;
  readonly name: string;
  /** One line. The card's subtitle. */
  readonly tagline: string;
  readonly description: string;
  readonly category: string;
  readonly featured: boolean;
  readonly icon: MarketplaceIcon;
  readonly source: { readonly label: string; readonly url: string };
  /**
   * What this row installs. Absent only on the "Add your own" card, which installs nothing: it
   * opens the editor, which is what `opensEditor` says.
   */
  readonly install?: MarketplaceInstall;
  /** The connector name this entry takes in connectors.json. Absent for a shell-tool-only row. */
  readonly connectorName?: string;
  /** Every credential this plugin needs, each declaring where one write has to land. */
  readonly credentials: readonly MarketplaceCredential[];
  /**
   * What an owner types when they want this and do not know its name -- "crm", "invoice",
   * "database". Read by the console's search and by the agent's plugin ranking, so the words
   * people search for do not have to be forced into a tagline.
   */
  readonly keywords: readonly string[];
  /** True only for the "Add your own" card, which opens the connector editor. */
  readonly opensEditor?: boolean;
  /** How we know it works. Required on every row; `documented` is refused. */
  readonly verification: MarketplaceVerification;
  /**
   * MARKET-26. The vendor facts this row depends on, each with its source and the day it was read.
   * Re-read on a cadence by cp/verification.mjs; a fact that has moved turns the row's card to
   * "Under review" and never touches `verification`.
   */
  readonly docs?: readonly MarketplaceDocFact[];
  /**
   * What a person has to do BEFORE the credential box on this page is any use at all: create a
   * developer app, add a business account, get a Page approved. Plain sentences, in order. A
   * marketing row without this is a masked box that cannot be filled in, which is the same failure
   * CONNECT-4 was about one level up.
   */
  readonly firstSteps?: readonly string[];
  /**
   * One sentence where the vendor's own documentation says two different things, quoted so the
   * person is not left to discover it against a rate limiter. Not a bug in this row: a fact about
   * the vendor, and one the recurring check must not try to resolve.
   */
  readonly knownContradiction?: string;
  /**
   * How long a doc read stays fresh. The plugin page draws "Checked <date>" until the row's own
   * dates are older than this and "Under review" after, because nothing pushes control-plane state
   * into a running box: between releases the customer-facing half runs on AGE.
   */
  readonly recheckDays?: number;
  /**
   * DERIVED, and present only on the rows `MARKETPLACE_PLUGINS` hands out -- never written by hand.
   * The vocabulary the catalog spoke before MARKET-6, kept answering so that a reader of this
   * module did not have to change in the same commit the row shape did. Prefer
   * `marketplacePluginKind` and `marketplaceCredentialHints`, which are the same answers.
   */
  readonly kind?: MarketplacePluginKind;
  readonly credentialHints?: Readonly<Record<string, string>>;
  /** DERIVED, like the two above: the shell tool this row turns on, or null when it turns on none. */
  readonly shellToolId?: string | null;
  /**
   * DERIVED. This row puts NOTHING on the box and is not the editor. What it carries is what a
   * person has to know and, on some of them, a credential another part of the product reads.
   *
   * Meta, X and LinkedIn are here because no official MCP server publishes an organic post
   * anywhere (read 2026-09-09: Meta's Social Technologies MCP manages apps and webhooks, Meta's
   * Ads MCP manages ads, X's hosted MCP reads posts and writes only bookmarks and Articles), so
   * the posting path is the customer's own developer app or the browser -- and inventing a
   * connector entry to hang a credential on would ship a connector that can only ever fail, which
   * is the live CONNECT-13 defect. Those three therefore carry NO masked box at all: a box for a
   * token nothing reads is the same lie one level up. Browserbase is here because it is
   * CLOUD-BROWSER-1's second engine, its own MCP repo is archived, and its key belongs in the host
   * process alone.
   *
   * The console draws no Add button for one of these -- there is nothing to add -- and
   * `validateMarketplaceCatalog` requires it to carry first steps and at least one doc fact, so a
   * row that installs nothing is a page that tells a person what to do rather than a dead card.
   * Derived rather than declared, so a row cannot claim it and install something too.
   */
  readonly installsNothing?: boolean;
  /**
   * PROXY-1 / PROXY-7. The name this service is mounted under on the proxy's MCP gateway. Present
   * only on a plugin whose upstream the operator holds a subscription to, and read only when a
   * proxy is configured: the row then comes back "Included with your plan" with no credential
   * fields, because the box is given a key of its own and the operator has none to type.
   */
  readonly proxyMcpServer?: string;
}

export interface MarketplaceBotSkill {
  readonly name: string;
  readonly description: string;
  /** A SKILL.md, imported for the agent through importAgentWorkflowText. */
  readonly body: string;
}

/**
 * BOTS-1. One paragraph of operating rules the bot already knows, as the page shows it and as the
 * import seeds it.
 *
 * TWO FORMS, AND THE SPLIT HAPPENS AT BUILD TIME. `text` is the paragraph -- what a person reads on
 * the bot page, prose, one after another, no bullets. `facts` is the same paragraph cut at sentence
 * boundaries into pieces that each fit the host's cap on one remembered fact
 * (MEMORY_MAX_CONTENT_LENGTH, 500), because `normalizeMemoryContent` collapses whitespace and then
 * SLICES: a 5,000-character persona seeded whole would land in the store cut off mid sentence and
 * nothing would say so. We do not raise that cap to make a catalog fit -- it is read on every write
 * path in the product, the agent's own remember tool included -- so the catalog does the splitting
 * and the new host verb refuses anything still over it rather than writing a cut version.
 */
export interface MarketplaceBotMemory {
  /** The paragraph, as the page shows it. */
  readonly text: string;
  /** The same paragraph as facts that each fit the host's cap. Rejoining them recovers `text`. */
  readonly facts: readonly string[];
}

/**
 * BOTS-1. A job that runs on its own, and the cron it will actually run under.
 *
 * `schedule` is a five-field cron or null, resolved when the catalog is BUILT rather than left as
 * the prose. `automation-store.upsert` writes nothing when a trigger will not normalise and the
 * gateway still answers 200, and `normalizeSchedule` accepts the bare word "weekly", stores it,
 * describes it as "weekly" and never computes a next run -- a routine that is dead the day somebody
 * switches it on. So a routine either carries a cron that `computeNextRunAt` resolves, or it is not
 * created at all and `scheduleNote` says why in plain words. Every routine is created switched off.
 */
export interface MarketplaceBotRoutine {
  readonly name: string;
  readonly summary: string;
  /** A five-field cron, or null when nothing this box can schedule was stated. */
  readonly schedule: string | null;
  /** The cadence in plain words, including when the hour is a declared default rather than stated. */
  readonly scheduleNote: string;
}

/**
 * BOTS-1. An app this bot uses, as the bot page shows it.
 *
 * `integrations` stays exactly what it has always been -- plugin ids, validated against
 * MARKETPLACE_PLUGINS -- and this is the row beside it that carries what the screenshots show: the
 * app's name as the source wrote it, the label a person reads, this bot's own sentence about what
 * it does with it, and what the page may offer.
 *
 *   connect  we have the plugin and it installs something: the Add card
 *   page     we have the plugin and it installs NOTHING (X, and commit 1694a3f's rule): an
 *            information line, and never an Add button, because there is nothing to add
 *   byo      we have no plugin for it: named as written, "not available yet", and the
 *            add-your-own door through custom-mcp
 */
export interface MarketplaceBotApp {
  /** The app's name exactly as the source wrote it ("notion-workspace", "Google Sheets"). */
  readonly name: string;
  /** The name a person reads ("Notion", "Google Sheets"). */
  readonly label: string;
  /** What THIS bot does with it, in its own words. Empty when the source only had a vendor tagline. */
  readonly line: string;
  /** A plugin id from MARKETPLACE_PLUGINS, or null when we have no row for it. */
  readonly plugin: string | null;
  readonly offer: "connect" | "page" | "byo";
}

export interface MarketplaceBot {
  readonly id: string;
  readonly name: string;
  readonly creator: string;
  /**
   * BOTS-1. What follows the creator's name on the row, so a community bot is credited rather than
   * quietly presented as ours: "by <name>, from the community". Absent on a first-party row.
   */
  readonly creatorNote?: string;
  readonly category: string;
  /**
   * BOTS-1. The categories this bot ALSO belongs to. A bot may sit under two chips upstream; one
   * becomes `category` and the rest land here so nothing is lost and the chip filter reads both.
   */
  readonly tags?: readonly string[];
  readonly featured: boolean;
  readonly tile: MarketplaceBotTile;
  readonly description: string;
  /** The persona the imported agent runs with. */
  readonly instructions: string;
  readonly skills: readonly MarketplaceBotSkill[];
  /** Plugin ids from MARKETPLACE_PLUGINS. The bot page offers Add for the missing ones. */
  readonly integrations: readonly string[];
  /**
   * BOTS-1. Facts it already knows, seeded into the agent's own memory store on import. Every row
   * in the catalog has these: a first-party row that declares none has them DERIVED from its
   * `instructions`, below, so the four blocks on a bot page are the same four blocks on every bot.
   */
  readonly memories?: readonly MarketplaceBotMemory[];
  /** BOTS-1. Jobs that run on their own, created disabled with the schedule their words imply. */
  readonly routines?: readonly MarketplaceBotRoutine[];
  /** BOTS-1. Apps it can use, with this bot's own sentence per app and what the page may offer. */
  readonly apps?: readonly MarketplaceBotApp[];
  /** BOTS-1. Where the row came from. Absent means first-party, and two validator rules are stricter. */
  readonly origin?: "first-party" | "community";
  /**
   * BOTS-1. The namespace this bot's skills are imported under, so 65 bots that each ship a
   * "Getting started" do not fight over one document in the box's shared library. It is what the
   * front matter in every `skills[].body` already names.
   */
  readonly skillPrefix?: string;
  /**
   * TEAMS-1. A pack that imports MORE THAN ONE agent names them here, each with its own
   * instructions, skills and integrations. A row with no `members` is one agent, exactly as every
   * bot row has been. The field is declared here so the three waves editing this tree have
   * genuinely disjoint file lists; source/shared/marketplace/marketing-team.ts fills it.
   */
  readonly members?: readonly MarketplaceBotMember[];
  /**
   * What the operator must supply before the pack is any use, said once, BEFORE the Import
   * button rather than after it: the two prerequisites in here take somebody else's days.
   */
  readonly firstRun?: {
    readonly headline: string;
    /** One line per thing to supply: a key, an Add, a document. */
    readonly needs: readonly string[];
    /** The ones that strand people, said before they hit them. */
    readonly prerequisites: readonly string[];
    readonly body: string;
  };
}

/** One specialist inside a pack: its own persona, its own skills, its own integrations. */
export interface MarketplaceBotMember {
  readonly id: string;
  /** The roster name is the pack's agent prefix plus this. */
  readonly role: string;
  /** One line: what this one is for, on the members list of the pack page. */
  readonly summary: string;
  readonly instructions: string;
  readonly skills: readonly MarketplaceBotSkill[];
  readonly integrations: readonly string[];
  /** The member this one reports to, by its id in this pack; null on the coordinator. */
  readonly reportsTo?: string | null;
}

/**
 * BOTS-1. A bot as the LIST serves it: the row and its chips, and a count per block.
 *
 * The five heavy fields are absent, and `getMarketplaceItem` is where the whole row comes from.
 * The type says so rather than leaving a reader to find out from a payload: `counts` is present on
 * a card and never on a row, so `card.counts != null && card.skills == null` is how a caller that
 * holds one of each tells them apart, and any code that would import a bot has to fetch the row.
 */
export interface MarketplaceBotCard extends Omit<MarketplaceBot, "instructions" | "memories" | "skills" | "routines" | "apps" | "members"> {
  readonly counts: {
    readonly memories: number;
    readonly skills: number;
    readonly routines: number;
    readonly apps: number;
  };
  /** A pack's members, projected to what the pack row's own line is drawn from. */
  readonly members?: readonly {
    readonly id: string;
    readonly role: string;
    readonly summary: string;
    readonly reportsTo: string | null;
  }[];
}

export interface MarketplaceCatalog {
  readonly plugins: readonly MarketplacePlugin[];
  readonly bots: readonly MarketplaceBot[];
  readonly categories: {
    readonly plugins: readonly string[];
    readonly bots: readonly string[];
  };
}

/**
 * Frozen on purpose: every chip widens the row the console draws, so a new category is a design
 * decision and not a side effect of adding a plugin. `Business` is the one this wave adds -- the
 * money-and-customers row an owner looks for, which none of the engineering categories was.
 */
export const MARKETPLACE_PLUGIN_CATEGORIES: readonly string[] = Object.freeze([
  "Featured",
  "Development",
  "Communication",
  "Project management",
  "Business",
  "Documents & Files",
  "Web & Search",
  "Code review",
  // "Shell tools" was here and no row has ever been filed under it. The console draws only the
  // chips that have members, so it was a chip nobody could ever see and the deploy gate went red
  // comparing the screen to this list. The one shell tool the catalog ships is a code review tool
  // and belongs where it is; "Shell tools" is how the TOOLS panel groups a connector, which is a
  // different list and is untouched.
  // Wave B. Richard's first hour is the reason: the rows a marketing person looks for are not
  // "Business" and not "Web & Search", and putting them anywhere else means the person who came
  // here to connect a Page has to read every chip to find out we have nothing for them.
  "Marketing",
]);

/**
 * BOTS-1 added the last three, and DEDUPED "Marketing", which this list shipped twice.
 *
 * The duplicate is not cosmetic: the categories go out on the wire and the console draws one chip
 * per entry, so the Bots half of the panel has been drawing two identical Marketing chips, the
 * second of which filters to the same rows as the first. TEAMS-1's comment meant "the pack belongs
 * under Marketing, not under Sales", and the chip it needed was already here.
 *
 * "From Grok Bot Team" -- 44 of the community pack's 69 rows -- is deliberately NOT here, under any
 * name. It is not a topic, it is the upstream's own byline, and folding it onto "From Titanbot team"
 * would credit 43 named community creators to us: a worse error than the one a rename would fix.
 * Each community bot keeps its topical chip instead, its second one goes into `tags`, and the four
 * rows the scrape left with nothing else get one from bots/overlay.json with a reason beside it.
 */
export const MARKETPLACE_BOT_CATEGORIES: readonly string[] = Object.freeze([
  "Featured",
  "From Titanbot team",
  "Engineering",
  "Operations",
  "Sales",
  // TEAMS-1's pack lands under this chip rather than under Sales, which is a different job.
  "Marketing",
  "Personal",
  // BOTS-1. The community pack brings three topics the first-party rows never had.
  "Design",
  "Product",
  "Recruiting & People",
]);

/**
 * Configuration env keys a catalog entry is allowed to give a non-empty value. A key NOT on this
 * list must be left empty, because an empty value is precisely how the host recognises a
 * credential field (CONNECT-4) -- and a credential with a value baked into the catalog would be a
 * secret in the repo.
 *
 * `MCP_REMOTE_CONFIG_DIR` is here because it is the opposite of a secret: it is where a bridge
 * keeps its own state. Left alone, mcp-remote writes under /root/.mcp-auth, which is not a volume,
 * so a box recreate wipes it. Pointed at sand-data it survives one.
 */
export const MARKETPLACE_CONFIGURATION_ENV_KEYS: readonly string[] = Object.freeze([
  "MCP_REMOTE_CONFIG_DIR",
]);

/** Where a bridge's own state lives, so a box recreate does not wipe it. */
export const MCP_REMOTE_CONFIG_DIR = "/home/box/sand-data/.mcp-auth";

/** The env every bridged remote row carries: the bridge's state directory, and nothing else. */
const BRIDGE_ENV = Object.freeze({ MCP_REMOTE_CONFIG_DIR });

/**
 * The rows as they are written. `PLUGINS` below is these with two DERIVED fields attached, so a
 * consumer that still speaks the pre-MARKET-6 vocabulary keeps working against the module itself
 * rather than only against the wire.
 */
const DECLARED_PLUGINS: readonly MarketplacePlugin[] = Object.freeze([
  Object.freeze({
    id: "github",
    name: "GitHub",
    tagline: "Read repositories, issues and pull requests",
    description:
      "GitHub's own hosted MCP server, authorized with a fine-grained personal access token. The entry filters the server down to repository, issue and code-change reads plus the identity tool, and sets X-MCP-Readonly, so nothing it exposes can write to a repository. The same token also feeds `gh` in the agent's shell, which is what gives git inside the box something to push with.",
    category: "Development",
    featured: true,
    icon: Object.freeze({ letter: "G", color: "#2d333b", file: "marketplace/logos/github.svg" }),
    source: Object.freeze({ label: "github/github-mcp-server", url: "https://github.com/github/github-mcp-server" }),
    connectorName: "github",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: Object.freeze({
          Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}",
          "X-MCP-Toolsets": "repos,issues,pull_requests",
          "X-MCP-Tools": "get_me",
          "X-MCP-Readonly": "true",
        }),
        env: Object.freeze({ GITHUB_PERSONAL_ACCESS_TOKEN: "" }),
      }),
      shellTool: "github-cli",
    }),
    keywords: Object.freeze(["git", "repository", "repo", "issues", "pull request", "code", "version control", "gh"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub personal access token",
        hint: "A GitHub fine-grained personal access token. Create one under Settings → Developer settings → Personal access tokens → Fine-grained tokens (github.com/settings/personal-access-tokens/new); reading needs Contents: read, Issues: read and Pull requests: read, plus the Metadata: read it includes automatically. Add Contents: write only if you want the box to push.",
        consumers: Object.freeze([
          Object.freeze({ kind: "connector", env: "GITHUB_PERSONAL_ACCESS_TOKEN" }),
          Object.freeze({ kind: "header", name: "Authorization" }),
          Object.freeze({ kind: "shell", env: "GITHUB_TOKEN" }),
        ]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "endpoint-answered",
      how: "POSTed an MCP initialize to https://api.githubcopilot.com/mcp/ from inside grok-bot-local-vm with a well-formed but invented token: HTTP 401 \"unauthorized: AuthenticateToken authentication failed\" in 0.4 s. The endpoint is live and reads the Authorization header; we hold no GitHub token of our own to list tools with.",
    }),
  }),
  Object.freeze({
    id: "slack",
    name: "Slack",
    tagline: "Read channels, threads and search as yourself",
    description:
      "A maintained Slack server that takes a user OAuth token from the environment, so it acts as the installing user and search works. Posting stays off: that is the server's own default, not a header this entry sets. This is not the Slack chat listener — the listener binds inbound events to an agent, this connector is outbound tools inside the box.",
    category: "Communication",
    featured: true,
    icon: Object.freeze({ letter: "S", color: "#4a154b" }),
    source: Object.freeze({ label: "korotovsky/slack-mcp-server", url: "https://github.com/korotovsky/slack-mcp-server" }),
    connectorName: "slack",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "stdio",
        command: "npx",
        args: Object.freeze(["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"]),
        env: Object.freeze({ SLACK_MCP_XOXP_TOKEN: "" }),
      }),
    }),
    keywords: Object.freeze(["chat", "messages", "channels", "team", "dm", "conversation"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "SLACK_MCP_XOXP_TOKEN",
        label: "Slack user OAuth token",
        hint: "A Slack user OAuth token (xoxp-), acting as the installing user. Create the app at api.slack.com/apps, add User Token Scopes, Install to Workspace and copy the User OAuth Token; channels:read alone lists public channels, and reading plus search also wants channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history, users:read and search:read.",
        consumers: Object.freeze([Object.freeze({ kind: "connector", env: "SLACK_MCP_XOXP_TOKEN" })]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "endpoint-answered",
      how: "Spawned `npx -y slack-mcp-server@1.3.0 --transport stdio` inside grok-bot-local-vm with an invented xoxp- token: the program downloaded, started and refused by name — \"Authentication failed - check your Slack tokens\", invalid_auth — rather than crashing or 404ing on npm. We hold no Slack workspace token to list tools with.",
    }),
  }),
  Object.freeze({
    id: "linear",
    name: "Linear",
    tagline: "Read issues, projects and cycles",
    description:
      "Linear's hosted endpoint, reached with a personal API key. The key matters: with no key the bridge falls through to a browser sign-in, and this box has no browser a person can finish one in. A read-only key is what Linear's own guidance recommends.",
    category: "Project management",
    featured: true,
    icon: Object.freeze({ letter: "L", color: "#5e6ad2", file: "marketplace/logos/linear.svg" }),
    source: Object.freeze({ label: "linear.app/docs/mcp", url: "https://linear.app/docs/mcp" }),
    connectorName: "linear",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: Object.freeze({ Authorization: "Bearer ${LINEAR_API_KEY}" }),
        env: Object.freeze({ LINEAR_API_KEY: "" }),
      }),
    }),
    keywords: Object.freeze(["issues", "tickets", "backlog", "sprint", "roadmap", "project tracker"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "LINEAR_API_KEY",
        label: "Linear personal API key",
        hint: "A Linear personal API key. Create one under Settings → Account → Security & Access → Personal API keys (linear.app/settings/account/security) and copy it once; Read is the only permission the read tools need, and Linear's own guidance recommends a Read-only key.",
        consumers: Object.freeze([
          Object.freeze({ kind: "connector", env: "LINEAR_API_KEY" }),
          Object.freeze({ kind: "header", name: "Authorization" }),
        ]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "endpoint-answered",
      how: "POSTed an MCP initialize to https://mcp.linear.app/mcp from inside grok-bot-local-vm with an invented bearer: HTTP 401 {\"error\":\"invalid_token\"} in 0.5 s. The endpoint is live and the bearer scheme is the right one; we hold no Linear key of our own to list tools with.",
    }),
  }),
  Object.freeze({
    id: "google",
    name: "Google Workspace",
    tagline: "Gmail, Docs and Drive through one server",
    description:
      "One process covering Gmail and Docs. It mints access tokens at runtime from an OAuth client pair plus a refresh token, so consent is done once in Google's OAuth Playground and nothing afterwards needs a browser inside the box. Three fields to fill, not one.",
    category: "Documents & Files",
    featured: false,
    icon: Object.freeze({ letter: "W", color: "#1a73e8", file: "marketplace/logos/google.svg" }),
    source: Object.freeze({ label: "EveryInc/google-workspace-mcp-server", url: "https://github.com/EveryInc/google-workspace-mcp-server" }),
    connectorName: "google",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "stdio",
        command: "npx",
        args: Object.freeze(["-y", "google-workspace-mcp-server@1.4.3"]),
        env: Object.freeze({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_REFRESH_TOKEN: "" }),
      }),
    }),
    keywords: Object.freeze(["gmail", "email", "docs", "drive", "calendar", "spreadsheet", "workspace"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "GOOGLE_CLIENT_ID",
        label: "Google OAuth client ID",
        hint: "The client ID of an OAuth Web application client. Create it in Google Cloud under APIs & Services → Credentials with https://developers.google.com/oauthplayground as an authorized redirect URI, on a project with the Gmail, Google Docs and Google Drive APIs enabled.",
        consumers: Object.freeze([Object.freeze({ kind: "connector", env: "GOOGLE_CLIENT_ID" })]),
      }),
      Object.freeze({
        field: "GOOGLE_CLIENT_SECRET",
        label: "Google OAuth client secret",
        hint: "The secret shown beside that same OAuth client under APIs & Services → Credentials. It is half of the client pair, not a scope of its own, and it is what the Playground is given to mint the refresh token.",
        consumers: Object.freeze([Object.freeze({ kind: "connector", env: "GOOGLE_CLIENT_SECRET" })]),
      }),
      Object.freeze({
        field: "GOOGLE_REFRESH_TOKEN",
        label: "Google refresh token",
        hint: "The refresh token from the OAuth 2.0 Playground exchange (gear → Use your own OAuth credentials → Authorize APIs → Exchange authorization code for tokens), not the access token; authorize gmail.readonly for Gmail reads, gmail.compose for drafts, documents for Docs read and write, and drive.file plus drive.readonly for the Docs file IDs.",
        consumers: Object.freeze([Object.freeze({ kind: "connector", env: "GOOGLE_REFRESH_TOKEN" })]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "Spawned `npx -y google-workspace-mcp-server@1.4.3` inside grok-bot-local-vm with invented client credentials: it started and listed 34 tools in 5.2 s. It defers Google's own auth to the first call, so listing tools does not prove the credentials, only that the server runs in this box.",
    }),
  }),
  Object.freeze({
    id: "tinyfish",
    name: "TinyFish",
    tagline: "Web search, page fetch and browser automation",
    description:
      "TinyFish's hosted endpoint plus its published command-line tool, which is one product and therefore one place to put a key: the value you store here reaches both the connector and the agent's shell. The key is carried as an Authorization bearer — X-API-Key is the REST-side name and this endpoint refuses it.",
    category: "Web & Search",
    featured: true,
    icon: Object.freeze({ letter: "T", color: "#0f766e" }),
    source: Object.freeze({ label: "agent.tinyfish.ai/mcp", url: "https://agent.tinyfish.ai/mcp" }),
    connectorName: "tinyfish",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://agent.tinyfish.ai/mcp",
        headers: Object.freeze({ Authorization: "Bearer ${TINYFISH_API_KEY}" }),
        env: Object.freeze({ TINYFISH_API_KEY: "" }),
      }),
      shellTool: "tinyfish-cli",
    }),
    keywords: Object.freeze(["search", "browse", "scrape", "web", "automation", "crawler", "fetch"]),
    proxyMcpServer: "tinyfish",
    credentials: Object.freeze([
      Object.freeze({
        field: "TINYFISH_API_KEY",
        label: "TinyFish API key",
        hint: "Your TinyFish account's API key, from the dashboard at agent.tinyfish.ai. The key is account-wide and carries no separate scopes. Stored once here, it is used by the connector and by the command-line tool in the agent's shell. If web search and page fetch are included with your plan you need no key here at all: your box is given one of its own and this card stays empty.",
        consumers: Object.freeze([
          Object.freeze({ kind: "connector", env: "TINYFISH_API_KEY" }),
          Object.freeze({ kind: "header", name: "Authorization" }),
          Object.freeze({ kind: "shell", env: "TINYFISH_API_KEY" }),
        ]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "endpoint-answered",
      how: "POSTed an MCP initialize to https://agent.tinyfish.ai/mcp from inside grok-bot-local-vm with an invented bearer: HTTP 401 \"Unauthorized: Valid OAuth Bearer token required\" in 0.6 s. The endpoint is live and the bearer scheme is the right one; no account key was used in this check.",
    }),
  }),
  Object.freeze({
    id: "context7",
    name: "Context7",
    tagline: "Up-to-date documentation for any library",
    description:
      "Looks up the current documentation for a library or framework and hands back the pages, so the agent writes against what a package does today rather than what it did when the model was trained. It needs no key at all: the endpoint answers anonymously.",
    category: "Development",
    featured: true,
    icon: Object.freeze({ letter: "C7", color: "#111827" }),
    source: Object.freeze({ label: "context7.com", url: "https://context7.com" }),
    connectorName: "context7",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        headers: Object.freeze({}),
        env: Object.freeze({}),
      }),
    }),
    keywords: Object.freeze(["docs", "documentation", "api reference", "library", "framework", "sdk"]),
    credentials: Object.freeze([]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "POSTed an MCP initialize then tools/list to https://mcp.context7.com/mcp from inside grok-bot-local-vm with no credential: 2 tools back in 0.6 s (resolve-library-id, query-docs).",
    }),
  }),
  Object.freeze({
    id: "exa",
    name: "Exa",
    tagline: "Search the web and read the pages it finds",
    description:
      "A search engine built for agents: it returns the contents of the pages, not a list of links to fetch separately. The public endpoint answers without a key, which is what makes it the cheapest thing on this page to try.",
    category: "Web & Search",
    featured: true,
    icon: Object.freeze({ letter: "E", color: "#1d4ed8" }),
    source: Object.freeze({ label: "exa.ai", url: "https://exa.ai" }),
    connectorName: "exa",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://mcp.exa.ai/mcp",
        headers: Object.freeze({}),
        env: Object.freeze({}),
      }),
    }),
    keywords: Object.freeze(["search", "web", "research", "find", "lookup", "internet"]),
    credentials: Object.freeze([]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "POSTed an MCP initialize then tools/list to https://mcp.exa.ai/mcp from inside grok-bot-local-vm with no credential: 2 tools back in 0.4 s.",
    }),
  }),
  Object.freeze({
    id: "cloudflare-docs",
    name: "Cloudflare docs",
    tagline: "Search Cloudflare's own documentation",
    description:
      "Cloudflare's documentation server. It reads their docs and nothing else — no account, no zone, no API token — so it is safe to add on a box that has no Cloudflare relationship at all, and it is the one card here that proves the remote path end to end without anybody minting anything.",
    category: "Development",
    featured: false,
    icon: Object.freeze({ letter: "CF", color: "#f6821f" }),
    source: Object.freeze({ label: "developers.cloudflare.com/agents/model-context-protocol", url: "https://developers.cloudflare.com/agents/model-context-protocol/" }),
    connectorName: "cloudflare-docs",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://docs.mcp.cloudflare.com/mcp",
        headers: Object.freeze({}),
        env: Object.freeze({}),
      }),
    }),
    keywords: Object.freeze(["cloudflare", "dns", "workers", "cdn", "docs", "documentation"]),
    credentials: Object.freeze([]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "POSTed an MCP initialize then tools/list to https://docs.mcp.cloudflare.com/mcp from inside grok-bot-local-vm with no credential: 2 tools back in 0.2 s (search_cloudflare_documentation, migrate_pages_to_workers_guide).",
    }),
  }),
  Object.freeze({
    id: "deepwiki",
    name: "DeepWiki",
    tagline: "Ask questions about any public repository",
    description:
      "Reads a public GitHub repository and answers questions about how it works, with the structure already indexed. Useful when somebody hands you a dependency and you need to know what it does before you trust it. No key: the endpoint answers anonymously.",
    category: "Development",
    featured: false,
    icon: Object.freeze({ letter: "DW", color: "#0f172a" }),
    source: Object.freeze({ label: "deepwiki.com", url: "https://deepwiki.com" }),
    connectorName: "deepwiki",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://mcp.deepwiki.com/mcp",
        headers: Object.freeze({}),
        env: Object.freeze({}),
      }),
    }),
    keywords: Object.freeze(["repository", "repo", "open source", "dependency", "codebase", "explain"]),
    credentials: Object.freeze([]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "POSTed an MCP initialize then tools/list to https://mcp.deepwiki.com/mcp from inside grok-bot-local-vm with no credential: 3 tools back in 1.5 s.",
    }),
  }),
  Object.freeze({
    id: "notion",
    name: "Notion",
    tagline: "Read and write pages and databases",
    description:
      "Notion's own server, running inside the box with an internal integration token. It reaches only the pages you explicitly share with the integration, which is the permission model — there is no scope to narrow beyond choosing what to connect.",
    category: "Documents & Files",
    featured: true,
    icon: Object.freeze({ letter: "N", color: "#191919" }),
    source: Object.freeze({ label: "makenotion/notion-mcp-server", url: "https://github.com/makenotion/notion-mcp-server" }),
    connectorName: "notion",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "stdio",
        command: "npx",
        args: Object.freeze(["-y", "@notionhq/notion-mcp-server@2.5.1"]),
        env: Object.freeze({ NOTION_TOKEN: "" }),
      }),
    }),
    keywords: Object.freeze(["notes", "wiki", "docs", "database", "knowledge base", "pages"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "NOTION_TOKEN",
        label: "Notion internal integration token",
        hint: "An internal integration token (ntn_...) from notion.so/profile/integrations — create the integration, then open each page or database you want reachable and use its ••• menu → Connections → your integration. Nothing you do not connect is visible, so connect the smallest set that works.",
        consumers: Object.freeze([Object.freeze({ kind: "connector", env: "NOTION_TOKEN" })]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "Spawned `npx -y @notionhq/notion-mcp-server@2.5.1` inside grok-bot-local-vm with an invented token: 24 tools listed in 36.2 s on a cold npx cache, and about 2 s once cached. The first connect on a fresh box is close to the 60-second connect timeout; the second is not.",
    }),
  }),
  Object.freeze({
    id: "airtable",
    name: "Airtable",
    tagline: "Read and update bases, tables and records",
    description:
      "The spreadsheet-shaped database a lot of small businesses actually run on: customers, inventory, jobs. The server runs in the box against a personal access token, and the token's scopes are what decide whether the agent can write or only read.",
    category: "Business",
    featured: true,
    icon: Object.freeze({ letter: "A", color: "#fcb400" }),
    source: Object.freeze({ label: "domdomegg/airtable-mcp-server", url: "https://github.com/domdomegg/airtable-mcp-server" }),
    connectorName: "airtable",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "stdio",
        command: "npx",
        args: Object.freeze(["-y", "airtable-mcp-server@1.14.0"]),
        env: Object.freeze({ AIRTABLE_API_KEY: "" }),
      }),
    }),
    keywords: Object.freeze(["database", "spreadsheet", "records", "crm", "inventory", "table", "base"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "AIRTABLE_API_KEY",
        label: "Airtable personal access token",
        hint: "A personal access token (pat...) from airtable.com/create/tokens, scoped to the bases you want reachable. schema.bases:read and data.records:read are enough to read; add data.records:write only if you want the agent to change records.",
        consumers: Object.freeze([Object.freeze({ kind: "connector", env: "AIRTABLE_API_KEY" })]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "Spawned `npx -y airtable-mcp-server@1.14.0` inside grok-bot-local-vm with an invented token: 16 tools listed in 6.6 s. It checks the token on the first call, not at startup, so listing tools proves the server runs here and not that the token is good.",
    }),
  }),
  Object.freeze({
    id: "todoist",
    name: "Todoist",
    tagline: "Read and manage tasks and projects",
    description:
      "Todoist's own server, running in the box against an API token from your account settings. The token is account-wide — Todoist does not scope them — so this one reaches everything the account can see.",
    category: "Project management",
    featured: false,
    icon: Object.freeze({ letter: "T", color: "#e44332" }),
    source: Object.freeze({ label: "Doist/todoist-mcp", url: "https://github.com/Doist/todoist-mcp" }),
    connectorName: "todoist",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "stdio",
        command: "npx",
        args: Object.freeze(["-y", "@doist/todoist-mcp@13.2.3"]),
        env: Object.freeze({ TODOIST_API_KEY: "" }),
      }),
    }),
    keywords: Object.freeze(["tasks", "todo", "reminders", "checklist", "projects", "personal"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "TODOIST_API_KEY",
        label: "Todoist API token",
        hint: "The API token from Todoist under Settings → Integrations → Developer. It is account-wide and cannot be narrowed, so add this on an account whose whole task list you are willing to expose.",
        consumers: Object.freeze([Object.freeze({ kind: "connector", env: "TODOIST_API_KEY" })]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "Spawned `npx -y @doist/todoist-mcp@13.2.3` inside grok-bot-local-vm with an invented token: 47 tools listed in 24.9 s on a cold npx cache. The token is checked on the first call, not at startup.",
    }),
  }),
  Object.freeze({
    id: "playwright",
    name: "Playwright browser",
    tagline: "Drive a real browser inside the box",
    description:
      "A real Chromium the agent can open pages in, click through and read — for the sites that have no API. It runs headless and isolated, so each session starts from a clean profile and nothing it does is saved. No credential: the browser is the whole permission model.",
    category: "Web & Search",
    featured: false,
    icon: Object.freeze({ letter: "P", color: "#2d4a3e" }),
    source: Object.freeze({ label: "microsoft/playwright-mcp", url: "https://github.com/microsoft/playwright-mcp" }),
    connectorName: "playwright",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "stdio",
        command: "npx",
        args: Object.freeze(["-y", "@playwright/mcp@0.0.80", "--headless", "--isolated"]),
        env: Object.freeze({}),
      }),
    }),
    keywords: Object.freeze(["browser", "chrome", "automation", "click", "form", "screenshot", "scrape"]),
    credentials: Object.freeze([]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "Spawned `npx -y @playwright/mcp@0.0.80 --headless --isolated` inside grok-bot-local-vm: 24 tools listed in 2.5 s. Listing tools does not download a browser; the first page it opens will, and that download is slower than the first connect.",
    }),
  }),
  Object.freeze({
    id: "resend",
    name: "Resend",
    tagline: "Send email from your own domain",
    description:
      "Sends transactional email — a quote, a receipt, a follow-up — from a domain you have verified, rather than from a mailbox the agent has to log into. The key is carried as a bearer, which is what their docs prescribe for a client with no browser.",
    category: "Business",
    featured: true,
    icon: Object.freeze({ letter: "R", color: "#000000" }),
    source: Object.freeze({ label: "resend.com/docs/mcp", url: "https://resend.com/docs" }),
    connectorName: "resend",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://mcp.resend.com/mcp",
        headers: Object.freeze({ Authorization: "Bearer ${RESEND_API_KEY}" }),
        env: Object.freeze({ RESEND_API_KEY: "" }),
      }),
    }),
    keywords: Object.freeze(["email", "send", "mail", "smtp", "newsletter", "transactional", "invoice"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "RESEND_API_KEY",
        label: "Resend API key",
        hint: "An API key from resend.com/api-keys. Choose Sending access rather than Full access, and restrict it to the one verified domain you want the agent to send from; a Full access key can also read and delete your domains.",
        consumers: Object.freeze([
          Object.freeze({ kind: "connector", env: "RESEND_API_KEY" }),
          Object.freeze({ kind: "header", name: "Authorization" }),
        ]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "POSTed an MCP initialize then tools/list to https://mcp.resend.com/mcp from inside grok-bot-local-vm with an invented bearer: 103 tools back in 0.6 s. It does not check the key until a tool is called, so this proves the endpoint and the transport, not the key.",
    }),
  }),
  Object.freeze({
    id: "stripe",
    name: "Stripe",
    tagline: "Look up customers, invoices and payments",
    description:
      "Reads and creates the objects a business actually asks about: who paid, what is outstanding, send this invoice. Use a restricted key rather than your secret key — Stripe lets you build one that can read customers and invoices and touch nothing else.",
    category: "Business",
    featured: true,
    icon: Object.freeze({ letter: "S", color: "#635bff" }),
    source: Object.freeze({ label: "docs.stripe.com/mcp", url: "https://docs.stripe.com/mcp" }),
    connectorName: "stripe",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://mcp.stripe.com",
        headers: Object.freeze({ Authorization: "Bearer ${STRIPE_API_KEY}" }),
        env: Object.freeze({ STRIPE_API_KEY: "" }),
      }),
    }),
    keywords: Object.freeze(["payments", "invoice", "billing", "customers", "subscription", "revenue", "money", "refund"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "STRIPE_API_KEY",
        label: "Stripe restricted API key",
        hint: "A RESTRICTED key (rk_...) from the Stripe dashboard under Developers → API keys → Create restricted key, not your secret key. Give it read on Customers, Invoices and Charges and nothing else; add write only for the objects you want the agent to create.",
        consumers: Object.freeze([
          Object.freeze({ kind: "connector", env: "STRIPE_API_KEY" }),
          Object.freeze({ kind: "header", name: "Authorization" }),
        ]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "endpoint-answered",
      how: "POSTed an MCP initialize to https://mcp.stripe.com from inside grok-bot-local-vm with an invented restricted key: HTTP 401 {\"error\":\"Unauthorized. See https://docs.stripe.com/mcp for usage instructions.\"} in 0.6 s. The endpoint is live and takes a bearer; we hold no Stripe key of our own to list tools with.",
    }),
  }),
  Object.freeze({
    id: "browser-use",
    name: "Browser Use",
    tagline: "Hand a browsing job to a hosted agent",
    description:
      "Describes a task in words — find this, fill that in, get me the number — and a hosted agent drives a browser to do it, so the box does not have to run one. The alternative to the Playwright card when the job is a goal rather than a script.",
    category: "Web & Search",
    featured: false,
    icon: Object.freeze({ letter: "BU", color: "#111827" }),
    source: Object.freeze({ label: "docs.browser-use.com", url: "https://docs.browser-use.com" }),
    connectorName: "browser-use",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://api.browser-use.com/mcp",
        headers: Object.freeze({ "X-Browser-Use-API-Key": "${BROWSER_USE_API_KEY}" }),
        env: Object.freeze({ BROWSER_USE_API_KEY: "" }),
      }),
    }),
    keywords: Object.freeze(["browser", "agent", "automation", "web task", "scrape", "form"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "BROWSER_USE_API_KEY",
        label: "Browser Use API key",
        hint: "An API key from cloud.browser-use.com under Billing → API keys. It is account-wide and it spends your balance on every run, so put it on an account with a cap you are comfortable with.",
        consumers: Object.freeze([
          Object.freeze({ kind: "connector", env: "BROWSER_USE_API_KEY" }),
          Object.freeze({ kind: "header", name: "X-Browser-Use-API-Key" }),
          // CLOUD-BROWSER-1. The same key is also the first cloud engine behind the four browser_*
          // tools, so the one box on this page fans out to the connector AND to the host's own
          // cloud-browser store, exactly the way GitHub's one token already reaches a connector
          // and `gh`. Declared here so the engine is a fact about the row rather than a name the
          // host hard-codes.
          Object.freeze({ kind: "cloud-browser", engine: "browser-use" }),
        ]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "POSTed an MCP initialize then tools/list to https://api.browser-use.com/mcp from inside grok-bot-local-vm with an invented key in X-Browser-Use-API-Key: 6 tools back in 0.3 s. It checks the key when a task is started, not at listing time, so this proves the endpoint and the header name, not the key.",
    }),
  }),
  // ---- MARKET-26: the marketing rows -----------------------------------------------------------
  //
  // Read against each vendor's own documentation on 2026-09-09, and every fact below carries the
  // page it came off and the day it was read. What that reading actually found, said once here so
  // no row has to repeat it: NO OFFICIAL MCP SERVER PUBLISHES AN ORGANIC POST ANYWHERE. Meta's
  // Social Technologies MCP manages apps and webhooks, Meta's Ads MCP manages ads, and X's hosted
  // MCP reads posts and writes only bookmarks and Articles. So on Meta, X and LinkedIn the
  // connector and the posting path are different things, and these rows say so rather than
  // shipping a card that looks like it posts.
  //
  // Three of them install nothing on purpose. A row whose only honest content is "here is what the
  // vendor requires of you first" is a page, not an entry, and `installsNothing` is how the console
  // knows to draw the steps and no Add button. Their endpoints were still called from inside the
  // box, with an invented token, so the row's verification is a measurement and not a reading.
  Object.freeze({
    id: "meta",
    name: "Meta: Facebook Pages and Instagram",
    tagline: "What Meta needs before an agent can post for a client",
    description:
      "Posting to a Facebook Page or an Instagram professional account goes through Meta's Graph API with your own developer app and your own tokens. There is no server to install here and no key box: Meta's own MCP servers manage apps, webhooks and ads, and none of them publishes an organic post. This page is the part that actually costs time — which login your app uses, which permissions that login grants, and the review Meta puts between posting for yourself and posting for a client.",
    category: "Marketing",
    featured: true,
    icon: Object.freeze({ letter: "M", color: "#0866ff" }),
    source: Object.freeze({ label: "developers.facebook.com · Graph API", url: "https://developers.facebook.com/docs/graph-api" }),
    keywords: Object.freeze(["facebook", "instagram", "meta", "page", "social", "post", "marketing", "reels", "business"]),
    credentials: Object.freeze([]),
    firstSteps: Object.freeze([
      "Create a Meta app at developers.facebook.com and add the Instagram or Facebook Login product to it. Which one you pick decides the permission names for everything after this, and the two sets are not interchangeable.",
      "Make sure the client's Instagram account is a professional account and, if you are using Facebook Login, that it is connected to a Facebook Page. An app cannot reach a personal account at all.",
      "Give yourself a role on the app and a role on the Page. With Standard Access an app posts only to accounts whose staff hold a role on the app, which covers your own accounts and nobody else's.",
      "The moment you post for a client whose staff hold no role on your app, you need Advanced Access: Business Verification, App Review for each permission you use, and an annual Data Use Checkup that keeps the access alive. Budget weeks, not an afternoon.",
      "Until that clears, post through the browser or through a scheduler the client already pays for.",
    ]),
    knownContradiction:
      "Meta's own content-publishing guide gives the Instagram publishing limit twice and differently: its Rate Limit section says 100 API-published posts in a 24-hour moving period, and its carousel section says 50 published posts in a 24-hour period. Plan against 50 and read the account's own /content_publishing_limit before a batch.",
    recheckDays: 7,
    docs: Object.freeze([
      Object.freeze({
        id: "graph-version",
        what: "The current Graph API version, which every endpoint path carries",
        url: "https://developers.facebook.com/docs/graph-api/changelog",
        anchor: "The latest Graph API version is",
        expected: "v26.0",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "page-post-permission",
        what: "The permission that lets an app create a Page post, and what it depends on",
        url: "https://developers.facebook.com/docs/permissions",
        anchor: "pages_manage_posts",
        expected: "pages_manage_posts",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "instagram-publish-permission",
        what: "The permission that lets an app publish an Instagram feed post under Facebook Login",
        url: "https://developers.facebook.com/docs/permissions",
        anchor: "instagram_content_publish",
        expected: "instagram_content_publish",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "instagram-login-scopes",
        what: "The two Instagram login configurations and their two different permission sets",
        url: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
        finalUrl: "https://developers.facebook.com/documentation/instagram-platform/content-publishing",
        anchor: "Permissions",
        expected: "instagram_business_content_publish",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "instagram-publish-limit",
        what: "How many posts an Instagram account may publish through the API in a day",
        url: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
        finalUrl: "https://developers.facebook.com/documentation/instagram-platform/content-publishing",
        anchor: "Instagram accounts are limited to",
        expected: "100 API-published posts within a 24-hour moving period",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-09",
      proof: "endpoint-answered",
      how: "GET https://graph.facebook.com/v26.0/me from inside grok-bot-local-vm with an invented access token: HTTP 400 OAuthException code 190, \"Invalid OAuth access token - Cannot parse access token\", in 0.20 s. The version in the path is live and the endpoint reads the token; we hold no Meta app of our own to post with, and this row installs nothing.",
    }),
  }),
  Object.freeze({
    id: "x",
    name: "X",
    tagline: "What posting to X costs, and why it needs your own app",
    description:
      "X dropped its access tiers: there is no application to fill in and no app review, you buy credits and pay per request. What it does need is your own developer app and a user-context token, because the hosted MCP server cannot create an ordinary post and an app-only bearer is refused at the endpoint. There is nothing to install from this page; it is here so the cost of a posting habit is on the screen before somebody builds one.",
    category: "Marketing",
    featured: false,
    icon: Object.freeze({ letter: "X", color: "#0f1419" }),
    source: Object.freeze({ label: "docs.x.com · X API", url: "https://docs.x.com/x-api/getting-started/about-x-api" }),
    keywords: Object.freeze(["twitter", "x", "post", "tweet", "social", "marketing", "thread"]),
    credentials: Object.freeze([]),
    firstSteps: Object.freeze([
      "Create a developer app in X's Developer Console and buy credits. There is no tier to apply for and no app review; an empty credit balance is the only thing that stops a request.",
      "Set a spending limit on the app before anyone uses it. A post carrying a link is more than thirteen times the price of a post without one, so an unattended posting habit is the expensive shape.",
      "Authorise the account you will post as through OAuth 2.0 with tweet.write, tweet.read, users.read and offline.access. POST /2/tweets refuses an app-only bearer outright, so the app's own key is not enough.",
      "That user-context token needs a local bridge to reach an agent: X's hosted MCP server takes an app-only bearer, and it cannot create an ordinary post. Treat X's own MCP as a reader, not the posting path.",
      "Keep X posting off until somebody has agreed a per-post ceiling for the client. The approval card carries the cost line.",
    ]),
    knownContradiction:
      "X's own quickstart still shows quote-posting through quote_tweet_id while the same endpoint page says quote-posting requires an Enterprise plan and is not available on pay-per-use. Assume a quote post fails on a self-serve app.",
    recheckDays: 7,
    docs: Object.freeze([
      Object.freeze({
        id: "pricing-model",
        what: "That X charges per usage rather than by subscription tier",
        url: "https://docs.x.com/x-api/getting-started/pricing",
        anchor: "The X API uses",
        expected: "pay-per-usage",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "post-price",
        what: "What one created post costs",
        url: "https://docs.x.com/x-api/getting-started/pricing",
        anchor: "Write operations",
        expected: "$0.015 per request",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "post-with-url-price",
        what: "What one created post carrying a link costs",
        url: "https://docs.x.com/x-api/getting-started/pricing",
        anchor: "Write operations",
        expected: "$0.200 per request",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "create-post-auth",
        what: "That creating a post needs a user-context token, not the app's own bearer",
        url: "https://docs.x.com/x-api/posts/creation-of-a-post",
        finalUrl: "https://docs.x.com/x-api/posts/create-post",
        anchor: "Authorizations",
        expected: "OAuth2UserToken",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-09",
      proof: "endpoint-answered",
      how: "POST https://api.x.com/2/tweets from inside grok-bot-local-vm with an invented bearer: HTTP 403 \"Unsupported Authentication ... Supported authentication types are [OAuth 1.0a User Context, OAuth 2.0 User Context]\" in 0.19 s. That refusal is the row's own point measured rather than read: the endpoint is live and it will not take an app-only token.",
    }),
  }),
  Object.freeze({
    id: "linkedin",
    name: "LinkedIn",
    tagline: "The application, the page and the token clock",
    description:
      "LinkedIn is the slowest of the three to get into and the one most likely to stop working quietly. Posting for an organisation needs an approved Community Management application, a Page that exists before the app does, and a token that expires every sixty days unless LinkedIn has named you a partner. Nothing installs from this page; it is the checklist and the clock.",
    category: "Marketing",
    featured: false,
    icon: Object.freeze({ letter: "in", color: "#0a66c2" }),
    source: Object.freeze({ label: "learn.microsoft.com · LinkedIn Posts API", url: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api" }),
    keywords: Object.freeze(["linkedin", "post", "company page", "organisation", "social", "marketing", "b2b"]),
    credentials: Object.freeze([]),
    firstSteps: Object.freeze([
      "Create the client's LinkedIn Page first. An app is attached to a Page, so there is no way to do this in the other order.",
      "Create the app at linkedin.com/developers and verify it against that Page. Verification is a link the Page's admin has to click, so it needs somebody at the client, not just you.",
      "Apply for Community Management API access. It is an application with a review, not a switch, and every app starts in the Development tier meanwhile: 500 calls per app per day and 100 per member per day, which is enough to build against and not enough to run twenty clients on.",
      "Ask for w_organization_social to post as the organisation and r_organization_social to read what it posted. The authenticated person needs an admin role on the Page or the call is refused whatever the app was granted.",
      "Put a reminder in the calendar for day fifty-five. Access tokens last sixty days and refresh tokens are reserved for approved partners, so for most apps re-authorising by hand is the renewal.",
    ]),
    recheckDays: 7,
    docs: Object.freeze([
      Object.freeze({
        id: "version-header",
        what: "The version header every Marketing API call has to carry",
        url: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
        finalUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-08",
        anchor: "All APIs require the request header",
        expected: "Linkedin-Version",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "org-post-permission",
        what: "The permission that lets an app post as an organisation",
        url: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
        finalUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-08",
        anchor: "Permissions",
        expected: "w_organization_social",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "posts-replaces-ugcposts",
        what: "That the Posts API is the current one and ugcPosts is the old one",
        url: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
        finalUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-08",
        anchor: "Note",
        expected: "The Posts API replaces the ugcPosts API",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "rate-limits",
        what: "The per-app rate limits outside the Development tier",
        url: "https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits",
        anchor: "",
        expected: "",
        checkedOn: "2026-09-09",
        state: "not-published",
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-09",
      proof: "endpoint-answered",
      how: "GET https://api.linkedin.com/rest/posts from inside grok-bot-local-vm with an invented bearer and Linkedin-Version: 202608: HTTP 401 {\"serviceErrorCode\":65600,\"code\":\"INVALID_ACCESS_TOKEN\"} in 0.36 s. The versioned endpoint is live and takes the header this row names; we hold no approved LinkedIn app, and this row installs nothing.",
    }),
  }),
  Object.freeze({
    id: "buffer",
    name: "Buffer",
    tagline: "Schedule to eleven networks with one self-serve key",
    description:
      "The only scheduler with a path you can walk on the first day: the key comes out of your own Buffer settings with nobody's approval, and Buffer's own MCP server posts to eleven networks through the one account you already pay for. Its second gift is a reminder mode — a post scheduled as a notification pings a person to publish it by hand, which is the honest answer for a network whose API we cannot reach for this client yet.",
    category: "Marketing",
    featured: true,
    icon: Object.freeze({ letter: "B", color: "#2c4bff" }),
    source: Object.freeze({ label: "developers.buffer.com", url: "https://developers.buffer.com" }),
    connectorName: "buffer",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "http",
        url: "https://mcp.buffer.com/mcp",
        headers: Object.freeze({ Authorization: "Bearer ${BUFFER_API_KEY}" }),
        env: Object.freeze({ BUFFER_API_KEY: "" }),
      }),
    }),
    keywords: Object.freeze(["schedule", "scheduler", "queue", "social", "posts", "calendar", "marketing", "publish"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "BUFFER_API_KEY",
        label: "Buffer API key",
        hint: "A key from Buffer's own Settings → API, minted by you with no application to file. It is ACCOUNT-WIDE: there is no per-organisation scoping, so a key made on an agency account reaches every client channel on that account. Put it on the account whose channels this workspace is allowed to touch, and nothing wider. On the free plan one key exists at a time and the account gets 100 requests per 15 minutes, 250 a day and 3,000 a month across everything.",
        consumers: Object.freeze([
          Object.freeze({ kind: "connector", env: "BUFFER_API_KEY" }),
          Object.freeze({ kind: "header", name: "Authorization" }),
        ]),
      }),
    ]),
    firstSteps: Object.freeze([
      "Connect the client's channels inside Buffer first. The API posts to channels Buffer already holds; it cannot add one.",
      "Mint the key in Buffer under Settings → API and paste it in the box on this page. Nothing else has to be approved.",
      "Decide per channel whether a post publishes itself or reminds a person: schedulingType \"notification\" hands the post to somebody to publish by hand, which is how a network we cannot post to directly still gets scheduled work.",
      "Check the plan's ceiling before a bulk run. On the free plan a conversation that lists posts, reads a few and edits one has already spent several of the day's 250 requests.",
    ]),
    recheckDays: 7,
    docs: Object.freeze([
      Object.freeze({
        id: "mcp-endpoint",
        what: "Buffer's own MCP endpoint and the header it takes",
        url: "https://developers.buffer.com/guides/integrations/mcp.html",
        anchor: "Configure Your MCP Client",
        expected: "https://mcp.buffer.com/mcp",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "create-post-networks",
        what: "Which networks one scheduled post can go to",
        url: "https://developers.buffer.com/guides/integrations/mcp.html",
        anchor: "Schedules or publishes a post on one channel",
        expected: "Instagram, Facebook, Twitter, LinkedIn, Pinterest, YouTube, Google Business, Mastodon, TikTok, Threads, Bluesky and Start Page",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "notification-scheduling",
        what: "The reminder mode that hands a post to a person instead of publishing it",
        url: "https://developers.buffer.com/guides/integrations/mcp.html",
        anchor: "schedulingType",
        expected: "notification to send you a reminder to post manually",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "free-plan-quota",
        what: "What the free plan allows in a rolling 15 minutes and 30 days",
        url: "https://developers.buffer.com/guides/api-limits.html",
        anchor: "Buffer API Rate Limits",
        expected: "3,000",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-09",
      proof: "endpoint-answered",
      how: "POSTed an MCP initialize to https://mcp.buffer.com/mcp from inside grok-bot-local-vm with an invented bearer: HTTP 401 {\"error\":\"Unauthorized: Invalid or expired token\"} in 0.33 s. The endpoint is live and reads the Authorization header; we hold no Buffer account of our own to list tools with.",
    }),
  }),
  Object.freeze({
    id: "browserbase",
    name: "Browserbase",
    tagline: "A cloud browser the agent can drive, with a live view a person can take over",
    description:
      "CLOUD-BROWSER-1's second engine. The same four browsing tools the agent already has, pointed at a browser running in Browserbase instead of the one in this box — which is what gets past a sign-up page that refuses the box's address, and what lets a person take the wheel for a code or an identity check without starting again. There is no server to install: the key is read by the host itself and reaches no process the agent can see.",
    category: "Web & Search",
    featured: false,
    icon: Object.freeze({ letter: "BB", color: "#f97316" }),
    source: Object.freeze({ label: "docs.browserbase.com", url: "https://docs.browserbase.com" }),
    keywords: Object.freeze(["browser", "cloud browser", "proxy", "residential", "live view", "signup", "captcha", "session"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "BROWSERBASE_API_KEY",
        label: "Browserbase API key",
        hint: "A key from the Browserbase dashboard under Settings. It is read only by the host process, out of its own 0600 store, and is put into no connector, no request from this page and no environment the agent's shell can read. Without a paid plan this is a cloud Chrome with NO residential proxy and a session that ends after 15 minutes, which is not the thing that gets past a sign-up page.",
        consumers: Object.freeze([
          Object.freeze({ kind: "cloud-browser", engine: "browserbase" }),
        ]),
      }),
      Object.freeze({
        field: "BROWSERBASE_PROJECT_ID",
        label: "Browserbase project id",
        hint: "The project id from the same Settings page. It is not a secret and it is kept beside the key anyway, because a key without it opens no session at all and two places to look is two places to forget. Until both are here this engine is not offered to the workspace.",
        consumers: Object.freeze([
          Object.freeze({ kind: "cloud-browser", engine: "browserbase" }),
        ]),
      }),
    ]),
    firstSteps: Object.freeze([
      "Make an account at browserbase.com and copy the API key and the project id from Settings.",
      "Check the plan before you rely on it. Residential proxies and sessions longer than 15 minutes are paid features, and the free plan's cloud Chrome comes from a datacentre address that the sites this exists for already refuse.",
      "Paste the key in the box on this page. It is stored on the host and read by the host; nothing hands it to the agent, to a connector or to the box's shell.",
      "Pick where the cloud engine is used in the workspace's browser settings. Every cloud session is metered and appears in the operator's ledger with the workspace named.",
    ]),
    recheckDays: 30,
    docs: Object.freeze([
      Object.freeze({
        id: "session-auth",
        what: "How a session is created and which header carries the key",
        url: "https://docs.browserbase.com/reference/api/create-a-session",
        anchor: "POST",
        expected: "X-BB-API-Key",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "built-in-proxies",
        what: "That the built-in proxies are residential and off unless asked for",
        url: "https://docs.browserbase.com/features/proxies",
        finalUrl: "https://docs.browserbase.com/platform/identity/proxies",
        anchor: "Built-in proxies",
        expected: "By default, `proxies` is set to false",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
      Object.freeze({
        id: "live-view-handover",
        what: "That a person can take a running session over to finish a login",
        url: "https://docs.browserbase.com/guides/authentication",
        finalUrl: "https://docs.browserbase.com/platform/identity/authentication",
        anchor: "Use the session live view to log in",
        expected: "Session Live View",
        checkedOn: "2026-09-09",
        state: "verified",
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-09",
      proof: "endpoint-answered",
      how: "POST https://api.browserbase.com/v1/sessions from inside grok-bot-local-vm with an invented key in X-BB-API-Key: HTTP 401 {\"statusCode\":401,\"error\":\"Unauthorized\"} in 0.33 s. The endpoint is live and reads that header; a session was deliberately not started, so nothing was billed.",
    }),
  }),
  Object.freeze({
    id: "localfiles",
    name: "Filesystem",
    tagline: "Read and write files in the box's workspace",
    description:
      "The reference filesystem server, scoped to /workspace inside the box. It needs no credential at all — the box's own filesystem is the whole permission model — so its card has nothing to fill in and it reads Working as soon as it connects.",
    category: "Documents & Files",
    featured: false,
    icon: Object.freeze({ letter: "F", color: "#7c5cff", file: "marketplace/logos/localfiles.svg" }),
    source: Object.freeze({
      label: "modelcontextprotocol/servers · filesystem",
      url: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    }),
    connectorName: "localfiles",
    install: Object.freeze({
      connector: Object.freeze({
        transport: "stdio",
        command: "npx",
        args: Object.freeze(["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/workspace"]),
        env: Object.freeze({}),
      }),
    }),
    keywords: Object.freeze(["files", "folder", "workspace", "read", "write", "disk", "documents"]),
    credentials: Object.freeze([]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "tools-listed",
      how: "Spawned `npx -y @modelcontextprotocol/server-filesystem@2026.8.31 /workspace` inside grok-bot-local-vm: 14 tools listed in 3.1 s. The version is pinned to the dated release that resolved on that day; this package ships a rolling date version and an unpinned entry is a different program every few weeks.",
    }),
  }),
  Object.freeze({
    id: "coderabbit",
    name: "CodeRabbit CLI",
    tagline: "Run an AI code review from the box's shell",
    description:
      "There is no CodeRabbit MCP server: the official product is an MCP client, and the community servers are unmaintained or read GitHub comments rather than run reviews. The integration is the official CLI with an Agentic API key in the agent's shell environment, installed into the box and run as `cr review --agent`.",
    category: "Code review",
    featured: true,
    icon: Object.freeze({ letter: "C", color: "#e05d38", file: "marketplace/logos/coderabbit.svg" }),
    source: Object.freeze({ label: "docs.coderabbit.ai/cli", url: "https://docs.coderabbit.ai/cli/index.md" }),
    install: Object.freeze({ shellTool: "coderabbit" }),
    keywords: Object.freeze(["review", "code review", "pull request", "lint", "quality", "diff"]),
    credentials: Object.freeze([
      Object.freeze({
        field: "CODERABBIT_API_KEY",
        label: "CodeRabbit Agentic API key",
        hint: "An Agentic API key from app.coderabbit.ai/settings/api-keys (app.eu.coderabbit.ai for EU accounts). User and workspace keys are a different product and the CLI refuses them; the key is org-bound and that org is billed for CLI reviews.",
        consumers: Object.freeze([Object.freeze({ kind: "shell", env: "CODERABBIT_API_KEY" })]),
      }),
    ]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "vendor-installer",
      how: "There is no endpoint to call: this row installs a command-line tool. Its install command is CodeRabbit's own documented one from docs.coderabbit.ai/cli, re-read on this date, and the gate never runs it because it is a curl-to-shell on a shared box.",
    }),
  }),
  Object.freeze({
    id: "custom-mcp",
    name: "Add your own",
    tagline: "Connect any MCP server, from a link or a command",
    description:
      "Anything this page does not already carry. Two shapes, and you pick: a LINK, which is an address the box talks to and a key if it needs one; or a PROGRAM, which is a command the box runs. Either way a key you type goes into the same protected store as every card here — never into the connector list, never into a chat. Servers that require signing in through a browser are the one thing this cannot take, because the sign-in would have to happen inside the box.",
    category: "Development",
    featured: false,
    icon: Object.freeze({ letter: "+", color: "#475569" }),
    source: Object.freeze({ label: "modelcontextprotocol.io", url: "https://modelcontextprotocol.io/docs/concepts/transports" }),
    opensEditor: true,
    keywords: Object.freeze(["custom", "own", "byo", "add", "manual", "third party", "mcp server", "url", "command"]),
    credentials: Object.freeze([]),
    verification: Object.freeze({
      checkedOn: "2026-09-08",
      proof: "vendor-installer",
      how: "This row installs nothing of its own: it opens the editor. What it opens is proved by scripts/verify-marketplace.mjs, which adds a link server and a program server through it on grok-bot-local-vm.",
    }),
  }),
]);

const RESEARCH_DESK_SKILL = `---
name: web-research-pass
description: Run one research question to a sourced answer, with every claim carrying its link.
---
# One research pass

1. Restate the question in a sentence and say what an answer would have to contain. If that sentence needs a fact you do not have, ask for it before searching.
2. Search first, fetch second. Use the TinyFish search tool for the shape of the answer, then fetch the two or three pages that actually carry it. A search snippet is a pointer, never a citation.
3. Keep a note per source: the URL, the date on the page, and the one sentence you are taking from it.
4. Write the answer as prose with the links inline. Every number and every claim carries the source it came from.
5. Say plainly what you could not establish. A gap named is worth more than a confident guess, and never invent a URL.
`;

const PR_REVIEW_SKILL = `---
name: review-a-pull-request
description: Read a pull request, run the CLI review, and report what actually matters.
---
# Review a pull request

1. Read the PR through the GitHub connector: title, body, the changed files and the diff. Say what the change is meant to do in one sentence before you judge it.
2. Run the CodeRabbit CLI on the checkout: \`cr review --agent --api-key "$CODERABBIT_API_KEY"\`. It is the second opinion, not the verdict.
3. Merge the two passes. Drop anything the diff does not support, and keep only findings you can point at a line for.
4. Rank what is left: correctness first, then data loss or security, then everything else. Say which findings are blocking and which are not.
5. Report as prose the author can act on. No praise, no restating the diff, and no finding without a file and a line.
`;

const OPS_WATCHER_SKILL = `---
name: channel-sweep
description: Sweep a Slack channel for what changed and report only what is new.
---
# Sweep a channel

1. Read the channel since the last sweep. If you do not know when that was, read the last few hours and say so.
2. Sort what you find: incidents, decisions, questions still unanswered, noise. Noise is dropped, not summarized.
3. For anything that looks like an incident, quote the message that says so and name who is on it.
4. Report only what is new since the last sweep. A sweep with nothing new ends the turn quietly rather than sending an empty update.
5. Never post into the channel unless you were asked to. Reading and reporting is the whole job.
`;

const ISSUE_TRIAGE_SKILL = `---
name: triage-the-inbox
description: Read new Linear issues, group them, and propose a priority with a reason.
---
# Triage the issue inbox

1. Read the unassigned or untriaged issues through the Linear connector. Read the whole description, not the title.
2. Group them: duplicates together, then bugs, then requests, then anything that is actually a question.
3. For each one propose a priority and give the reason in one line: who it affects and what it blocks.
4. Name the duplicates explicitly, with both issue ids, instead of quietly picking one.
5. Propose. Do not change an issue's state or assignee unless you were asked to in this conversation.
`;

const INBOX_TRIAGE_SKILL = `---
name: morning-inbox
description: Read the inbox, separate what needs a person from what does not, and draft the replies.
---
# Morning inbox

1. Read the unread mail through the Google Workspace connector. Skip anything automated unless it reports a failure.
2. Split it three ways: needs a decision from the user, can be answered with a draft, can be ignored.
3. For the second pile, write a draft reply per thread. Match the register of the thread you are answering — read a couple of earlier messages in it before drafting.
4. Never send. Leave drafts and report the list, so the user reviews before anything leaves.
5. Lead the report with the decisions the user has to make, each restated in full so it can be answered without opening the thread.
`;

const COURSE_NOTES_SKILL = `---
name: take-course-notes
description: Turn a lecture, video or reading into notes and a review sheet on disk.
---
# Take notes on one session

1. Ask what the session is and where the material lives before you start. Read it from the workspace through the Filesystem connector.
2. Write the notes in the session's own order, in the speaker's own vocabulary. Notes that reorganize the material lose the thread the lecture actually followed.
3. Mark every definition and every claim you would be tested on. Mark separately anything you did not follow — those are the questions to ask.
4. Save two files under the course folder: the notes, and a short review sheet of questions with their answers.
5. Say what the session did not cover that the syllabus said it would. A gap found now is a gap the user can ask about while it is still cheap.
`;

const DECLARED_BOTS: readonly MarketplaceBot[] = Object.freeze([
  Object.freeze({
    id: "research-desk",
    name: "Research desk",
    creator: "Titanbot team",
    category: "Featured",
    featured: true,
    tile: Object.freeze({ color: "#0f766e", shape: "circle", file: "marketplace/logos/bot-research-desk.png" }),
    description: "Answers a research question with sources, using TinyFish search and page fetch.",
    instructions:
      "You are a research desk. You answer questions by reading the web, and every claim you make carries the link it came from.\n\nSearch first to find the shape of the answer, then fetch the pages that actually carry it: a search snippet is a pointer, never a citation. Prefer a primary source over a summary of one, and say the date of anything that could have changed.\n\nWrite in plain prose with the links inline. Say plainly what you could not establish rather than filling the gap — a named gap is worth more than a confident guess, and you never invent a URL, a number or a date.",
    skills: Object.freeze([
      Object.freeze({
        name: "web-research-pass",
        description: "Run one research question to a sourced answer, with every claim carrying its link.",
        body: RESEARCH_DESK_SKILL,
      }),
    ]),
    integrations: Object.freeze(["tinyfish"]),
  }),
  Object.freeze({
    id: "pr-review-desk",
    name: "PR review desk",
    creator: "Titanbot team",
    category: "Engineering",
    featured: true,
    tile: Object.freeze({ color: "#2d333b", shape: "square", file: "marketplace/logos/bot-pr-review-desk.png" }),
    description: "Reads a pull request on GitHub, runs the CodeRabbit CLI, and reports what matters.",
    instructions:
      "You review pull requests. You read the diff through the GitHub connector and you run the CodeRabbit CLI on the checkout, and then you decide — the CLI is a second opinion, not a verdict.\n\nSay what the change is meant to do before you judge it. Keep only findings you can point at a file and a line for, rank them correctness first, and mark plainly which are blocking.\n\nYou do not praise, you do not restate the diff, and you never approve or merge anything. The report goes to the author; the decision stays with them.",
    skills: Object.freeze([
      Object.freeze({
        name: "review-a-pull-request",
        description: "Read a pull request, run the CLI review, and report what actually matters.",
        body: PR_REVIEW_SKILL,
      }),
    ]),
    integrations: Object.freeze(["github", "coderabbit"]),
  }),
  Object.freeze({
    id: "ops-watcher",
    name: "Ops watcher",
    creator: "Titanbot team",
    category: "Operations",
    featured: true,
    tile: Object.freeze({ color: "#4a154b", shape: "circle", file: "marketplace/logos/bot-ops-watcher.png" }),
    description: "Sweeps a Slack channel and reports incidents, decisions and open questions.",
    instructions:
      "You watch a Slack channel and report what changed. You read; you do not post into the channel unless you were asked to.\n\nSort what you find into incidents, decisions, and questions still unanswered. Everything else is noise and is dropped rather than summarized. Quote the message that says an incident is happening, and name who is on it.\n\nReport only what is new since your last sweep. When nothing is new, end the turn quietly instead of sending an empty update.",
    skills: Object.freeze([
      Object.freeze({
        name: "channel-sweep",
        description: "Sweep a Slack channel for what changed and report only what is new.",
        body: OPS_WATCHER_SKILL,
      }),
    ]),
    integrations: Object.freeze(["slack"]),
  }),
  Object.freeze({
    id: "issue-triage",
    name: "Issue triage",
    creator: "Titanbot team",
    category: "Engineering",
    featured: false,
    tile: Object.freeze({ color: "#5e6ad2", shape: "square", file: "marketplace/logos/bot-issue-triage.png" }),
    description: "Reads new Linear issues, groups the duplicates, and proposes a priority with a reason.",
    instructions:
      "You triage an issue tracker. You read new Linear issues in full — the description, not the title — and you propose.\n\nGroup duplicates and name both issue ids rather than quietly picking one. For every issue give a priority and the reason in one line: who it affects and what it blocks.\n\nYou propose; you do not change an issue's state, priority or assignee unless the user asked you to in this conversation.",
    skills: Object.freeze([
      Object.freeze({
        name: "triage-the-inbox",
        description: "Read new Linear issues, group them, and propose a priority with a reason.",
        body: ISSUE_TRIAGE_SKILL,
      }),
    ]),
    integrations: Object.freeze(["linear"]),
  }),
  Object.freeze({
    id: "inbox-triage",
    name: "Inbox triage",
    creator: "Titanbot team",
    category: "Personal",
    featured: false,
    tile: Object.freeze({ color: "#1a73e8", shape: "circle", file: "marketplace/logos/bot-inbox-triage.png" }),
    description: "Reads the morning mail, drafts the easy replies, and surfaces the decisions.",
    instructions:
      "You triage a mail inbox through the Google Workspace connector. You read, you draft, and you never send.\n\nSplit the unread mail three ways: needs a decision from the user, can be answered with a draft, can be ignored. Write a draft for the middle pile and match the register of the thread you are answering — read a couple of earlier messages in it first.\n\nLead your report with the decisions, each one restated in full so it can be answered without opening the thread.",
    skills: Object.freeze([
      Object.freeze({
        name: "morning-inbox",
        description: "Read the inbox, separate what needs a person from what does not, and draft the replies.",
        body: INBOX_TRIAGE_SKILL,
      }),
    ]),
    integrations: Object.freeze(["google"]),
  }),
  Object.freeze({
    id: "course-note-taker",
    name: "Course note-taker",
    creator: "Titanbot team",
    category: "Personal",
    featured: false,
    tile: Object.freeze({ color: "#7c5cff", shape: "square", file: "marketplace/logos/bot-course-note-taker.png" }),
    description: "Turns a lecture, video or reading into notes and a review sheet in the workspace.",
    instructions:
      "You take notes on a course. You read the material out of the workspace through the Filesystem connector and you write the notes back there.\n\nKeep the session's own order and the speaker's own vocabulary: notes that reorganize the material lose the thread the lecture followed. Mark every definition and every testable claim, and mark separately anything you did not follow — those are the questions to ask next.\n\nEnd every session with two files: the notes, and a short review sheet of questions and answers. Say what the session did not cover that it was supposed to.",
    skills: Object.freeze([
      Object.freeze({
        name: "take-course-notes",
        description: "Turn a lecture, video or reading into notes and a review sheet on disk.",
        body: COURSE_NOTES_SKILL,
      }),
    ]),
    integrations: Object.freeze(["localfiles"]),
  }),
  ...MARKETING_TEAM_BOTS,
]);

/**
 * BOTS-1. The Memories block, for the rows that predate it.
 *
 * The six first-party templates and the Marketing pack each carry ONE paragraph of operating rules,
 * and it has always lived in `instructions`. Rather than edit seven rows across two files that
 * other waves are inside, the block is DERIVED: a row that declares no memories gets one, its
 * instructions, so every bot page in the catalog shows the same four blocks. A row that declares
 * its own is left exactly as it is.
 *
 * The 500-character split is the same rule the generator applies, and it is here rather than in
 * two places because it is a property of the host's memory store, not of where a row came from.
 */
const MEMORY_FACT_LIMIT = 500;

/** One paragraph as facts that each fit the store's cap, cut at sentence ends. */
export function marketplaceMemoryFacts(paragraph: string): readonly string[] {
  const text = paragraph.replace(/\s+/g, " ").trim();
  if (text.length <= MEMORY_FACT_LIMIT) return text.length === 0 ? [] : [text];
  const facts: string[] = [];
  let current = "";
  const flush = (): void => { if (current.length > 0) { facts.push(current); current = ""; } };
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    if (piece.length > MEMORY_FACT_LIMIT) {
      flush();
      let rest = piece;
      while (rest.length > MEMORY_FACT_LIMIT) {
        const cut = rest.lastIndexOf(" ", MEMORY_FACT_LIMIT);
        facts.push(rest.slice(0, cut > 0 ? cut : MEMORY_FACT_LIMIT).trim());
        rest = rest.slice(cut > 0 ? cut : MEMORY_FACT_LIMIT).trim();
      }
      current = rest;
      continue;
    }
    if (current.length === 0) current = piece;
    else if (current.length + 1 + piece.length <= MEMORY_FACT_LIMIT) current = `${current} ${piece}`;
    else { flush(); current = piece; }
  }
  flush();
  return facts;
}

const BOTS: readonly MarketplaceBot[] = Object.freeze([...DECLARED_BOTS, ...COMMUNITY_BOTS].map((bot) => {
  if (bot.memories != null) return bot;
  const facts = marketplaceMemoryFacts(bot.instructions);
  if (facts.length === 0) return bot;
  return Object.freeze({
    ...bot,
    // `text` keeps the paragraph breaks the persona was written with -- the page shows it as prose,
    // and flattening a three-paragraph persona into one line reads as a wall. `facts` is the
    // collapsed form, because that is what the memory store writes.
    memories: Object.freeze([Object.freeze({ text: bot.instructions.trim(), facts: Object.freeze(facts) })]),
  }) as MarketplaceBot;
}));

/**
 * `kind` and `credentialHints` were fields a row declared; they are now answers computed from what
 * it installs and what credentials it declares. They are attached here rather than left to each
 * caller because the alternative is a flag day: every reader of the catalog module -- the host, the
 * console, the verify scripts, four test suites -- would have to change in the same commit as the
 * row shape, across three waves editing the same tree. Derived and attached, the new shape is the
 * authority and the old vocabulary keeps answering.
 */
const PLUGINS: readonly MarketplacePlugin[] = Object.freeze(DECLARED_PLUGINS.map((plugin) => Object.freeze({
  ...plugin,
  kind: marketplacePluginKind(plugin),
  credentialHints: Object.freeze(marketplaceCredentialHints(plugin)),
  installsNothing: marketplaceInstallsNothing(plugin),
})));

export const MARKETPLACE_PLUGINS = PLUGINS;
export const MARKETPLACE_BOTS = BOTS;

export const MARKETPLACE_CATALOG: MarketplaceCatalog = Object.freeze({
  plugins: MARKETPLACE_PLUGINS,
  bots: MARKETPLACE_BOTS,
  categories: Object.freeze({
    plugins: MARKETPLACE_PLUGIN_CATEGORIES,
    bots: MARKETPLACE_BOT_CATEGORIES,
  }),
});

export function findMarketplacePlugin(id: unknown): MarketplacePlugin | undefined {
  return typeof id === "string" ? MARKETPLACE_PLUGINS.find((plugin) => plugin.id === id) : undefined;
}

export function findMarketplaceBot(id: unknown): MarketplaceBot | undefined {
  return typeof id === "string" ? MARKETPLACE_BOTS.find((bot) => bot.id === id) : undefined;
}

/**
 * What the wire calls this row. Derived rather than declared: a row that installs a connector is a
 * connector, and TinyFish -- which installs both -- is a connector with a CLI attached, because
 * that is the thing the console draws a connector card for.
 */
export function marketplacePluginKind(plugin: MarketplacePlugin): MarketplacePluginKind {
  return plugin.install?.connector != null ? "connector" : "shell-tool";
}

/**
 * MARKET-26. A row that puts nothing on the box and is not the editor.
 *
 * It is a question the type could not answer before this wave, because before it every row either
 * installed something or opened the editor. Meta, X and LinkedIn install nothing because there is
 * nothing honest to install, and the console has to know that to draw the page rather than an Add
 * button that would call a host command with no entry behind it.
 */
export function marketplaceInstallsNothing(plugin: MarketplacePlugin): boolean {
  return plugin.opensEditor !== true
    && plugin.install?.connector == null
    && (plugin.install?.shellTool == null || plugin.install.shellTool.length === 0);
}

/** The spec a row declares, before this box's opinion about how to run it. */
export function marketplaceConnectorSpec(plugin: MarketplacePlugin): ConnectorSpec | null {
  return plugin.install?.connector ?? null;
}

/**
 * The one filter both surfaces use: the console's search field and the agent's SearchPlugins.
 *
 * `keywords` is in the haystack on purpose. An owner does not type "Airtable", they type
 * "database" or "customers"; forcing those words into the tagline instead would make every card
 * read like a keyword stuffing, and it would break the four searches the tool suite pins.
 */
export function searchMarketplacePlugins(query: unknown): readonly MarketplacePlugin[] {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle.length === 0) return MARKETPLACE_PLUGINS;
  return MARKETPLACE_PLUGINS.filter((plugin) =>
    `${plugin.name} ${plugin.tagline} ${plugin.category} ${plugin.keywords.join(" ")}`.toLowerCase().includes(needle));
}

/**
 * PROXY-1 / PROXY-7. The proxy's MCP mount, when this box has one. `null` and an absent option are
 * the same thing and are the default everywhere: an operator install, the console's preset row,
 * the marketplace card and every existing caller pass nothing and get exactly the entry they got
 * before.
 */
export interface MarketplaceConnectorEntryOptions {
  readonly proxyMcpUrl?: string | null;
  /** How a remote spec is materialised. Defaults to the tree's own default. */
  readonly remoteMode?: RemoteConnectorMode;
}

/**
 * The tenant form of a remote connector: the far end moves to the proxy, which mounts several
 * services at one URL, and the box carries its own virtual key instead of the operator's.
 * `x-litellm-api-key` rather than `Authorization` because the bridge owns the Authorization header
 * for its own sign-in flow, and `x-mcp-servers` names which of the proxy's mounts this row is.
 */
function proxyConnectorSpec(spec: ConnectorSpec, server: string, proxyMcpUrl: string): ConnectorSpec {
  const field = connectorSpecCredentialFields(spec)[0];
  if (field == null) return spec;
  return {
    transport: "http",
    url: proxyMcpUrl,
    headers: { "x-litellm-api-key": `Bearer \${${field}}`, "x-mcp-servers": server },
    env: { [field]: "" },
  };
}

/**
 * The connectors.json entry of a plugin on this box today, or null for a shell-tool-only row and
 * for the editor card.
 *
 * Every word about bridges, version pins and transport flags lives in `connectorEntryFromSpec`.
 * What is added here is `MCP_REMOTE_CONFIG_DIR`: a bridge left alone writes its own state under
 * /root, which is not a volume, so a box recreate throws it away. It is configuration, not a
 * credential, which is why it is on MARKETPLACE_CONFIGURATION_ENV_KEYS and why it does not show up
 * as a field to fill.
 */
export function marketplaceConnectorEntry(
  plugin: MarketplacePlugin,
  options: MarketplaceConnectorEntryOptions = {},
): ConnectorEntry | null {
  const declared = marketplaceConnectorSpec(plugin);
  if (declared == null) return null;
  const proxyMcpUrl = options.proxyMcpUrl ?? null;
  const spec = proxyMcpUrl != null && proxyMcpUrl.length > 0 && plugin.proxyMcpServer != null
    ? proxyConnectorSpec(declared, plugin.proxyMcpServer, proxyMcpUrl)
    : declared;
  // PROXY-7's mount is inside the tenant's own docker network on plain http, and the host's writer
  // refuses exactly that address shape for a native remote -- rightly, because a private plain-http
  // endpoint is where a box's own control ports live. So a proxied row is still materialised as a
  // bridge, which is a program and not an address, and the rule does not apply to it. The leg is
  // not built and no box has a proxy mount configured, so nothing ships on this path today; it is
  // MARKET-11 to move it onto the native rung before it does, because a bridge puts the header on
  // the command line.
  const proxied = spec !== declared;
  const entry = connectorEntryFromSpec(spec, {
    remoteMode: options.remoteMode ?? (proxied ? "bridge-argv" : DEFAULT_REMOTE_CONNECTOR_MODE),
    ...(plugin.connectorName == null ? {} : { connectorName: plugin.connectorName }),
  });
  // A native remote entry is already what lands on the box: an address, its headers and the fields
  // those headers resolve against. Nothing to add, and nothing to drop -- this function returned
  // null on it while the bridge was the default, which quietly made every remote row uninstallable
  // the moment the default moved.
  if (!("command" in entry)) return entry;
  const bridged = isRemoteSpec(spec);
  return {
    command: entry.command,
    args: entry.args,
    env: bridged ? { ...BRIDGE_ENV, ...entry.env } : entry.env,
  };
}

/**
 * The same answer. Kept because callers written while `marketplaceConnectorEntry` could only speak
 * the command shape reach for this name to mean "whatever shape it really is", and that is now what
 * both of them mean.
 */
export function marketplaceConnectorEntryOrRemote(
  plugin: MarketplacePlugin,
  options: MarketplaceConnectorEntryOptions = {},
): ConnectorEntry | null {
  return marketplaceConnectorEntry(plugin, options);
}

/**
 * The command shape only: a row a four-field connector form can be filled from. A remote row has no
 * command to put in such a form, and answers null rather than a half-built one.
 */
export function marketplaceStdioConnectorEntry(
  plugin: MarketplacePlugin,
  options: MarketplaceConnectorEntryOptions = {},
): MarketplaceConnectorEntry | null {
  const entry = marketplaceConnectorEntry(plugin, options);
  return entry != null && "command" in entry ? entry : null;
}

/** The shell tool id of a plugin, or null when it installs no CLI. */
export function marketplaceShellToolId(plugin: MarketplacePlugin): string | null {
  return plugin.install?.shellTool ?? null;
}

/** Every credential field of a plugin: the name each stored value is written under. */
/**
 * A row's credential fields. `credentials` is the authority, but a row that speaks only the
 * pre-MARKET-6 vocabulary -- one carrying `credentialHints` and no declaration, which is what an
 * older cached catalog row and every hand-built fixture is -- still answers, because the two
 * vocabularies have to overlap for as long as anything holds a row from before the seam.
 */
export function marketplaceCredentialFields(plugin: MarketplacePlugin): readonly string[] {
  return plugin.credentials == null
    ? Object.keys(plugin.credentialHints ?? {})
    : plugin.credentials.map((credential) => credential.field);
}

/**
 * The old `credentialHints` map, derived. Kept because the plugin page, the agent's field list and
 * the console's preset row all still speak "a sentence per env name", and MARKET-5's fan-out is a
 * change to WHERE one value goes, not to what the operator is told about it.
 */
export function marketplaceCredentialHints(plugin: MarketplacePlugin): Record<string, string> {
  if (plugin.credentials == null) return { ...(plugin.credentialHints ?? {}) };
  const hints: Record<string, string> = {};
  for (const credential of plugin.credentials) hints[credential.field] = credential.hint;
  return hints;
}

/** The credential a stored field belongs to, so a write knows every consumer it has to reach. */
export function marketplaceCredential(plugin: MarketplacePlugin, field: unknown): MarketplaceCredential | null {
  return plugin.credentials?.find((credential) => credential.field === field) ?? null;
}

/**
 * One row in the shape the console and the verify scripts already read. `getMarketplaceItem`
 * answers with this, so a plugin fetched on its own is the row the list handed out rather than a
 * differently-shaped cousin of it.
 */
export function marketplacePluginWireView(
  plugin: MarketplacePlugin,
  options: MarketplaceConnectorEntryOptions = {},
): MarketplacePlugin {
  const entry = marketplaceConnectorEntry(plugin, options);
  return {
    ...plugin,
    kind: marketplacePluginKind(plugin),
    install: plugin.opensEditor === true ? null : entry ?? marketplaceShellToolId(plugin),
    credentialHints: marketplaceCredentialHints(plugin),
    shellToolId: marketplaceShellToolId(plugin),
    // MARKET-26. `docs`, `firstSteps`, `knownContradiction` and `recheckDays` ride along in the
    // spread above because they are plain data on the row. This one is derived, so it has to be
    // computed here as well or the console would have to work "there is nothing to install" out
    // for itself from a shape that says shell-tool.
    installsNothing: marketplaceInstallsNothing(plugin),
  } as MarketplacePlugin;
}

/**
 * The whole catalog in that shape.
 *
 * `listMarketplace` served this module verbatim, so the row shape WAS the wire shape and changing
 * one changed the other. This is the seam: rows carry `install.connector` as a spec and
 * `credentials` as a list, and the wire keeps carrying `kind`, `install` and `credentialHints`
 * derived from them, so nothing in ui/machine-room or scripts/ has to change on the day the row
 * shape does. The new fields ride along beside the old ones rather than replacing them, because a
 * console that wants the fan-out needs `credentials` and a console that does not is unaffected.
 */
export function marketplaceCatalogWireView(
  catalog: MarketplaceCatalog = MARKETPLACE_CATALOG,
  options: MarketplaceConnectorEntryOptions = {},
): MarketplaceCatalog {
  return {
    plugins: catalog.plugins.map((plugin) => marketplacePluginWireView(plugin, options)),
    // The list's rows are CARDS (MarketplaceBotCard), not whole rows. The wire type still says
    // MarketplaceCatalog because every reader of this answer -- the host, the console, four verify
    // scripts -- would otherwise have to change in the same commit, and a card is a bot row with
    // five fields absent rather than a different thing.
    bots: catalog.bots.map(marketplaceBotCardView) as unknown as readonly MarketplaceBot[],
    categories: catalog.categories,
  };
}

/**
 * BOTS-1. What a bot looks like in the LIST, which is not what it looks like on its page.
 *
 * MEASURED on grok-bot-local-vm 2026-09-09, before this wave: the `listMarketplace` answer was
 * 110,564 bytes with 7 bots in it, and the console fetched it TWICE on one Marketplace open. With
 * 72 rows served whole -- 423 paragraphs of memories, each carried a second time as facts, plus 263
 * skill bodies -- it projects to roughly 460 KB, so nearly a megabyte per panel opening on a relay
 * that buffers each body whole, per tenant. That is not a page being slow, it is a list paying for
 * detail nobody is looking at.
 *
 * So the list carries a CARD: what the rows and chips are drawn from, plus a count per block so the
 * page can say "7 skills" before it fetches them. The five heavy fields -- instructions, memories,
 * skills, routines, apps -- come off, and `getMarketplaceItem` serves the whole row when a person
 * opens one. That command already exists, already works, and the console had never called it.
 *
 * `integrations` STAYS on the card: it is a short list of ids, the row's chips are drawn from it,
 * and the Bots tab has always filtered on it.
 */
export function marketplaceBotCardView(bot: MarketplaceBot): MarketplaceBotCard {
  const { instructions, memories, skills, routines, apps, members, ...card } = bot as MarketplaceBot & Record<string, unknown>;
  return {
    ...card,
    counts: {
      memories: memories?.length ?? 0,
      skills: skills?.length ?? 0,
      routines: routines?.length ?? 0,
      apps: apps?.length ?? 0,
    },
    // A pack's member list is what the pack row draws its "seven specialists" line from, so it stays
    // -- projected to the four fields that line needs, not the personas and skill bodies behind them.
    ...(Array.isArray(members) ? {
      members: (members as readonly MarketplaceBotMember[]).map((member) => ({
        id: member.id, role: member.role, summary: member.summary, reportsTo: member.reportsTo ?? null,
      })),
    } : {}),
  } as unknown as MarketplaceBotCard;
}

/**
 * A logo path is a file the relay serves out of `ui/machine-room/`, and nothing else. It must be
 * relative (the console fetches no image off the internet), it must live under the logos directory
 * so one NOTICE.md covers every image the catalog names, and it may not climb out of it.
 */
const LOGO_PREFIX = "marketplace/logos/";
export function marketplaceLogoProblem(where: string, file: unknown): string | null {
  if (file == null) return null;
  if (typeof file !== "string" || file.length === 0) return `${where} has a logo file that is not a path`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) || file.startsWith("//")) return `${where} has a logo URL ("${file}"); the console fetches no image, so it must be a file in this repo`;
  if (file.startsWith("/") || file.split("/").includes("..")) return `${where} has a logo path that leaves the console's own root ("${file}")`;
  if (!file.startsWith(LOGO_PREFIX)) return `${where} has a logo path outside ${LOGO_PREFIX} ("${file}")`;
  if (!/\.(svg|png)$/i.test(file)) return `${where} has a logo that is not an .svg or a .png ("${file}")`;
  return null;
}

/**
 * The four search tokens the plugin tools pin with `deepEqual`. A tagline that carries one of them
 * silently changes what SearchPlugins answers for a query nobody re-ran, so the catalog refuses it
 * and the words owners actually type go in `keywords` instead, which those searches do not read.
 */
const PINNED_SEARCH_TOKENS: readonly string[] = Object.freeze(["linear", "pull requests", "code review", "kubernetes"]);

/** Which row is allowed to answer each pinned search, because it is the row the token is about. */
const PINNED_SEARCH_OWNER: Readonly<Record<string, string>> = Object.freeze({
  linear: "linear",
  "pull requests": "github",
  "code review": "coderabbit",
});

/**
 * The catalog's own invariants, as a list of problems rather than a throw, so a test can print all
 * of them at once and the host can log rather than fail to start.
 */
export function validateMarketplaceCatalog(catalog: MarketplaceCatalog = MARKETPLACE_CATALOG): string[] {
  const problems: string[] = [];
  const pluginIds = new Set<string>();
  const connectorNames = new Map<string, string>();
  for (const plugin of catalog.plugins) {
    const where = `plugin "${plugin.id}"`;
    if (pluginIds.has(plugin.id)) problems.push(`duplicate plugin id "${plugin.id}"`);
    pluginIds.add(plugin.id);
    if (!catalog.categories.plugins.includes(plugin.category)) {
      problems.push(`${where} has category "${plugin.category}", which is not in the category list`);
    }
    if (plugin.tagline.length === 0 || plugin.tagline.includes("\n")) problems.push(`${where} has no one-line tagline`);
    const searchable = `${plugin.name} ${plugin.tagline} ${plugin.category}`.toLowerCase();
    for (const token of PINNED_SEARCH_TOKENS) {
      const owner = PINNED_SEARCH_OWNER[token];
      if (searchable.includes(token) && owner !== plugin.id) {
        problems.push(`${where} answers the pinned search "${token}", which belongs to ${owner == null ? "no plugin at all" : `"${owner}"`}; put the words owners type in keywords, which that search does not read`);
      }
    }
    if (plugin.keywords.length === 0) problems.push(`${where} carries no keywords, so an owner who does not know its name cannot find it`);
    const logoProblem = marketplaceLogoProblem(where, plugin.icon.file);
    if (logoProblem != null) problems.push(logoProblem);

    // -- verification: a stamp, and never "documented"
    const verification = plugin.verification;
    if (verification == null) {
      problems.push(`${where} carries no verification stamp; a row nobody ran does not reach a card`);
    } else {
      if (verification.proof === "documented") {
        problems.push(`${where} is verified only by reading the vendor's documentation; run it on a box and record what came back, or leave it out`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(verification.checkedOn)) {
        problems.push(`${where} has a verification date that is not a date ("${verification.checkedOn}")`);
      }
      if (verification.how.trim().length < 40) {
        problems.push(`${where} does not say what was actually done to verify it`);
      }
      if (verification.proof === "vendor-installer" && plugin.install?.connector != null) {
        problems.push(`${where} installs a connector, so its proof has to be that the connector ran, not that the vendor documents an installer`);
      }
    }

    // -- MARKET-26: the doc facts, which must never become the verification stamp
    //
    // The two dated facts are different in kind and the validator is where that stays true. A doc
    // read says the vendor still documents what this row assumes; it can never say the row works,
    // which is what `proof` means and why `documented` is refused above. A row is free to carry no
    // doc facts at all -- most do not -- but a Marketing row must carry one, because that whole
    // category exists for vendors whose requirements move between our releases.
    const docs = Array.isArray(plugin.docs) ? plugin.docs : [];
    const docIds = new Set<string>();
    for (const doc of docs) {
      const which = `${where} doc fact "${doc.id}"`;
      if (doc.id.trim().length === 0) problems.push(`${where} carries a doc fact with no id`);
      if (docIds.has(doc.id)) problems.push(`${where} declares the doc fact "${doc.id}" twice`);
      docIds.add(doc.id);
      if (doc.what.trim().length === 0) problems.push(`${which} does not say what it is`);
      if (!/^https:\/\/[^\s]+$/.test(doc.url)) {
        problems.push(`${which} names "${doc.url}", which is not an https source; a fact read over plain http is not evidence`);
      }
      if (doc.finalUrl != null && !/^https:\/\/[^\s]+$/.test(doc.finalUrl)) {
        problems.push(`${which} names a landing address that is not https ("${doc.finalUrl}")`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.checkedOn)) {
        problems.push(`${which} has a read date that is not a date ("${doc.checkedOn}")`);
      }
      if (doc.state === "not-published") {
        // The vendor's own statement that it does not publish this. It has nothing to fetch, so a
        // weekly run must not flip the row every week over the absence -- and an expected literal
        // beside it would mean somebody had written down a fact nobody can check.
        if (doc.expected.length > 0) {
          problems.push(`${which} is recorded as not published by the vendor and still names an expected value ("${doc.expected}")`);
        }
      } else {
        if (doc.expected.trim().length === 0) problems.push(`${which} names nothing the vendor's page has to keep saying`);
        if (doc.anchor.trim().length === 0) problems.push(`${which} names no anchor, so the differ would have to read the whole page`);
      }
    }
    if (plugin.category === "Marketing" && docs.length === 0) {
      problems.push(`${where} is a marketing row and carries no doc fact; those vendors move their requirements between our releases, so a row with no dated source goes stale in silence`);
    }
    if (plugin.recheckDays != null && !(Number.isInteger(plugin.recheckDays) && plugin.recheckDays > 0)) {
      problems.push(`${where} has a recheck interval that is not a whole number of days ("${String(plugin.recheckDays)}")`);
    }
    if (docs.length > 0 && plugin.recheckDays == null) {
      problems.push(`${where} carries doc facts and no recheckDays, so the plugin page has no age at which to say the row is under review`);
    }
    for (const step of plugin.firstSteps ?? []) {
      if (step.trim().length === 0) problems.push(`${where} has an empty first step`);
    }

    // -- what it installs
    const spec = marketplaceConnectorSpec(plugin);
    const shellTool = marketplaceShellToolId(plugin);
    if (plugin.install == null && plugin.opensEditor !== true) {
      // MARKET-26. A row may now install nothing -- Meta, X and LinkedIn have nothing honest to
      // install, and Browserbase's key is read by the host itself -- but only as a PAGE: it has to
      // tell the person what to do and name a dated source for it. Without both it is a dead card,
      // which is what this refusal has always been about.
      if (docs.length === 0 || (plugin.firstSteps ?? []).length === 0) {
        problems.push(`${where} installs nothing and does not open the editor; a row like that has to carry first steps and at least one dated doc fact, or it is a card that does nothing and says nothing`);
      }
    }
    if (plugin.install != null && spec == null && shellTool == null) {
      problems.push(`${where} has an install that names neither a connector nor a shell tool`);
    }
    if (spec != null) {
      if (plugin.connectorName == null || plugin.connectorName.length === 0) {
        problems.push(`${where} installs a connector and has no connectorName`);
      } else {
        const taken = connectorNames.get(plugin.connectorName);
        if (taken != null) problems.push(`${where} and "${taken}" both claim the connector name "${plugin.connectorName}"; one would silently overwrite the other`);
        connectorNames.set(plugin.connectorName, plugin.id);
      }
      problems.push(...connectorSpecProblems(where, spec, MARKETPLACE_CONFIGURATION_ENV_KEYS));
    } else if (plugin.connectorName != null) {
      problems.push(`${where} names a connector "${plugin.connectorName}" but declares no connector to run`);
    }

    // -- credentials: one home, every consumer real
    const declared = new Set<string>();
    for (const credential of plugin.credentials) {
      if (declared.has(credential.field)) problems.push(`${where} declares "${credential.field}" twice`);
      declared.add(credential.field);
      if (credential.hint.trim().length === 0) {
        problems.push(`${where} credential "${credential.field}" has no hint; a masked box with no sentence under it is the bug CONNECT-4 was about`);
      }
      if (credential.label.trim().length === 0) problems.push(`${where} credential "${credential.field}" has no label`);
      if (credential.consumers.length === 0) {
        problems.push(`${where} credential "${credential.field}" names no consumer, so a stored value would go nowhere`);
      }
      for (const consumer of credential.consumers) {
        if (consumer.kind === "connector") {
          if (spec == null) {
            problems.push(`${where} credential "${credential.field}" feeds a connector and the plugin installs none`);
          } else if (spec.env[consumer.env] !== "") {
            problems.push(`${where} credential "${credential.field}" feeds connector env "${consumer.env}", which the entry does not leave empty`);
          }
        } else if (consumer.kind === "header") {
          if (spec == null || !isRemoteSpec(spec)) {
            problems.push(`${where} credential "${credential.field}" feeds header "${consumer.name}" and the plugin has no endpoint to send it to`);
          } else {
            const value = spec.headers[consumer.name];
            if (value == null) {
              problems.push(`${where} credential "${credential.field}" feeds header "${consumer.name}", which the entry does not set`);
            } else if (headerPlaceholderField(value) !== credential.field) {
              problems.push(`${where} header "${consumer.name}" does not resolve against "${credential.field}"`);
            }
          }
        } else if (consumer.kind === "cloud-browser") {
          // CLOUD-BROWSER-1. The engine name is the whole of what this consumer says, and it has to
          // be a name -- the host resolves the store's section from it, so an empty one would put a
          // vendor key in a section called "".
          if (typeof consumer.engine !== "string" || consumer.engine.trim().length === 0) {
            problems.push(`${where} credential "${credential.field}" feeds the cloud browser and names no engine`);
          }
        } else if (shellTool == null) {
          problems.push(`${where} credential "${credential.field}" feeds the agent's shell and the plugin installs no shell tool`);
        }
      }
    }
    if (spec != null) {
      for (const field of connectorSpecCredentialFields(spec)) {
        if (!declared.has(field)) {
          problems.push(`${where} leaves env "${field}" empty, which the host reads as a credential field, and declares no credential for it`);
        }
      }
    }
  }

  const botIds = new Set<string>();
  for (const bot of catalog.bots) {
    const where = `bot "${bot.id}"`;
    if (botIds.has(bot.id)) problems.push(`duplicate bot id "${bot.id}"`);
    botIds.add(bot.id);
    if (!catalog.categories.bots.includes(bot.category)) {
      problems.push(`${where} has category "${bot.category}", which is not in the category list`);
    }
    for (const tag of bot.tags ?? []) {
      if (!catalog.categories.bots.includes(tag)) problems.push(`${where} carries the tag "${tag}", which is not in the category list, so its chip would filter to nothing`);
      if (tag === bot.category) problems.push(`${where} repeats its own category "${tag}" as a tag`);
    }
    const botLogoProblem = marketplaceLogoProblem(where, bot.tile.file);
    if (botLogoProblem != null) problems.push(botLogoProblem);

    // BOTS-1. These two rules are about a row WE WROTE. A first-party template with no skill or no
    // integration is a row somebody forgot to finish. A community row is a scrape: 15 of the 65 name
    // no skill and 16 name no plugin we carry, and they are still worth adding because their
    // memories are the whole substance of the bot. What a community row may NOT be is a row an
    // import could do nothing at all with, which is the rule immediately after this one.
    if (bot.origin !== "community") {
      if (bot.skills.length === 0) problems.push(`${where} has no skills`);
      if (bot.integrations.length === 0) problems.push(`${where} names no integrations`);
    } else if (bot.skills.length === 0 && (bot.memories?.length ?? 0) === 0 && (bot.routines?.length ?? 0) === 0) {
      problems.push(`${where} is a community row carrying no memory, no skill and no routine; adding it would create an empty agent`);
    }
    for (const integration of bot.integrations) {
      if (!pluginIds.has(integration)) problems.push(`${where} names integration "${integration}", which is not a plugin id`);
    }

    // BOTS-1. Every fact has to fit the store, or the host would write a version cut mid sentence.
    for (const [index, memory] of (bot.memories ?? []).entries()) {
      if (memory.text.trim().length === 0) problems.push(`${where} memory ${index} is empty`);
      if (memory.facts.length === 0) problems.push(`${where} memory ${index} carries no facts, so nothing would be seeded`);
      for (const fact of memory.facts) {
        const length = fact.replace(/\s+/g, " ").trim().length;
        if (length > MEMORY_FACT_LIMIT) {
          problems.push(`${where} has a fact of ${length} characters; the host caps one at ${MEMORY_FACT_LIMIT} and truncates silently, so the catalog splits rather than lets it be cut`);
        }
      }
    }

    // BOTS-1. A routine either carries a cron the host can actually resolve, or it carries null and
    // says why. The bare word "weekly" normalises, stores, and never runs.
    for (const routine of bot.routines ?? []) {
      if (routine.name.trim().length === 0) problems.push(`${where} has a routine with no name`);
      if (routine.scheduleNote.trim().length === 0) problems.push(`${where} routine "${routine.name}" says nothing about when it runs`);
      if (routine.schedule != null && routine.schedule.trim().split(/\s+/).length !== 5) {
        problems.push(`${where} routine "${routine.name}" has a schedule that is not a five-field cron ("${routine.schedule}")`);
      }
    }

    // BOTS-1. An app may name a plugin only if we really carry it, and its offer has to match what
    // that plugin does: a row that installs nothing gets an information line, never an Add.
    for (const app of bot.apps ?? []) {
      const at = `${where} app "${app.name}"`;
      if (app.label.trim().length === 0) problems.push(`${at} has no label a person could read`);
      if (app.plugin == null) {
        if (app.offer !== "byo") problems.push(`${at} offers "${app.offer}" and names no plugin; with nothing to install the only honest offer is add-your-own`);
      } else {
        const plugin = catalog.plugins.find((row) => row.id === app.plugin);
        if (plugin == null) problems.push(`${at} names the plugin "${app.plugin}", which is not in the catalog`);
        else if (plugin.installsNothing === true && app.offer !== "page") {
          problems.push(`${at} maps to "${app.plugin}", which installs nothing, and offers "${app.offer}"; that would draw an Add button with no install behind it`);
        } else if (plugin.installsNothing !== true && app.offer === "page") {
          problems.push(`${at} maps to "${app.plugin}", which does install something, and offers only a page`);
        } else if (!bot.integrations.includes(app.plugin)) {
          problems.push(`${at} names the plugin "${app.plugin}" and the row's integrations do not, so the chips and the Apps block would disagree`);
        }
      }
    }
  }
  return problems;
}
