# The Marketplace: plugins and bots

**What this is.** The operator's index for the Marketplace panel in the console — the two tabs, what
Add and Import actually do, where providers and listeners went, and the catalog those tabs are drawn
from. It is the companion to [docs/CONNECTORS.md](CONNECTORS.md): that file is the per-service
walk-through (which credential to mint, with what permissions, and the first call that proves it),
this one is the surface those services are installed from.

**Status: the wave landed and both gate arms have run on the box.** The mechanism underneath it —
a connector entry in `connectors.json`, an empty env value as a credential field, the host's 0600
secret store, `refreshMcp` — was already measured, and `docs/CONNECTORS.md` is where it is described
from. On top of it, `verify-connector-plane.mjs --plugin-tools` passed whole (27 checks, 0 failures)
and the dashboard gate's marketplace arc passed except for two things: the imported-bot card and a
group of provider-card rows. Both are marked **Known red** at the sentence that claims them (§2, §4
step 4), both have a fix in the tree that landed after that run, and neither fix has been re-gated.
§7 carries the numbers.

## 1. The two tabs

The button that used to say **Global capabilities** and the panel that used to say **Plugins,
connectors & skills** are now one word: **Marketplace**. It opens on the **Plugins** tab; **Bots** is
the second pill.

**Plugins** is the box's own catalog of things it can install: a search field, a row of category
chips, and a section per category of cards. A card is an icon tile (a letter on a colour — the
catalog carries no external images, so a card cannot pull a logo off the internet), the plugin name,
one line of tagline, and an **Add** button that becomes **✓ Added** once the plugin is installed.
Clicking a card opens the **plugin page**: the icon and name, **View Source ↗**, **Uninstall**, the
description, an **Accounts** box, and a **Connectors** box.

**Bots** is a catalog of agent templates: featured cards (a coloured tile, the creator, the bot's
name), a search field, category chips, and sections of rows underneath. Clicking one opens the **bot
page**: the tile, the name, *By Titanbot team*, the description, an **Import Bot** button, and three
tabs down the left — **Instructions** (how this bot should work), **Skills** (the playbooks it can
run, each with a name and a description), and **Integrations** (the plugins it needs, each with an
**Add** button when this box does not have it yet).

Both tabs read one catalog, and they read it through the gateway rather than off a static JSON file,
so the cards on the screen and the plugins the agent's own tools can see are the same list. See §5.

## 2. What is not in the Marketplace any more

**Providers moved to Settings.** A provider is an inference endpoint this box answers through — a
subscription adopted on this Mac, or an endpoint holding a pasted key. It was never a plugin; it was
in that panel because the panel was a flat list of everything global. It now renders in **Settings**
under **Inference**, as a **Providers** section, using the same provider cards, with the same
"answering now" pill and the same **Use this endpoint** button. Nothing about how a provider is
adopted, keyed, switched or reported was meant to change — only where the section is drawn.

**Known red at the §7 run.** The move did change what a provider card shows. Settings drew two open
detail panes at once — Providers and Chat listeners each fell back to their own first card — so the
Slack listener's Connect form, its masked token input and its Cursor-route button sat on the page
beside every provider card. Three provider-card checks failed on it (`market-dashboard-rerun.log`
lines 153, 154 and 156), and the key-form row at line 161 failed for the same reason. Commit
`2e3a1e9` draws the detail only in the section that holds the selection, so one detail pane, one
install button and one password input are on the page again. That fix has not been re-gated.

**Chat listeners moved to Settings too**, as a **Chat listeners** section. A listener binds a chat
platform to *one agent* with a token the host takes (`connectChannel`), which is a per-agent setting
rather than something you install once for the box; it reads correctly beside the other host
settings and read wrong beside a catalog of installable things.

So the Marketplace holds exactly two kinds of thing: plugins and bots. A card in it asking for an
inference key is a bug — file it.

## 3. Add a plugin, from the operator's side

1. **Open it.** Marketplace → **Plugins**. Type in the search field to filter by name, tagline or
   category, or press a category chip. **Featured** is the chip for the entries the catalog marks
   `featured`; the rest are the catalog's own categories.
2. **Press Add on the card.** For a connector plugin, Add writes the plugin's entry into
   `/home/box/sand-data/connectors.json` and calls `refreshMcp` — the same `POST /connectors` plus
   `refreshMcp` round trip the connector editor's **Add connector** button already makes, so the host
   relaunches its stdio servers with no container restart. **No credential is written**: the entry
   carries the environment variable *names* with empty values, because `connectors.json` is plaintext
   on the box.
3. **The plugin page opens.** Its **Accounts** box is the credential card that already exists — one
   masked *Enter securely* input per credential field, with the catalog's one-line hint under each
   saying what the value is, where it is created and the least it needs to work. Until a field has a
   stored value, the Accounts row says **Needs auth**.
4. **Paste the key and press Store on the host.** `setConnectorSecret` puts the value in the host's
   0600 store (`connector-env-secrets.json`), and the host merges it into the connector process's
   environment when it spawns it. The page keeps no copy and never reads one back: the card can only
   say the host *holds* a value, which it learns from `listConnectorSecretFields`.
5. **Watch the Connectors box.** It lists the server, its status and its tool count, and then the
   tools themselves with their enable toggles. When the box reports the server connected, the
   Accounts row reads **Ready**.

**The four states, and where each one comes from.** These are the four labels the card can carry,
in the order the console decides them (`ui/machine-room/gateway-adapter.js`, the label ladder).

| State | What it means | Read from |
| --- | --- | --- |
| Not installed | the plugin's connector name is not in `connectors.json` (for a shell-tool plugin: `command -v <binary>` in the box finds no such program — see below) | the connectors file / the box's own shell |
| Needs auth | installed, and at least one credential field has no stored value | `listConnectorSecretFields`: the field is in `fields` and not in `stored` |
| Ready | installed, keyed, and the connector reports connected | the host's own connector status |
| Connecting | installed, with nothing left to key, and the connector is not reporting connected yet | the same connector status, before it says connected |

**Connecting is the state an Add lands in**, and it is not a transient the operator can ignore: the
plugin page opens on the click rather than after the host's MCP connect returns, which can take the
best part of a minute for a server that cannot authenticate yet. A card that sits at Connecting is
telling you the entry is written and the box has not got a tool list back.

**Two kinds of plugin behave slightly differently.**

- A **shell tool** (CodeRabbit CLI, TinyFish CLI) is not an MCP server: it is a command-line program
  the agent runs itself, with a key in the box shell's environment. Its Add runs the catalog's
  install command inside the box as user `box`, capped at five minutes, and shows the tail of its
  output; its Accounts box writes to the `shell` section of the same 0600 store (`setShellSecret`),
  which is a *different environment* from a connector's — a key stored on the `tinyfish` connector
  does not reach the TinyFish CLI. Nothing about a shell tool appears in `connectors.json` or in
  `tools/list`. **Nothing records the install, so "installed" is asked of the box, not of a file.**
  The host runs inside the box and already spawns `/bin/sh -lc` there to run the installer, so the
  same shell answers `command -v <binary>` — `cr` for CodeRabbit, `cli-anything-tinyfish` for the
  TinyFish CLI, named on each entry in `shell-tool-catalog.ts` — and that exit status is the install
  state (`probeShellToolBinary`, beside `runShellToolInstall`). A **stored key is a different fact**
  and stays where it belongs, in the credential field's `isStored`: a key with no program is a
  command the agent would report as available and then fail to run, and a program with no key is a
  tool the operator would be told to install a second time. A shell tool gets no Uninstall control:
  `installShellTool` has no inverse on this host.
- **Custom MCP server** is the catalog entry for everything the catalog does not know. It is the one
  row with no entry to write, so it carries `install: null` and `opensEditor: true` instead: its Add
  opens the connector editor that already exists — name, command, arguments, environment variable
  names — so a server with no card is still added from the same place. An agent's `InstallPlugin`
  refuses it with that explanation rather than writing anything, because there is nothing to write.

**Uninstall** is on the plugin page, and it takes **two clicks**: the first arms it (the button
reads *Click again*), the second removes it. One stray click should not drop a connector. It removes
the entry from `connectors.json` and re-reads the file, and it offers to clear that plugin's stored secrets (`deleteConnectorSecret`) as a separate,
explicit step — removing an entry does not silently destroy a key you may be about to re-add. After
an uninstall with the secrets left alone, `connectors.json` is byte-identical to what it was before
the Add.

## 4. Import a bot, from the operator's side

A bot is a **template**, not a running thing: a persona, some skills, and a list of plugins it
expects. Importing one mints a new agent on this box.

1. **Open it.** Marketplace → **Bots** → a card. Read the three tabs first: **Instructions** is the
   persona the agent will run with, **Skills** are the playbooks that get imported with it, and
   **Integrations** names the plugins it needs.
2. **Press Import Bot.** The console calls `createAgent` with the bot's name and, as the
   `description`, the template's description followed by its instructions —
   `` `${description}\n\n${instructions}` ``, in that order. On this host the profile's
   `description` *is* the persona field: an agent is stored as `{ name, description, title,
   avatarShape, avatarColor }`, `renderAgentProfileUpdate` feeds the model only "Current name" and
   "Current description", and the agent-side CreateAgent tool calls that same field "the new agent's
   persona / instructions" (`source/host/runner/tools/sand-agent-management-tools.ts`). There is no
   separate system-prompt or instructions field on an agent to put it in, so the two share that one
   field. `title` is the operator-facing Role, not a prompt input, and the import does not set it.
3. **Then one `importAgentWorkflowText` per skill**, each with the skill's name and its `SKILL.md`
   body, so the imported agent's Skills list carries the template's skill names.
4. **The bot page then shows the imported agent**, and its Integrations list with an **Add** button
   beside each plugin this box does not have — that Add is the same Add as §3, credential card and
   all. Importing a bot never installs a plugin or takes a key by itself. **Known red at the §7
   run:** the imported card was not on screen when the import returned, because the paint waited on
   `adapter.refresh()` and `refreshInstalled()` behind it — `market-dashboard-rerun.log` line 145,
   "no imported card on screen". Commit `0499430` paints on the import result, ahead of those two
   round trips. That fix has not been re-gated.
5. **Importing the same bot twice** makes a second agent named `<name> copy`, the same way
   duplicating an agent does (`cloneAgentDisplayName`, `source/host/agents/agent-clone.ts`). It is
   not an error and it does not overwrite the first one.

Deleting the agent afterwards is the ordinary agent delete in the sidebar; nothing in the catalog
remembers that you imported it.

## 5. The catalog

One file, in the repo, bundled into the host:

```
source/shared/marketplace/catalog.ts   →   export const MARKETPLACE_PLUGINS, MARKETPLACE_BOTS,
                                                        MARKETPLACE_CATALOG
```

It is served by two gateway commands:

| Command | Arguments | Answers |
| --- | --- | --- |
| `listMarketplace` | `{}` | `{ plugins, bots, categories: { plugins, bots } }` — `categories` is an object of two lists, one per tab, **not** a flat array; a reader that calls `categories.map` gets nothing |
| `getMarketplaceItem` | `{ kind, id }` | that one item |

**The console reads the catalog only through the gateway** — never a static JSON beside the page.
That is the point of putting it in `source/shared`: the agent's plugin tools resolve against the same
export, so what the operator sees on a card and what the model gets back from `SearchPlugins` cannot
drift. It also means the catalog ships **with the host bundle** — adding an entry is a code change
and a rebuild, not a file dropped on the box.

### A plugin

| Field | What it is |
| --- | --- |
| `id` | stable id; the plugin tools and the console cards are keyed by it |
| `name` | display name |
| `tagline` | one line, the card's second row |
| `description` | the paragraph on the plugin page |
| `category` | one of the declared plugin categories |
| `featured` | `true` puts it under the **Featured** chip as well as its own |
| `icon` | `{ letter, color }` — drawn, never fetched; the catalog carries no image URLs |
| `source` | `{ label, url }`, behind **View Source ↗** |
| `kind` | `"connector"` or `"shell-tool"` |
| `install` | for a connector, the exact `{ command, args, env }` entry; for a shell tool, the shell-tool id; `null` for Custom MCP server |
| `connectorName` | the key the entry takes in `connectors.json` — what "installed" is decided against |
| `opensEditor` | `true` on Custom MCP server only: it has no entry, it opens the connector editor |
| `credentialHints` | `{ ENV_KEY: "one line" }` — what the value is, where it is created, the least it needs |

```ts
{
  id: "tinyfish",
  name: "TinyFish",
  tagline: "Web search, page fetch and browser automation behind one API key.",
  description: "TinyFish's hosted MCP endpoint, bridged into the box over stdio. …",
  category: "Web & Search",
  featured: true,
  icon: { letter: "T", color: "#0f766e" },
  source: { label: "agent.tinyfish.ai/mcp", url: "https://agent.tinyfish.ai/mcp" },
  kind: "connector",
  connectorName: "tinyfish",
  install: {                            // the entry, written out here; see the note below on why
    command: "npx",
    args: ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp",
           "--transport", "http-only",
           "--header", "Authorization:Bearer ${TINYFISH_API_KEY}"],
    env: { TINYFISH_API_KEY: "" },      // empty value = credential field, never a key
  },
  credentialHints: { TINYFISH_API_KEY: "Your TinyFish account's API key, carried as an Authorization bearer …" },
}
```

**One entry, and a test that forbids a second one from drifting.** A connector entry is written in
three places and the suite makes it impossible for them to disagree. `ui/machine-room/gateway-adapter.js`
is a plain browser script loaded by a `<script>` tag with no build step, so it cannot import the
catalog's TypeScript module, and the contract says the console reads the catalog only through the
gateway — one file genuinely cannot import the other as things stand. So instead:
`tests/connector-preset-catalog.test.mjs` already holds each console preset against its report in
`docs/connectors/`, and `tests/marketplace-catalog.test.mjs` asserts that the catalog's entry and its
credential hints are deep-equal to the preset's. Editing any one of the three alone fails the suite.
Two copies of the same `args` array is how a header ends up quoted in one place and split in the
other, which is exactly the bug the quoting rule in the connector editor exists to prevent. The
Filesystem plugin is the one entry no console preset carries, so the catalog is where it lives.

If the console is later fed its `CONNECTOR_PRESETS` from `listMarketplace` at boot, that deep-equal
test should be deleted and replaced by that wiring.

Seeded plugins: **GitHub**, **Slack**, **Linear**, **Google Workspace**, **TinyFish**, **Filesystem**
(`localfiles`), **CodeRabbit CLI**, **TinyFish CLI**, and **Custom MCP server**. Categories:
Featured, Development, Communication, Project management, Documents & Files, Web & Search, Code
review, Shell tools.

### A bot

| Field | What it is |
| --- | --- |
| `id` | stable id |
| `name` | display name |
| `creator` | `"Titanbot team"` for everything shipped in the box |
| `category` | one of the declared bot categories |
| `featured` | `true` puts it in the Featured strip |
| `tile` | `{ color, shape }` — the card's face, drawn, not fetched |
| `description` | the paragraph on the bot page |
| `instructions` | the persona the imported agent runs with (§4 step 2) |
| `skills` | `[{ name, description, body }]`, `body` being a `SKILL.md` text |
| `integrations` | plugin ids — every one must exist in `MARKETPLACE_PLUGINS` |

```ts
{
  id: "research-desk",
  name: "Research desk",
  creator: "Titanbot team",
  category: "Operations",
  featured: true,
  tile: { color: "#2f6f4f", shape: "circle" },
  description: "Takes a research question to a sourced answer: searches, fetches the pages it cites, …",
  instructions: "You are a research desk. …",
  skills: [{ name: "Source a claim", description: "Search, fetch, quote, cite.", body: "# Source a claim\n…" }],
  integrations: ["tinyfish"],
}
```

Seeded bots, all six of them templates this box can run today: **Research desk** (TinyFish), **PR
review desk** (GitHub + CodeRabbit CLI), **Ops watcher** (Slack), **Issue triage** (Linear), **Inbox
triage** (Google Workspace), **Course note-taker** (Filesystem). Categories: Featured, From Titanbot
team, Engineering, Operations, Sales, Personal.

**Featured and From Titanbot team are computed chips**, not values you store: a card lands under
Featured because `featured` is true, and under From Titanbot team because `creator` is
`"Titanbot team"`. Every other chip matches the item's own `category`.

## 6. How to add an entry

**A plugin.**

1. If it is a connector the console cannot already write, get the entry right first: write the
   service's report under `docs/connectors/` (what the credential is, where it is minted, the least
   permission that works, the first call and the answer that means it worked, and what bites), and
   land the `{command,args,env}` entry so the entry and the report cannot drift.
2. Add the object to the `PLUGINS` array in `source/shared/marketplace/catalog.ts` (the private const
   the file exports as `MARKETPLACE_PLUGINS`). `category` must be one of
   the declared categories. `icon` is a letter and a colour — do not reach for a logo URL, the cards
   are deliberately image-free. Write one `credentialHints` line per env key the entry leaves empty:
   what the value is, where it is created, what it needs. **Never a key, a token or an example
   secret** — a catalog is source, it is in git, and it ships inside the bundle.
3. Add the service's section to `docs/CONNECTORS.md` so the operator has a walk-through, and point
   `source.url` at something a person can actually read. **The shipped catalog already owes one:**
   Filesystem (`localfiles`) is a card whose Add works and which has no section in
   `docs/CONNECTORS.md` and no report in `docs/connectors/`. It takes no credential, which is how it
   slipped through; it is still the one entry this step is owed.
4. Rebuild the host and run the gates in §7. The catalog is bundled, so an entry that is not in a
   deployed bundle does not exist on the box.

**A bot.**

1. Write it against plugins that are already in the catalog: `integrations` is a list of plugin ids,
   and a bot naming a plugin that does not exist is a card whose Add button cannot work.
2. Keep it honest. A seeded bot is a template the box can run today with the plugins it names, not an
   aspiration. If it needs a tool this build does not have, it does not belong in the catalog yet.
3. `instructions` is the persona, and it becomes the agent's profile description on import, so write
   it as the agent's own standing brief rather than as marketing copy.
4. Each skill's `body` is a whole `SKILL.md`: a title, when to use it, and the steps. It is imported
   verbatim through `importAgentWorkflowText`, so what you write is what the agent gets.

## 7. How this is proved

Two existing gates gain arms for it. Both are box gates — the integrator runs them, on the shared
box, through `bash scripts/on-box.sh`.

- **`scripts/verify-dashboard.mjs`** — the Marketplace opens on Plugins with the catalog's cards,
  category chips and a working search; no provider appears in the Marketplace and the Providers
  section appears in Settings; **Add** on *TinyFish (API key)* writes the entry and opens a plugin
  page whose Accounts row says **Needs auth**; **Uninstall** removes it and `connectors.json` is
  byte-identical to before; the Bots tab lists the six templates; **Import** on *Research desk*
  creates an agent whose description matches and whose skills list the template's skill names, and
  the gate deletes it again.
- **`scripts/verify-connector-plane.mjs --plugin-tools`** — `listMarketplace` and
  `getMarketplaceItem` answer the catalog (TinyFish, with `TINYFISH_API_KEY` declared and empty),
  then a probe agent turn drives the four tools against a connector plugin this box does not already
  have: `SearchPlugins` lists the catalog and names it, `GetPlugin` returns it with its credential
  field, `InstallPlugin` writes the entry, `UninstallPlugin` removes it, byte-identical after.

**What the arms actually measured.** `verify-connector-plane.mjs --plugin-tools` passed whole: 27
checks, 0 failures, the four tools driven through a probe agent turn (the install leg ran against
GitHub, the first catalog connector the box did not already hold). `verify-dashboard.mjs` ran the
whole console; its marketplace arc came back green — the Plugins tab, the chips and search, Add and
Uninstall with `connectors.json` byte-identical after, no provider card in the Marketplace, the
Providers and Chat listeners sections in Settings, the six bot templates, and Import Bot creating an
agent with the template's description and skills — **except** for the two rows marked Known red
above: the imported-bot card (§4 step 4) and the provider-card group (§2). `2e3a1e9` and `0499430`
fix those two and landed after that run, so re-run this gate before calling them green.

## 8. The agent's own path: SearchPlugins → GetPlugin → InstallPlugin

The agent has had four plugin tools all along — `SearchPlugins`, `GetPlugin`, `InstallPlugin`,
`UninstallPlugin` — and they resolved against **Cursor's** marketplace, which this box has no account
for. `source/host/extensions/mcp/mcp-service.ts` says it plainly: there is no usable Cursor account,
and the call threw straight out of `SearchPlugins`. So the catalog was always empty and the tools
were dead ends. They now resolve against the local catalog:
`source/host/extensions/mcp/marketplace-plugins.ts` is the module that answers all four, wired in
from `mcp-service.ts`. (`source/shared/node/mcp/mcp-catalog-flow.ts` is untouched Cursor plumbing,
still imported by `source/shared/node/mcp/mcp-manager.ts`; it is not where these tools are served
from.) The wording in
`source/host/runner/system-prompt.ts` and in the add-connector seed skill
(`source/host/extensions/managed-setup/seed-skills/add-connector/SKILL.md`) says **the Marketplace**
rather than Cursor's.

| Tool | What it does now |
| --- | --- |
| `SearchPlugins` | lists the catalog's plugins; a query filters on name, tagline and category. Read-only. |
| `GetPlugin` | one plugin, with its credential fields and whether the host already holds a value for each |
| `InstallPlugin` | for a connector, writes the entry through the same host path the relay uses; for a shell tool, runs the catalog's install command in the box through `runShellToolInstall` — the same door the plugin page's button uses — and re-probes rather than trusting its exit code. Either way it answers with the fields the operator must fill on the plugin page. A plugin already installed is left untouched: nothing is rewritten, because the entry on the box may be one the operator has edited since |
| `UninstallPlugin` | removes the entry. A shell tool has no uninstall on this host, and the answer says so rather than reporting a removal that did not happen |

**The split is the one the whole connector plane is built on: the agent installs, the operator
keys.** `setConnectorSecret` is a console command and deliberately not an agent tool, because a key
typed into a conversation is in the transcript, in the model's context, and in whatever window that
was compacted into. So `InstallPlugin` succeeding does not mean the connector works: its answer names
the credential card the operator has to go and fill, and a tool call made before the key is stored
fails naming that card rather than as a bare transport error.

`AddMcpServer` is unchanged and stays the route for a server the catalog does not know.

## See also

- [docs/CONNECTORS.md](CONNECTORS.md) — per-service walk-throughs: the credential, its permissions,
  the first call, and what bites.
- [docs/CONNECTORS-TINYFISH.md](CONNECTORS-TINYFISH.md) — the reference connector, including the
  OAuth alternative and the shell-tool CLI.
- [docs/CONNECTOR-PLUGIN-PLANE.md](CONNECTOR-PLUGIN-PLANE.md) — the longer-term substrate decision
  (OpenConnector as the catalog behind the transport this repo already has). The local catalog is
  what ships now; that decision is what it grows into.
