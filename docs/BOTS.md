# The bot standard

What a bot in this Marketplace is, how the 65 community rows are built and kept, and what bites.

A bot is a **title, a category, and four blocks**: memories (facts it already knows), skills
(playbooks it can run), routines (jobs that run on their own) and integrations (apps it can use).
One click on Add creates an agent with that title, seeds those memories into its own memory store,
installs those skills as SKILL.md documents, creates those routines switched off, and says in plain
words which apps it still needs. A second click says it is already on the roster.

Every bot page shows the same four blocks under the same four headings, in this order:

| Block | The line under it |
| --- | --- |
| Memories | Facts it already knows |
| Skills | Playbooks it can run |
| Routines | Jobs that run on their own |
| Integrations | Apps it can use |

There is no Instructions block. The host has exactly one identity field -- the agent's description
-- and `personaFor` composes it as `description + blank line + instructions`, so a row's
`instructions` **is** its identity, and on a community row that has memories it is set to the bot's
first memory. That means one paragraph is deliberately duplicated between the identity and the
memory store on those rows. It is consistent rather than accidental: the sentence that says what the
bot is, is both the thing the model is told it is and the first thing it remembers.

**A row the scrape gives no memories carries no instructions at all.** Four do: `chief-health`,
`projects-manager`, `the-morning-newspaper` and `writing-bot`. The generator used to fall back to
the description there, which composed `description + blank line + description` and told those four
agents their own one-line bio twice as their whole identity. Empty means the description alone, the
generator now fails the build when the two strings are equal, and their Memories block shows the
honest empty state: *this bot knows nothing in advance; it starts with its description and learns as
you work with it*.

The first-party rows predate the Memories block and are not edited to gain one. `catalog.ts` derives
it: a row that declares no memories gets one composed from its `instructions`. The six templates and
the Marketing team pack therefore show the same four blocks as every community row, without
`marketing-team.ts` being touched by a wave that does not own it.

---

## Where a row comes from

Three files, and only one of them is written by hand.

```
source/shared/marketplace/bots/bots.json     the scrape, exactly as it came off the wire, NEVER edited
source/shared/marketplace/bots/overlay.json  every human decision, each with the string it replaces and a why
scripts/build-bot-catalog.mjs                reads both, writes the module
source/shared/marketplace/community-bots.ts  GENERATED, never hand-edited
```

`bots.json` is 69 bots scraped from the upstream marketplace on 2026-09-09, checked in verbatim
(sha256 `7e3378792d408a72ab499fa3b3e80e149d2d22bfaca171eea60a40d4f4371b68`). `SOURCE-README.md` beside
it is that scrape's own index, kept for provenance; it links to per-bot pages this repo does not
carry, so read it as a record of what was taken rather than as documentation.

The overlay is the only place a person changes anything. Each row carries the EXACT `from` string it
replaces and a `why`, and **the build fails when a `from` is no longer found**, so the overlay cannot
rot quietly against a re-scrape. `tests/community-bots.test.mjs` regenerates the module in memory and
asserts the checked-in file is byte identical, so a hand edit to a row is a red suite rather than a
change nobody can reproduce. That is what makes 65 rows maintainable and 500 possible later.

### Adding a bot to the catalog

1. Add the bot's object to `bots.json` in the scrape's own shape (`id`, `name`, `creatorName`,
   `description`, `categories`, `color`, `shape`, `memories[].description`, `skills[].name` and
   `.description`, `routines[].name` and `.summary`, `integrations[].name` and `.description`).
2. Run `node scripts/build-bot-catalog.mjs`. It will refuse and tell you what is wrong: an app name
   that is not in the mapping table, a category it cannot resolve, a row with nothing in it, or any
   string still naming the old upstream.
3. Fix those in `overlay.json`, never in `bots.json`, each with a `why`.
4. Rerun the generator, then `node --test tests/community-bots.test.mjs tests/marketplace-catalog.test.mjs`.
5. Commit the data, the overlay and the regenerated module together.

`node scripts/build-bot-catalog.mjs --check` writes nothing and exits non-zero when the module is
stale. That is the form a gate runs.

---

## The four things the standard had to decide

### 1. Memories are split at build time, and refused at write time

`sand-memory.ts` caps one remembered fact at 500 characters (`MEMORY_MAX_CONTENT_LENGTH`) and
`normalizeMemoryContent` collapses whitespace and then **slices**, silently.

**Measured on this Mac, 2026-09-09, over `bots.json`:** 444 memories, 190,747 characters. 48 of them
are over the cap and **62,898 characters would have vanished mid sentence**, on the persona and
job-boundary paragraphs that are the whole identity of the eight worst bots (`alfred` 6,173
characters in one memory, `hiring-activity-monitor` 5,226, `follow-through-agent` 5,145,
`account-research` 5,038, `warm-intro-finder` 5,026, `prospector` 4,980,
`pipeline-health-and-forecast` 4,945, `deal-qualification` 4,943).

The cap is **not raised**. It is read on every write path in the product, including the agent's own
remember tool, and the recent-memory prompt has its own separate budget; raising it to make a catalog
fit would be a host-wide behaviour change nobody asked for. Nothing is truncated either. Instead:

- The generator splits each paragraph at sentence boundaries into chunks that each fit. A single
  sentence longer than the cap -- the list-shaped memories, `Job: a, b, c, d ...` -- has no boundary
  to break at and is cut at the last space that fits; 29 of the 594 facts are such cuts and every one
  of them is over 400 characters, which is what the test pins.
- A row carries **both** forms: `text` is the paragraph the page shows, `facts` is the list the
  import seeds. Rejoining the facts recovers the paragraph, and the test asserts it for all 423.
- `text` keeps the source's own line breaks. 42 of the shipped memories have real structure --
  `JOB BOUNDARY`, then `Owns:`, then `Does not own:`, each on its own line -- and flattening every
  run of whitespace turned those into one unreadable paragraph. The memory store collapses
  whitespace itself when a fact is written, which is exactly why `facts` is built from the collapsed
  form and `text` is not.
- The new host verb **refuses** anything still over the cap rather than writing a cut version, and
  reports it under `rejected`.

Shipped: 423 memories, 594 facts, none over 500 characters.

### 2. A routine gets a real cron or nothing, and the default hour is declared

`automation-store.upsert` writes nothing when a trigger will not normalise and the gateway still
answers 200. `normalizeSchedule` accepts the bare word `weekly`, stores it, describes it as
"weekly", and never computes a next run -- a routine that is dead the day somebody switches it on.

So the schedule is resolved when the catalog is BUILT, from the routine's name and summary together,
and a row carries a five-field cron or `null` plus a `scheduleNote` in plain words. A stated clock is
used as stated (`7:00am local`, `Weekdays at 1:00 PM`). Only an explicit am/pm counts as a clock:
`3:15 local` is genuinely ambiguous and belongs in the overlay with a person's reason, not in a guess.

**A cadence with no clock takes a declared default**, written here, shown on the page and named in
the import report:

| The words say | Cron | Default hour |
| --- | --- | --- |
| a named day ("Every Friday morning") | `0 9 * * 5` | 09:00 |
| weekdays ("Each weekday morning") | `0 9 * * 1-5` | 09:00 |
| a week with no day ("Once a week") | `0 9 * * 1` | 09:00, Monday |
| twice a week, no days | `0 9 * * 1,4` | 09:00, Monday and Thursday |
| daily ("Every day", "all seven days") | `0 9 * * *` | 09:00 |
| monthly ("On the 1st of every month") | `0 9 1 * *` | 09:00 |
| an afternoon | hour 14 | 14:00 |
| an evening | hour 17 | 17:00 |
| a midday | hour 12 | 12:00 |
| a night with no hour ("Nightly") | `0 2 * * *` | 02:00 |

All in the box's local time. A default that is disclosed on the page, created switched off, and named
in the report is not an invented fact.

**Not created at all**, with the page saying so instead: an event trigger ("After a meeting ends", "On
the morning of the event", "The evening before"), continuous polling ("Through the workday"), an hour
only the operator knows ("On the mornings you pick"), and quarterly -- `describeSchedule` cannot render
a quarterly cron as words, so a quarterly routine would show a raw expression on the page, and the only
quarterly routine in the scrape belonged to a bot that is dropped anyway.

**Measured:** 104 routines, 91 resolve to a cron, 13 do not. The 13 are

```
deal-hunting        Watchlist check                    follow-through-agent  Commitment-strand audit
echo                Post-meeting recap draft           mr-toms               Evening interview prep
event-producer      Day-of brief                       mr-toms               Urgent thread check
event-producer      Post-event recap draft             mr-toms               Candidate reply drafts
sales-call-coach    Objection drill                    tally                 Reporting ask watch
warm-intro-finder   Warm-path follow-through queue     webby                 Site PR follow-up
webby               Post-fill dashboard ship
```

Every emitted cron is compiled through `computeNextRunAt` by the test and must resolve to a finite
next run, and through `describeSchedule` and must come back as prose rather than the raw expression.
Two routines take their cron from the overlay rather than the resolver: `webby`'s hourly dashboard
book (`35 * * * 1-5`, from its own "refresh at :35") and its cash close (`15 15 * * 1-5`, from
"ship at 3:15 local" with the afternoon written down by a person rather than guessed).

Every routine is created **disabled**. Nothing this catalog adds ever starts running on its own.

### 3. Integrations: a new field, and no Google lie

`integrations: readonly string[]` is unchanged -- plugin ids, validated against the plugin list, and
the six original rows are untouched. Beside it, `apps` carries what a bot page actually shows: the
app's name as the source wrote it, the label a person reads, this bot's own sentence about what it
does with it, the plugin id when we have one, and what the page may offer.

| offer | What the page draws |
| --- | --- |
| `connect` | the Add card, because there is something to install |
| `page` | an information line and **never** an Add, because that plugin installs nothing (the rule commit 1694a3f set for X, Meta, LinkedIn and Browserbase) |
| `byo` | the name as written, "not available yet", and the add-your-own door through custom-mcp |

**The full mapping, with the count of entries across the 65 shipped rows:**

| Name as the source writes it | Shown as | Plugin | Offer | Entries |
| --- | --- | --- | --- | --- |
| `Gmail` | Gmail | `google` | connect | 27 |
| `slack` | Slack | `slack` | connect | 26 |
| `notion-workspace` | Notion | `notion` | connect | 26 |
| `linear` | Linear | `linear` | connect | 26 |
| `Google Sheets` | Google Sheets | `google` | connect | 22 |
| `Slack` | Slack | `slack` | connect | 16 |
| `Google Calendar` | Google Calendar | `google` | connect | 15 |
| `Notion` | Notion | `notion` | connect | 15 |
| `figma` | Figma | -- | byo | 14 |
| `Granola` | Granola | -- | byo | 12 |
| `Salesforce` | Salesforce | -- | byo | 11 |
| `hex` | Hex | -- | byo | 10 |
| `X` | X | `x` | page | 5 |
| `Databricks SQL` | Databricks SQL | -- | byo | 4 |
| `Google Drive` | Google Drive | `google` | connect | 4 |
| `Gong` | Gong | -- | byo | 3 |
| `Profound` | Profound | -- | byo | 2 |
| `pstack` | pstack | -- | byo | 2 |
| `Ashby` | Ashby | -- | byo | 2 |
| `Google Slides` | Google Slides | -- | byo | 1 |
| `datadog` | Datadog | -- | byo | 1 |
| `sentry` | Sentry | -- | byo | 1 |
| `Ramp` | Ramp | -- | byo | 1 |

Slack appears under two spellings and Notion under two, and both spellings map to the one plugin. A
bot that names Gmail, Sheets, Calendar and Drive gets four app rows -- each with its own sentence,
which is what a person reads -- and one entry, `google`, in `integrations`.

**THE GOOGLE MEASUREMENT.** The `google` row's own description says "One process covering Gmail and
Docs", and its credential hint names only the gmail, documents and drive scopes. Mapping Sheets and
Calendar to it on the strength of the row's words would have been the CONNECT-13 defect this catalog
already names -- a connector that can only ever fail. So it was measured instead.

> **Measured on grok-bot-local-vm, 2026-09-09.** `npx -y google-workspace-mcp-server@1.4.3` spawned
> inside the box with invented credentials, `initialize` then `tools/list`: **34 tools**.
> `docs_get_document`, `docs_create_document`, `docs_batch_update`;
> `drive_list_comments`, `drive_create_comment`, `drive_reply_to_comment`, `drive_resolve_comment`,
> `drive_delete_comment`, `drive_list_files`, `drive_search_files`, `drive_get_file`, `drive_copy_file`;
> `sheets_get_spreadsheet`, `sheets_get_values`, `sheets_batch_get_values`, `sheets_update_values`,
> `sheets_append_values`, `sheets_create_spreadsheet`, `sheets_batch_update`, `sheets_clear_values`,
> `sheets_duplicate_sheet`, `sheets_create_pivot_table`;
> `gmail_list_messages`, `gmail_get_message`, `gmail_list_threads`, `gmail_get_thread`,
> `gmail_list_labels`, `gmail_create_draft`, `gmail_list_attachments`, `gmail_get_attachment`;
> `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_freebusy_query`.
> **No `slides_*` tool of any kind.**

So Sheets (11 tools, read and write) and Calendar (4 tools) map to `google`, and Slides does not --
it goes to the add-your-own door like any app we have no row for. The test pins all three.

**Two things that follow from that list and bite.** Calendar is **read only** on this server: it
lists calendars and events and answers free/busy, and there is no tool that creates one. Ten bots
carry the sentence "Search events and schedule meetings"; the searching works and the scheduling does
not. And the `google` row's credential hint tells an operator to authorize gmail, documents and drive
scopes, which is now short by the Sheets and Calendar scopes those 37 entries need. Both belong to
the plugin row, which this wave does not own. **Owner: the next connector pass. Next action:** add
`spreadsheets` and `calendar.readonly` to the `GOOGLE_REFRESH_TOKEN` hint, and say on the row that
calendar is read-only, so a person following it does not connect and then get a 403 on the first
Sheets call. **Proof:** a bot naming Google Sheets connects from its own page and the first
`sheets_get_values` call comes back with data rather than a scope error. This section is the item's
home until it lands as a row in `docs/GAP-ANALYSIS.md`; the wave hands that row to its integrator
rather than writing into a file six waves share.

**The app's own sentence.** 145 of the 244 entries carry a sentence written for that bot ("Keep the
ideas board, briefs, and question map where your team already writes"), and those are shown. 41 are
blank and 58 more repeat a vendor tagline verbatim across two or more bots ("Search, read, draft, and
manage email", "Notion Skills + Notion MCP server packaged as a ... plugin"). The rule is mechanical:
**a sentence that appears on two or more bots is the vendor's, not this bot's**, so it is dropped and
the page shows the plugin's own words. A sentence a person writes goes in the overlay; the generator
never invents filler.

### 4. The list is cards, the page fetches the row

**Measured on grok-bot-local-vm, 2026-09-09, before this wave:** the `listMarketplace` answer was
**110,564 bytes** with 24 plugins and 7 bots, and the console fetched it **twice** on one Marketplace
open. Its bot rows carried `instructions` and `skills` in full.

**Measured on this Mac, 2026-09-09, in process, with this wave's catalog built:** serving the 72 rows
whole is **996,262 bytes**, nearly a megabyte per panel opening on a relay that buffers each body
whole, per tenant. That is not a page being slow, it is a list paying for detail nobody is reading.

So `marketplaceCatalogWireView` projects each bot to a **card**: everything the row and its chips are
drawn from, plus a count per block so the page can say "7 skills" before it fetches them. The five
heavy fields come off -- `instructions`, `memories`, `skills`, `routines`, `apps` -- and a pack's
`members` are projected to `id`, `role`, `summary` and `reportsTo`. `integrations` stays: it is a
short list of ids and the chips have always been drawn from it.

**Measured on this Mac with the projection: 95,455 bytes** (54,146 of plugins, 40,988 of bots) --
smaller, with 72 bots in it, than the 110,564 the box serves today with seven.

The two numbers are the same quantity and not two different ones. The pre-wave catalog was rebuilt
straight out of git and serialized in process on this Mac: **110,564 bytes**, byte for byte what
`curl` measured off the box's own gateway. The box has no proxy, so `catalogForBox` is the bundled
catalog character for character, and there is no envelope between the two figures.

| | Plugins | Bots | `listMarketplace` |
| --- | --- | --- | --- |
| before this wave, on grok-bot-local-vm over HTTP | 24 | 7 | 110,564 B |
| before this wave, in process on this Mac | 24 | 7 | 110,564 B |
| after, in process on this Mac | 24 | 72 | **95,455 B** |
| after, if the rows were served whole | 24 | 72 | 996,262 B |

`getMarketplaceItem` serves the whole row and is untouched. It already existed, already worked, and
the console had never called it.

> **This is a contract change.** Anything that imports a bot must fetch its row through
> `getMarketplaceItem` first; a list card has no instructions, no skills and no memories. The type
> says so -- `MarketplaceBotCard` -- and `card.counts != null && card.skills == null` is how a
> caller holding one of each tells them apart. `scripts/verify-dashboard.mjs` and
> `scripts/verify-marketing.mjs` were changed in the same commit to fetch the detail row, and both
> merge the card underneath it so they still run against a bundle older than the projection. The
> live numbers after the projection get measured on the box and on the R750 at ship time.

---

## The rows

69 scraped, **4 dropped, 65 shipped**, plus the 7 first-party rows which stay and are shown first.

**The four dropped, and why a shorter catalog beats a broken bot.** Scrubbing the vendor's name out
of these leaves a bot whose skills and memories still describe machinery this product does not have.

| Dropped | Why |
| --- | --- |
| `tinkabot` | its whole job is packaging and publishing plugins into the old vendor's plugin directory |
| `dr-eggbot-v2` | its job is creating more of the old vendor's bots, through their own create-a-bot call |
| `researchy` | its method is shelling out to a signed-in vendor CLI on the machine, pinned to a vendor model |
| `alfred` | it governs a fleet of the old vendor's bots: its memories are an operating model for their org |

The second tier -- rows that name machinery we partly lack -- keeps its rows and takes prose
corrections through the overlay, with what is missing said plainly on the page.

**"From Grok Bot Team" is dropped as a category rather than renamed.** It is not a topic, it is the
upstream's own byline, and it was on 44 of the 69 rows. Folding it onto our "From Titanbot team" chip
would credit 43 named community creators to us, which is a worse error than the one the rename fixes.
Each bot keeps its topical category, a second category goes into `tags` so nothing is lost and the
chip filter reads both, and the four rows the scrape left with nothing else get one from the overlay
with a reason (`overheard` and `tradbot-2` had no category at all; `haggle-bot` and `dr-eggbot-v2`
had only the team byline, and the second of those is dropped).

Shipped categories: Sales 20, Marketing 16, Personal 13, Design 4, Operations 4, Product 3,
Engineering 3, Recruiting & People 2. `MARKETPLACE_BOT_CATEGORIES` gained Design, Product and
Recruiting & People, and **lost the duplicate "Marketing" entry it had been shipping** -- the list
goes out on the wire and the console draws one chip per entry, so the Bots half of the panel had two
identical Marketing chips filtering to the same rows.

**The creator stays**, as a credit line: `creator` is the person's name and `creatorNote` is
"from the community", so a row reads "by Adam Tanguay, from the community". The upstream account
handle is not shipped and neither is the creator's photo. One scraped description ended
"Created by @karenxcheng", which shipped that credit a second time as a handle on another product's
platform; the overlay strips it, and the generator fails on any string matching `Created by @handle`
so a re-scrape cannot bring it back.

**Tiles are drawn, never fetched.** `tile.file` is absent on every community row, so each one gets
the console's drawn face and nothing is fetched from the internet. The scrape's eleven colour words
and eighteen shape words are translated onto the product's palette and the four radii the console
knows, because eighteen shape drawings is UI work this wave does not buy.

| Scrape shape | Drawn as |
| --- | --- |
| egg, dome, pebble, blob, bean, cloud | `circle` (50%) |
| squircle, capsule, teardrop, leaf, gem, crystal | `squircle` (30%) |
| tablet, arch, cylinder, shield | `rounded` (18%) |
| hex, wedge | `square` (8%) |

Colours: blue `#7cb0f5`, green `#5fca8f`, violet `#a996f5`, magenta `#ef8fc0`, orange `#f2a765`,
gray `#c3cad6`, cyan `#79d7ea`, red `#f0999b`, black `#9aa4b2`, brown `#cfa47e`, yellow `#e8cf6a`.
None of them is a dark tone: the console paints the drawn face in near-black, so a literally black
tile would be a blank square with an invisible face on it, and "black" therefore becomes the lightest
graphite that still reads as the achromatic tile of the set.

**Skills.** All 263 shipped community skills arrived as a name and a one-line description with no
playbook body -- the source's `content` field is a copy of its `description` on every one of them. The
generator writes a SKILL.md from the description in a fixed template whose last section, **"Written
from a summary"**, says exactly that and tells the bot to sharpen it after its first real run. The
document is namespaced by the bot id (`seo-aeo-desk-getting-started`), because sixty-five packs that
each ship a "Getting started" would otherwise fight over one document in the box's shared library;
`skillPrefix` on the row is that namespace, and the name a person reads stays the human one.

Fifteen shipped rows carry no skill at all and sixteen name no plugin we have. Both are fine for a
community row and are still defects on one of ours: `validateMarketplaceCatalog` scopes those two
rules to `origin !== "community"`, and requires instead that a community row carry at least one of
memories, skills or routines -- a row an import could do nothing with is still a problem.

---

## Titan and the catalog (TITAN-CATALOG-1)

Jason, 2026-09-09: *"Titan should be able to see all connectors and all the agents as a catalog.
When creating a new agent, it should be able to pull from those templates."* Titan had filed the
same thing himself two minutes earlier: he could create a blank agent and read a profile, but "a
template system where you pick a pre-built role and it comes with a starter persona, memory seeds,
and maybe connector configs, that's not here yet."

He was right, and the reason was structural, in two places at once. The whole of the Add sequence
lived in the browser, in `ui/machine-room/bot-setup.js`, so nothing in the box could run it. And
nothing in the box could SEE the bots half of the catalog either: the plugin half already had eleven
tools, the bot half had none. This wave is both halves, and they only work together -- a bot that can
read the catalog but not import from it can still only build blank.

### One import, two doors

The sequence moved into the box, unchanged, as the gateway verb `importMarketplaceBot`
(`source/host/extensions/marketplace/marketplace-bot-import.ts`). The console's Add calls it and
the agent's tool calls it, so there is one implementation and no way for the two to disagree.

```
importMarketplaceBot { id, name?, duplicate? }
  -> { state, alreadyExisted, agent{id,name}, agentId, name,
       memories{added,duplicates,rejected[]},
       skills{imported[],reused[],skipped[]},
       routines{created[],notCreated[]},
       apps{connected[],addable[],informational[],byo[]},
       integrations{connected[],offered[],informational[],unavailable[]},
       message, rolledBack? }
```

**It takes an id, not a row.** The row is resolved inside the box with `findMarketplaceBot`. A
caller holding a list CARD — which carries no instructions, memories, skills, routines or apps —
cannot hand one back and quietly create a description-only agent holding nothing. That is the first
entry under "What bites", made impossible rather than documented.

**`apps` is the console's four buckets and `integrations` is the same thing as plain names.** The
panel card draws the first; a person, and an agent reporting to one, reads the second.

The order, the idempotency, the " copy" behaviour, the rollback, the persona composition, the fact
splitting, the frontmatter naming, the cron rule and the plain-words receipt all moved across
intact. They are pinned by `tests/host-marketplace-bot-import.test.mjs` against a fake box, which is the
only honest place to pin an order, and by `scripts/verify-titan-catalog.mjs` against a real one.

### What the console kept

`bot-setup.js` is 125 lines now: the roster read the page does before it offers Add, one call, and
two sentences a browser has to be able to say for itself — a box older than the console (the relay
serves one console to every workspace, and a box that has not been updated does not carry the verb),
and a box that answers with nothing. `tests/bot-setup.test.mjs` asserts the file names none of the
ten writing commands, because a thin caller that quietly regrows the eight steps would pass every
other case in that suite.

`marketplace-bots.js` was not touched: it still calls `setUpBot(gateway, bot, {duplicate,
onProgress})` and still renders the same receipt fields.

### The app-shape defect, found twice on one evening

`planApps` read `row.pluginId` and `row.description`. A catalog app row carries `plugin` and `line`
(`MarketplaceBotApp`, catalog.ts). Every app on every generated row therefore fell past the
connected and addable branches into the add-your-own bucket.

**Measured against the live host's own `getMarketplaceItem` answer for `account-book` on
grok-bot-local-vm 2026-09-09:** the host served 11 app rows, 7 of them carrying a `plugin` id and 0
carrying a `pluginId`, and the shipped code put all 11 in `byo` — Slack, Notion, Linear, Hex,
Databricks SQL, Gmail, Google Calendar, Granola, Google Drive, Google Sheets and Salesforce. So the
receipt told a customer that Slack "is not something we carry yet, so you would add your own" for
apps this box carries and may already have installed. Roughly 177 of the 244 app entries across the
65 community rows carry a plugin id and every one of them was misreported.

BOTS-4b found the same thing on the same evening, from the other end — one press
of Add on `mr-toms` on the R750 demo tenant — and fixed the console's reader by normalising both
spellings in `appsOf`. The two fixes are not a duplicate: theirs keeps the page honest for as long
as the page reads a row itself, and this one moves the reading into the box, where both doors get it.

The second half of the same defect is this wave's alone: `installedPluginIds` was an option **no
caller in the product ever passed** (the page computes the installed set for its own chips and never
handed it over), so `connected` was empty even on the six first-party integrations-only rows, whose
path otherwise worked.

Both are fixed in the move rather than ported. The verb reads `plugin` and `line` first, keeps
`pluginId`/`description` as fallbacks so an older row still resolves, and **derives installed state
itself** — `connectors.json` for a connector, a binary probe for a shell tool, through the same
reader the plugin tools use. There is no argument left for a caller to forget. The regression case
is fed `findMarketplaceBot("account-book")` straight out of the bundled catalog rather than a
fixture, because a hand-written fixture in the report's own vocabulary is exactly what kept the old
suite green over this.

### A team pack does not come through this door

A pack is several agents with a coordinator and a reporting line, and that sequence lives on the
Bots tab (`marketplace-bots.js`, the Import team button). Through the verb it would make ONE agent
carrying the pack's name and none of its members, which looks like it worked, so the verb refuses a
row carrying `members` in plain words and points at the page. The Bots tab already routes packs
away from `setUpBot`, so nothing in the console reaches that refusal.

### The seam between the two halves

The import lives in the box and the tools live in the runner, and for most of a day neither could
reach the other. The runner composition looked for the import on the transcript manager, which does
not carry it and cannot: the adapter it runs against is built inside the gateway api out of
`mintAgent`, `removeAgentCompletely`, `createAutomationFor` and the host's own `kickstartIfPending`,
none of which the composition can reach. So the setup tool was never built on a real box. A bot
could read the whole catalog and still only create blank agents, which is the thing this wave
exists to stop, and nothing in either half's tests could see it — the two read-only tools still
built, so every case stayed green.

The composition takes the importer late now instead of discovering it, and the host hands it in as
soon as it holds both objects, which is before any turn can run. Building a second adapter in the
composition was the alternative and is refused in a comment there: it would differ in agent
teardown, automation attribution and the introduction, which is the drift the wave exists to end.
Three cases guard the wiring, because a broken line there fails nothing else.

### What the bot can see now

A door in the box is no use to someone who never opens the Bots tab and instead just says to their
bot "create me an Instagram marketer".

**Measured before this wave, grok-bot-local-vm, bundle `df1300366eb2`, 2026-09-09.** A fresh agent
asked exactly that made ONE tool call, `CreateAgent`, and shipped an agent with a persona the model
invented on the spot, 0 memories, 0 routines, no playbooks and no template. It never looked at the
catalog and never mentioned that ready-made bots exist. Three tools in `source/host/runner/tools/sand-catalog-tools.ts`:

| It does | What comes back |
| --- | --- |
| looks through the catalog | every bot as a card -- id, name, category, its one line, the counts of the four blocks, and each app it wants with whether this box has that plugin -- plus the app connectors, ranked against what the person actually asked for |
| reads one in full | the whole row: the persona, the facts, the playbooks, the jobs with their cadence, and every app with THIS bot's own sentence about what it does with it |
| sets one up | the host verb, which runs the same eight-step sequence the Add button runs, and answers what it made and what could not be connected |

The plugin half of the same catalog already had eleven tools (`SearchPlugins`, `GetPlugin` and the
nine lifecycle ones); this is the bot half, which had none. The two read-only tools resolve the row
in process through `findMarketplaceBot`, never from anything the model hands back, because a list
card carries no instructions, memories, skills, routines or apps at all and importing from one would
create a description-only agent with nothing in it.

### The question, in the words Jason asked for
 One paragraph in the standing persona and two lines
in the onboarding seed skill, both in first person and neither naming a tool: look at what the
catalog already carries, name the two or three closest with a line each, and ask *"would you like
one of those, or one built from scratch?"* -- then set it up and say what it came with and what
still needs connecting. It sits in the general block of the persona, not behind the lead marker,
because the tools are offered on the same predicate `CreateAgent` has always used.

### What an answer costs

**Measured on this Mac 2026-09-09 against the shipped catalog:** a
query ("create me an Instagram marketer") ranks 19 rows, shows the best 15 and costs 5,884
characters; one template in full is 7,717 (`account-book`); and the whole catalog with no query at
all is 26,363 characters over 335 lines. The tool's own description tells the model to say what the
person asked for, because "everything" is the expensive answer and is almost never the useful one.

### Two things that bite here

- **There is no Instagram bot.** One row in the whole catalog mentions Instagram and it is a pack.
  The literal word "marketer" appears in no id, name or category, so a whole-word match on the
  sentence in the report returns NOTHING -- which leaves the model with nothing to offer and sends
  it straight back to building blank, the original bug wearing a tool. Query tokens are therefore
  matched on their first six characters, which is what makes *marketer* and *Marketing* one stem.
  For the same reason `scripts/verify-titan-catalog-tools.mjs` asserts that the reply names rows that
  exist in `listMarketplace`, and never a particular id.
- **A quiet chip is not free.** Every `defineCommunicateTool` tool rides the proto case
  `communicateUpdateToolCall`, and the console's `NOT_A_RECEIPT` filter drops every outline row
  matching `/communicate/` before it renders -- so built the obvious way these three would have
  drawn nothing at all. They ride three unclaimed proto cases instead (`getAgentStatusToolCall`,
  `readAgentTranscriptToolCall`, `createAgentToolCall`, none of which anything else in this product
  builds), and the console gives each a fixed sentence with an EMPTY detail: *Looked at the
  catalog*, *Read a template*, *Set up &lt;name&gt; from the catalog*. The template's name reaches the
  page only through the call's own args, the way the mail chip takes its recipient out of `message`.
  That is the FEEDBACK-1 / MAIL-3 pattern, and a test pins both halves so a rename on either side is
  a red test rather than a proto name on a customer's screen.

### Three things only running the two halves together found

Each of these was measured on grok-bot-local-vm on 2026-09-10 by asking a fresh bot "create me an
Instagram marketer" and then answering "use the template". Neither half could have found any of
them alone: the tools half had no import to call, and the import half was never driven by a model.

**A team was offered and could not be delivered.** Ranked in with everything else, `marketing-team`
comes back FIRST for that sentence, because it is the best answer to it. The bot offered it, was
told to use it, and the import refused it — a team is several bots with a coordinator and goes on
from its own page with all its members at once. Teams are listed under their own heading now, which
says where they are added, so the person still hears that one exists.

**And the bot then said it had worked.** Handed that refusal back as a SUCCESSFUL tool call whose
message happened to be bad news, it answered *"Done — Marketing team is set up and on your roster"*
and invented a reason it was empty. Nothing had been created. The case is what a model reads first,
so no wording inside a success fixes it: a report that created no agent is an error now.

**And the question was never asked.** Told in prose, in three separate places, to ask whether they
want one of those or one built from scratch, a bot named three rows and stopped — no question mark
anywhere in the reply. It had found the choice and never put it to the person, which is the half of
Jason's sentence that makes the other half worth anything. The question is QUOTED for the model to
copy now, and it is the last thing either read tool says.

### And four more the review found, all in the bot's own sentence

Measured on this Mac on 2026-09-10 by driving the real verb against the sequence suite's fake box
and handing its REAL report to the real tool. Every one of these was a place where the console's card
and the bot's words disagreed about the same import, which is the one thing this wave exists to make
impossible.

**The counts were all zero.** The tool's reader accepted `memories` as a number or a list. The verb
answers `memories {added, duplicates, rejected}`, `skills {imported, reused, skipped}` and
`routines {created, notCreated}` -- objects -- so all three collapsed to 0 and a bot told a customer
*"It knows 0 fact(s), brings 0 playbook(s) and carries 0 job(s)"* about an import that had written 7
facts, 11 playbooks and 3 jobs. The card on the same report said seven. The fix is not a second
counter: the tool prints `report.message`, the one plain-words receipt the import composed, which IS
what the card draws. A counter written on the reading side is a counter that can disagree.

**A job the box could not schedule went unmentioned.** The reader looped `report.notCreated` and
printed `missed.reason`; the verb puts them at `report.routines.notCreated` with the field named
`why`. Wrong path and wrong field, so the loop never ran once. `deal-hunting` carries a routine with
no cron: the card said *"1 job could not be set up because it waits on something rather than a
clock"* and the bot said nothing at all.

**An all-page-only row read as wanting no apps.** Apps come back in FOUR buckets -- connected,
addable, page-only, bring-your-own -- and both sentences counted three. `tech-demos` and `webby`
carry nothing but page-only apps, so both doors printed the positive claim *"It needs no apps
connected"* about a bot that does want one. Page-only apps are named now, on the card and in the
bot's words, and "needs no apps" is said only when all four buckets are empty.

**And the question fired on a browse.** Jason's sentence has two halves -- *"Titan should be able to
see all connectors and all the agents as a catalog"* AND *"when creating a new agent ... ask"* -- and
the first had been wired to the second: the quoted question was appended to BOTH read tools
unconditionally, so somebody asking "what connectors do you have?" was answered with an offer to
build a bot and told that nothing would be set up until they chose one. It is conditional now, with
the quoted sentence kept verbatim because quoting it is what measurably made the model ask it at
all, and the browse-only case named in the same breath. A leg in the box gate asks exactly that
question and reads the answer.

Two smaller ones from the same pass. The listing text NAMED two tools to the model (*"SearchPlugins
lists them"*, *"Full detail on a connector is in GetPlugin"*) and the gate's no-tool-names regex
listed neither, so a model relaying one would have put a tool name on a customer's screen with the
gate green; the strings say it in plain words now and both names are in the regex. And the story that
"an older box withholds the setup tool" was never reachable: `host-gateway-api.ts` declares
`importMarketplaceBot` unconditionally and `sand-host.ts` hands it to the composition before any turn
can run, so every running box builds all three tools. The claim is gone from the four places that
carried it, and a box that answers no to the verb is now a FAILED gate leg instead of a skipped one.

### What the gates assert, and where

Two scripts, because the two halves are measured differently: `scripts/verify-titan-catalog.mjs`
drives the import verb against a real box, and `scripts/verify-titan-catalog-tools.mjs` drives a
real turn and reads what the bot said. Both send `titanbot-gate/<script-name>` and both take the
box lock, so they run one at a time.


`scripts/verify-titan-catalog.mjs` on grok-bot-local-vm: the verb sets a real catalog row up; the
box is read back and every fact is compared character for character (the store slices over its cap
and says nothing); every job is on the box and switched off; **no app naming a plugin is ever
reported as one we do not carry**; the same bot goes in again through `bot-setup.js` loaded into
the gate process and the two agents are compared field for field; a third press writes nothing; and
the bot's own introduction is waited for. **Measured 2026-09-09: 34 PASS, 0 FAIL, exit 0**, with the
bot's own words 15 s after the import. Everything it creates is taken back, and the check is that the
bots THAT RUN made are off the roster — never that the roster count matches, because another wave was
driving the same box that evening and its scratch agents came and went under the run.

On the R750 demo tenant the introduction leg is NOT asserted. `BOX-7` is measured: that box starts
no introduction for any new agent, including a plain one created with `isKickstartRequested: true`.
There the claim is the roster row, the memories, the playbooks, the jobs switched off, and the
receipt's wording about apps.

`scripts/verify-titan-catalog-tools.mjs` on the same box: the bot looked at the catalog before it
answered, read templates in full, asked whether they want one of those or one built from scratch,
named only rows that exist in that box's own `listMarketplace`, created nothing while it was still
asking, let no tool name reach the person, and still built one from scratch when that is what was
asked for. **Measured 2026-09-09: 7 legs PASS, 0 FAIL.** Its final roster check fails loudly rather
than swallowing a box that stopped answering -- an earlier draft used `.catch(() => [])` and would
have printed that the roster was clean over bots still on it.


**Measured on the R750 demo tenant through console.titanium.bot, 2026-09-10, bundle
`e13cc0bf6a07`**, signed in as a throwaway customer account on the `demo` workspace that was
removed afterwards. Asked "Create me an Instagram marketer", the demo Titan looked at the catalog
and came back with *"Stills & Clips Desk, Clip Bot, Marketing team — which one should I go with? Or
if you'd rather I just build an Instagram marketer from scratch, say the word"*, and put the same
choice up as a card with a button per template. Pressing one set it up: the transcript drew the
quiet chip **Set up Instagram Marketer from the catalog** in plain words with nothing to expand,
the bot appeared on the roster reading "Ready for the next task" with 1 routine and 26 skills, and
the receipt said *"It came with Slack already connected"* — the app-shape fix, live, on the door a
customer actually uses. Read back on that box, both bots carried the row's facts and their jobs
with `isEnabled: false`. Neither wrote a first message, which is `BOX-7` and is why that leg is not
asserted there. Both bots and the account were removed afterwards; the roster is back at 8.

**Titan's own report is closed.** He filed it himself through the Report-a-problem card on
2026-09-10T01:56:56Z from the `titanium` workspace: **feedback report #5, "No bot template system
visible to Titan — BOTS-1 not yet landed"** (*"a template system where you pick a pre-built role
(Instagram Marketer, Scribe, Research Agent, etc.) and it comes with a starter persona, memory seeds,
and maybe connector configs, that's not here yet"*). It was marked closed in the control plane's
Feedback panel on 2026-09-10 once this wave was live on that box.

---

## The plugin roadmap (MARKET-40)

The apps these 65 bots ask for, in demand order, counted over the scrape's 246 entries. This wave
builds none of them; it makes the demand visible and maps by name, so each row flips from
"not available yet" to Add on its own the day the plugin lands.

| # | App | Entries | Have it? |
| --- | --- | --- | --- |
| 1 | Slack | 42 | yes |
| 2 | Notion | 41 | yes |
| 3 | Gmail | 27 | yes, through Google Workspace |
| 4 | Linear | 26 | yes |
| 5 | Google Sheets | 22 | yes, through Google Workspace (measured above) |
| 6 | Google Calendar | 15 | yes, read only (measured above) |
| 7 | Figma | 14 | **no** |
| 8 | Granola | 12 | **no** |
| 9 | Salesforce | 11 | **no** |
| 10 | Hex | 10 | **no** |
| 11 | X | 5 | a page, not an install |
| 12 | Databricks SQL | 4 | **no** |
| 13 | Google Drive | 4 | yes, through Google Workspace |
| 14 | Gong | 3 | **no** |
| 15 | Profound | 2 | **no** |
| 16 | pstack | 2 | **no** |
| 17 | Ashby | 2 | **no** |
| 18 | Google Slides | 1 | **no** (the installed server carries no slides tool) |
| 19 | Datadog | 1 | **no** |
| 20 | Sentry | 1 | **no** |
| 21 | Ramp | 1 | **no** |

Thirteen names with no row: Figma, Granola, Salesforce, Hex, Databricks SQL, Gong, Profound, pstack,
Ashby, Google Slides, Datadog, Sentry, Ramp. **Owner: the marketplace pass after this wave. Next
action:** verified plugin rows in that order for the ones with a usable MCP or API today, each with
the credential shape and the "what you must do first" block MARKET-26 introduced. **Proof:** the SEO
desk's six integrations all offer Add on the demo tenant.

---

## What the page draws, and the words on the controls

**The row is titled by the app the bot names, not by the plugin that covers it.** One plugin covers
several surfaces -- Gmail, Google Calendar, Google Sheets and Google Drive are all the Google
Workspace connector -- and titling each row with the plugin drew three rows that were the same
string end to end, each with its own Add. Measured on the R750 demo tenant 2026-09-09: Account
Research Desk drew four Google rows, three of them identical, and 23 of the 65 community rows draw
two to four. So the title is the surface (`Gmail`), the plugin is named under it ("through Google
Workspace"), and **only the first row for a plugin carries the Add** -- the rest say "the same
connection as above", because the second press would install what the first already did.

**No app row is ever drawn without a line.** The generator demotes a sentence that repeats verbatim
across bots -- that is the app vendor's tagline rather than this bot's reason -- but it no longer
drops it: it ships as `fallbackLine`, and the page draws `line`, then `fallbackLine`, then the
plugin's own tagline. Before that, 99 of the 244 app rows had no line and 19 of those had no plugin
to fall back on either, so the page drew a name, "not available yet", and nothing that said what the
app was. For an app the scrape gives no sentence at all and we carry no plugin for, the mapping table
in the generator carries an `about` line of our own (Granola, Salesforce); the build fails on any
new name that would go out bare, which asks a person for one line rather than shipping an empty row.

**The Skills and Routines blocks are not truncated.** The list rows and the cards run their text
through `oneLine`, which cuts at 140 characters, because one line is the promise there. On the bot's
own page the "Use when…" sentence IS the block: 108 of the pack's 263 skill descriptions are longer
than that (the longest 436) and 19 of the 104 routine summaries are, so both are drawn whole and CSS
wraps them.

**"On the roster" comes off the box, not off this browser session.** The tab does one `listAgents`
read when it opens and matches by name, the same match the setup's own roster check uses. Without it
every one of the 72 rows drew Add again on any fresh page load, and the only way to find out was to
press one and read the refusal. A team pack is never one agent, so the roster names are not consulted
for one.

**The words on the controls.** A list row draws a round **Add**; a bot's own page draws **Import
Bot**; a team pack draws **Import team (n)**. The first two differ deliberately -- they are the two
controls in Jason's screenshots, and the page's word is the same verb the pack beside it uses, so the
tab never offers "Add bot" here and "Import team" there for the same gesture. The intro sentence
names both.

## What bites

- **The list is a card now.** A row fetched from `listMarketplace` has no `instructions`, `skills`,
  `memories`, `routines` or `apps`. Anything that imports a bot has to call `getMarketplaceItem`
  first. Code that imported straight off the list will silently create an agent with a
  description-only persona and no skills.
- **`addMemory` returns null on a duplicate and `upsert` returns null at the cap, both silently.**
  Read every write back (`getAgentMemories`, `getAgentWorkflows`, `getAgentAutomations`) before
  reporting what you set up, or the report is a guess.
- **A trigger that will not normalise writes nothing and still answers 200.** That is why a schedule
  is a cron resolved at build time and never the prose. The bare word "weekly" is accepted, stored,
  and never runs.
- **`describeSchedule` hands back the raw expression** when it cannot render one as words. A cron the
  console can only show as `0 9 1 1,4,7,10 *` is a cron this catalog does not emit.
- **A skill document name is clamped at 80 characters** by the host, silently. The longest namespaced
  name in the pack is 54, and the test pins the limit so a longer bot id does not start colliding.
- **Calendar is read only** on the Google server this catalog installs, and its credential hint is
  short by the Sheets and Calendar scopes. Both belong to the plugin row, which this wave does not
  own; the owner and the next action are under "The Google measurement" above.
- **The generated module is 945 KB of TypeScript.** That is data, not code, and it is
  what a checked-in generated file costs when the diff has to stay reviewable. It bundles into a
  20 MB host and the wire never sees more than a card of it.
- **Do not edit `community-bots.ts`.** The test regenerates it and compares byte for byte. Edit the
  overlay, with a `why`, and rerun the generator.

- **The All view draws six rows per section, not all of them.** Measured on
  grok-bot-local-vm and on the R750 demo tenant, 2026-09-09: 40 of the 72 rows are on screen
  in the All view; the rest are behind that section's own "See all N in <category>" chip or the
  search box. Anything automated that looks for a bot on the list must search for it by name or
  press its chip. A check that asserts "every bot is on one screen" was true of seven rows and is
  not true of 72.
- **A read still in flight is not a read that failed.** The page paints the card while
  `getMarketplaceItem` is running. Until 2026-09-09 the four blocks said the row "could not be read
  from the host" during that window and told the person to close the page. Any new block on this
  page has to distinguish pending from failed, or it will lie for as long as the fetch takes.
- **The app buckets hold apps, not names.** `apps.addable`, `apps.byo` and `apps.informational`
  carry `{name, label, description, pluginId}`. Rendering them through a string helper prints
  `[object Object]`, which is what the setup receipt did on its first live run.
- **The catalog writes `plugin` and `line`; both readers want `pluginId` and `description`.** The
  generator emits an app row as `{name, label, line, fallbackLine, plugin, offer}`. The page half
  (`marketplace-bots.js` `appsOf`) and the setup half (`bot-setup.js` `appsOf`) each normalise both
  spellings. Anything new that reads `bot.apps` must do the same: the setup half did not, so every
  generated app arrived with an empty plugin id, fell into the add-your-own bucket, and the receipt
  told a customer that Slack, Notion, Linear, Gmail, Google Calendar and Google Sheets are apps we
  do not carry -- on the same page that had just drawn an Add for them. Every fixture in the suite
  wrote the reader's spelling, so it was green throughout; the shape is now pinned against a real
  catalog row in `tests/community-bots.test.mjs`.
- **The setup reports lists, not counts.** `skills.imported` and `skills.reused` are arrays of
  document names. `Number([...])` is `NaN` and `NaN > 0` is false, which silently dropped the
  playbook clause from every receipt of every bot while the sentence under it, built from the same
  lists, named them correctly. The card counts either shape now, and the gate fails a receipt that
  names no playbooks for a row that carries some.
- **The receipt says facts, the block says memories, and both are right.** The Memories block draws
  the catalog's paragraphs; the store holds the facts those paragraphs were split into at the host's
  500-character cap. Recruiting Coordinator is 5 paragraphs and 8 facts. Anything that counts one
  and labels it the other reads as a page disagreeing with itself.
- **A team pack seeds no memory store.** Its import creates one bot per member with that member's
  own written brief as its identity and never calls `addAgentMemories`. The Memories block on a pack
  says so; the single-bot footnote would be a promise the press does not keep.
- **There is a third reader of `bot.apps` now, and it is in the box.**
  `source/host/extensions/marketplace/marketplace-bot-import.ts` reads an app row for the gateway
  verb both doors go through, and it reads `plugin` and `line` first with the two console spellings
  as fallbacks. Its regression case is fed `findMarketplaceBot("account-book")` straight out of the
  bundled catalog rather than a fixture, because a fixture written in the reader's own vocabulary is
  exactly what kept this green.
- **And the same rule binds a check over a REPORT, not just over a row.** The catalog tools' own
  suite fed `describeImportReport` a hand-written `{memories: 4, skills: ["a","b"], routines: 3}` --
  a vocabulary the verb has never returned -- and every count the bot read back was 0 for as long as
  that was the only case. A case about what a bot says after an import drives the real
  `importMarketplaceBot` against the shared fake box (`tests/helpers/host-marketplace-import.mjs`,
  `fakeMarketplaceBox`) over a real catalog row, and asserts over THAT report. The hand-written one
  stays, labelled for the only thing it can honestly pin: the older loose shapes.
- **The bot's sentence and the card's sentence are the same string.** `report.message` is composed
  once in the host and both doors print it. Anything that counts the report again on the reading side
  is a second opinion about the same import, and the first one disagreed with the card for a day.

## What is not proven yet

**The bot's own first message does not appear on the demo tenant's box.** Measured on the R750,
2026-09-09, box `titanbot-box-atonqjq7zx593jsacaccpfau`: after Add, the agent is on the roster with
its facts, playbooks and jobs, and nothing is ever written to its conversation. A PLAIN agent
created with `isKickstartRequested: true` and then kickstarted on that same box answers
`{"isIntroductionInFlight": false}` and writes nothing in 180 s either, so the introduction is not
something the bot setup broke — that box starts no introduction for any new agent.

On grok-bot-local-vm the same sequence works and the words are the bot's own, roughly 60 s after the
press: *"Hey! I'm your account researcher. I dig into the companies you sell to and hand you back
call briefs, stakeholder maps, and account plans worth using. Everything I pull off the web comes
with a source and a date, so you always know what's solid."* followed by a question about what the
person sells. That box answers `{"isIntroductionInFlight": true}` and reports 8 healthy endpoints.

Owner: whoever next has the demo tenant. Next action: find out why that box declines to start an
introduction (the endpoint it is pinned to, or a host setting), and re-run the Add there. It is
filed as `BOX-7` in docs/GAP-ANALYSIS.md.
