# The Marketplace

The console's **Marketplace** button opens one dialog with two pill tabs, **Plugins** and **Bots**.
It replaces the old *Global capabilities* panel, which mixed four unlike things in one list:
connectors you install, shell tools you install, chat listeners you bind, and providers you answer
through. The last two are not things anybody installs, so this wave moved them out — the operator's
own words were *"I really don't want providers in this marketplace area. Providers should be moved
and should only be under the settings."*

The panel opens on **Plugins**.

## One catalog, served by the host

Both tabs are drawn from a single catalog that lives in the repo at
`source/shared/marketplace/catalog.ts` and is bundled into the host. The console reads it through
two gateway commands and never from a static JSON of its own:

| Command | Arguments | Answers |
| --- | --- | --- |
| `listMarketplace` | `{}` | `{ plugins, bots, categories }` |
| `getMarketplaceItem` | `{ kind, id }` | the one item |

That single source is the point. The agents' own plugin tools — `SearchPlugins`, `GetPlugin`,
`InstallPlugin`, `UninstallPlugin` — resolve against the same catalog, so what a model can find and
what an operator can see are the same list. A host that has not landed the commands answers
`unknown gateway method`, and the tab says the host serves no catalog rather than drawing an empty
one.

## The Plugins tab

A **plugin** is one thing the box can run for an agent: an MCP **connector** the host spawns, or a
**shell tool** the agent runs from its own shell. The tab has, top to bottom:

- an **installed strip** — how many are installed, how many the box reports connected, and one icon
  per installed card. An icon opens that plugin's page, including one no catalog row claims (a
  custom MCP server, or a connector added by hand);
- a **search field** — it filters on name, tagline and category, the same rule `SearchPlugins`
  applies;
- **category chips** — `All` plus the catalog's own categories;
- **sections**, one per category, each a grid of cards: icon tile, name, one line, and either an
  **Add** button or a **✓ Added** pill;
- the **Add or remove a connector** editor, unchanged, at the bottom. The catalog's *Custom MCP
  server* card opens it rather than writing anything.

### Add

**Add** writes the catalog entry through exactly the path the connector editor already used:
`POST /connectors` on the relay, then `refreshMcp`, so the host relaunches its stdio servers with
no container restart. The entry written is the catalog's own `{command, args, env}` object with the
environment **names** and no values — `connectors.json` is plaintext on the box, and a credential
never goes in it. Add then opens the plugin's page, which is where the credential does go.

For a shell tool, Add is `installShellTool`: the host runs the catalog's install command inside the
box as user `box`, capped at five minutes, and the tail of its output comes back on the card.

### The plugin page

- the icon, the name, and the state pill;
- **View source ↗**, a link to the service's own documentation, and **Uninstall**;
- the description;
- an **Accounts** box: a `default` row carrying the state, and the credential card that already
  existed — one masked field per credential the entry declares, stored by the host with
  `setConnectorSecret` (or `setShellSecret` for a shell tool) into its own 0600 store, never into
  `connectors.json` and never into this page's markup;
- a **Connectors** box: the server, the box's own word for its status, its tool count, and every
  tool it discovered with its enable switch.

### The three states

Derived in `ui/machine-room/gateway-adapter.js` (`installedPlugins`) from the connector and
shell-tool cards the console already builds — never from a second read of the box:

| State | What it means |
| --- | --- |
| **Not installed** | the connector's name is not in `connectors.json` (or the shell tool is not installed). A host running a server by that name is not enough: an account server has no entry, and "Added" would offer an Uninstall that removes nothing. |
| **Needs auth** | installed, and a credential field the entry declares has no value in the host's store. `listConnectorSecretFields` answers `fields` and `stored` separately, and only the second may make a card claim the host holds a value. |
| **Connecting** | installed and authenticated, and the box has not finished launching it. |
| **Ready** | installed, nothing left to authenticate, and the box reports it connected. |

### Uninstall

**Uninstall** takes two clicks. Where the host stores credentials for that connector, the first
click's row offers to clear them as well — and they are cleared **first**, because
`deleteConnectorSecret` resolves the server through `connectors.json`: once the entry is gone the
host cannot reach its own store for it, and the value would sit there for the life of the box. Then
the entry comes out through the same `removeConnector` write the editor's Remove row makes.

## The Bots tab

A **bot** is an agent template: a persona, the skills it can run, and the plugins it needs. The tab
lists them as cards under the same category chips, and a bot's page has its description and three
sections — **Instructions** (the persona the agent runs with), **Skills** (each playbook's name and
description) and **Integrations** (the plugins it needs, with an Add button for the missing ones).

**Import Bot** creates a real agent: `createAgent` with the template's name, its description, and
its instructions as the agent's persona, then `importAgentWorkflowText` once per skill. Importing
the same bot twice makes a second agent with `" copy"` appended, the same way Duplicate does. The
bot's page then shows the imported agent and which of its integrations are still missing.

## Where the providers went

**Settings** (the ⚙ button). Providers are a **Providers** section directly under **Inference** —
the same provider cards, with the same key form, the same "Use this endpoint" button and the same
"answering now" pill. Nothing about their behaviour changed; only the panel they live in.

Chat listeners moved with them, as a **Chat listeners** section in the same panel. A listener binds
to one agent — the agent whose conversation is on screen — which is why it belongs beside the
box's own settings rather than in a catalog of things to install.

## Adding to the catalog

Edit `source/shared/marketplace/catalog.ts` and rebuild the host. Nothing in the console needs to
change: it draws whatever the two commands answer.

### A plugin

```ts
{
  id: "linear",                       // the connector's name in connectors.json
  name: "Linear",
  tagline: "Issues, projects and cycles.",   // one line, on the card
  description: "…",                          // the plugin page's paragraph
  category: "Project management",            // one of `categories`
  featured: false,
  icon: { letter: "L", color: "#5e6ad2" },   // no external images
  source: { label: "linear.app", url: "https://linear.app/docs/mcp" },
  kind: "connector",                          // or "shell-tool"
  install: LINEAR_PRESET_ENTRY,               // the preset's own {command,args,env} object
  credentialHints: { LINEAR_API_KEY: "A Linear personal API key…" },
}
```

Two rules that are not style:

- **`install` reuses the preset entry object; it does not restate it.** The entries are fixed
  against the primary-source reports in `docs/connectors/`, and
  `tests/connector-preset-catalog.test.mjs` fails if a report and an entry drift apart. A second
  copy in this file would be a second thing to keep true.
- **`credentialHints` is one line per credential field**: what the value is, where it is created,
  and the least it needs to work. It is what the plugin page shows an operator who reaches it
  without the credential in hand.

For a `shell-tool`, `install` is the shell-tool id from
`source/host/extensions/shell-tools/shell-tool-catalog.ts`.

The categories are `Featured`, `Development`, `Communication`, `Project management`,
`Documents & Files`, `Web & Search`, `Code review` and `Shell tools`. `Featured` is the `featured`
flag rather than a category anything is filed under.

### A bot

```ts
{
  id: "research-desk",
  name: "Research desk",
  creator: "Titanbot team",
  category: "From Titanbot team",
  featured: true,
  tile: { color: "#31b6b8", shape: "circle" },
  description: "…",
  instructions: "…",                    // the persona the imported agent runs with
  skills: [{ name: "Daily scan", description: "…", body: "…SKILL.md text…" }],
  integrations: ["tinyfish"],           // plugin ids
}
```

Seed only what the box can actually run today. A template whose integration has no plugin behind it
imports an agent that cannot do the job it is named for.

## Where the code is

| Piece | File |
| --- | --- |
| The catalog | `source/shared/marketplace/catalog.ts` |
| The two gateway commands | `source/host/gateway-protocol.ts`, `source/host/host-gateway-api.ts` |
| The agents' plugin tools | `source/shared/node/mcp/mcp-catalog-flow.ts`, `mcp-service.ts` |
| The panel, tabs, cards and plugin page | `ui/machine-room/app.js` (the `Marketplace` block) |
| The catalog reads and the install-state derivation | `ui/machine-room/gateway-adapter.js` |
| Providers and listeners in Settings | `ui/machine-room/app.js` (`pluginGroupSection`) |
| The gate | `scripts/verify-dashboard.mjs`, `scripts/verify-connector-plane.mjs --plugin-tools` |
| The derivations, against a stub gateway | `tests/machine-room-marketplace.test.mjs` |

The mechanism underneath — what a connector entry is, what makes an env key a credential field, and
where the values are stored — is [docs/CONNECTORS.md](CONNECTORS.md).
