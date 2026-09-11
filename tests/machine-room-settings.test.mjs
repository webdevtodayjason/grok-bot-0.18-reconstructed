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
  // VOICE-7. The Talk mode row, so the sweeps below read its words too: a row added to this surface
  // that no banned-word or one-control leg ever looked at is a row outside the rule.
  talkMode: "push",
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
  voiceMinutes: { used: 4, cap: 30, perCall: 10 },
  codingMinutes: { used: 12, cap: null },
  plan: "Included",
  version: "0.47.0",
  updateAvailable: true,
  canUpdateBox: true,
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

test("the Usage rows draw the numbers that exist and nothing else", () => {
  const mr = pure();
  const rows = mr.rowsFor("usage", FULL_FACTS);
  const talking = rows.find((row) => row.id === "voice-minutes");
  // VOICE-8's fifth control. The old card said the day pair and the call ceiling on one line; the
  // replacement said only the day pair, so nothing told a person a single call ends at all.
  assert.equal(talking.control.text, "4 of 30 minutes, up to 10 in one call");
  const noCeiling = mr.rowsFor("usage", { ...FULL_FACTS, voiceMinutes: { used: 4, cap: 30 } })
    .find((row) => row.id === "voice-minutes");
  assert.equal(noCeiling.control.text, "4 of 30 minutes", "a workspace with no per-call ceiling is told nothing about one");
  // Coding minutes are counted and never capped by the month on this product, so the honest control
  // is the figure. A bar needs two numbers and inventing the second is the PROXY-1 failure.
  const coding = rows.find((row) => row.id === "coding-minutes");
  assert.equal(coding.control.kind, "pill");
  assert.equal(coding.control.text, "12 minutes");
  const capped = mr.rowsFor("usage", { ...FULL_FACTS, codingMinutes: { used: 12, cap: 600 } })
    .find((row) => row.id === "coding-minutes");
  assert.equal(capped.control.kind, "meter", "and it becomes a bar the day a monthly ceiling exists");
  assert.equal(capped.control.text, "12 of 600 minutes");
  // Neither row is drawn on a fact nobody answered.
  assert.deepEqual(mr.rowsFor("usage", { ...FULL_FACTS, voiceMinutes: null, codingMinutes: null, plan: null })
    .map((row) => row.id), ["billing"]);
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
  // THE SECOND PRESS NAMES THE CONSEQUENCE AND THE WORKSPACE. This control replaces the running
  // computer; "Click Again to Confirm" beside the resting row's copy does not say whose computer.
  const armedRow = (facts) => mr.rowsFor("updates", facts).find((row) => row.id === "update-box");
  assert.match(armedRow({ ...FULL_FACTS, updateArmed: true }).line, /replaced with a fresh one and restarts/);
  assert.match(armedRow({ ...FULL_FACTS, updateArmed: true }).line, /for Acme Plumbing/,
    "and it names the workspace whose computer is about to restart");
  assert.match(armedRow({ ...FULL_FACTS, updateArmed: true, workspaceName: null }).line, /for this workspace/);
  assert.match(armedRow(FULL_FACTS).line, /^Updates the computer your assistants share/);
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
  // NO PERCENTAGE, ever, on either. The reference's "Weekly usage 42%" is a percentage of a plan's
  // weekly allowance and this product has no allowance for a number to be a percentage of, so the row
  // says what it opens and nothing else. It comes back with the plan (row ME-PLAN-1).
  assert.equal(mr.accountMenuRows({}).find((row) => row.id === "usage").label, "Weekly usage");
  assert.equal(mr.accountMenuRows(FULL_FACTS).find((row) => row.id === "usage").label, "Weekly usage");
  for (const row of mr.accountMenuRows({ ...FULL_FACTS, weeklyUsage: 42 })) {
    assert.ok(!/%/.test(row.label ?? ""), "no row on the menu prints a percentage off a fact nothing answers");
  }
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
  // THE FALLBACK IS THE OPERATOR BODY, so it is gated on the operator fact rather than painted at
  // whoever pressed the button. A customer gets one plain line; the old panel, with its two password
  // fields and its Reset, is drawn only after GET /auth/state says operator. Fail closed: the check
  // is `me?.operator !== true`, so null, an absent field and a thrown read all draw nothing.
  assert.match(source, /Settings could not load\. Reload the page\./,
    "a customer whose settings.js did not load reads one plain line");
  assert.match(source, /if \(me\?\.operator !== true \|\| openPluginSurface !== "settings"\) return;/,
    "the old panel is painted only for the operator, and only while Settings is still open");
  assert.match(source, /openPanel\("Your workspace", "Settings", settingsPanel\(\)\);/);
  const fallback = source.slice(source.indexOf("function openSettingsPanel("), source.indexOf("function fillHostStatus("));
  assert.ok(fallback.indexOf("Settings could not load") < fallback.indexOf("settingsPanel()"),
    "the plain line is painted first and the operator body replaces it, never the other way round");
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

// ---- SETTINGS-3: a read that started before a change may not paint over it ------------------------
//
// THE BROWSER LEG PROVES THIS END TO END and this one proves it DETERMINISTICALLY, which the browser
// cannot: there the window is a few hundred milliseconds wide at 390x844 and shut at 1440x900, and a
// leg that waits for the sheet to settle passes on the bug. Here the read is held open on purpose, so
// the order is the assertion rather than the timing.
//
// The producer was open()'s own `void readFacts().then(paint)`. readFacts snapshots the live values
// SYNCHRONOUSLY before its first await; act() wrote the module, this browser's storage and the DOM node
// and never the facts; so a change made while the read was in flight was painted over from that older
// snapshot. MEASURED on grok-bot-local-vm at 390x844, 2026-09-10: 10 of 10 runs left the Talk mode
// select reading `always` while the module and localStorage both read `push`.
test("a read that started before a person's change does not publish its older snapshot over it", async () => {
  const mr = (() => {
    // A stub with enough of a page for readFacts to gather: a voice module that answers the OLD value,
    // and a /auth/devices read this test can hold open and release by hand.
    let release = null;
    const held = new Promise((resolve) => { release = resolve; });
    const stub = {
      document: undefined,
      localStorage: { getItem: () => null, setItem: () => {} },
      fetch: async () => { await held; return { ok: true, status: 200, text: async () => JSON.stringify({ devices: [] }) }; },
      __voice: { talkMode: () => "always", micDeviceId: () => "", supportsMicChoice: false },
    };
    const source = readFileSync(path.join(repoRoot, "ui/machine-room/settings.js"), "utf8");
    new Function("window", source)(stub);
    return { api: stub.__mrSettings, release };
  })();

  // The read is in flight and has already taken its synchronous snapshot of the old value.
  const reading = mr.api._readFacts();
  // The person changes it. act() goes through this one door, which writes the facts AND stamps the
  // change, and act("update-box") was already writing facts directly before this wave -- the habit is
  // this file's own.
  mr.api._noteChange("talkMode", "push");
  assert.equal(mr.api.facts().talkMode, "push", "the change did not reach the facts at all");
  // Now the read lands.
  mr.release();
  await reading;
  assert.equal(mr.api.facts().talkMode, "push",
    "the read published its own older snapshot over a change made after it started, which is SETTINGS-3");
  // A change made BEFORE the next read has nothing newer to re-apply, so the live value wins again --
  // which is what has to happen for a value the relay is the authority on.
  await mr.api._readFacts();
  assert.equal(mr.api.facts().talkMode, "always",
    "a read that started AFTER the change must win, or a route answer could never correct a stale control");
  // And the log is bounded: it is a guard, not a history of the session.
  for (let n = 0; n < 50; n += 1) mr.api._noteChange("theme", n % 2 === 0 ? "dark" : "light");
  assert.ok(mr.api._changeLog().length <= 32, `the change log grew to ${mr.api._changeLog().length}`);
});

// ---- VOICE-8: the seam a module contributes a row to a section whose body is somebody else's ------
//
// THE FAILURE THIS PINS IS SILENT. The registry was published for exactly this and bodyMarkup returned
// EARLY for a mounts section -- it never reached contributorsFor at all -- and the Operator section
// carried no groups. So register({section: "operator", group: "talking"}) stored the entry, had its
// fill() called with the operator body on every paint, and never drew its markup: no error, no failing
// test, a row nobody can see. docs/SETTINGS.md promised that call as VOICE-8's next action.
test("a module contributes rows to the Operator section, beside app.js's own stack and not inside it", () => {
  const mr = pure();
  const operator = mr.SECTIONS.find((section) => section.id === "operator");
  assert.equal(operator.mounts, "operator", "the Operator body is still app.js's to fill");
  assert.deepEqual(operator.groups.map((group) => group.id), ["talking"],
    "the one group this section names is the one VOICE-8's rows go in, and nothing else grew an array");

  const bare = mr._bodyMarkup(operator, { operator: true });
  assert.ok(!bare.includes("data-settings-contributed-host"),
    "a section nobody has contributed a row to draws exactly what it drew before: no heading, no empty card");

  assert.equal(mr.register({
    id: "voice-service", section: "operator", group: "talking", order: 10, operatorOnly: true,
    markup: () => '<div><strong>Service</strong><small>which one does the talking</small></div><div class="setting-control"><select data-voice-vendor></select></div>',
  }), true);
  assert.equal(mr.register({
    id: "voice-agent", section: "operator", group: "talking", order: 40, operatorOnly: true,
    markup: () => '<div><strong>Who you are talking to</strong><small>the head of your team</small></div><div class="setting-control"><select data-voice-agent></select></div>',
  }), true);

  const drawn = mr._bodyMarkup(operator, { operator: true });
  assert.match(drawn, /data-settings-contributed="voice-service"/, "a row registered on Operator is not on Operator");
  assert.match(drawn, /data-voice-vendor/, "the control itself never reached the page");
  assert.match(drawn, /<p class="settings-group-label">Talking<\/p>/, "the group it named has no heading");
  // BESIDE app.js's stack, never inside it. That body is somebody else's markup and every gate reads its
  // controls by id; a row inserted into it is a row inside a container this file does not own.
  const stack = drawn.indexOf('class="settings-rows settings-operator"');
  const contributed = drawn.indexOf("data-settings-contributed-host=");
  assert.ok(stack >= 0 && contributed > stack, "the contributed rows are not a sibling AFTER the operator stack");
  assert.match(drawn, /<div class="settings-rows settings-operator" data-settings-section="operator"><\/div>/,
    "app.js's own container is no longer byte-identical, which is what keeps its controls and their gates untouched");
  // In the order they asked for, not the order they registered in.
  assert.ok(drawn.indexOf("voice-service") < drawn.indexOf("voice-agent"));
});

test("an operatorOnly contributed row is absent when the facts do not say operator", () => {
  const mr = pure();
  const operator = mr.SECTIONS.find((section) => section.id === "operator");
  mr.register({
    id: "voice-service", section: "operator", group: "talking", operatorOnly: true,
    markup: () => '<div><strong>Service</strong><small>which one</small></div><div class="setting-control"><select data-voice-vendor></select></div>',
  });
  // FAIL CLOSED, the same rule the nav follows. An identity the console could not read is not an
  // operator, so absent, null and false all draw nothing -- and the control's own attribute is the thing
  // asserted, because that is what a customer would be able to reach.
  for (const facts of [{}, { operator: null }, { operator: false }, { operator: "yes" }, { operator: 1 }]) {
    const drawn = mr._bodyMarkup(operator, facts);
    assert.ok(!drawn.includes("data-voice-vendor"),
      `facts of ${JSON.stringify(facts)} drew the operator's control`);
    assert.ok(!drawn.includes("data-settings-contributed-host"), `facts of ${JSON.stringify(facts)} drew the container`);
  }
  assert.match(mr._bodyMarkup(operator, { operator: true }), /data-voice-vendor/);
  // And on no customer section at all, whichever way the facts read.
  for (const section of mr.sectionsFor(false)) {
    for (const facts of [{ ...FULL_FACTS }, { ...FULL_FACTS, operator: true }]) {
      assert.ok(!/data-voice-(vendor|model|voice|agent)/.test(mr._bodyMarkup(section, facts)),
        `${section.id} carries one of the operator's talking controls`);
    }
  }
});

test("the Operator section's contributed copy is exempt from the banned-word sweep, like the rest of it", () => {
  // RULE 1 IS ABOUT A CUSTOMER'S ROWS. docs/SETTINGS.md section 2 exempts the Operator section by
  // design: a vendor's name and the word key are the OPERATOR's words, and the four Talking rows are
  // his. The sweep has to go on reading only what a customer can read -- and it has to keep catching a
  // contributed row on a CUSTOMER section, which is the half that would otherwise be a hole in it.
  const mr = pure();
  mr.register({
    id: "voice-service", section: "operator", group: "talking", operatorOnly: true,
    markup: () => '<div><strong>Service</strong><small>Which service does the talking, on your own key.</small></div><div class="setting-control"><select data-voice-vendor></select></div>',
  });
  const copy = mr.customerCopy({ ...FULL_FACTS, operator: true });
  assert.equal(copy.filter((entry) => /^operator/.test(entry.where)).length, 0,
    "the sweep reached the operator's section, which is exempt by design and would fail on his own words");
  assert.deepEqual(copy.filter((entry) => mr.BANNED.test(entry.text)), [],
    "a customer-visible word tripped the sweep");
  // The contributed row's own words are not in the sweep's input at all, which is what "exempt" means
  // here -- and the proof that it is the SECTION and not the row that is exempt is that the same words
  // on a customer section are still unreachable to a contributor: customerCopy walks rowsFor, which is
  // this file's own rows, so the guard that really matters is the live page's, swept by
  // scripts/verify-settings.mjs over every node on the five customer sections.
  assert.equal(copy.filter((entry) => /Which service does the talking/.test(entry.text)).length, 0);
});

// The seam voice.js opens Settings through, and why it is a function of a SECTION and not a click.
// voice.js used to synthesise a click on #shelf-settings, which computes display:none at 390x844 --
// so "Open voice settings" was dead on every phone, silently, because a click on a hidden element
// is not an error and nothing throws. This takes a section id and works at every width.
test("__mrUi publishes one way into Settings, and it takes a section rather than an event", async () => {
  const app = await read("ui/machine-room/app.js");
  assert.match(app, /openSettings: \(sectionId\) => openSettingsPanel\(typeof sectionId === "string" \? sectionId : "general"\)/,
    "__mrUi.openSettings must exist and must not be handed a click event as a section");
  // And the gears go through a wrapper for the same reason: bound straight to openSettingsPanel,
  // the first argument every press passed was a MouseEvent standing where a section id goes.
  assert.match(app, /const openSettings = \(\) => openSettingsPanel\("general"\);/);
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
