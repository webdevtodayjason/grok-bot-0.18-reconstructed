// MAIL-1: the Email card in Settings, and the two adapter calls behind it.
//
// The card gives every agent an address at the operator's own domain and shows the mail that came
// in. Three things about it are worth pinning, because each of them has gone wrong on a card like
// this one before:
//   - the two secrets are write-only. The relay answers apiKeySet / webhookSecretSet and never a
//     value, so "set" on this card is the relay's word and there is nothing on screen to leak.
//   - nothing is painted from a click. Every cell comes from the answer the relay gave, so a save
//     the relay refused cannot leave the card claiming mail is arriving.
//   - the words are the ones a business owner reads, not the ones the wiring uses.
//
// The shipped block itself is run here rather than pattern-matched, the way the trigger editor and
// the routines panel are: a copy in the test would go on passing after the card changed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- the card, sliced out of app.js ------------------------------------------------------------
async function loadMailCard({ adapter = {}, state = { workers: [] }, showToast = () => {}, navigator = {} } = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  // ---- the Email card (docs/MAIL.md)");
  const end = source.indexOf("  // ---- end the Email card");
  assert.ok(start > 0 && end > start, "the Email card block must be findable in app.js");
  // The page's own escaper, not a copy of it: an escaping check against a copy proves nothing.
  const escStart = source.indexOf("  function escapeHtml(value) {");
  const escEnd = source.indexOf("  function sameContext(");
  assert.ok(escStart > 0 && escEnd > escStart, "escapeHtml must be findable in app.js");
  const dom = cardDom();
  const elements = { panelContent: { querySelector: (selector) => (selector === "[data-mail]" ? dom : null) } };
  const body = `${source.slice(escStart, escEnd)}\n${source.slice(start, end)}`;
  const exports = "return { MAIL_OUTCOME, mailWhen, mailAgentOptions, mailSection, mailSettingsFromCard,"
    + " paintMail, fillMail, saveMail, isMailControl, mailClick };";
  const card = new Function("adapter", "state", "elements", "showToast", "navigator", `${body}\n${exports}`)(
    adapter, state, elements, showToast, navigator);
  return { ...card, dom };
}

// Just enough element for the paint: the card only ever reads a value, writes a value, writes
// text, writes innerHTML, disables a button, or sets aria-pressed.
function node(extra = {}) {
  return {
    value: "", textContent: "", innerHTML: "", disabled: false, attrs: {}, focused: false, selected: false,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    hasAttribute(name) { return name in this.attrs; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    ...extra,
  };
}

const CARD_SELECTORS = [
  "[data-mail-domain]", "[data-mail-from-name]", "[data-mail-webhook-url]", "[data-mail-catch-all]",
  "[data-mail-enabled]", "[data-mail-enabled-note]", "[data-mail-key-note]", "[data-mail-secret-note]",
  "[data-mail-key]", "[data-mail-secret]", "[data-mail-key-clear]", "[data-mail-secret-clear]",
  "[data-mail-addresses]", "[data-mail-rows]",
];

function cardDom() {
  const nodes = {};
  for (const selector of CARD_SELECTORS) nodes[selector] = node();
  return { nodes, querySelector: (selector) => nodes[selector] ?? null };
}

// A button the click handler is handed, named the way the card names it.
const control = (attr) => node({ attrs: { [attr]: "" } });

const AGENTS = [
  { agentId: "a1", name: "Titan", address: "titan@titanium.bot" },
  { agentId: "a2", name: "Chief of Staff", address: "chiefofstaff@titanium.bot" },
];
const ROSTER = { workers: [{ id: "a1", name: "Titan" }, { id: "a2", name: "Chief of Staff" }] };

const SETTINGS = {
  enabled: true,
  domain: "titanium.bot",
  fromName: "Titanium Bot",
  apiBase: "https://api.resend.com",
  catchAllAgentId: "a1",
  routes: { support: "a2" },
  apiKeySet: true,
  webhookSecretSet: false,
  webhookUrl: "https://console.titanium.bot/hooks/resend",
  addresses: AGENTS,
  recent: [
    { at: "2026-09-06T15:04:00.000Z", email_id: "e1", from: "jason@webdevtoday.com", subject: "Invoice question", agentId: "a1", agentName: "Titan", outcome: "delivered" },
    { at: "2026-09-06T14:00:00.000Z", email_id: "e2", from: "someone@example.com", subject: "", agentId: "", agentName: "", outcome: "no_route" },
  ],
};

const reader = (settings = SETTINGS) => ({ getMailSettings: () => Promise.resolve(settings) });

// ---- the markup --------------------------------------------------------------------------------

test("the card is left out of Settings on an adapter that cannot read the mail settings", async () => {
  const card = await loadMailCard({ adapter: {} });
  assert.equal(card.mailSection(), "");
});

test("the card names, in plain words, everything the operator has to fill in", async () => {
  const card = await loadMailCard({ adapter: reader() });
  const markup = card.mailSection();
  for (const label of [
    "Receiving", "Your domain", "Sender name", "Who gets mail nobody else is named for",
    "The address to paste into Resend", "Resend API key", "Webhook signing secret",
    "Addresses", "Mail that arrived",
  ]) assert.ok(markup.includes(label), `the card must say "${label}"`);
  // The four columns of the received table, in the words of somebody looking for their email.
  for (const column of ["<th>When</th>", "<th>From</th>", "<th>Subject</th>", "<th>Went to</th>"]) {
    assert.ok(markup.includes(column), `the received table must have ${column}`);
  }
});

test("the card is written for a business owner, not for whoever wired it", async () => {
  const card = await loadMailCard({ adapter: reader() });
  // The words on screen, with the wiring taken out: an attribute may well be called
  // data-mail-catch-all, but nobody reading the card should have to know that phrase.
  const words = card.mailSection().replace(/<[^>]*>/g, " ");
  for (const banned of [/endpoint/i, /payload/i, /\bHMAC\b/i, /svix/i, /localpart/i, /catch-all/i,
    /\bJSON\b/, /jsonl/i, /ledger/i, /\bhost bundle\b/i, /—/]) {
    assert.doesNotMatch(words, banned, `the card must not say ${banned}`);
  }
});

test("the webhook address is read-only and has a copy button beside it", async () => {
  const markup = (await loadMailCard({ adapter: reader() })).mailSection();
  assert.match(markup, /<input type="text" readonly data-mail-webhook-url \/>/);
  assert.match(markup, /data-mail-copy>Copy<\/button>/);
});

test("both secrets are password fields with their own Save and Clear, and neither is ever read back", async () => {
  const markup = (await loadMailCard({ adapter: reader() })).mailSection();
  for (const field of ["data-mail-key", "data-mail-secret"]) {
    assert.match(markup, new RegExp(`<input type="password" autocomplete="off" [^>]*${field} \\/>`),
      `${field} must be a password field that fills from nothing`);
  }
  for (const button of ["data-mail-key-set", "data-mail-secret-set", "data-mail-key-clear", "data-mail-secret-clear"]) {
    assert.ok(markup.includes(button), `the card must have ${button}`);
  }
  // The markup is built before any answer arrives, so there is no value in it to leak, and the
  // shape the relay answers has no field that could carry one.
  assert.equal(Object.keys(SETTINGS).some((key) => /^(apiKey|webhookSecret)$/.test(key)), false);
  assert.doesNotMatch(markup, /value="(re_|whsec_)/);
});

// ---- the paint ---------------------------------------------------------------------------------

test("the paint puts the relay's answer on the card, including both secret states", async () => {
  const card = await loadMailCard({ adapter: reader(), state: ROSTER });
  card.paintMail(card.dom, SETTINGS);
  const at = (selector) => card.dom.nodes[selector];
  assert.equal(at("[data-mail-domain]").value, "titanium.bot");
  assert.equal(at("[data-mail-from-name]").value, "Titanium Bot");
  assert.equal(at("[data-mail-webhook-url]").value, "https://console.titanium.bot/hooks/resend");
  assert.equal(at("[data-mail-enabled]").getAttribute("aria-pressed"), "true");
  // A key that is set and a signing secret that is not: the card says so in words, and Clear is
  // only offered for the one there is something to clear.
  assert.equal(at("[data-mail-key-note]").textContent, "Saved.");
  assert.equal(at("[data-mail-secret-note]").textContent, "Not saved yet.");
  assert.equal(at("[data-mail-key-clear]").disabled, false);
  assert.equal(at("[data-mail-secret-clear]").disabled, true);
  // On, but a signing secret is missing, so mail cannot actually arrive yet and the card says that
  // rather than claiming it is working.
  assert.match(at("[data-mail-enabled-note]").textContent, /not finished/i);
});

test("receiving off says so, and a finished setup says mail is arriving", async () => {
  const card = await loadMailCard({ adapter: reader(), state: ROSTER });
  card.paintMail(card.dom, { ...SETTINGS, enabled: false });
  assert.match(card.dom.nodes["[data-mail-enabled-note]"].textContent, /^Off\./);
  card.paintMail(card.dom, { ...SETTINGS, webhookSecretSet: true });
  assert.match(card.dom.nodes["[data-mail-enabled-note]"].textContent, /^On\. Mail sent to an agent's address arrives/);
});

test("a relay that would not answer says so, instead of drawing email as switched off", async () => {
  const card = await loadMailCard({
    adapter: { getMailSettings: () => Promise.reject(new Error("signed out")) }, state: ROSTER,
  });
  await card.fillMail();
  assert.match(card.dom.nodes["[data-mail-enabled-note]"].textContent, /did not answer for email: signed out/);
});

test("the address list carries one row per agent, and says so when there is no domain yet", async () => {
  const card = await loadMailCard({ adapter: reader(), state: ROSTER });
  card.paintMail(card.dom, SETTINGS);
  const drawn = card.dom.nodes["[data-mail-addresses]"].innerHTML;
  assert.match(drawn, /titan@titanium\.bot/);
  assert.match(drawn, /chiefofstaff@titanium\.bot/);
  assert.equal(drawn.split("mail-address-row").length - 1, AGENTS.length);
  card.paintMail(card.dom, { ...SETTINGS, addresses: [] });
  assert.match(card.dom.nodes["[data-mail-addresses]"].innerHTML, /Type your domain above/);
});

test("the picker keeps an agent that has been deleted rather than silently re-pointing the mail", async () => {
  const card = await loadMailCard({ adapter: reader(), state: ROSTER });
  card.paintMail(card.dom, { ...SETTINGS, catchAllAgentId: "gone" });
  const options = card.dom.nodes["[data-mail-catch-all]"].innerHTML;
  assert.match(options, /value="gone" selected>gone \(not an agent on this box\)/);
  // And "nobody" is a real choice, not the absence of one.
  assert.match(options, /<option value=""[^>]*>Nobody/);
});

test("the received rows say where a message went in words, and never print the message", async () => {
  const card = await loadMailCard({ adapter: reader(), state: ROSTER });
  card.paintMail(card.dom, SETTINGS);
  const rows = card.dom.nodes["[data-mail-rows]"].innerHTML;
  assert.match(rows, /jason@webdevtoday\.com/);
  assert.match(rows, /Invoice question/);
  assert.match(rows, />Titan</, "a delivered row says which agent got it");
  assert.match(rows, /nobody was named for it/, "an undelivered row says why in plain words");
  assert.doesNotMatch(rows, /no_route/, "the relay's own word for it is not what the operator reads");
  card.paintMail(card.dom, { ...SETTINGS, recent: [] });
  assert.match(card.dom.nodes["[data-mail-rows]"].innerHTML, /No mail has arrived yet/);
});

test("a hostile sender or subject is escaped into the table rather than drawn", async () => {
  const card = await loadMailCard({ adapter: reader(), state: ROSTER });
  card.paintMail(card.dom, {
    ...SETTINGS,
    recent: [{ at: SETTINGS.recent[0].at, from: "<img src=x onerror=alert(1)>", subject: "<script>alert(2)</script>", agentName: "Titan", outcome: "delivered" }],
  });
  const rows = card.dom.nodes["[data-mail-rows]"].innerHTML;
  assert.doesNotMatch(rows, /<img|<script/);
  assert.match(rows, /&lt;img/);
});

// ---- the controls ------------------------------------------------------------------------------

test("Save sends the three plain settings and nothing else", async () => {
  const written = [];
  const card = await loadMailCard({
    adapter: { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (patch) => { written.push(patch); return Promise.resolve(SETTINGS); } },
    state: ROSTER,
  });
  card.dom.nodes["[data-mail-domain]"].value = " titanium.bot ";
  card.dom.nodes["[data-mail-from-name]"].value = "Titanium Bot";
  card.dom.nodes["[data-mail-catch-all]"].value = "a2";
  await card.mailClick(control("data-mail-save"));
  // Trimmed, and carrying no secret: a Save cannot send a key the operator never retyped.
  assert.deepEqual(written, [{ domain: "titanium.bot", fromName: "Titanium Bot", catchAllAgentId: "a2" }]);
});

test("a save is reported, and the card repaints from what the relay answered", async () => {
  const said = [];
  const card = await loadMailCard({
    adapter: {
      getMailSettings: () => Promise.resolve(SETTINGS),
      // The relay stored a domain of its own choosing, lowercased. The card has to show that one.
      setMailSettings: () => Promise.resolve({ ...SETTINGS, domain: "titanium.bot", enabled: false }),
    },
    state: ROSTER, showToast: (line) => said.push(line),
  });
  card.dom.nodes["[data-mail-domain]"].value = "TITANIUM.BOT";
  const button = control("data-mail-save");
  await card.mailClick(button);
  assert.deepEqual(said, ["Email settings saved."]);
  assert.equal(card.dom.nodes["[data-mail-domain]"].value, "titanium.bot");
  assert.equal(card.dom.nodes["[data-mail-enabled]"].getAttribute("aria-pressed"), "false");
  assert.equal(button.disabled, false, "the button is given back whatever the relay said");
});

test("a refused save is said out loud and the button comes back", async () => {
  const said = [];
  const card = await loadMailCard({
    adapter: { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: () => Promise.reject(new Error("could not write ui/mail.json")) },
    state: ROSTER, showToast: (line) => said.push(line),
  });
  const button = control("data-mail-save");
  await card.mailClick(button);
  assert.deepEqual(said, ["Email settings were not saved: could not write ui/mail.json"]);
  assert.equal(button.disabled, false);
});

test("a secret goes to the relay once, and the field is emptied", async () => {
  const written = [];
  const said = [];
  const card = await loadMailCard({
    adapter: { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (patch) => { written.push(patch); return Promise.resolve({ ...SETTINGS, webhookSecretSet: true }); } },
    state: ROSTER, showToast: (line) => said.push(line),
  });
  card.dom.nodes["[data-mail-secret]"].value = "  whsec_notreal  ";
  await card.mailClick(control("data-mail-secret-set"));
  assert.deepEqual(written, [{ webhookSecret: "whsec_notreal" }]);
  assert.equal(card.dom.nodes["[data-mail-secret]"].value, "", "the typed secret does not stay on the page");
  assert.deepEqual(said, ["The signing secret is saved on the relay."]);
  assert.equal(card.dom.nodes["[data-mail-secret-note]"].textContent, "Saved.");
});

test("an empty secret field is not written, and says what to do instead", async () => {
  const written = [];
  const said = [];
  const card = await loadMailCard({
    adapter: { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (patch) => { written.push(patch); return Promise.resolve(SETTINGS); } },
    state: ROSTER, showToast: (line) => said.push(line),
  });
  card.dom.nodes["[data-mail-key]"].value = "   ";
  await card.mailClick(control("data-mail-key-set"));
  // An empty field is not a clear. Writing "" here would wipe a working key nobody asked to remove.
  assert.deepEqual(written, []);
  assert.deepEqual(said, ["Type the key first."]);
});

test("Clear sends null, which is the only thing that empties a secret", async () => {
  const written = [];
  const card = await loadMailCard({
    adapter: { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (patch) => { written.push(patch); return Promise.resolve({ ...SETTINGS, apiKeySet: false }); } },
    state: ROSTER,
  });
  await card.mailClick(control("data-mail-key-clear"));
  await card.mailClick(control("data-mail-secret-clear"));
  assert.deepEqual(written, [{ apiKey: null }, { webhookSecret: null }]);
});

test("the switch writes only enabled, and repaints from the relay rather than from the click", async () => {
  const written = [];
  const card = await loadMailCard({
    // The relay refuses to come on. The switch must end up where the relay is, not where it was clicked.
    adapter: { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (patch) => { written.push(patch); return Promise.resolve({ ...SETTINGS, enabled: false }); } },
    state: ROSTER,
  });
  const toggle = control("data-mail-enabled");
  toggle.setAttribute("aria-pressed", "false");
  await card.mailClick(toggle);
  assert.deepEqual(written, [{ enabled: true }]);
  assert.equal(card.dom.nodes["[data-mail-enabled]"].getAttribute("aria-pressed"), "false");
});

test("every control on the card is one the click handler knows", async () => {
  const card = await loadMailCard({ adapter: reader() });
  const markup = card.mailSection();
  const inMarkup = [...markup.matchAll(/data-mail-[a-z-]+/g)].map((match) => match[0]);
  for (const attr of new Set(inMarkup)) {
    // Only the buttons and the switch are clicked; the inputs and the containers are read.
    if (!/(-set|-clear|-copy|-save|-enabled)$/.test(attr)) continue;
    assert.equal(card.isMailControl(control(attr)), true, `${attr} must reach the card's click handler`);
  }
  assert.equal(card.isMailControl(control("data-mail-domain")), false, "an input is not a control");
});

test("Copy puts the webhook address on the clipboard, and offers it for selection when it cannot", async () => {
  const said = [];
  const copied = [];
  const card = await loadMailCard({
    adapter: reader(),
    navigator: { clipboard: { writeText: (value) => { copied.push(value); return Promise.resolve(); } } },
    showToast: (line) => said.push(line),
  });
  card.dom.nodes["[data-mail-webhook-url]"].value = SETTINGS.webhookUrl;
  await card.mailClick(control("data-mail-copy"));
  assert.deepEqual(copied, [SETTINGS.webhookUrl]);
  assert.deepEqual(said, ["Address copied."]);

  const refusing = await loadMailCard({
    adapter: reader(),
    navigator: { clipboard: { writeText: () => Promise.reject(new Error("blocked")) } },
    showToast: (line) => said.push(line),
  });
  refusing.dom.nodes["[data-mail-webhook-url]"].value = SETTINGS.webhookUrl;
  await refusing.mailClick(control("data-mail-copy"));
  assert.equal(refusing.dom.nodes["[data-mail-webhook-url]"].selected, true, "it is selected so it can be copied by hand");
  assert.match(said[said.length - 1], /would not let the page write the clipboard/);
});

// ---- the two adapter calls, against a stub relay ------------------------------------------------
async function loadAdapter(relay) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter };\n  global.__bootMachineRoom =",
  );
  const requests = [];
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
    open: () => {},
  };
  const fetchStub = async (url, init) => {
    const target = String(url);
    if (target === "/mail/settings") {
      requests.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      const answer = await relay(requests[requests.length - 1]);
      return {
        ok: answer.ok !== false, status: answer.status ?? 200,
        headers: { get: () => null },
        json: async () => answer.body, text: async () => JSON.stringify(answer.body),
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  const { createGatewayAdapter } = fn(window, fetchStub);
  const state = {
    activeContext: { kind: "worker", id: "w1" }, openContexts: [{ kind: "worker", id: "w1" }],
    workers: [{ id: "w1", name: "Titan", status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null }],
    rooms: [], routines: [], plugins: [], models: { default: "d", available: [] },
    settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
    desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
  };
  return { adapter: createGatewayAdapter(state), requests, state };
}

test("the adapter reads the mail settings from the relay, and gets back no secret to hold", async () => {
  const { adapter, requests } = await loadAdapter(() => ({ body: SETTINGS }));
  const answer = await adapter.getMailSettings();
  // A plain same-origin GET: the console is served by the relay, so the session cookie rides along
  // by itself and there is no second credential for this page to keep.
  assert.deepEqual(requests, [{ method: "GET", body: null }]);
  assert.equal(answer.webhookUrl, SETTINGS.webhookUrl);
  // Whatever the relay sends, it is only ever a flag: there is no field here that could hold one.
  assert.equal(answer.apiKey, undefined);
  assert.equal(answer.webhookSecret, undefined);
  assert.equal(answer.apiKeySet, true);
});

test("the adapter writes a partial, so one control cannot overwrite what another owns", async () => {
  const { adapter, requests } = await loadAdapter(() => ({ body: SETTINGS }));
  await adapter.setMailSettings({ enabled: true });
  await adapter.setMailSettings({ webhookSecret: null });
  assert.deepEqual(requests.map((r) => r.method), ["POST", "POST"]);
  assert.deepEqual(requests.map((r) => r.body), [{ enabled: true }, { webhookSecret: null }]);
});

test("a relay that refuses the write comes back as a sentence the card can print", async () => {
  const { adapter } = await loadAdapter(() => ({ ok: false, status: 400, body: { error: "the body must be JSON" } }));
  await assert.rejects(adapter.setMailSettings({ domain: "nope nope" }), /the body must be JSON/);
});
