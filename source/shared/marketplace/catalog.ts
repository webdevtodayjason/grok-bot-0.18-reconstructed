/**
 * The Marketplace catalog: the plugins this box can install and the bot templates it can import.
 *
 * ONE catalog, in the repo, bundled into the host. The console never reads a static JSON: it asks
 * the gateway (`listMarketplace`, `getMarketplaceItem`), which serves exactly this module. That is
 * what makes the agent's SearchPlugins and the operator's Marketplace panel the same catalog
 * rather than two lists that drift.
 *
 * A PLUGIN is one installable thing. `kind: "connector"` means an entry in
 * `/home/box/sand-data/connectors.json` -- `{command, args, env}`, the shape CONNECT-3 fixed, with
 * every credential env value left as the EMPTY STRING so the host's credential rule (CONNECT-4)
 * recognises it and the console draws a card for it. `kind: "shell-tool"` means a CLI the agent
 * runs from its own shell, installed through `installShellTool`; `install` is then the shell tool's
 * id in source/host/extensions/shell-tools/shell-tool-catalog.ts.
 *
 * The connector entries here are the same objects the console's preset row offers
 * (ui/machine-room/gateway-adapter.js, CONNECTOR_PRESETS), which are in turn section 2 of that
 * service's report under docs/connectors/ character for character. Three copies of one fact would
 * drift, so tests/marketplace-catalog.test.mjs holds this file against the preset array and
 * tests/connector-preset-catalog.test.mjs holds the preset array against the reports. Editing any
 * one of the three alone fails the suite.
 *
 * NOTHING in this file is a credential. Every `env` value is the empty string, every hint says
 * where a key is minted and what the least permission is, and no value is ever stored here.
 */

export type MarketplacePluginKind = "connector" | "shell-tool";

/** No external images: a letter on a colour is the whole icon, drawn by the console. */
export interface MarketplaceIcon {
  readonly letter: string;
  readonly color: string;
}

/** The connectors.json entry, exactly as it lands on the box. */
export interface MarketplaceConnectorEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
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
  readonly kind: MarketplacePluginKind;
  /**
   * A connector's entry, or a shell tool's id. `null` is the one exception in the seed: the
   * "Custom MCP server" card has no entry of its own -- it opens the connector editor the console
   * already has, which is what `opensEditor` says.
   */
  readonly install: MarketplaceConnectorEntry | string | null;
  /** The connector name this entry takes in connectors.json. Absent for a shell tool. */
  readonly connectorName?: string;
  /** One line per credential field, keyed by the env name the operator must fill. */
  readonly credentialHints: Readonly<Record<string, string>>;
  /** True only for the Custom MCP server card, which opens the existing connector editor. */
  readonly opensEditor?: boolean;
}

export interface MarketplaceBotSkill {
  readonly name: string;
  readonly description: string;
  /** A SKILL.md, imported for the agent through importAgentWorkflowText. */
  readonly body: string;
}

export interface MarketplaceBot {
  readonly id: string;
  readonly name: string;
  readonly creator: string;
  readonly category: string;
  readonly featured: boolean;
  readonly tile: { readonly color: string; readonly shape: string };
  readonly description: string;
  /** The persona the imported agent runs with. */
  readonly instructions: string;
  readonly skills: readonly MarketplaceBotSkill[];
  /** Plugin ids from MARKETPLACE_PLUGINS. The bot page offers Add for the missing ones. */
  readonly integrations: readonly string[];
}

export interface MarketplaceCatalog {
  readonly plugins: readonly MarketplacePlugin[];
  readonly bots: readonly MarketplaceBot[];
  readonly categories: {
    readonly plugins: readonly string[];
    readonly bots: readonly string[];
  };
}

export const MARKETPLACE_PLUGIN_CATEGORIES: readonly string[] = Object.freeze([
  "Featured",
  "Development",
  "Communication",
  "Project management",
  "Documents & Files",
  "Web & Search",
  "Code review",
  "Shell tools",
]);

export const MARKETPLACE_BOT_CATEGORIES: readonly string[] = Object.freeze([
  "Featured",
  "From Titanbot team",
  "Engineering",
  "Operations",
  "Sales",
  "Personal",
]);

/**
 * Configuration env keys a catalog entry is allowed to give a non-empty value. A key NOT on this
 * list must be left empty, because an empty value is precisely how the host recognises a
 * credential field (CONNECT-4) -- and a credential with a value baked into the catalog would be a
 * secret in the repo. The list is empty today and the test asserts the rule either way.
 */
export const MARKETPLACE_CONFIGURATION_ENV_KEYS: readonly string[] = Object.freeze([]);

const PLUGINS: readonly MarketplacePlugin[] = Object.freeze([
  Object.freeze({
    id: "github",
    name: "GitHub",
    tagline: "Read repositories, issues and pull requests",
    description:
      "GitHub's own hosted MCP server, bridged into this box's stdio interface by mcp-remote and authorized with a fine-grained personal access token. The entry filters the server down to repository, issue and pull-request reads plus the identity tool, and sets X-MCP-Readonly, so nothing it exposes can write to a repository.",
    category: "Development",
    featured: true,
    icon: Object.freeze({ letter: "G", color: "#2d333b" }),
    source: Object.freeze({ label: "github/github-mcp-server", url: "https://github.com/github/github-mcp-server" }),
    kind: "connector",
    connectorName: "github",
    install: Object.freeze({
      command: "npx",
      args: Object.freeze([
        "-y",
        "mcp-remote@0.8.3",
        "https://api.githubcopilot.com/mcp/",
        "--transport",
        "http-only",
        "--header",
        "Authorization:Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}",
        "--header",
        "X-MCP-Toolsets:repos,issues,pull_requests",
        "--header",
        "X-MCP-Tools:get_me",
        "--header",
        "X-MCP-Readonly:true",
      ]),
      env: Object.freeze({ GITHUB_PERSONAL_ACCESS_TOKEN: "" }),
    }),
    credentialHints: Object.freeze({
      GITHUB_PERSONAL_ACCESS_TOKEN:
        "A GitHub fine-grained personal access token. Create one under Settings → Developer settings → Personal access tokens → Fine-grained tokens (github.com/settings/personal-access-tokens/new); the least this entry needs is Contents: read, Issues: read and Pull requests: read, plus the Metadata: read it includes automatically.",
    }),
  }),
  Object.freeze({
    id: "slack",
    name: "Slack",
    tagline: "Read channels, threads and search as yourself",
    description:
      "A maintained stdio Slack server that takes a user OAuth token from the environment, so it acts as the installing user and search works. Posting stays off: that is the server's own default, not a header this entry sets. This is not the Slack chat listener — the listener binds inbound events to an agent, this connector is outbound tools inside the box.",
    category: "Communication",
    featured: true,
    icon: Object.freeze({ letter: "S", color: "#4a154b" }),
    source: Object.freeze({ label: "korotovsky/slack-mcp-server", url: "https://github.com/korotovsky/slack-mcp-server" }),
    kind: "connector",
    connectorName: "slack",
    install: Object.freeze({
      command: "npx",
      args: Object.freeze(["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"]),
      env: Object.freeze({ SLACK_MCP_XOXP_TOKEN: "" }),
    }),
    credentialHints: Object.freeze({
      SLACK_MCP_XOXP_TOKEN:
        "A Slack user OAuth token (xoxp-), acting as the installing user. Create the app at api.slack.com/apps, add User Token Scopes, Install to Workspace and copy the User OAuth Token; channels:read alone lists public channels, and reading plus search also wants channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history, users:read and search:read.",
    }),
  }),
  Object.freeze({
    id: "linear",
    name: "Linear",
    tagline: "Read issues, projects and cycles",
    description:
      "Linear's hosted Streamable HTTP endpoint, bridged by mcp-remote with a personal API key as the bearer. The header matters: without it mcp-remote falls through to a browser OAuth flow, and this box has no browser that can finish one. A read-only key is what Linear's own MCP guidance recommends.",
    category: "Project management",
    featured: true,
    icon: Object.freeze({ letter: "L", color: "#5e6ad2" }),
    source: Object.freeze({ label: "linear.app/docs/mcp", url: "https://linear.app/docs/mcp" }),
    kind: "connector",
    connectorName: "linear",
    install: Object.freeze({
      command: "npx",
      args: Object.freeze([
        "-y",
        "mcp-remote@0.8.3",
        "https://mcp.linear.app/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:Bearer ${LINEAR_API_KEY}",
      ]),
      env: Object.freeze({ LINEAR_API_KEY: "" }),
    }),
    credentialHints: Object.freeze({
      LINEAR_API_KEY:
        "A Linear personal API key. Create one under Settings → Account → Security & Access → Personal API keys (linear.app/settings/account/security) and copy it once; Read is the only permission the read tools need, and Linear's own MCP FAQ recommends a Read-only key.",
    }),
  }),
  Object.freeze({
    id: "google",
    name: "Google Workspace",
    tagline: "Gmail, Docs and Drive through one stdio server",
    description:
      "One stdio process covering Gmail and Docs. It mints access tokens at runtime from an OAuth client pair plus a refresh token, so consent is done once in Google's OAuth Playground and nothing afterwards needs a browser inside the box. Three credential fields, not one.",
    category: "Documents & Files",
    featured: false,
    icon: Object.freeze({ letter: "W", color: "#1a73e8" }),
    source: Object.freeze({ label: "EveryInc/google-workspace-mcp-server", url: "https://github.com/EveryInc/google-workspace-mcp-server" }),
    kind: "connector",
    connectorName: "google",
    install: Object.freeze({
      command: "npx",
      args: Object.freeze(["-y", "google-workspace-mcp-server@1.4.3"]),
      env: Object.freeze({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_REFRESH_TOKEN: "" }),
    }),
    credentialHints: Object.freeze({
      GOOGLE_CLIENT_ID:
        "The client ID of an OAuth Web application client. Create it in Google Cloud under APIs & Services → Credentials with https://developers.google.com/oauthplayground as an authorized redirect URI, on a project with the Gmail, Google Docs and Google Drive APIs enabled.",
      GOOGLE_CLIENT_SECRET:
        "The secret shown beside that same OAuth client under APIs & Services → Credentials. It is half of the client pair, not a scope of its own, and it is what the Playground is given to mint the refresh token.",
      GOOGLE_REFRESH_TOKEN:
        "The refresh token from the OAuth 2.0 Playground exchange (gear → Use your own OAuth credentials → Authorize APIs → Exchange authorization code for tokens), not the access token; authorize gmail.readonly for Gmail reads, gmail.compose for drafts, documents for Docs read and write, and drive.file plus drive.readonly for the Docs file IDs.",
    }),
  }),
  Object.freeze({
    id: "tinyfish",
    name: "TinyFish",
    tagline: "Web search, page fetch and browser automation",
    description:
      "TinyFish's hosted MCP endpoint, bridged by mcp-remote with the API key carried as an Authorization bearer — X-API-Key is the REST-side name and this endpoint refuses it. mcp-remote expands ${TINYFISH_API_KEY} from its own environment at start, so the literal ${...} text is what lands in connectors.json and the key stays in the host's store.",
    category: "Web & Search",
    featured: true,
    icon: Object.freeze({ letter: "T", color: "#0f766e" }),
    source: Object.freeze({ label: "agent.tinyfish.ai/mcp", url: "https://agent.tinyfish.ai/mcp" }),
    kind: "connector",
    connectorName: "tinyfish",
    install: Object.freeze({
      command: "npx",
      args: Object.freeze([
        "-y",
        "mcp-remote",
        "https://agent.tinyfish.ai/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:Bearer ${TINYFISH_API_KEY}",
      ]),
      env: Object.freeze({ TINYFISH_API_KEY: "" }),
    }),
    credentialHints: Object.freeze({
      TINYFISH_API_KEY:
        "Your TinyFish account's API key, carried to https://agent.tinyfish.ai/mcp as an Authorization bearer — X-API-Key is the REST-side name and this endpoint refuses it. The key is account-wide; it carries no separate scopes.",
    }),
  }),
  Object.freeze({
    id: "localfiles",
    name: "Filesystem",
    tagline: "Read and write files in the box's workspace",
    description:
      "The reference filesystem MCP server, scoped to /workspace inside the box. It needs no credential at all — the box's own filesystem is the whole permission model — so its card has no Accounts row to fill and it reads Ready as soon as the server connects.",
    category: "Documents & Files",
    featured: false,
    icon: Object.freeze({ letter: "F", color: "#7c5cff" }),
    source: Object.freeze({
      label: "modelcontextprotocol/servers · filesystem",
      url: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    }),
    kind: "connector",
    connectorName: "localfiles",
    install: Object.freeze({
      command: "npx",
      args: Object.freeze(["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]),
      env: Object.freeze({}),
    }),
    credentialHints: Object.freeze({}),
  }),
  Object.freeze({
    id: "coderabbit",
    name: "CodeRabbit CLI",
    tagline: "Run an AI code review from the box's shell",
    description:
      "There is no CodeRabbit MCP server: the official product is an MCP client, and the community servers are unmaintained or read GitHub comments rather than run reviews. The integration is the official CLI with an Agentic API key in the agent's shell environment, installed into the box and run as `cr review --agent`.",
    category: "Code review",
    featured: true,
    icon: Object.freeze({ letter: "C", color: "#e05d38" }),
    source: Object.freeze({ label: "docs.coderabbit.ai/cli", url: "https://docs.coderabbit.ai/cli/index.md" }),
    kind: "shell-tool",
    install: "coderabbit",
    credentialHints: Object.freeze({
      CODERABBIT_API_KEY:
        "An Agentic API key from app.coderabbit.ai/settings/api-keys (app.eu.coderabbit.ai for EU accounts). User and workspace keys are a different product and the CLI refuses them; the key is org-bound and that org is billed for CLI reviews.",
    }),
  }),
  Object.freeze({
    id: "tinyfish-cli",
    name: "TinyFish CLI",
    tagline: "Drive TinyFish from the shell, with its published skill",
    description:
      "A pip package that reads TINYFISH_API_KEY out of the environment, with a published SKILL.md the host imports as an agent workflow so the agent learns the commands from their author. Its key lives in the shell section of the secret store, which is a different place from the tinyfish connector's process environment: storing one does not fill the other.",
    category: "Shell tools",
    featured: false,
    icon: Object.freeze({ letter: "T", color: "#155e75" }),
    source: Object.freeze({
      label: "webdevtodayjason/cli-anything-tinyfish",
      url: "https://github.com/webdevtodayjason/cli-anything-tinyfish",
    }),
    kind: "shell-tool",
    install: "tinyfish-cli",
    credentialHints: Object.freeze({
      TINYFISH_API_KEY:
        "The same TinyFish API key the tinyfish connector uses, stored for the agent's shell instead of the connector process. A key stored on the tinyfish connector card does not reach this CLI.",
    }),
  }),
  Object.freeze({
    id: "custom-mcp",
    name: "Custom MCP server",
    tagline: "Add any stdio MCP server by hand",
    description:
      "Anything the catalog does not carry. This opens the connector editor already in the console: a name, a command, its arguments and the environment variable NAMES the process needs. Names only — a value you leave empty becomes a credential field on the connector's card, where the host stores it instead of connectors.json.",
    category: "Development",
    featured: false,
    icon: Object.freeze({ letter: "+", color: "#475569" }),
    source: Object.freeze({ label: "docs/CONNECTORS.md", url: "https://modelcontextprotocol.io/docs/concepts/transports" }),
    kind: "connector",
    install: null,
    opensEditor: true,
    credentialHints: Object.freeze({}),
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

const BOTS: readonly MarketplaceBot[] = Object.freeze([
  Object.freeze({
    id: "research-desk",
    name: "Research desk",
    creator: "Titanbot team",
    category: "Featured",
    featured: true,
    tile: Object.freeze({ color: "#0f766e", shape: "circle" }),
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
    tile: Object.freeze({ color: "#2d333b", shape: "square" }),
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
    tile: Object.freeze({ color: "#4a154b", shape: "circle" }),
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
    tile: Object.freeze({ color: "#5e6ad2", shape: "square" }),
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
    tile: Object.freeze({ color: "#1a73e8", shape: "circle" }),
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
    tile: Object.freeze({ color: "#7c5cff", shape: "square" }),
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
]);

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
 * The one filter both surfaces use: the console's search field and the agent's SearchPlugins.
 * Name, tagline and category, case-insensitively, so "search" finds TinyFish through its tagline
 * and "code review" finds CodeRabbit through its category.
 */
export function searchMarketplacePlugins(query: unknown): readonly MarketplacePlugin[] {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle.length === 0) return MARKETPLACE_PLUGINS;
  return MARKETPLACE_PLUGINS.filter((plugin) =>
    `${plugin.name} ${plugin.tagline} ${plugin.category}`.toLowerCase().includes(needle));
}

/** The connector entry of a plugin, or null for a shell tool and for the editor card. */
export function marketplaceConnectorEntry(plugin: MarketplacePlugin): MarketplaceConnectorEntry | null {
  return plugin.kind === "connector" && plugin.install != null && typeof plugin.install !== "string"
    ? plugin.install
    : null;
}

/** The shell tool id of a plugin, or null when it is not a shell tool. */
export function marketplaceShellToolId(plugin: MarketplacePlugin): string | null {
  return plugin.kind === "shell-tool" && typeof plugin.install === "string" ? plugin.install : null;
}

/**
 * Every credential field of a plugin: for a connector, the env keys the entry leaves empty (the
 * host's own rule), and for a shell tool, the env names its hints declare.
 */
export function marketplaceCredentialFields(plugin: MarketplacePlugin): readonly string[] {
  const entry = marketplaceConnectorEntry(plugin);
  if (entry == null) return Object.keys(plugin.credentialHints);
  return Object.entries(entry.env).flatMap(([field, value]) => (value === "" ? [field] : []));
}

/**
 * The catalog's own invariants, as a list of problems rather than a throw, so a test can print all
 * of them at once and the host can log rather than fail to start.
 */
export function validateMarketplaceCatalog(catalog: MarketplaceCatalog = MARKETPLACE_CATALOG): string[] {
  const problems: string[] = [];
  const pluginIds = new Set<string>();
  for (const plugin of catalog.plugins) {
    if (pluginIds.has(plugin.id)) problems.push(`duplicate plugin id "${plugin.id}"`);
    pluginIds.add(plugin.id);
    if (!catalog.categories.plugins.includes(plugin.category)) {
      problems.push(`plugin "${plugin.id}" has category "${plugin.category}", which is not in the category list`);
    }
    if (plugin.tagline.includes("\n")) problems.push(`plugin "${plugin.id}" has a multi-line tagline`);
    if (plugin.install == null && plugin.opensEditor !== true) {
      problems.push(`plugin "${plugin.id}" has no install and does not open the editor`);
    }
    if (plugin.kind === "shell-tool" && typeof plugin.install !== "string") {
      problems.push(`shell-tool plugin "${plugin.id}" must install by shell tool id`);
    }
    const entry = marketplaceConnectorEntry(plugin);
    if (entry != null) {
      if (plugin.connectorName == null || plugin.connectorName.length === 0) {
        problems.push(`connector plugin "${plugin.id}" has no connectorName`);
      }
      for (const [field, value] of Object.entries(entry.env)) {
        if (value !== "" && !MARKETPLACE_CONFIGURATION_ENV_KEYS.includes(field)) {
          problems.push(`plugin "${plugin.id}" gives env "${field}" a non-empty value; only a declared configuration key may carry one`);
        }
      }
      for (const field of marketplaceCredentialFields(plugin)) {
        if (plugin.credentialHints[field] == null) problems.push(`plugin "${plugin.id}" has no hint for credential field "${field}"`);
      }
    }
  }
  const botIds = new Set<string>();
  for (const bot of catalog.bots) {
    if (botIds.has(bot.id)) problems.push(`duplicate bot id "${bot.id}"`);
    botIds.add(bot.id);
    if (!catalog.categories.bots.includes(bot.category)) {
      problems.push(`bot "${bot.id}" has category "${bot.category}", which is not in the category list`);
    }
    if (bot.skills.length === 0) problems.push(`bot "${bot.id}" has no skills`);
    if (bot.integrations.length === 0) problems.push(`bot "${bot.id}" names no integrations`);
    for (const integration of bot.integrations) {
      if (!pluginIds.has(integration)) problems.push(`bot "${bot.id}" names integration "${integration}", which is not a plugin id`);
    }
  }
  return problems;
}
