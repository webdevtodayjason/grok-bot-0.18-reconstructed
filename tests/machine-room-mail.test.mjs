// MAIL-1: the Email card in Settings, and the two adapter calls behind it.
//
// The card gives every agent an address at the operator's own domain and shows the mail that came
// in. Three things about it are worth pinning, because each of them has gone wrong on a card like
// this one before:
//   - the two secrets are write-only. The relay answers apiKeySet / webhookSecretSet and never a
//     value, so "set" on this card is the relay's word and there is nothing on screen to leak.
//   - nothing is painted from a click. Every cell comes from the answer the relay gave.
//   - the words are the ones a business owner reads. "Where email to your agents arrives", not
//     "webhook endpoint"; "no agent matched that address", not "no_route".
//
// The shipped block itself is run here rather than pattern-matched, the way the trigger editor and
// the routines panel are: a copy in the test would go on passing after the card changed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- the card, sliced out of app.js ----------------------------------------------------------
async function loadMailCard(adapter = {}, page = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  // ---- MAIL-1: Settings -> Email");
  const end = source.indexOf("  // ---- end MAIL-1");
  assert.ok(start > 0 && end > start, "the MAIL-1 block must be findable in app.js");
  // The page's own escaper, not a copy of it: an escaping check against a copy proves nothing.
  const escStart = source.indexOf("  function escapeHtml(value) {");
  const escEnd = source.indexOf("  function sameContext(");
  assert.ok(escStart > 0 && escEnd > escStart, "escapeHtml must be findable in app.js");
  const body = `${source.slice(escStart, escEnd)}\n${source.slice(start, end)}`;
  const exports = "return { MAIL_SECRETS, mailSection, mailEnabledNote, mailSecretPill, mailAgentOptions,"
    + " mailAddressRows, mailWentTo, mailRecentRows, mailSettingsFromCard, paintMail, paintMailEnabled, mailClick, fillMail };";
  return new Function("adapter", "elements", "showToast", "navigator", `${body}\n${exports}`)(
    adapter, page.elements ?? {}, page.showToast ?? (() => {}), page.navigator ?? {});
}

// Just enough element for the paint: the card only ever reads a value, writes a value, writes
// text, writes innerHTML, sets a class, disables a button, or sets aria-pressed.
function node(extra = {}) {
  return {
    value: "", textContent: "", innerHTML: "", className: "", disabled: false, attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    ...extra,
  };
}

function cardDom() {
  const nodes = {};
  const make = (selector) => (nodes[selector] ??= node());
  for (const selector of [
    "[data-mail-enabled-note]", "[data-mail-enabled]", "[data-mail-domain]", "[data-mail-from-name]",
    "[data-mail-webhook-url]", "[data-mail-catch-all]", "[data-mail-addresses]", "[data-mail-recent]",
  ]) make(selector);
  for (const kind of ["apiKey", "webhookSecret"]) {
    const pill = node();
    const clear = node();
    const input = node();
    nodes[`[data-mail-secret="${kind}"]`] = {
      kind,
      getAttribute: () => kind,
      querySelector: (selector) => (selector === "[data-mail-secret-pill]" ? pill
        : selector === "[data-mail-secret-input]" ? input
        : selector === '[data-mail-action="secret-clear"]' ? clear : null),
      pill, clear, input,
    };
  }
  return { nodes, querySelector: (selector) => nodes[selector] ?? null };
}

const AGENTS = [
  { agentId: "a1", name: "Titan", address: "titan@titanium.bot" },
  { agentId: "a2", name: "Chief of Staff", address: "chiefofstaff@titanium.bot" },
];

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
    { at: "2026-09-06T14:00:00.000Z", email_id: "e2", from: "someone@example.com", subject: "", agentId: null, agentName: null, outcome: "no_route" },
  ],
};

test("the card is left out of Settings on an adapter that cannot read the mail settings", async () => {
  const card = await loadMailCard({});
  assert.equal(card.mailSection(), "");
});

test("the card names, in plain words, everything the operator has to fill in", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const markup = card.mailSection();
  for (const label of [
    "Your domain", "Sender name", "When no agent matches", "Where email to your agents arrives",
    "Resend API key", "Webhook signing secret", "Your agents' addresses", "Mail that arrived",
  ]) assert.ok(markup.includes(label), `the card must say "${label}"`);
  // The four columns of the received table, in the words of somebody looking for their email.
  for (const column of ["<th>When</th>", "<th>From</th>", "<th>Subject</th>", "<th>Went to</th>"]) {
    assert.ok(markup.includes(column), `the received table must have ${column}`);
  }
});

test("the card is written for a business owner, not for whoever wired it", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  // The words on screen, with the wiring taken out: an attribute may well be called
  // data-mail-catch-all, but nobody reading the card should have to know that phrase.
  const words = card.mailSection().replace(/<[^>]*>/g, " ");
  for (const banned of [/endpoint/i, /payload/i, /\bHMAC\b/i, /svix/i, /localpart/i, /catch-all/i,
    /\bJSON\b/, /jsonl/i, /ledger/i, /\bhost bundle\b/i, /—/]) {
    assert.doesNotMatch(words, banned, `the card must not say ${banned}`);
  }
});

test("the webhook address is read-only and has a copy button beside it", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const markup = card.mailSection();
  assert.match(markup, /<input type="text" readonly[^>]*data-mail-webhook-url \/>/);
  assert.match(markup, /data-mail-action="copy">Copy<\/button>/);
});

test("both secrets are password fields with their own Save and Clear, and neither is ever read back", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const markup = card.mailSection();
  for (const kind of ["apiKey", "webhookSecret"]) {
    assert.ok(markup.includes(`data-mail-secret="${kind}"`), `${kind} must have its own block`);
  }
  assert.equal((markup.match(/type="password"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-mail-action="secret-set"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-mail-action="secret-clear"/g) ?? []).length, 2);
  // The skeleton carries no value for either one: the relay never sends one, so there is no
  // attribute here that a longer answer could ever fill in.
  assert.doesNotMatch(markup, /data-mail-secret-input[^>]*value=/);
});

test("a secret the relay holds reads set, and one it does not reads not set", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  assert.deepEqual(card.mailSecretPill(true), { text: "set", className: "status-pill success" });
  assert.deepEqual(card.mailSecretPill(false), { text: "not set", className: "status-pill attention" });
});

test("the paint puts the relay's answer on the card, including both secret states", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const root = cardDom();
  card.paintMail(root, SETTINGS);
  assert.equal(root.nodes["[data-mail-domain]"].value, "titanium.bot");
  assert.equal(root.nodes["[data-mail-from-name]"].value, "Titanium Bot");
  assert.equal(root.nodes["[data-mail-webhook-url]"].value, "https://console.titanium.bot/hooks/resend");
  assert.equal(root.nodes["[data-mail-enabled]"].getAttribute("aria-pressed"), "true");
  assert.match(root.nodes["[data-mail-enabled-note]"].textContent, /^On\./);

  const key = root.nodes['[data-mail-secret="apiKey"]'];
  assert.equal(key.pill.textContent, "set");
  assert.equal(key.clear.disabled, false, "a stored key can be cleared");
  const hook = root.nodes['[data-mail-secret="webhookSecret"]'];
  assert.equal(hook.pill.textContent, "not set");
  assert.equal(hook.clear.disabled, true, "there is nothing to clear when none is stored");

  assert.match(root.nodes["[data-mail-catch-all]"].innerHTML, /<option value="a1" selected>Titan<\/option>/);
  assert.match(root.nodes["[data-mail-addresses]"].innerHTML, /chiefofstaff@titanium\.bot/);
  assert.match(root.nodes["[data-mail-recent]"].innerHTML, /Invoice question/);
});

test("a relay that answered nothing at all is not drawn as email switched off", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(null) });
  const root = cardDom();
  root.nodes["[data-mail-domain]"].value = "titanium.bot";
  card.paintMail(root, null);
  assert.equal(root.nodes["[data-mail-enabled]"].disabled, true);
  assert.match(root.nodes["[data-mail-enabled-note]"].textContent, /did not answer/);
  // Nothing is blanked and neither table claims the box is empty.
  assert.equal(root.nodes["[data-mail-domain]"].value, "titanium.bot");
  assert.match(root.nodes["[data-mail-addresses]"].innerHTML, /not known/);
  assert.match(root.nodes["[data-mail-recent]"].innerHTML, /not known/);
  assert.match(card.mailEnabledNote({ enabled: false }), /^Off\./);
});

test("the address list carries one row per agent, plus any extra address the relay holds", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const rows = card.mailAddressRows(SETTINGS);
  assert.equal((rows.match(/data-mail-address-row/g) ?? []).length, 3);
  assert.ok(rows.includes("titan@titanium.bot"));
  assert.ok(rows.includes("chiefofstaff@titanium.bot"));
  // The extra route is shown against the agent it points at, built with the same domain.
  assert.ok(rows.includes("support@titanium.bot"));
  assert.ok(rows.includes("Chief of Staff"));
  assert.match(card.mailAddressRows({ addresses: [], routes: {} }), /no agents on this box yet/);
});

test("the picker keeps an agent that has been deleted rather than silently re-pointing the mail", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const options = card.mailAgentOptions(AGENTS, "gone-42");
  assert.match(options, /<option value="gone-42" selected>gone-42 \(not an agent on this box\)<\/option>/);
  assert.ok(options.includes('<option value="">No one chosen</option>'));
  const none = card.mailAgentOptions(AGENTS, "");
  assert.match(none, /<option value="" selected>No one chosen<\/option>/);
});

test("the received rows say where a message went in words, and never print the message", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const rows = card.mailRecentRows(SETTINGS.recent);
  assert.ok(rows.includes("Titan"), "a delivered row names the agent that got it");
  assert.match(rows, /no agent matched that address/);
  assert.match(rows, /\(no subject\)/);
  assert.doesNotMatch(rows, /no_route/, "the outcome is said in words, not in its code");
  assert.match(card.mailRecentRows([]), /No mail has arrived yet\./);
  // A subject is somebody else's text arriving from the internet, so it is escaped.
  const nasty = card.mailRecentRows([{ at: "2026-09-06T15:04:00.000Z", from: "a@b.c", subject: "<script>x</script>", agentName: "Titan", outcome: "delivered" }]);
  assert.ok(nasty.includes("&lt;script&gt;"));
  assert.doesNotMatch(nasty, /<script>/);
});

test("Save sends the three plain settings and nothing else", async () => {
  const card = await loadMailCard({ getMailSettings: () => Promise.resolve(SETTINGS) });
  const values = {
    "[data-mail-domain]": { value: "  titanium.bot  " },
    "[data-mail-from-name]": { value: "Titanium Bot" },
    "[data-mail-catch-all]": { value: "a2" },
  };
  const written = card.mailSettingsFromCard({ querySelector: (selector) => values[selector] ?? null });
  assert.deepEqual(written, { domain: "titanium.bot", fromName: "Titanium Bot", catchAllAgentId: "a2" });
  // The switch owns `enabled`, each secret button owns its own key, and the relay keeps a route
  // nobody sent. A Save that carried any of them could turn email on or drop a route by accident.
  for (const owned of ["enabled", "apiKey", "webhookSecret", "routes"]) {
    assert.equal(owned in written, false, `Save must not write ${owned}`);
  }
});

test("Save writes once through the adapter and reports what the relay answered", async () => {
  const writes = [];
  const toasts = [];
  const root = cardDom();
  root.nodes["[data-mail-domain]"].value = "titanium.bot";
  root.nodes["[data-mail-from-name]"].value = "Titanium Bot";
  root.nodes["[data-mail-catch-all]"].value = "a1";
  const card = await loadMailCard(
    { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (partial) => { writes.push(partial); return Promise.resolve(SETTINGS); } },
    { elements: { panelContent: { querySelector: (selector) => (selector === "[data-mail]" ? root : null) } }, showToast: (message) => toasts.push(message) },
  );
  card.mailClick(node({ getAttribute: (name) => (name === "data-mail-action" ? "save" : null) }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(writes, [{ domain: "titanium.bot", fromName: "Titanium Bot", catchAllAgentId: "a1" }]);
  assert.match(toasts.join(" "), /@titanium\.bot/);
});

test("a secret goes to the relay once, the field is emptied, and a refusal is said out loud", async () => {
  const writes = [];
  const toasts = [];
  const root = cardDom();
  const block = root.nodes['[data-mail-secret="apiKey"]'];
  block.input.value = "  re_fake_key_for_this_test  ";
  const card = await loadMailCard(
    { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (partial) => { writes.push(partial); return Promise.resolve(SETTINGS); } },
    { elements: { panelContent: { querySelector: (selector) => (selector === "[data-mail]" ? root : null) } }, showToast: (message) => toasts.push(message) },
  );
  const button = node({
    getAttribute: (name) => (name === "data-mail-action" ? "secret-set" : null),
    closest: () => block,
  });
  card.mailClick(button);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(writes, [{ apiKey: "re_fake_key_for_this_test" }]);
  assert.equal(block.input.value, "", "the field must not keep the value after the write");
  assert.match(toasts.join(" "), /Resend API key saved/);

  // Clear is null, which is what the relay reads as "remove it".
  writes.length = 0;
  card.mailClick(node({
    getAttribute: (name) => (name === "data-mail-action" ? "secret-clear" : null),
    closest: () => block,
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(writes, [{ apiKey: null }]);
});

test("an empty secret field is not written, and says what to do instead", async () => {
  const writes = [];
  const toasts = [];
  const root = cardDom();
  const block = root.nodes['[data-mail-secret="webhookSecret"]'];
  const card = await loadMailCard(
    { getMailSettings: () => Promise.resolve(SETTINGS), setMailSettings: (partial) => { writes.push(partial); return Promise.resolve(SETTINGS); } },
    { elements: { panelContent: { querySelector: (selector) => (selector === "[data-mail]" ? root : null) } }, showToast: (message) => toasts.push(message) },
  );
  card.mailClick(node({
    getAttribute: (name) => (name === "data-mail-action" ? "secret-set" : null),
    closest: () => block,
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(writes, []);
  assert.match(toasts.join(" "), /Paste the webhook signing secret first/);
});

test("the switch writes only enabled, and repaints from the relay rather than from the click", async () => {
  const writes = [];
  const root = cardDom();
  const card = await loadMailCard(
    // The relay says no, and the card has to end up showing off rather than the position the
    // switch was dragged to.
    { getMailSettings: () => Promise.resolve({ ...SETTINGS, enabled: false }), setMailSettings: (partial) => { writes.push(partial); return Promise.resolve({ ...SETTINGS, enabled: false }); } },
    { elements: { panelContent: { querySelector: (selector) => (selector === "[data-mail]" ? root : null) } } },
  );
  const toggle = node({ getAttribute(name) { return name === "data-mail-action" ? "enabled" : this.attrs[name] ?? "false"; } });
  card.mailClick(toggle);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(writes, [{ enabled: true }]);
  assert.equal(root.nodes["[data-mail-enabled]"].getAttribute("aria-pressed"), "false");
  assert.match(root.nodes["[data-mail-enabled-note]"].textContent, /^Off\./);
});

// ---- the two adapter calls, against a stub relay ----------------------------------------------
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
      requests.push({ method: init?.method ?? "GET", credentials: init?.credentials ?? null, body: init?.body ? JSON.parse(init.body) : null });
      const answer = await relay(requests[requests.length - 1]);
      return {
        ok: answer.ok !== false, status: answer.status ?? 200,
        headers: { get: () => null },
        json: async () => answer.body, text: async () => JSON.stringify(answer.body),
      };
    }
    return { ok: true, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
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

test("the adapter reads the mail settings from the relay, with the console session", async () => {
  const { adapter, requests } = await loadAdapter(() => ({ body: SETTINGS }));
  const answer = await adapter.getMailSettings();
  assert.deepEqual(requests, [{ method: "GET", credentials: "include", body: null }]);
  assert.equal(answer.webhookUrl, SETTINGS.webhookUrl);
  // Whatever the relay sends, it is only ever a flag: there is no field here that could hold one.
  assert.equal(answer.apiKey, undefined);
  assert.equal(answer.webhookSecret, undefined);
});

test("the adapter writes a partial, so one control cannot overwrite what another owns", async () => {
  const { adapter, requests } = await loadAdapter(() => ({ body: SETTINGS }));
  await adapter.setMailSettings({ enabled: true });
  await adapter.setMailSettings({ webhookSecret: null });
  assert.deepEqual(requests.map((r) => r.method), ["POST", "POST"]);
  assert.deepEqual(requests.map((r) => r.body), [{ enabled: true }, { webhookSecret: null }]);
  assert.deepEqual(requests.map((r) => r.credentials), ["include", "include"]);
});

test("a relay that refuses the write comes back as a sentence the card can print", async () => {
  const { adapter, state } = await loadAdapter(() => ({ ok: false, status: 400, body: { error: "domain is not a domain" } }));
  await assert.rejects(adapter.setMailSettings({ domain: "nope nope" }), /domain is not a domain/);
  // The refusal is also on the record, the way a refused job bus write is.
  const said = state.workers[0].messages.map((message) => message.text).join(" ");
  assert.match(said, /The email settings were not saved: domain is not a domain/);
});
