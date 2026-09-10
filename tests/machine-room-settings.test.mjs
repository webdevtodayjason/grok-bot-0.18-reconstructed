// SETTINGS-2. The settings surface: its sections, its rows, its words, and who is shown what.
//
// Jason, 2026-09-10, on what shipped: "it's so busy, with so much stuff ... A user is never going to
// put a resend key in. That's on the backend ... it's getting to the point where you've got to be a
// developer to understand what's going on."
//
// EVERY LEG HERE FAILS ON THE TREE BEFORE THIS WAVE AND PASSES AFTER. The four that matter most are
// the ones nothing pinned before:
//
//   1. No customer-visible label or line may carry key, token, secret, endpoint, relay, proxy,
//      webhook or a vendor name. Measured on the old panel: 8 of 23 rows and 5 of 10 headings did.
//   2. The Operator section is drawn on `operator: true` and on nothing else -- not on an absent
//      identity, not on a falsy one, and never on a page heuristic.
//   3. backgrounds.js no longer keys its mount on the panel's TITLE. The old guard matched
//      /Global router|Operator settings/, which this wave renames; with it in place the background
//      picker would have disappeared with no error, no page error and no test.
//   4. Two cards mount themselves into Settings from outside it, and each has ONE home. The
//      Notifications card aims at [data-push-mount], the Notifications body's own slot. The Voice
//      card aims at "#panel-content .settings-list", which is the operator's stack and nowhere else.
//      Give them the same selector and whichever section is on screen gets both.
//
// settings.js is a classic browser script: it hangs one object on the window it is handed. Evaluating
// it against a stub with NO document is how its pure half is meant to be read, and is the contract
// marketplace-bots.js and push-settings.js already keep.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFile(path.join(repoRoot, rel), "utf8");

function loadBrowserScript(relativePath, stub = {}) {
  const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
  new Function("window", source)(stub);
  return stub;
}

/** The module with no page at all, which is how the pure half has to be readable. */
const pure = () => loadBrowserScript("ui/machine-room/settings.js", { document: undefined }).__mrSettings;

// The facts a live console would hand it, with every optional one present, so the sweep below reads
// every row the surface can draw rather than only the ones a cold box answers.
const FULL_FACTS = {
  operator: false,
  passwordConfigured: true,
  devices: [{ id: "d1", name: "Jason's iPhone", detail: "iPhone or iPad · added 9/9/2026" }],
  theme: "system",
  workspaceName: "Acme Plumbing",
  email: "owner@acme.example",
  microphones: [{ id: "mic-1", label: "MacBook Pro Microphone" }],
  microphone: "mic-1",
  voice: { enabled: true, available: true },
  botName: "Titan",
  botEmail: "titan@acme.example",
  botCount: 4,
  botCap: 13,
  boxName: "acme-plumbing",
  boxRunning: true,
  localToolPermission: "ask",
  askBefore: "sending email",
  planChoices: [{ id: "sub:zai", name: "GLM 4.6" }],
  planCurrent: "sub:zai",
  voiceMinutes: { used: 4, cap: 30 },
  codingMinutes: { used: 12, cap: 600 },
  plan: "Included",
  version: "0.47.0",
  updateAvailable: true,
  canUpdateBox: true,
  weeklyUsage: 42,
};

// ---- the sections -------------------------------------------------------------------------------

test("the surface is six sections in the original's order, and Operator is last and the operator's", () => {
  const mr = pure();
  assert.deepEqual(mr.SECTIONS.map((section) => section.id),
    ["general", "computer", "usage", "updates", "notifications", "operator"],
    "General, Computer, Usage & Billing, Updates, then the one this product adds, then the operator's");
  assert.deepEqual(mr.SECTIONS.map((section) => section.label),
    ["General", "Computer", "Usage & Billing", "Updates", "Notifications", "Operator"]);
  assert.equal(mr.SECTIONS.at(-1).id, "operator", "the operator's section is last on the nav, not first");
});

test("Operator is drawn on operator:true and on nothing else", () => {
  const mr = pure();
  assert.deepEqual(mr.sectionsFor(true).map((s) => s.id).filter((id) => id === "operator"), ["operator"]);
  assert.deepEqual(mr.sectionsFor(false).map((s) => s.id), ["general", "computer", "usage", "updates", "notifications"]);
  // FAIL CLOSED. An identity the console could not read is not an operator: the session answer absent,
  // unreadable, or carrying no operator field at all -- each arrives here as null or undefined.
  for (const answer of [null, undefined, 0, "", "true", {}]) {
    assert.ok(!mr.sectionsFor(answer).some((s) => s.id === "operator"),
      `an identity of ${JSON.stringify(answer)} must not draw the operator's section`);
  }
});

// ---- every row's shape --------------------------------------------------------------------------

test("every customer row is a label, at most one explanation line, and exactly one control", () => {
  const mr = pure();
  for (const section of mr.sectionsFor(false)) {
    for (const row of mr.rowsFor(section.id, FULL_FACTS)) {
      assert.ok(typeof row.label === "string" && row.label.length > 0, `${section.id}/${row.id} has no label`);
      assert.ok(row.line === undefined || typeof row.line === "string", `${section.id}/${row.id}'s line is not one line`);
      if (typeof row.line === "string") assert.ok(!row.line.includes("\n"), `${section.id}/${row.id}'s line is more than one line`);
      assert.ok(row.control != null && typeof row.control.kind === "string",
        `${section.id}/${row.id} has no control, and a row without one is a row that does nothing`);
      assert.ok(typeof row.group === "string" && section.groups.some((group) => group.id === row.group),
        `${section.id}/${row.id} names a group its section does not have (${row.group})`);
    }
  }
});

test("a fact the machine could not answer omits its row rather than drawing a zero", () => {
  const mr = pure();
  // A cold console: no identity, no mail, no voice module, no plan, no devices route.
  const rows = mr.rowsFor("general", { theme: "system" }).map((row) => row.id);
  assert.deepEqual(rows, ["theme", "language", "background"],
    "with nothing answered, General is the three rows that need no machine behind them");
  assert.deepEqual(mr.rowsFor("computer", {}).map((row) => row.id), [], "and Computer draws nothing at all");
  assert.deepEqual(mr.rowsFor("usage", {}).map((row) => row.id), ["billing"],
    "Usage keeps the one row that is a sentence about who to ask, and no invented numbers");
  // Sign out only where a password exists; the loopback console on this Mac has none.
  assert.ok(!mr.rowsFor("general", {}).some((row) => row.id === "sign-out"));
  assert.ok(mr.rowsFor("general", { passwordConfigured: true }).some((row) => row.id === "sign-out"));
});

test("the three rows the reference has that this product must not pretend about", () => {
  const mr = pure();
  const general = mr.rowsFor("general", FULL_FACTS);
  // A web console has no hardware acceleration setting. The reference's row is a desktop-app fact.
  assert.ok(!general.some((row) => /hardware/i.test(row.label)), "no hardware-acceleration row");
  // The reference offers Add account; one workspace per sign-in is what this product does, and a
  // control that never becomes enabled is a promise. ACCOUNT-ADD-1 is the filed row.
  assert.ok(!general.some((row) => /add account/i.test(row.label)), "no Add account row");
  // Language is there and honest, rather than absent or lying.
  const language = general.find((row) => row.id === "language");
  assert.ok(!language.control.action, "the Language picker is disabled until there is a second language");
  assert.match(language.line, /English for now/);
});

test("no customer section offers to reset the computer, and the Update row arms twice", () => {
  const mr = pure();
  for (const section of mr.sectionsFor(false)) {
    for (const row of mr.rowsFor(section.id, FULL_FACTS)) {
      assert.ok(!/\breset\b/i.test(`${row.label} ${row.line ?? ""}`),
        `${section.id}/${row.id} offers a reset, and a rebuild is the operator's hazard (BOX-6)`);
    }
  }
  const at = (facts) => mr.rowsFor("updates", facts).find((row) => row.id === "update-box").control;
  assert.equal(at(FULL_FACTS).text, "Update", "at rest it reads Update");
  assert.equal(at({ ...FULL_FACTS, updateArmed: true }).text, "Click Again to Confirm", "armed it reads the confirm");
  assert.equal(at({ ...FULL_FACTS, updateArmed: true }).variant, "armed", "and it is drawn as a different button");
  assert.equal(at({ ...FULL_FACTS, updateArmed: false }).variant, "ghost", "and disarms back to the same button it was");
  // Enabled only where a newer bundle is published, which is what keeps it inert on a patched host.
  assert.equal(at({ ...FULL_FACTS, updateAvailable: false }).disabled, true);
  assert.equal(at({ ...FULL_FACTS, updateAvailable: null }).disabled, true);
  assert.equal(at({ ...FULL_FACTS, canUpdateBox: false }).disabled, true, "and only where the adapter can actually do it");
  assert.equal(at(FULL_FACTS).disabled, false);
});

test("the computer's three execution choices are the host's own three, in the reference's words", () => {
  const mr = pure();
  const row = mr.rowsFor("computer", FULL_FACTS).find((one) => one.id === "execution");
  assert.deepEqual(row.control.options.map((option) => option.value), ["always", "ask", "never"],
    "source/shared/local-tool-permission.ts exports exactly these three");
  assert.deepEqual(row.control.options.map((option) => option.label), ["Always allow", "Ask every time", "Never allow"]);
  assert.match(row.line, /Auto-review still checks everything first/);
  // A pick the operator's ceiling narrowed says so on the row rather than sitting there looking saved.
  const capped = mr.rowsFor("computer", { ...FULL_FACTS, localToolCapped: true }).find((one) => one.id === "execution");
  assert.match(capped.line, /Your operator caps this/);
});

// ---- the words ----------------------------------------------------------------------------------

test("no customer-visible label or line carries a key, a secret or a vendor's name", () => {
  const mr = pure();
  const offenders = mr.customerCopy(FULL_FACTS).filter((entry) => mr.BANNED.test(entry.text));
  assert.deepEqual(offenders, [],
    offenders.length === 0 ? "" : `these read like a developer wrote them: ${offenders.map((one) => `${one.where}: "${one.text}"`).join(" | ")}`);
});

test("the ban is the nine words and the vendor list, and it really catches them", () => {
  const mr = pure();
  for (const word of ["key", "token", "secret", "endpoint", "relay", "proxy", "webhook",
    "Resend", "OpenAI", "xAI", "Anthropic", "z.ai", "GLM", "Grok", "Firebase", "APNs", "Coolify", "S3", "GitHub", "Slack", "browser-use"]) {
    assert.ok(mr.BANNED.test(`Paste your ${word} here`), `the sweep does not catch ${word}`);
  }
  // And it is a word boundary, not a substring: "monkey" is not a key and "keystone" is not either.
  assert.ok(!mr.BANNED.test("monkey"), "a substring match would fail on innocent words");
  assert.ok(!mr.BANNED.test("Keystone Plumbing"), "a customer's own company name must not trip it");
});

test("a machine's own value is marked as one, so the sweep reads copy and not a model's name", () => {
  const mr = pure();
  // "GLM 4.6" is on the page as an option the person picks between. It is the machine's word, not the
  // product's, and the row that carries it is marked so the live sweep can tell them apart.
  const row = mr.rowsFor("computer", FULL_FACTS).find((one) => one.id === "answers");
  assert.ok(row.control.options.every((option) => option.machine === true));
  assert.ok(mr.rowsFor("usage", FULL_FACTS).find((one) => one.id === "plan").control.machine === true);
  assert.ok(mr.rowsFor("general", FULL_FACTS).find((one) => one.id === "bots").control.machine === true);
});

// ---- the account menu ---------------------------------------------------------------------------

test("the account menu is the reference's rows, in the reference's order", () => {
  const mr = pure();
  assert.deepEqual(mr.accountMenuRows(FULL_FACTS).map((row) => row.id),
    ["update-banner", "usage", "mobile", "support", "settings", "rule", "log-out"]);
  // No banner where nothing is waiting, and no Log out where signing out would do nothing.
  assert.deepEqual(mr.accountMenuRows({ updateAvailable: false }).map((row) => row.id),
    ["usage", "mobile", "support", "settings", "rule"]);
  const support = mr.accountMenuRows(FULL_FACTS).find((row) => row.id === "support");
  assert.deepEqual(support.items.map((item) => item.id), ["feedback", "self-test", "about"],
    "Send feedback, Run a self-test, About. No Help Center: there is no page behind it");
  assert.ok(!mr.accountMenuRows(FULL_FACTS).some((row) => /help center/i.test(row.label ?? "")));
  assert.ok(!mr.accountMenuRows(FULL_FACTS).some((row) => /add account/i.test(row.label ?? "")));
  // The percentage is drawn only where a cap exists.
  assert.equal(mr.accountMenuRows({}).find((row) => row.id === "usage").label, "Weekly usage");
  assert.equal(mr.accountMenuRows(FULL_FACTS).find((row) => row.id === "usage").label, "Weekly usage 42%");
});

// ---- the mount contract -------------------------------------------------------------------------

test("exactly one body carries the Notifications slot, and no customer body is a .settings-list", () => {
  const mr = pure();
  const bodies = mr.SECTIONS.map((section) => ({ id: section.id, markup: mr._bodyMarkup(section, FULL_FACTS) }));
  const withSlot = bodies.filter((body) => /data-push-mount/.test(body.markup)).map((body) => body.id);
  assert.deepEqual(withSlot, ["notifications"],
    "push-settings.js mounts on [data-push-mount], so a second one on the surface is its card in two places");
  // .settings-list is the OPERATOR stack's, because that is the selector voice.js hunts for. A
  // customer body carrying it would take the Voice card and its technical rows onto a customer's
  // screen -- which is the whole thing this wave exists to stop.
  const withList = bodies.filter((body) => /class="settings-list"/.test(body.markup)).map((body) => body.id);
  assert.deepEqual(withList, [], "no body this file draws may carry .settings-list");
  for (const body of bodies) {
    if (body.id === "operator") continue;
    assert.match(body.markup, new RegExp(`data-settings-section="${body.id}"`), `${body.id}'s body is not marked with its own id`);
    assert.match(body.markup, /class="settings-rows"/, `${body.id}'s body must be a settings-rows`);
  }
});

test("app.js's operator body keeps .settings-list, which is where the Voice card lands", async () => {
  const source = await read("ui/machine-room/app.js");
  const start = source.indexOf("function settingsPanel(");
  assert.notEqual(start, -1, "app.js no longer draws the operator body");
  const body = source.slice(start, source.indexOf("function openSettingsPanel(", start));
  // voice.js queries "#panel-content .settings-list" and inserts after [data-mail]. Both halves of
  // that have to be here or its card silently stops appearing anywhere at all.
  assert.match(body, /class="settings-list settings-operator-list"/);
  assert.ok(body.includes("mailSection()"), "voice.js puts its card after the mail card, so the mail card has to be here");
  // Nothing is lost: every card the old panel held is still built here.
  for (const part of ["endpoint-select", "pluginGroupSection(\"Plan\"", "pluginGroupSection(\"Providers\"", "pluginGroupSection(\"Listeners\"",
    "auto-review-toggle", "data-save-review", "jobBusSection()", "mailSection()", "data-update-box", "data-reset-box"]) {
    assert.ok(body.includes(part), `the operator body dropped ${part}, and this wave loses nothing`);
  }
  // And it says where the keys went, because two fields left the cards below it.
  assert.match(body, /api\.titanium\.bot\/admin/);
});

test("the mail card's sending-key field is gone and its signing secret stayed", async () => {
  const source = await read("ui/machine-room/app.js");
  // KEYS-1: the key the product sends mail with belongs to the operator of the install and is pasted
  // once in the admin console. No field, no Save, no Clear, anywhere on a workspace's own card.
  assert.ok(!/data-mail-key[^-]/.test(source), "the sending-key input is still on the mail card");
  assert.ok(!source.includes("data-mail-key-set"), "the sending key's Save is still on the mail card");
  assert.ok(!source.includes("data-mail-key-clear"), "the sending key's Clear is still on the mail card");
  assert.ok(!/\{ apiKey: value \}/.test(source), "the console can still write a sending key");
  // MAIL-WEBHOOK-1: the inbound signing secret is a routing discriminator, not a vendor credential,
  // and one global value in front of every edge would let the first claimant read another
  // customer's mail. It stays on files and it stays on the operator's own card.
  assert.ok(source.includes("data-mail-secret-set"), "the signing secret must still be settable");
  assert.ok(source.includes("data-mail-secret-clear"));
  // Whether a key is set at all is still READ, because that is what decides if receiving can be on.
  assert.ok(source.includes("settings.apiKeySet"));
});

test("backgrounds.js mounts on the surface's event and not on the panel's title", async () => {
  const source = await read("ui/machine-room/backgrounds.js");
  // THE REGRESSION THIS TEST EXISTS FOR. The old guard was
  //   if (!/Global router|Operator settings/i.test(panel-title.textContent)) return;
  // and this wave renames that panel to "Settings". Nothing pinned it, so the picker would simply
  // have stopped appearing: no error, no page error, no failing gate.
  assert.ok(!/\/Global router\|Operator settings\/i\.test\(/.test(source),
    "the picker still keys on a string of copy this wave renames");
  assert.ok(!/getElementById\("settings-button"\)|getElementById\("shelf-settings"\)/.test(source),
    "the picker still hangs listeners on the gear buttons");
  assert.match(source, /titanbot:settings-section/, "it listens for the surface's own section event");
  assert.match(source, /data-settings-mount="background"/, "and it mounts into the Background row's control slot");
  assert.match(source, /data-settings-section="general"/, "in General, and nowhere else");
  // Both paths -- the working one and the bg-boot-absent note -- use the same mount.
  assert.equal(source.match(/addEventListener\("titanbot:settings-section"/g).length, 2,
    "the no-boot note mounts the same way the tiles do, or it lands somewhere else");
});

test("the one copy edit inside push-settings.js, and nothing else of it moved", async () => {
  const source = await read("ui/machine-room/push-settings.js");
  assert.ok(!source.includes("Credentials an agent needs"), "that row's label carried a word a customer must not read");
  assert.match(source, /When your agent needs a sign-in from you/);
  assert.match(source, /A tool asked for a login and he cannot go on without it/);
  // Its mount is untouched: structural, on .settings-list, and keyed on no string of copy.
  assert.match(source, /\.settings-list/);
  assert.ok(!/\/Global router\|Operator settings\/i?\.test\(/.test(source), "no string of the panel's copy is load bearing");
  // And the card's own visible copy is clean under the same sweep the surface's rows get.
  const mr = pure();
  const copy = [...source.matchAll(/^\s{4}"?[a-z-]+"?: \["([^"]+)", "([^"]+)"\],$/gm)].flatMap((hit) => [hit[1], hit[2]]);
  assert.ok(copy.length >= 12, `the six kinds' copy was not found to sweep (${copy.length} strings)`);
  const offenders = copy.filter((text) => mr.BANNED.test(text));
  assert.deepEqual(offenders, [], `these notification rows read like a developer wrote them: ${offenders.join(" | ")}`);
});

// ---- the shell -----------------------------------------------------------------------------------

test("the shell is a nav plus one swappable body, and the DOM contract is what the gate reads", () => {
  const mr = pure();
  const shell = mr._shellMarkup("general", false);
  for (const mark of ["data-settings-surface", "data-settings-search", 'data-settings-nav="general"', "data-settings-body"]) {
    assert.ok(shell.includes(mark), `the shell is missing ${mark}`);
  }
  assert.ok(!shell.includes('data-settings-nav="operator"'), "a customer's nav must not carry the operator's entry");
  assert.ok(mr._shellMarkup("general", true).includes('data-settings-nav="operator"'));
  // One control slot per row, and it is the row's second and last child. That is what makes "exactly
  // one control" a thing a gate can count on the live page.
  const row = mr._rowMarkup(mr.rowsFor("general", FULL_FACTS).find((one) => one.id === "theme"));
  assert.match(row, /^<div class="setting-row" data-setting-row="theme"><div><strong>Theme<\/strong><small>/);
  assert.equal(row.match(/class="setting-control/g).length, 1);
});

test("every group a section names gets a label, and a group with nothing in it is not drawn", () => {
  const mr = pure();
  const general = mr._bodyMarkup(mr.SECTIONS[0], FULL_FACTS);
  for (const group of ["account", "appearance", "system", "bot"]) {
    assert.match(general, new RegExp(`data-settings-group="${group}"`), `General lost its ${group} group`);
  }
  assert.match(general, /<p class="settings-group-label">Account<\/p>/);
  // A cold console has no System group and no Bot group, and draws neither heading.
  const cold = mr._bodyMarkup(mr.SECTIONS[0], { theme: "system" });
  assert.ok(!cold.includes('data-settings-group="system"'), "an empty group heading is a promise with nothing behind it");
  assert.ok(!cold.includes('data-settings-group="bot"'));
  assert.match(cold, /data-settings-group="appearance"/);
});

test("the search reaches a section by a row's own words, not only by the nav's label", () => {
  const mr = pure();
  const reaches = (needle) => mr.SECTIONS.filter((section) => {
    const hay = [section.label, section.title, section.subtitle, ...(section.keywords ?? []),
      ...mr.rowsFor(section.id, FULL_FACTS).map((row) => `${row.label} ${row.line ?? ""}`)].join(" ").toLowerCase();
    return hay.includes(needle);
  }).map((section) => section.id);
  assert.deepEqual(reaches("quiet"), ["notifications"], "typing quiet reaches Notifications");
  assert.deepEqual(reaches("background"), ["general"], "typing background reaches General");
  assert.ok(reaches("microphone").includes("general"));
  assert.ok(reaches("billing").includes("usage"));
});

// ---- the console still boots with the module absent ----------------------------------------------

test("app.js falls back to the panel that shipped when settings.js is not served", async () => {
  const source = await read("ui/machine-room/app.js");
  assert.match(source, /window\.__mrSettings\?\.open\?\.\(section\) === true\) return;/,
    "the surface is asked first and the fallback runs only when it is not there");
  assert.match(source, /openPanel\("Your workspace", "Settings", settingsPanel\(\)\);/);
  // openSettingsPanel keeps its name and its openPluginSurface contract, which renderPluginsPanel
  // depends on.
  assert.match(source, /function openSettingsPanel\(section = "general"\)/);
  assert.match(source, /openPluginSurface = "settings";/);
  assert.match(source, /openSettingsPanel\("operator"\); return;/,
    "a provider card's own control reopens the section it lives in");
  // The two live refills are guarded on the section being drawn, or they paint into nothing.
  assert.match(source, /openPluginSurface === "settings" && settingsSection === "operator"\) fillJobBusRows/);
  assert.match(source, /openPluginSurface === "settings" && settingsSection === "operator"\) fillEndpoints/);
  // And the seam the two sibling modules read.
  assert.match(source, /settingsHost: \{/);
  assert.match(source, /operatorMarkup: settingsPanel/);
  assert.match(source, /operatorFill: fillOperatorSettings/);
});

test("settings.js publishes its pure half with no document and throws on nothing", () => {
  assert.doesNotThrow(() => loadBrowserScript("ui/machine-room/settings.js", { document: undefined }),
    "a module that needed a page would take the console down on a stub");
  const mr = pure();
  for (const name of ["SECTIONS", "sectionsFor", "rowsFor", "accountMenuRows", "open", "shown", "paint", "register", "refresh"]) {
    assert.ok(mr[name] != null, `__mrSettings.${name} is not published`);
  }
  // open() on a stub with no page answers false rather than throwing.
  assert.equal(mr.open("general"), false);
  assert.equal(mr.shown(), null);
});

// The seam voice.js, push-settings.js and backgrounds.js were told to build against, so that no
// module ever again finds its place on this panel by matching a string of copy. That is the failure
// that would have deleted the background picker the moment this wave renamed the panel: silently,
// with no error and nothing in this suite pinning it.
test("a sibling module contributes a row by registering it, idempotently and by section", () => {
  const mr = pure();
  const drawn = () => mr._bodyMarkup(mr.SECTIONS.find((s) => s.id === "general"), FULL_FACTS);
  assert.ok(!drawn().includes("data-settings-contributed=\"talking\""), "nothing is contributed before anything registers");

  assert.equal(mr.register({ id: "talking", section: "general", group: "system", markup: () => "<strong>Talking</strong><span>x</span>" }), true);
  assert.match(drawn(), /data-settings-contributed="talking"/, "a registered row is drawn into its own section and group");
  assert.match(drawn(), /data-settings-group="system"[\s\S]*data-settings-contributed="talking"/, "and into the group it named");

  // IDEMPOTENT BY ID. A module that registers on load, and again on a reconnect, is one row.
  mr.register({ id: "talking", section: "general", group: "system", markup: () => "<strong>Talking</strong><span>y</span>" });
  assert.equal(drawn().match(/data-settings-contributed="talking"/g).length, 1, "registering twice under one id is one row");

  // A row for another section does not leak into this one.
  mr.register({ id: "elsewhere", section: "computer", group: "computers", markup: () => "<strong>Elsewhere</strong><span>z</span>" });
  assert.ok(!drawn().includes("data-settings-contributed=\"elsewhere\""), "a row registered on Computer is not drawn on General");

  // operatorOnly is honoured against the facts, never against a page heuristic.
  mr.register({ id: "operators-only", section: "general", group: "system", operatorOnly: true, markup: () => "<strong>Only me</strong><span>q</span>" });
  assert.ok(!drawn().includes("data-settings-contributed=\"operators-only\""), "a customer is not shown an operator's contributed row");
  const asOperator = mr._bodyMarkup(mr.SECTIONS.find((s) => s.id === "general"), { ...FULL_FACTS, operator: true });
  assert.match(asOperator, /data-settings-contributed="operators-only"/, "and the operator is");

  // Nonsense is refused rather than stored.
  for (const bad of [null, undefined, {}, { id: "" }, { id: 7 }]) assert.equal(mr.register(bad), false, `register(${JSON.stringify(bad)}) should refuse`);
});

test("account-menu.js reads the surface's row list rather than keeping a second copy", async () => {
  const source = await read("ui/machine-room/account-menu.js");
  assert.match(source, /__mrSettings/, "the menu reads the published rows");
  assert.ok(!/"Get the app for mobile"/.test(source.replace(/https:\/\/titanium\.bot\/app/, "")) || source.includes("accountMenuRows"),
    "the row labels live in settings.js, not here");
  const stub = loadBrowserScript("ui/machine-room/account-menu.js", { document: undefined });
  assert.ok(stub.__accountMenu != null, "it publishes itself at load with no page");
  assert.equal(stub.__accountMenu.isOpen(), false);
});

test("index.html serves both modules and the surface's own sheet", async () => {
  const html = await read("ui/machine-room/index.html");
  assert.match(html, /<script src="settings\.js"><\/script>/);
  assert.match(html, /<script src="account-menu\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="settings\.css" \/>/);
  // settings.js before account-menu.js: the menu reads the surface's rows.
  assert.ok(html.indexOf('src="settings.js"') < html.indexOf('src="account-menu.js"'));
});

test("settings.css sizes the dialog and never touches styles.css's own rules", async () => {
  const css = await read("ui/machine-room/settings.css");
  assert.match(css, /\.panel-dialog\.is-settings \{/);
  assert.match(css, /min\(1100px, 92vw\)/);
  assert.match(css, /min\(760px, 88vh\)/);
  assert.match(css, /@media \(max-width: 900px\)/, "the phone sheet");
  assert.match(css, /100dvh/);
  assert.match(css, /min-height: 44px/, "44 px targets at phone widths");
  // Every rule is scoped to .is-settings or to a class this surface invents. A bare .setting-row or
  // .panel-dialog rule here would change panels this wave does not own.
  const selectors = [...css.matchAll(/^([^@\s][^{]*)\{/gm)].map((hit) => hit[1].trim());
  const loose = selectors.filter((selector) => /(^|,)\s*\.(panel-dialog|dialog-frame|dialog-body|setting-row|settings-section|switch|status-pill)\b/.test(selector)
    && !/is-settings|settings-card|settings-surface/.test(selector));
  assert.deepEqual(loose, [], `these rules reach outside the surface: ${loose.join(" | ")}`);
});
