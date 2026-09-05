# The Marketplace

One button, two tabs. **Plugins** are the things this box can install — a connector (an MCP server
the box runs) or a shell tool (a CLI the box installs). **Bots** are agent templates: a persona,
its skills, and the plugins it needs. The button and the panel used to be called *Global
capabilities*, and providers and chat listeners used to live inside it; they do not any more —
see [Where the providers went](#where-the-providers-went).

The catalog is one file in the repo, `source/shared/marketplace/catalog.ts`, bundled into the host.
The console never reads a static JSON: it asks the gateway. That is the whole point — the operator's
Marketplace panel and the agent's `SearchPlugins` resolve against the same data, so a plugin the
agent offers to install is one the operator can see, and neither list can drift from the other.

Two gateway commands serve it:

| command | argument | answer |
| --- | --- | --- |
| `listMarketplace` | `{}` | `{ plugins, bots, categories }` — the whole catalog |
| `getMarketplaceItem` | `{ kind: "plugin" \| "bot", id }` | that one item |

Both are pure reads out of the bundle: no box, no network, no account. Per-install state is *not*
in them — "installed", "Needs auth" and "Ready" come from the connector commands
(`listInstalledMcpServers`, `listConnectorSecretFields`), which is what keeps the catalog a catalog.

## Plugins: what Add does

A plugin is installed when its connector name is in `/home/box/sand-data/connectors.json`. **Add**
writes that entry through the same door the connector editor uses (the console's `POST /connectors`,
or the host's own writer for an agent's `InstallPlugin`) and then calls `refreshMcp`, so the host
relaunches its stdio servers with no container restart. Then it opens the plugin page.

The plugin page has the two boxes the connector plane already had:

- **Accounts** — one credential card per credential field. A credential field is an env key whose
  value in the entry is the **empty string**; that rule is the host's (CONNECT-4), and it is why no
  catalog entry may carry a non-empty env value. Until a value is stored the row reads **Needs
  auth**; once the connector reports connected it reads **Ready**.
- **Connectors** — the server, its status and its tool count, with the per-tool enable toggles.

**Uninstall** removes the entry and reloads. It deliberately leaves the stored credential alone, so
re-adding the plugin does not need a fresh key; clearing it is a separate action
(`deleteConnectorSecret`), which the page offers.

The whole credential story is unchanged and is written up in [CONNECTORS.md](CONNECTORS.md): no key
ever goes in `connectors.json`, values live in the 0600 store, and **the agent cannot set one** — a
key typed into a conversation is in the transcript, the model's context and whatever window that was
compacted into. `InstallPlugin` therefore answers with the *names* of the fields the operator has to
fill and where to fill them.

Two plugins are not connectors:

- **Shell tools** (CodeRabbit CLI, TinyFish CLI) install by running a command inside the box
  (`installShellTool`) and take their key from the shell section of the same 0600 store.
  `InstallPlugin` refuses them with that explanation rather than writing `connectors.json`. This box
  keeps no install record for a shell tool, so the closest true signal for "installed" — the one the
  Shell tools panel already shows — is whether the host holds its key.
- **Custom MCP server** has no entry at all: it opens the connector editor, where a name, a command,
  its arguments and the environment variable *names* are typed by hand.

## Bots: what Import does

A bot is a template, not a running thing. **Import Bot** does three steps:

1. `createAgent` with the bot's name and its `instructions` as the agent's persona.
2. `importAgentWorkflowText` once per skill, so each `SKILL.md` in the template lands as one of the
   agent's workflows.
3. The bot page then shows the imported agent and the plugins the template names, with **Add**
   beside any that are not installed.

Importing the same bot twice makes a second agent with `" copy"` appended, the way `duplicateAgent`
does — a template is meant to be taken more than once.

Note for whoever wires the import: the host's `createAgent` takes `name`, `description`, `title`,
`avatarShape` and `avatarColor`, and `description` is the free-text field the agent's persona
actually runs from (that is the field MR-28 is about). There is no separate persona field to put
`instructions` in.

## Where the providers went

Providers and chat listeners are not in the Marketplace. Nothing about how they behave changed, only
where they live:

- **Providers** render in **Settings → Inference** as a *Providers* section, using the same provider
  cards.
- **Chat listeners** render in **Settings** as *Chat listeners*.

The operator's reason, in his words: *"I really don't want providers in this marketplace area.
Providers should be moved and should only be under the settings."* A marketplace is a place to add a
capability; a provider is how the box thinks, and it belongs beside the rest of the box's settings.

## The catalog schema

### A plugin

```ts
{
  id, name,
  tagline,            // one line; the card's subtitle, and part of what search matches
  description,        // the paragraph on the plugin page
  category,           // one of categories.plugins
  featured,           // drives the Featured section, independent of category
  icon: { letter, color },          // no external images, ever
  source: { label, url },           // "View Source ↗" on the plugin page
  kind: "connector" | "shell-tool",
  install,            // a connector: the exact {command,args,env} entry. a shell tool: its id.
  connectorName,      // the name the entry takes in connectors.json (connectors only)
  credentialHints: { ENV_KEY: "one line: what the value is, where it is minted, the least it needs" },
}
```

Categories: Featured, Development, Communication, Project management, Documents & Files, Web &
Search, Code review, Shell tools.

### A bot

```ts
{
  id, name,
  creator,            // "Titanbot team"
  category,           // one of categories.bots
  featured,
  tile: { color, shape },
  description,        // one line, shown on the card and the bot page
  instructions,       // the persona the imported agent runs with
  skills: [{ name, description, body }],   // body is a whole SKILL.md, front matter included
  integrations: [pluginId, ...],
}
```

Categories: Featured, From Titanbot team, Engineering, Operations, Sales, Personal.

## Adding a plugin

1. If it is a connector, research it first and land the report under `docs/connectors/<service>.md`
   with its entry in section 2. `tests/connector-preset-catalog.test.mjs` holds the console's preset
   row against that section, and `tests/marketplace-catalog.test.mjs` holds this catalog against the
   preset row — so an entry exists in three places and none of the three can be edited alone.
2. Add the object to `MARKETPLACE_PLUGINS`. Every credential env value is the **empty string** and
   every credential field has a one-line hint; the test fails otherwise, and so it should — a
   non-empty env value in the catalog would be a secret in git.
3. Add the connector's preset to `CONNECTOR_PRESETS` in `ui/machine-room/gateway-adapter.js` with
   the identical entry, so the connector editor offers it too.
4. `npm test`. The catalog validator checks the category, the hints and the shape; a separate case
   scans every string in the catalog for anything key-shaped.

## Adding a bot

1. Add the object to `MARKETPLACE_BOTS`. Its `integrations` must be plugin ids that exist, and every
   skill body must be a real `SKILL.md` whose front-matter `name` matches the skill's `name` — both
   are asserted.
2. Keep the persona to what the box can actually do today. A template whose integrations are not in
   the catalog is a promise the Import button cannot keep.

## Gates

- `scripts/verify-dashboard.mjs` — the Marketplace opens on Plugins with the catalog's cards, the
  category chips and a working search; no provider appears in it and the Providers section is in
  Settings; **Add** on *TinyFish (API key)* writes the entry and opens a plugin page whose Accounts
  row says Needs auth; **Uninstall** removes it and `connectors.json` is byte-identical to before;
  the Bots tab lists the six templates; **Import** on *Research desk* creates an agent whose
  description matches and whose skills list the template's skill names.
- `scripts/verify-connector-plane.mjs --plugin-tools` — `SearchPlugins` lists the catalog,
  `GetPlugin` returns TinyFish with its field, `InstallPlugin` writes the entry, `UninstallPlugin`
  removes it, byte-identical after.
