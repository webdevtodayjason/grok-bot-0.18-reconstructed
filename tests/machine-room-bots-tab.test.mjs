// BOTS-4 / item C: the Bots tab and the bot page, pinned as the markup a person is handed.
//
// WHY THESE ARE STRINGS RATHER THAN SHAPES. Jason gave the four blocks their words -- Memories
// "Facts it already knows", Skills "Playbooks it can run", Routines "Jobs that run on their own",
// Integrations "Apps it can use" -- off six screenshots of the product this catalog came from. A
// test that asserted "there are four blocks" would pass on a page that said "Knowledge" and
// "Automations", which is a different promise to the person reading it. So the labels and the
// hints are compared as literal text, and changing one is a deliberate edit here as well.
//
// AND WHY THE MARKUP SHAPE. Three of these pin structure that a passing page.click() cannot:
//
//   - the row's Add is a SIBLING of the row's open button, inside a div. Chrome honours a click on
//     a button nested in a button and fires both handlers, so a nested Add would open the bot page
//     AND start the setup on one press -- and a click driven by a script would look fine.
//   - a category chip is `.tag` inside `.palette-chips.marketplace-chips`, which is what the
//     Plugins half of the same panel draws against CSS that has been in styles.css since MARKET-1.
//     It was `.roster-tab`, the big underlined pill the panel's own tab switch uses.
//   - a chip with no members is not drawn at all. The host's declared list is a superset of what
//     any one box serves, and a chip that empties the page is a control that cannot work.
//
// The module is an IIFE that attaches window.__marketplaceBots and touches nothing at load, so it
// is loaded here exactly the way tests/helpers/marketing-team-console.mjs loads it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBotsTab() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/marketplace-bots.js"), "utf8");
  const win = {
    fetch: async () => { throw new Error("the render paths must not reach the network"); },
    Element: class {},
    document: null,
    __machineRoomLive: true,
  };
  const module = new Function("window", `${source}\nreturn window.__marketplaceBots;`)(win);
  if (module == null || typeof module.preview !== "function") {
    throw new Error("marketplace-bots.js did not export its render preview");
  }
  return module;
}

const bots = await loadBotsTab();

// ---------------------------------------------------------------- the fixture
//
// Three rows shaped like the three the gate picks off the live catalog: one with routines, one
// with an app this box has no plugin for, one that carried two categories upstream.
const SEO = {
  id: "seo-aeo-desk",
  name: "SEO & AEO Desk",
  creator: "Adam Tanguay",
  creatorNote: "from the community",
  community: true,
  category: "Marketing",
  tags: ["Sales"],
  featured: false,
  tile: { color: "#3fb950", shape: "squircle" },
  description: "Turns your keywords into content ideas and writer-ready briefs.",
  instructions: "I run the search side of your content program.",
  memories: [
    { text: "I run the search side of your content program. I find what people search and ask, rank the opportunities, and write briefs your writer can work from." },
    { text: "I don't write the finished article and I don't publish anything. I talk plain and short, and I ask one question at a time." },
  ],
  skills: [
    { name: "Getting started", description: "Use on the first conversation after setup.", body: "# Getting started" },
    { name: "Keyword and question research", description: "Use when the user pastes keywords.", body: "# Keywords" },
  ],
  routines: [
    { name: "Weekly search report", summary: "Disabled by default. Every Monday morning, what moved last week.", schedule: "0 9 * * 1", scheduleNote: "Every Monday at 09:00" },
    { name: "Topic watch", summary: "Speaks up only when a new question worth a page shows up.", schedule: null, scheduleNote: "" },
  ],
  integrations: ["notion", "slack"],
  apps: [
    { name: "notion-workspace", label: "Notion", line: "Keep the ideas board, briefs, and question map where your team already writes.", pluginId: "notion", offer: "connect" },
    { name: "slack", label: "Slack", line: "Post the weekly search report to a channel you choose.", pluginId: "slack", offer: "connect" },
    { name: "X", label: "X", line: "Watch what your buyers are asking out loud.", pluginId: "x", offer: "page" },
    { name: "Profound", label: "Profound", line: "Read how AI assistants answer for your category.", pluginId: "", offer: "byo" },
  ],
};

// Three surfaces of one plugin, the shape 23 of the 65 community rows carry.
const GOOGLE_APPS = [
  { name: "Gmail", label: "Gmail", line: "Search, read and draft mail.", pluginId: "google", offer: "connect" },
  { name: "Google Calendar", label: "Google Calendar", line: "Book and move meetings.", pluginId: "google", offer: "connect" },
];

const OURS = {
  id: "research-desk",
  name: "Research desk",
  creator: "Titanbot team",
  category: "From Titanbot team",
  featured: false,
  tile: { color: "#31b6b8", shape: "circle" },
  description: "Runs a web research pass and comes back with sourced notes.",
  instructions: "Search before you answer.",
  memories: [{ text: "Search before you answer, and cite every claim with the page you read it on." }],
  skills: [{ name: "Web research brief", description: "Search, read, summarise.", body: "# brief" }],
  routines: [],
  integrations: [],
};

const PLUGINS = [
  { id: "notion", name: "Notion", tagline: "Read and write pages in a Notion workspace.", kind: "connector" },
  { id: "slack", name: "Slack", tagline: "Read and post in Slack channels.", kind: "connector" },
  // The rule commit 1694a3f set: a row that installs nothing gets no Add, anywhere.
  { id: "x", name: "X", tagline: "What the vendor requires of you before anything can post.", installsNothing: true },
  { id: "google", name: "Google Workspace", tagline: "Gmail, Docs and Drive through one server.", kind: "connector" },
];

const CATALOG = {
  bots: [OURS, SEO],
  plugins: PLUGINS,
  categories: ["Featured", "From Titanbot team", "Marketing", "Sales", "Recruiting & People"],
};

const escapeText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const list = (extra = {}) => bots.preview({ ...CATALOG, ...extra }, "list");
const page = (botId, extra = {}) => bots.preview({ ...CATALOG, botId, ...extra }, "page");

// ---------------------------------------------------------------- 1. the four blocks
test("the rail is four blocks, in this order, in the words Jason used", () => {
  assert.deepEqual(bots.BOT_PAGES.map((entry) => [entry.id, entry.label, entry.hint]), [
    ["memories", "Memories", "Facts it already knows"],
    ["skills", "Skills", "Playbooks it can run"],
    ["routines", "Routines", "Jobs that run on their own"],
    ["integrations", "Integrations", "Apps it can use"],
  ]);
});

test("the page draws all four and opens on Memories", () => {
  const html = page("seo-aeo-desk");
  for (const entry of bots.BOT_PAGES) {
    assert.ok(html.includes(`data-bot-tab="${entry.id}"`), `${entry.id} is not on the rail`);
    assert.ok(html.includes(`<strong>${entry.label}</strong><small>${entry.hint}</small>`), `${entry.label} is not drawn in its own words`);
  }
  assert.ok(html.includes('class="plugin-nav-button is-active" type="button" data-bot-tab="memories"'), "the page did not open on Memories");
  // Instructions is gone as a block, and so is the footnote that described it.
  assert.ok(!html.includes('data-bot-tab="instructions"'), "the Instructions block is still on the rail");
  assert.ok(!html.includes("How this Bot should work"));
  assert.ok(!html.includes("which is the only field this host feeds the model"));
});

test("the pack rail gains Memories as its first entry and keeps everything else", () => {
  assert.equal(bots.TEAM_PAGES[0].id, "memories");
  assert.deepEqual(bots.TEAM_PAGES.map((entry) => entry.id), ["memories", "members", "firstrun", "instructions", "skills", "integrations"]);
});

// ---------------------------------------------------------------- 2. memories
test("memories are paragraphs of prose, with no heading and no bullet", () => {
  const html = page("seo-aeo-desk", { page: "memories" });
  const escaped = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  for (const memory of SEO.memories) assert.ok(html.includes(escaped(memory.text)), memory.text.slice(0, 40));
  assert.equal((html.match(/class="marketplace-memory"/g) ?? []).length, SEO.memories.length);
  assert.ok(!/<li>|<h3>memory|memory 1/i.test(html), "a memory was drawn with furniture around it");
  // The footnote says what adding the bot does with them, which is the one write on this page.
  assert.ok(html.includes("seeded as the bot's own remembered facts when you add it"), html.slice(-400));
  assert.ok(html.includes("edit or delete any of them from its Memory panel"));
});

// A team pack seeds no memory store: its import creates one bot per member with that member's own
// written brief as its identity. The single-bot footnote would be a promise the press does not keep.
test("a team pack's Memories block says what its import actually does", () => {
  const pack = {
    ...OURS,
    id: "marketing-team",
    name: "Marketing team",
    memories: [{ text: "We run the marketing desk: briefs in, drafts out, nothing posted without a yes." }],
    members: [{ id: "coord", role: "Coordinator", summary: "Runs the desk.", instructions: "Run the desk.", skills: [], integrations: [] }],
    packaging: { agentPrefix: "mkt-", skillPrefix: "mkt-" },
  };
  const html = page("marketing-team", { page: "memories", bots: [pack] });
  assert.ok(html.includes("one bot per member, each with its own written brief as its identity"), html.slice(-600));
  assert.ok(!html.includes("seeded as the bot's own remembered facts"), "the pack promised a memory write its import never makes");
  // And a single bot still carries the promise its Add does keep.
  assert.ok(page("seo-aeo-desk", { page: "memories" }).includes("seeded as the bot's own remembered facts"));
});

// oneLine cuts at 140 characters IN THE STRING, so a wider window never recovers it. 108 of the
// pack's 263 skill descriptions are longer than that and the "Use when…" sentence is the block.
test("a long skill line is drawn whole on the Skills block", () => {
  const long = `Use when the hiring manager asks for a slate: ${"read the tracker, pull the last five loops, and write the shortlist with a reason per name. ".repeat(4)}`;
  const html = page("seo-aeo-desk", { page: "skills", bots: [OURS, { ...SEO, skills: [{ name: "Slate", description: long, body: "" }] }] });
  assert.ok(long.length > 400, `the fixture is only ${long.length} characters`);
  assert.ok(html.includes(escapeText(long.trim())), html.slice(0, 800));
  assert.ok(!html.includes("…</small>"), "the line was truncated on the block that exists to show it");
});

// ---------------------------------------------------------------- 3. routines
test("a routine says its cadence in words, that it arrives off, and the event ones say they are not created", () => {
  const html = page("seo-aeo-desk", { page: "routines" });
  assert.ok(html.includes("Every Monday at 09:00 — off until you switch it on"), html);
  // The summary's own "Disabled by default." is stripped: the line under it already says so.
  assert.ok(!/Disabled by default/i.test(html), "the row said it twice");
  assert.ok(html.includes("Every Monday morning, what moved last week."));
  assert.ok(html.includes("waits on something this box cannot watch"), html);
  assert.ok(html.includes("1 of 2 are created, switched off"), html.slice(-400));
});

test("a cron with no words of its own is still read as words", () => {
  assert.equal(bots.scheduleWords({ schedule: "0 9 * * 1-5" }), "Every weekday at 09:00");
  assert.equal(bots.scheduleWords({ schedule: "0 2 * * *" }), "Every day at 02:00");
  assert.equal(bots.scheduleWords({ schedule: "0 9 1 * *" }), "Once a month at 09:00");
  assert.equal(bots.scheduleWords({ schedule: "0 9 1 1,4,7,10 *" }), "Once a quarter at 09:00");
  assert.equal(bots.scheduleWords({ schedule: "0 9 * * 1", scheduleNote: "Every Monday at 09:00" }), "Every Monday at 09:00");
  assert.equal(bots.scheduleWords({ schedule: null }), "");
});

// ---------------------------------------------------------------- 4. integrations: three controls
test("an app shows the bot's own sentence, not the plugin's tagline", () => {
  const html = page("seo-aeo-desk", { page: "integrations" });
  assert.ok(html.includes("Keep the ideas board, briefs, and question map where your team already writes."), html.slice(0, 600));
  assert.ok(!html.includes("Read and write pages in a Notion workspace."), "the plugin's tagline replaced the bot's own line");
});

test("the three controls: installed, Add, and a line with no Add at all", () => {
  const html = page("seo-aeo-desk", { page: "integrations", installed: ["notion"] });
  // installed
  assert.match(html, /data-integration="notion"[\s\S]*?status-pill success">installed/);
  assert.ok(!html.includes('data-add-integration="notion"'), "an installed app still offered Add");
  // addable
  assert.ok(html.includes('data-add-integration="slack"'), "a connectable app offered no Add");
  // installs nothing: a line, and no Add anywhere on the page for it
  assert.ok(!html.includes('data-add-integration="x"'), "a row that installs nothing drew an Add");
  assert.ok(html.includes("nothing to install — open its card under Plugins"), html);
  // and one we carry no plugin for at all
  assert.match(html, /data-integration="Profound"[\s\S]*?not available yet/);
  assert.ok(html.includes("Add your own"), "the door to adding your own server is not named");
});

test("an app row says which of the three it is, so the gate can read it off the page", () => {
  const html = page("seo-aeo-desk", { page: "integrations", installed: ["notion"] });
  assert.match(html, /data-integration="notion" data-app="notion-workspace" data-app-offer="connect"/);
  assert.match(html, /data-integration="x" data-app="X" data-app-offer="page"/);
  assert.match(html, /data-integration="Profound" data-app="Profound" data-app-offer="byo"/);
});

// One plugin covers several apps. Titling the row with the PLUGIN drew Gmail, Google Calendar and
// Google Sheets as three rows that were the same string end to end, each with its own Add.
test("two surfaces of one plugin are two rows a person can tell apart, with one Add between them", () => {
  const html = page("seo-aeo-desk", { page: "integrations", bots: [OURS, { ...SEO, apps: GOOGLE_APPS }] });
  assert.ok(html.includes("<strong>Gmail</strong>"), html.slice(0, 900));
  assert.ok(html.includes("<strong>Google Calendar</strong>"), "the second Google surface was drawn as the plugin again");
  assert.ok(html.includes("Search, read and draft mail."), "the app's own line was replaced by the plugin's");
  assert.ok(html.includes("Book and move meetings."));
  // Named once, under both, so a person knows which connection covers them.
  assert.equal((html.match(/through Google Workspace/g) ?? []).length, 2);
  // And exactly one Add: the second press would install what the first already did.
  assert.equal((html.match(/data-add-integration="google"/g) ?? []).length, 1, "one plugin drew two Adds");
  assert.ok(html.includes("the same connection as above"));
});

// The generator drops a sentence that repeats across bots and ships it as `fallbackLine`; the row
// must still say what the app is for rather than a name and a pill.
test("an app whose own sentence is shared still draws a line", () => {
  const shared = [{ name: "Ashby", label: "Ashby", line: "", fallbackLine: "Search candidates, prep interviews, and manage pipeline tasks.", pluginId: "", offer: "byo" }];
  const html = page("seo-aeo-desk", { page: "integrations", bots: [OURS, { ...SEO, apps: shared }] });
  assert.ok(html.includes("Search candidates, prep interviews, and manage pipeline tasks."), html.slice(0, 900));
  assert.match(html, /data-integration="Ashby"[\s\S]*?not available yet/);
});

// ---------------------------------------------------------------- 5. the list
test("a row is a div with two sibling buttons, and the Add is not inside the open button", () => {
  const html = list();
  assert.match(html, /<div class="marketplace-bot-row" data-bot-row="seo-aeo-desk">/);
  const row = html.slice(html.indexOf('data-bot-row="seo-aeo-desk"'));
  const open = row.indexOf('data-bot-id="seo-aeo-desk"');
  const closeOpen = row.indexOf("</button>", open);
  const add = row.indexOf('data-add-bot="seo-aeo-desk"');
  assert.ok(open > 0 && add > 0, "the row has no open button or no Add");
  assert.ok(add > closeOpen, "the Add button is INSIDE the open button; Chrome fires both handlers");
  // And the wrapper itself is not a button either.
  assert.ok(!/<button[^>]*class="marketplace-bot-row"/.test(html));
});

test("a featured bot is a card and carries the same Add", () => {
  // Four of the seven rows this box serves are featured, so they are drawn as cards -- and the
  // round Add was on none of them until this was measured on screen.
  const html = list({ bots: [{ ...OURS, featured: true }, SEO] });
  const card = html.slice(html.indexOf('data-bot-row="research-desk"'));
  assert.ok(card.startsWith('data-bot-row="research-desk"'));
  assert.match(html, /<div class="plugin-card marketplace-bot-card" data-bot-row="research-desk">/);
  assert.ok(card.includes('data-add-bot="research-desk"'), "a featured card has no Add");
  const open = card.indexOf('data-bot-id="research-desk"');
  assert.ok(card.indexOf('data-add-bot="research-desk"') > card.indexOf("</button>", open), "the Add is inside the card's own button");
});

test("the Add control says in plain words that adding starts the bot talking", () => {
  const html = list();
  assert.ok(/title="Add SEO &amp; AEO Desk: it lands on the roster and starts talking"/.test(html), html.slice(0, 400));
  assert.ok(html.includes("it says hello in its own conversation"), "the list never says what Add does");
  assert.ok(html.includes("Its jobs arrive switched off"));
});

test("the credit line names the creator and says where the row came from", () => {
  const html = list();
  assert.ok(html.includes("by Adam Tanguay, from the community"), html.slice(0, 600));
  assert.ok(html.includes("by Titanbot team"), "our own rows lost their credit");
});

test("our own rows come first, under their own heading", () => {
  const html = list();
  const heading = html.indexOf("From the Titanium Bot team");
  const ours = html.indexOf('data-bot-row="research-desk"');
  const theirs = html.indexOf('data-bot-row="seo-aeo-desk"');
  assert.ok(heading > 0, "our own rows have no section of their own");
  assert.ok(ours > 0 && theirs > 0, "a row is missing from the list");
  assert.ok(heading < ours && ours < theirs, `${heading} ${ours} ${theirs}`);
});

// ---------------------------------------------------------------- 6. the chips
test("a chip is a tag in the marketplace chip row, the way the Plugins half draws one", () => {
  const html = list();
  assert.match(html, /<div class="palette-chips marketplace-chips" role="group" aria-label="Bot categories" data-bot-chips>/);
  assert.match(html, /<button class="tag is-active" type="button" data-bot-category="All"/);
  assert.ok(!/class="roster-tab[^"]*" type="button" data-bot-category/.test(html), "the chips are still panel tabs");
});

test("a chip with no members is not drawn", () => {
  const html = list();
  assert.ok(html.includes('data-bot-category="Marketing"'), "a category with members lost its chip");
  // Declared by the host, carried by no row on this box.
  assert.ok(!html.includes('data-bot-category="Recruiting &amp; People"'), "an empty chip was drawn");
  assert.ok(!html.includes('data-bot-category="Recruiting & People"'));
});

test("the filter reads a bot's second category as well as its first", () => {
  // SEO & AEO Desk is filed under Marketing and carries Sales as a tag.
  assert.ok(list({ category: "Marketing" }).includes('data-bot-row="seo-aeo-desk"'));
  assert.ok(list({ category: "Sales" }).includes('data-bot-row="seo-aeo-desk"'), "the second category filters to nothing");
  assert.ok(!list({ category: "Sales" }).includes('data-bot-row="research-desk"'));
});

// A bot already on the box looked unadded on every fresh page load: "on the roster" was derived
// from this browser session's own Add outcomes alone, so at 72 rows the only way to find out was
// to press one and read the refusal.
test("a bot whose name is already on the box says so with no import of its own", () => {
  const roster = ["SEO & AEO Desk"];
  const rows = list({ roster });
  assert.match(rows, /data-bot-row="seo-aeo-desk"[\s\S]*?on the roster/);
  assert.ok(!/data-bot-row="seo-aeo-desk"[\s\S]*?data-add-bot="seo-aeo-desk"/.test(rows), "a bot already here still drew Add");
  // The other row is untouched.
  assert.match(rows, /data-add-bot="research-desk"/);
  // And its own page says it too, rather than offering Import Bot a second time.
  const html = page("seo-aeo-desk", { roster });
  assert.match(html, /data-bot-on-roster="seo-aeo-desk"/);
  assert.ok(!html.includes('data-import-bot="seo-aeo-desk"'));
});

// ---------------------------------------------------------------- 7. the outcome card
test("a second Add says it is already on the roster and offers a deliberate second copy", () => {
  const html = page("seo-aeo-desk", { outcome: { state: "already", agent: { id: "a7", name: "SEO & AEO Desk" } } });
  assert.match(html, /data-bot-already="a7"/);
  assert.ok(html.includes("Already on the roster"), html.slice(-400));
  assert.ok(html.includes("nothing was created and nothing was changed"));
  assert.match(html, /data-add-copy="seo-aeo-desk"/);
  assert.ok(html.includes("Add another copy"));
  // And the hero says so rather than offering Add a second time.
  assert.ok(!html.includes('data-import-bot="seo-aeo-desk"'), "Add was still offered on a bot already here");
  assert.match(html, /data-bot-on-roster="seo-aeo-desk"/);
});

test("the receipt reports what landed, what was refused, and what is not connected", () => {
  const html = page("seo-aeo-desk", {
    installed: ["notion"],
    outcome: {
      state: "done",
      agent: { id: "a9", name: "SEO & AEO Desk" },
      memories: { added: 12, duplicates: 1, rejected: [{ text: "…", why: "it is longer than a memory can be" }] },
      // LISTS, the shape both setup paths return. They were numbers here, so Number([...]) being
      // NaN -- which dropped the playbook clause from every receipt of every bot -- passed.
      skills: { imported: ["a", "b", "c", "d", "e", "f", "g"], reused: ["h", "i"], skipped: [{ source: "Brief writer", reason: "the host refused it" }] },
      routines: { created: [{ name: "Weekly search report", schedule: "0 9 * * 1" }], notCreated: [{ name: "Topic watch", why: "it names no schedule this box can run" }] },
      apps: { connected: ["Notion"], addable: ["Slack"], byo: ["Profound"], informational: ["X"] },
      message: "",
    },
  });
  assert.match(html, /data-imported-agent="a9"/);
  // FACTS, not memories: the block above shows 5 paragraphs and the store holds the facts they were
  // split into, so the card says what the sentence under it has always said.
  assert.ok(html.includes("It has 12 facts it remembers, 9 playbooks, 1 job, switched off."), html.slice(-800));
  assert.ok(html.includes("it is longer than a memory can be"));
  assert.ok(html.includes("Brief writer was skipped"));
  assert.ok(html.includes("Topic watch was not created"));
  assert.ok(html.includes("Not connected yet: Slack, Profound, X"), html.slice(-500));
});

test("every state of a bot page renders, with nothing undefined in it", () => {
  const states = [
    null,
    { state: "running", step: "Creating the bot" },
    { state: "failed", message: "the host refused" },
    { state: "already", agent: { id: "a1", name: "SEO & AEO Desk" } },
    { state: "done", agent: { id: "a1", name: "SEO & AEO Desk" }, memories: { added: 0, rejected: [] }, skills: { imported: 0, skipped: [] }, routines: { created: [], notCreated: [] }, apps: { connected: [], addable: [], byo: [], informational: [] } },
  ];
  for (const outcome of states) {
    for (const block of ["memories", "skills", "routines", "integrations"]) {
      const html = page("seo-aeo-desk", { page: block, outcome });
      assert.equal(typeof html, "string");
      assert.ok(!/undefined|\[object Object\]|NaN/.test(html), `${block}/${outcome == null ? "none" : outcome.state}: ${html.slice(0, 300)}`);
    }
  }
});

// ---------------------------------------------------------------- 8. the card projection
test("a card whose row could not be read says so rather than saying the bot knows nothing", () => {
  const card = { ...SEO, memories: [], skills: [], routines: [], apps: [], integrations: [], counts: { memories: 12, skills: 7, routines: 2, apps: 4 } };
  const html = bots.preview({ ...CATALOG, bots: [OURS, card], botId: "seo-aeo-desk", page: "memories", detailError: "this host served no row for it" }, "page");
  assert.ok(html.includes("could not be read from the host"), html.slice(0, 800));
  assert.ok(!html.includes("This bot knows nothing in advance"), "an unread row was reported as an empty one");
  assert.match(html, /data-bot-detail-error/);
});

test("appsOf falls back to the plugin ids on a row that carries no apps of its own", () => {
  assert.deepEqual(bots.appsOf(OURS), []);
  assert.deepEqual(
    bots.appsOf({ integrations: ["notion", "slack"] }).map((app) => [app.name, app.pluginId, app.offer]),
    [["notion", "notion", "connect"], ["slack", "slack", "connect"]],
  );
});
