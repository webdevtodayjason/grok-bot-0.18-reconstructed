// PUSH-1. The decider, the collapse rules, quiet hours, the badge, the payloads and the pruning.
//
// Every test here drives ui/push-edge.mjs directly, with the clock, the gateway call, the sender and
// the files all injected, because that is the only way the rules can be proved without a relay, a box
// and an Apple account. The gate (scripts/verify-push.mjs) then proves the same rules against the
// real local box; these prove the ones a box cannot be made to produce on demand -- a card expiring,
// a quiet window ending, a vendor answering 410.
//
// The clock is an input and never Date.now(): a quiet-hours test that waited for 22:00 would be a
// test that passes once a day.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXPIRING_CARD_TTL_MS, FCM_COLLAPSE_BUCKET, MAX_COLLAPSE_ID_BYTES, MAX_FCM_COLLAPSE_KEYS,
  MAX_PUSH_PAYLOAD_BYTES, MAX_PUSH_REASON_LENGTH,
  PUSH_CARD_KINDS, PUSH_FILE, PUSH_SENT_FILE, PUSH_STUB_LEDGER_FILE, SENT_LEDGER_CAP,
  buildApnsMessage, buildFcmMessage, cardKey, cardsFromEntry, cardsFromReports, cardsFromTail,
  clipReason, createPushEdge, createPushStore, createSentLedger, createStubSender, deepLinks,
  prunesDevice, quietHoursEndMs, quietHoursHold,
} from "../ui/push-edge.mjs";

const fresh = () => mkdtempSync(path.join(tmpdir(), "push-edge-"));

// A tenant context shaped exactly like the one ui/server.mjs's buildContext hands every other edge:
// a slug and a file() that names a path inside this workspace's own state directory.
function tenantContext(slug = "demo", dir = fresh()) {
  return { slug, name: slug, dir, file: (name) => path.join(dir, name), ensureDir: () => {} };
}

const TEN_AM = Date.UTC(2026, 8, 10, 10, 0, 0);

// ---- the six card kinds, and the one that is never pushed ---------------------------------------

const approvalEntry = (over = {}) => ({
  kind: "send-message", id: "t10s0", timestampMs: TEN_AM,
  message: { type: "auto-review-approval", approval: { requestId: "req-1", summary: "Send that email to the client", reason: "it leaves the box", command: "send_email", ...over } },
});
const askEntry = (over = {}) => ({
  kind: "send-message", id: "t11s0", timestampMs: TEN_AM,
  message: { type: "local-tool-permission", ask: { requestId: "ask-1", action: "Run", target: "psql", description: "This runs on the box itself, not in a sandbox.", ...over } },
});
const widgetEntry = (entryOver = {}) => ({
  kind: "send-message", id: "t12s0", timestampMs: TEN_AM, ...entryOver,
  message: { type: "widget", widget: { prompt: "Which invoice should I chase first?", options: ["the oldest", "the biggest"] } },
});
const secretEntry = (entryOver = {}) => ({
  kind: "send-message", id: "t13s0", timestampMs: TEN_AM, ...entryOver,
  message: { type: "secret-request", secretRequest: { label: "the Stripe key", field: "STRIPE_KEY", description: "a model wrote this sentence" } },
});
const handoffEntry = (over = {}) => ({
  kind: "send-message", id: "t14s0", timestampMs: TEN_AM,
  boxRequestId: "box-1", boxInstruction: "Sign in to the bank so I can download the statement", ...over,
  message: { type: "text", content: "I need you at the keyboard." },
});

const context = { tenant: "demo", agentId: "agent-1", agentName: "Books", nowMs: TEN_AM + 1000 };

test("each of the six card kinds becomes exactly one card with the right kind, key and title", () => {
  const entries = [approvalEntry(), askEntry(), widgetEntry(), secretEntry(), handoffEntry()];
  const cards = cardsFromTail(entries, context);
  const reports = cardsFromReports([{ id: "pr-1", at: new Date(TEN_AM).toISOString(), agentId: "agent-1", agentName: "Books", report: { title: "The browser tool times out on every page", description: "three runs, all timed out" } }], { tenant: "demo", nowMs: context.nowMs });

  const all = [...cards, ...reports];
  assert.equal(all.length, 6, "five transcript kinds plus a report row");
  assert.deepEqual(all.map((card) => card.kind).sort(), [...PUSH_CARD_KINDS].sort());

  // One card per entry, every key distinct, every key 32 hex characters.
  const keys = new Set(all.map((card) => card.key));
  assert.equal(keys.size, 6, "one collapse key per card");
  for (const card of all) assert.match(card.key, /^[0-9a-f]{32}$/);

  const byKind = Object.fromEntries(all.map((card) => [card.kind, card]));
  assert.equal(byKind["auto-review"].title, "Send that email to the client");
  assert.equal(byKind["auto-review"].requestId, "req-1");
  // The console's own title for this card, character for character (gateway-adapter.js:138).
  assert.equal(byKind["local-tool"].title, "Run · psql");
  assert.equal(byKind["local-tool"].requestId, "ask-1");
  assert.equal(byKind.widget.title, "Which invoice should I chase first?");
  assert.equal(byKind.widget.requestId, "", "a widget question has no request id, only an entry id");
  assert.equal(byKind.secret.title, "The agent asked for the Stripe key");
  assert.equal(byKind["box-handoff"].title, "Take the keyboard for Books");
  assert.equal(byKind["box-handoff"].requestId, "box-1");
  assert.equal(byKind.report.title, "The browser tool times out on every page");
  for (const card of all) assert.equal(card.pending, true, `${card.kind} is pending`);
});

test("a secret request never carries the model's own description into a notification", () => {
  const [card] = cardsFromEntry(secretEntry(), context);
  assert.ok(!card.reason.includes("a model wrote this sentence"),
    "a model can name the value it is asking about, so its prose never reaches a lock screen");
  assert.equal(card.reason, "It needs a credential before it can carry on.");
});

test("the page-local failed-turn offer is not a card at all", () => {
  // offer-<seq> is minted at app.js:995 and dies with the page. It has no transcript entry and no
  // durable id, so there is nothing for this decider to see and nothing to collapse on.
  const cards = cardsFromTail([{ kind: "turn-failed", id: "t15", timestampMs: TEN_AM, text: "the turn failed", cause: "provider" }], context);
  assert.deepEqual(cards, [], "a failed turn produces no push");
});

test("an answered, dismissed, provided or resolved card is not pending, read off the host's own stamp", () => {
  const cases = [
    [approvalEntry({ status: "approved" }), "auto-review"],
    [askEntry({ status: "denied" }), "local-tool"],
    [widgetEntry({ respondedValue: "the oldest" }), "widget"],
    [widgetEntry({ widgetDismissed: true }), "widget"],
    [secretEntry({ secretProvided: true }), "secret"],
    [handoffEntry({ boxResolution: "handed_back" }), "box-handoff"],
    [handoffEntry({ boxResolution: "dismissed" }), "box-handoff"],
  ];
  for (const [entry, kind] of cases) {
    const [card] = cardsFromEntry(entry, context);
    assert.equal(card.kind, kind);
    assert.equal(card.pending, false, `${kind} with the host's stamp on it is not pending`);
  }
});

test("only the two self-expiring kinds carry a deadline, and an expired one stops being pending", () => {
  const [approval] = cardsFromEntry(approvalEntry(), context);
  const [ask] = cardsFromEntry(askEntry(), context);
  assert.equal(approval.deadlineMs, TEN_AM + EXPIRING_CARD_TTL_MS);
  assert.equal(ask.deadlineMs, TEN_AM + EXPIRING_CARD_TTL_MS);
  for (const entry of [widgetEntry(), secretEntry(), handoffEntry()]) {
    const [card] = cardsFromEntry(entry, context);
    assert.equal(card.deadlineMs, 0, `${card.kind} waits for a person and never expires`);
  }
  // Past the deadline the stamp is irrelevant: the host stops taking an answer, so a phone offering
  // one would be lying.
  const [late] = cardsFromEntry(approvalEntry(), { ...context, nowMs: TEN_AM + EXPIRING_CARD_TTL_MS + 1 });
  assert.equal(late.pending, false);
  assert.equal(late.expired, true);
});

test("the card key is stable on tenant, agent and entry and on nothing else", () => {
  const one = cardKey({ tenant: "demo", agentId: "a", entryId: "e" });
  assert.equal(one, cardKey({ tenant: "demo", agentId: "a", entryId: "e" }), "the same card, the same key");
  assert.notEqual(one, cardKey({ tenant: "other", agentId: "a", entryId: "e" }), "two workspaces never share a key");
  assert.notEqual(one, cardKey({ tenant: "demo", agentId: "b", entryId: "e" }));
  assert.notEqual(one, cardKey({ tenant: "demo", agentId: "a", entryId: "f" }));
  // The raw slug is not in the key: a collapse id is echoed in APNs diagnostics.
  assert.ok(!one.includes("demo"));
});

// ---- the two collapse rules, which are NOT one rule ---------------------------------------------

test("iOS collapses per card inside the 64-byte ceiling; Android tags per card and collapses per bucket", () => {
  const [approval] = cardsFromEntry(approvalEntry(), context);
  const [ask] = cardsFromEntry(askEntry(), context);

  const ios = buildApnsMessage(approval, { badge: 1, bundleId: "bot.titanium.app", host: "console.titanium.bot", nowMs: context.nowMs });
  assert.equal(ios.headers["apns-collapse-id"], approval.key, "per card on iOS, which merges rather than stacks");
  assert.ok(Buffer.byteLength(ios.headers["apns-collapse-id"], "utf8") <= MAX_COLLAPSE_ID_BYTES);

  const android = buildFcmMessage(approval, { badge: 1, token: "fcm-token", host: "console.titanium.bot", nowMs: context.nowMs });
  assert.equal(android.message.android.notification.tag, approval.key, "the tag is what replaces a notification in the drawer");
  // collapse_key is per BUCKET and not per kind: six kinds against FCM's four-key ceiling. The test
  // below this one pins the fold itself.
  assert.equal(android.message.android.collapse_key, "decision", "collapse_key is per bucket, because FCM guarantees only four at once");

  // Two cards of the same kind share a collapse_key and differ by tag. That is the whole point: a
  // key per card would silently lose the guarantee at the fifth distinct key.
  const second = buildFcmMessage({ ...approval, key: "f".repeat(32), entryId: "t99s0" }, { badge: 2, token: "fcm-token", nowMs: context.nowMs });
  assert.equal(second.message.android.collapse_key, android.message.android.collapse_key);
  assert.notEqual(second.message.android.notification.tag, android.message.android.notification.tag);

  // And two kinds in DIFFERENT buckets get different collapse keys, so a question never buries the
  // keyboard. Two kinds in the same bucket deliberately share one, and are told apart by tag above.
  const handoff = buildFcmMessage(cardsFromEntry(handoffEntry(), context)[0], { badge: 1, token: "fcm-token", nowMs: context.nowMs });
  assert.equal(handoff.message.android.collapse_key, "keyboard");
  assert.notEqual(handoff.message.android.collapse_key, android.message.android.collapse_key);
  const other = buildFcmMessage(ask, { badge: 1, token: "fcm-token", nowMs: context.nowMs });
  assert.equal(other.message.android.collapse_key, "decision", "an ask is a decision, like an approval");
});

test("the payload fits, puts the custom keys beside aps, and carries no transcript prose past the reason", () => {
  const long = "x".repeat(4000);
  const [card] = cardsFromEntry(approvalEntry({ reason: long, command: long }), context);
  assert.ok(card.reason.length <= MAX_PUSH_REASON_LENGTH, `the reason is clipped to ${MAX_PUSH_REASON_LENGTH}`);
  const built = buildApnsMessage(card, { badge: 4, bundleId: "bot.titanium.app", host: "console.titanium.bot", nowMs: context.nowMs });
  assert.ok(built.bytes < MAX_PUSH_PAYLOAD_BYTES, `${built.bytes} bytes is inside the ${MAX_PUSH_PAYLOAD_BYTES} ceiling`);
  // PEERS of aps, never inside it: anything APNs does not recognise inside aps is undefined.
  for (const key of ["cardKey", "kind", "tenant", "agent", "entry", "request", "link", "web"]) {
    assert.ok(Object.hasOwn(built.payload, key), `${key} is a peer of aps`);
    assert.ok(!Object.hasOwn(built.payload.aps, key), `${key} is not inside aps`);
  }
  assert.deepEqual(Object.keys(built.payload.aps).sort(), ["alert", "badge", "sound", "thread-id"]);
  assert.equal(built.payload.aps.badge, 4);
  assert.equal(built.payload.aps["thread-id"], "agent-1");
  assert.ok(!JSON.stringify(built.payload).includes(long), "the un-clipped prose is nowhere in the payload");
});

test("a token never rides in a deep link, and the https fallback names the entry", () => {
  const [card] = cardsFromEntry(handoffEntry(), context);
  const links = deepLinks(card, { host: "console.titanium.bot" });
  assert.equal(links.app, "titaniumbot://card?tenant=demo&agent=agent-1&entry=t14s0&kind=box-handoff");
  assert.equal(links.web, "https://console.titanium.bot/?agent=agent-1&entry=t14s0");
  for (const link of [links.app, links.web]) {
    assert.ok(!/token|bearer|session|authorization/i.test(link), "no credential in a URL, ever");
  }
});

test("the silent badge update is an alert-free, sound-free background push", () => {
  const [card] = cardsFromEntry(approvalEntry(), context);
  const ios = buildApnsMessage(card, { badge: 0, bundleId: "bot.titanium.app", silent: true, nowMs: context.nowMs });
  assert.equal(ios.headers["apns-push-type"], "background");
  assert.equal(ios.headers["apns-priority"], "5");
  assert.equal(ios.headers["apns-collapse-id"], card.key, "the same key, so it lands on the notification it closes");
  assert.equal(ios.headers["apns-expiration"], undefined, "a badge update is not a card and does not expire with one");
  assert.equal(ios.payload.aps["content-available"], 1);
  assert.equal(ios.payload.aps.alert, undefined);
  assert.equal(ios.payload.aps.sound, undefined);
  const android = buildFcmMessage(card, { badge: 0, token: "t", silent: true, nowMs: context.nowMs });
  assert.equal(android.message.android.notification, undefined, "data only, or Android draws one itself");
  assert.equal(android.message.data.closed, "1");
});

test("an alert for an expiring card carries the card's own deadline on both platforms", () => {
  const [card] = cardsFromEntry(approvalEntry(), context);
  const ios = buildApnsMessage(card, { badge: 1, bundleId: "b", nowMs: context.nowMs });
  assert.equal(ios.headers["apns-expiration"], String(Math.floor(card.deadlineMs / 1000)));
  const android = buildFcmMessage(card, { badge: 1, token: "t", nowMs: context.nowMs });
  assert.equal(android.message.android.ttl, `${Math.round((card.deadlineMs - context.nowMs) / 1000)}s`);
});

// ---- quiet hours ---------------------------------------------------------------------------------

test("quiet hours wrap midnight, respect the account's offset, and are off by default", () => {
  const off = { quietHours: { on: false, from: 22, to: 7 }, utcOffsetMinutes: 0 };
  assert.equal(quietHoursHold(off, Date.UTC(2026, 8, 10, 23, 0, 0)), false, "off is off");

  const wrapping = { quietHours: { on: true, from: 22, to: 7 }, utcOffsetMinutes: 0 };
  assert.equal(quietHoursHold(wrapping, Date.UTC(2026, 8, 10, 23, 0, 0)), true);
  assert.equal(quietHoursHold(wrapping, Date.UTC(2026, 8, 11, 3, 0, 0)), true);
  assert.equal(quietHoursHold(wrapping, Date.UTC(2026, 8, 11, 7, 0, 0)), false, "the window is half open at the end");
  assert.equal(quietHoursHold(wrapping, Date.UTC(2026, 8, 11, 12, 0, 0)), false);

  const sameDay = { quietHours: { on: true, from: 9, to: 17 }, utcOffsetMinutes: 0 };
  assert.equal(quietHoursHold(sameDay, Date.UTC(2026, 8, 10, 12, 0, 0)), true);
  assert.equal(quietHoursHold(sameDay, Date.UTC(2026, 8, 10, 20, 0, 0)), false);

  // Chicago in September is UTC-5. 23:00 UTC is 18:00 there, which is NOT inside 22 to 7 local.
  const chicago = { quietHours: { on: true, from: 22, to: 7 }, utcOffsetMinutes: -300 };
  assert.equal(quietHoursHold(chicago, Date.UTC(2026, 8, 10, 23, 0, 0)), false, "the offset is the whole point");
  assert.equal(quietHoursHold(chicago, Date.UTC(2026, 8, 11, 4, 0, 0)), true, "23:00 local");
});

test("a held card says WHEN the window ends, because \"3 held\" alone reads as three cards dropped", () => {
  const settings = { quietHours: { on: true, from: 22, to: 7 }, utcOffsetMinutes: 0 };
  // Inside the window at 23:00 UTC: it ends at 07:00 the next morning.
  assert.equal(new Date(quietHoursEndMs(settings, Date.UTC(2026, 8, 10, 23, 0, 0))).toISOString(), "2026-09-11T07:00:00.000Z");
  // And from the small hours of the same night, the same morning.
  assert.equal(new Date(quietHoursEndMs(settings, Date.UTC(2026, 8, 11, 3, 0, 0))).toISOString(), "2026-09-11T07:00:00.000Z");
  // Outside the window there is nothing to say, so it says nothing rather than a time in the past.
  assert.equal(quietHoursEndMs(settings, Date.UTC(2026, 8, 11, 12, 0, 0)), 0);
  assert.equal(quietHoursEndMs({ quietHours: { on: false, from: 22, to: 7 } }, Date.UTC(2026, 8, 10, 23, 0, 0)), 0);
  // And the offset moves it, the same way the hold does: Chicago's 23:00 is 04:00 UTC, so its window
  // ends at 12:00 UTC.
  const chicago = { quietHours: { on: true, from: 22, to: 7 }, utcOffsetMinutes: -300 };
  assert.equal(new Date(quietHoursEndMs(chicago, Date.UTC(2026, 8, 11, 4, 0, 0))).toISOString(), "2026-09-11T12:00:00.000Z");
});

// ---- the store -----------------------------------------------------------------------------------

test("registration is idempotent per deviceId, scoped by sub, and never answers a token", async () => {
  const t = tenantContext();
  const store = createPushStore({ file: t.file(PUSH_FILE) });
  await store.register({ deviceId: "phone-1", platform: "ios", token: "apns-token-one", sub: "person-a", name: "Jason's iPhone" });
  await store.register({ deviceId: "phone-1", platform: "ios", token: "apns-token-two", sub: "person-a", name: "Jason's iPhone" });
  await store.register({ deviceId: "phone-2", platform: "android", token: "fcm-token", sub: "person-b" });

  const state = await store.read();
  assert.equal(state.devices.length, 2, "a second registration of the same device updates rather than duplicating");
  const one = state.devices.find((d) => d.deviceId === "phone-1");
  assert.equal(one.token, "apns-token-two", "the newest token wins");
  assert.equal(one.sub, "person-a");
  assert.equal(one.env, "production", "production unless the app says sandbox");
  assert.ok(one.tokenAt > 0, "the timestamp is refreshed on every upload, which is the fid transition's rule");

  // Whatever the client hands back is stored verbatim. FCM's `token` field is deprecated in favour of
  // `fid` and `fid` accepts a registration token through the transition, so this relay does not get
  // to have an opinion about which form a vendor's SDK is on this month.
  await store.register({ deviceId: "phone-2", platform: "android", token: "a-fid-shaped-value:with-colons", sub: "person-b" });
  assert.equal((await store.read()).devices.find((d) => d.deviceId === "phone-2").token, "a-fid-shaped-value:with-colons");

  assert.equal((await store.register({ deviceId: "", platform: "ios", token: "x" })).ok, false);
  assert.equal((await store.register({ deviceId: "d", platform: "web", token: "x" })).ok, false, "three platforms, and web is not one");
  assert.equal((await store.register({ deviceId: "d", platform: "ios", token: "" })).ok, false);

  assert.equal((await store.forget("phone-1")).removed, true);
  assert.equal((await store.forget("phone-1")).removed, false, "forgetting twice is not an error");
  assert.equal((await store.read()).devices.length, 1);
});

test("settings are per person, keyed on sub, and the instance door means the workspace", async () => {
  const t = tenantContext();
  const store = createPushStore({ file: t.file(PUSH_FILE) });
  const mine = await store.saveSettings("person-a", { kinds: { widget: false }, quietHours: { on: true, from: 23, to: 6 }, utcOffsetMinutes: -300 });
  assert.equal(mine.kinds.widget, false);
  assert.equal(mine.kinds["auto-review"], true, "a kind nobody switched off is on");
  assert.equal(mine.quietHours.on, true);
  assert.equal(mine.utcOffsetMinutes, -300);

  const theirs = await store.settingsFor("person-b");
  assert.equal(theirs.kinds.widget, true, "one person's switch is not another's");
  assert.equal(theirs.quietHours.on, false);

  // "" is the instance-password door, which has no person behind it, so it means the workspace.
  const workspace = await store.saveSettings("", { kinds: { report: false } });
  assert.equal(workspace.kinds.report, false);
  assert.equal((await store.settingsFor("person-a")).kinds.report, true, "and it is still not anybody else's");

  // An hour out of range is clamped rather than stored: a 47 in this field is a quiet window that
  // never opens and never closes.
  assert.equal((await store.saveSettings("person-c", { quietHours: { on: true, from: 47, to: -3 } })).quietHours.from, 23);
});

test("the sent ledger survives a restart and is capped", async () => {
  const t = tenantContext();
  const file = t.file(PUSH_SENT_FILE);
  const ledger = createSentLedger({ file, now: () => TEN_AM });
  const rows = await ledger.read();
  for (let i = 0; i < SENT_LEDGER_CAP + 40; i += 1) {
    rows.set(`key-${i}`, { key: `key-${i}`, kind: "widget", state: "alerted", at: TEN_AM - (SENT_LEDGER_CAP + 40 - i) * 1000, deadlineMs: 0, agentId: "a", entryId: `e-${i}` });
  }
  await ledger.write(rows);

  // A second reader, as a restarted relay would be. An in-memory map would have re-notified a
  // customer about every one of these on the next redeploy.
  const after = await createSentLedger({ file, now: () => TEN_AM }).read();
  assert.equal(after.size, SENT_LEDGER_CAP, `capped at ${SENT_LEDGER_CAP}`);
  assert.ok(after.has(`key-${SENT_LEDGER_CAP + 39}`), "the newest rows are the ones kept");
  assert.ok(!after.has("key-0"), "the oldest are dropped");

  // And age bites too: the same file read eight days later is empty.
  const old = await createSentLedger({ file, now: () => TEN_AM + 8 * 24 * 60 * 60 * 1000 }).read();
  assert.equal(old.size, 0, "nothing older than seven days");
});

// ---- what a vendor answer means -----------------------------------------------------------------

test("410, UNREGISTERED and a bad-argument 400 prune the row; everything else does not", () => {
  assert.ok(prunesDevice({ platform: "ios", status: 410, reason: "Unregistered" }).length > 0);
  assert.ok(prunesDevice({ platform: "ios", status: 400, reason: "ExpiredToken" }).length > 0);
  assert.ok(prunesDevice({ platform: "android", status: 404, reason: "UNREGISTERED" }).length > 0);
  assert.ok(prunesDevice({ platform: "android", status: 400, reason: "INVALID_ARGUMENT" }).length > 0);
  // These are ours to fix or to wait out, not the device's fault, so the row stays.
  assert.equal(prunesDevice({ platform: "ios", status: 400, reason: "BadDeviceToken" }), "");
  assert.equal(prunesDevice({ platform: "ios", status: 403, reason: "ExpiredProviderToken" }), "");
  assert.equal(prunesDevice({ platform: "ios", status: 429, reason: "TooManyRequests" }), "");
  assert.equal(prunesDevice({ platform: "android", status: 503, reason: "UNAVAILABLE" }), "");
});

// ---- the whole loop, with everything injected ---------------------------------------------------

/** A push edge over one workspace, a recording sender, and a clock the test moves by hand. */
function harness({ devices = [], settings = {}, tail = [], reports = [], nowRef = { at: TEN_AM }, slug = "demo" } = {}) {
  const t = tenantContext(slug);
  const sent = [];
  const calls = [];
  const roster = { agents: [{ id: "agent-1", name: "Books", newestEntryId: "t10s0", unreadCount: 1, updatedAt: TEN_AM, awaitingUserResponse: null }] };
  const edge = createPushEdge({
    readBody: async () => "",
    fail: () => true,
    tenants: () => [t],
    contextOf: (want) => (want === slug ? t : null),
    subOf: () => "",
    now: () => nowRef.at,
    hostOf: () => "console.titanium.bot",
    credentials: () => ({}),
    gatewayCall: async (_t, command, args) => {
      calls.push({ command, args });
      const body = command === "listAgents" ? roster
        : command === "listProblemReports" ? { reports: reports() }
          : command === "getAgentTranscriptTail" ? { entries: tail() }
            : {};
      return { status: 200, text: JSON.stringify(body), type: "application/json" };
    },
    senderFor: () => ({ kind: "recording", async send(row) { sent.push(row); return { ok: true, status: 200 }; } }),
    log: () => {},
  });
  return { t, edge, sent, calls, roster, nowRef };
}

test("a workspace with no registered device reaches its box zero times", async () => {
  const h = harness({ tail: () => [approvalEntry()], reports: () => [] });
  const answer = await h.edge.sweepOnce("a test");
  assert.equal(h.calls.length, 0, "the first act of a sweep is a file read, never a gateway call");
  assert.equal(h.edge.stats().gatewayCalls, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(answer.swept[0].skipped, "no device is registered");
  // And no push file was written for a workspace that has nothing to say.
  assert.equal(existsSync(h.t.file(PUSH_SENT_FILE)), false);
});

test("a real pending card sends exactly one push; the same card twice sends nothing", async () => {
  const h = harness({ tail: () => [approvalEntry()], reports: () => [] });
  await h.edge.storeFor(h.t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });

  const first = await h.edge.sweepOnce("the first pass");
  assert.equal(h.sent.length, 1, "one push per card");
  assert.equal(h.sent[0].silent, false);
  assert.equal(h.sent[0].card.kind, "auto-review");
  assert.equal(h.sent[0].card.title, "Send that email to the client");
  assert.equal(h.sent[0].badge, 1, "the badge is the count of pending cards");
  assert.equal(first.swept[0].sent, 1);
  const calls = h.calls.map((call) => call.command);
  assert.deepEqual(calls, ["listAgents", "listProblemReports", "getAgentTranscriptTail"],
    "the roster is the change detector and one tail read is the authority");
  assert.deepEqual(h.calls[2].args, { id: "agent-1", limit: 5 });

  // A second pass over the same card. The roster has not moved, but the card is still open, so the
  // tail is read again (the close is what drops the badge) and NOTHING is sent.
  const second = await h.edge.sweepOnce("the second pass");
  assert.equal(h.sent.length, 1, "deduped from the ledger on disk");
  assert.equal(second.swept[0].sent, 0);
});

test("answering a card sends one silent badge update and no second alert", async () => {
  let answered = false;
  const h = harness({ tail: () => [answered ? approvalEntry({ status: "approved" }) : approvalEntry()], reports: () => [] });
  await h.edge.storeFor(h.t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });

  await h.edge.sweepOnce("one");
  assert.equal(h.sent.length, 1);
  answered = true;
  const after = await h.edge.sweepOnce("two");
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].silent, true, "a silent update, so every other device's badge drops");
  assert.equal(h.sent[1].badge, 0);
  assert.equal(h.sent[1].headers["apns-push-type"], "background");
  assert.equal(after.swept[0].closed, 1);

  // And it closes once: a third pass over the same answered card sends nothing at all.
  await h.edge.sweepOnce("three");
  assert.equal(h.sent.length, 2);
});

test("a card that expires unread closes from the ledger alone, with no gateway call about it", async () => {
  const nowRef = { at: TEN_AM };
  // The transcript goes quiet: after the first pass the tail answers nothing, which is what a
  // compacted or rolled-past entry looks like.
  let visible = true;
  const h = harness({ tail: () => (visible ? [approvalEntry()] : []), reports: () => [], nowRef });
  await h.edge.storeFor(h.t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });
  await h.edge.sweepOnce("one");
  assert.equal(h.sent.length, 1);

  visible = false;
  nowRef.at = TEN_AM + EXPIRING_CARD_TTL_MS + 1;
  const after = await h.edge.sweepOnce("past the deadline");
  assert.equal(after.swept[0].closed, 1, "the ledger knows the deadline");
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].silent, true);
  assert.equal(h.sent[1].badge, 0);
});

test("quiet hours hold the alert, pass the silent update, and release exactly one catch-up", async () => {
  const nowRef = { at: Date.UTC(2026, 8, 10, 23, 0, 0) };
  const h = harness({ tail: () => [handoffEntry()], reports: () => [], nowRef });
  await h.edge.storeFor(h.t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });
  await h.edge.storeFor(h.t).saveSettings("", { quietHours: { on: true, from: 22, to: 7 }, utcOffsetMinutes: 0 });

  const held = await h.edge.sweepOnce("inside the window");
  assert.equal(h.sent.length, 0, "the alert is held");
  assert.equal(held.swept[0].held, 1);

  // Still inside the window, several passes later: still nothing, and still exactly one owed.
  nowRef.at = Date.UTC(2026, 8, 11, 3, 0, 0);
  await h.edge.sweepOnce("still inside");
  assert.equal(h.sent.length, 0);

  // The window ends. One catch-up alert, on the same collapse key.
  nowRef.at = Date.UTC(2026, 8, 11, 7, 30, 0);
  const out = await h.edge.sweepOnce("the window ended");
  assert.equal(h.sent.length, 1, "exactly one catch-up");
  assert.equal(h.sent[0].silent, false);
  assert.equal(out.swept[0].sent, 1);

  // And one only: the next pass is quiet again.
  nowRef.at = Date.UTC(2026, 8, 11, 8, 0, 0);
  await h.edge.sweepOnce("after");
  assert.equal(h.sent.length, 1);
});

test("a silent badge update goes out inside quiet hours, because a badge makes no sound", async () => {
  const nowRef = { at: Date.UTC(2026, 8, 10, 23, 0, 0) };
  let answered = false;
  const h = harness({ tail: () => [answered ? widgetEntry({ respondedValue: "the oldest" }) : widgetEntry()], reports: () => [], nowRef });
  await h.edge.storeFor(h.t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });

  // Alerted before the window, so there is something to close inside it.
  nowRef.at = Date.UTC(2026, 8, 10, 18, 0, 0);
  await h.edge.sweepOnce("before");
  assert.equal(h.sent.length, 1);

  await h.edge.storeFor(h.t).saveSettings("", { quietHours: { on: true, from: 22, to: 7 }, utcOffsetMinutes: 0 });
  nowRef.at = Date.UTC(2026, 8, 10, 23, 30, 0);
  answered = true;
  await h.edge.sweepOnce("inside the window");
  assert.equal(h.sent.length, 2, "the badge still drops while somebody sleeps");
  assert.equal(h.sent[1].silent, true);
});

test("a per-kind switch holds the alert for that kind and for no other", async () => {
  const h = harness({ tail: () => [widgetEntry(), handoffEntry()], reports: () => [] });
  await h.edge.storeFor(h.t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });
  await h.edge.storeFor(h.t).saveSettings("", { kinds: { widget: false } });

  await h.edge.sweepOnce("one");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].card.kind, "box-handoff", "the switched-off kind did not wake anybody");
  // The badge still counts BOTH, because the card is still waiting whether or not it notified.
  assert.equal(h.sent[0].badge, 2);
});

test("the badge is the count of pending cards across every kind", async () => {
  const h = harness({
    tail: () => [approvalEntry(), widgetEntry(), secretEntry({ secretProvided: true }), handoffEntry()],
    reports: () => [{ id: "pr-1", at: new Date(TEN_AM).toISOString(), agentId: "agent-1", agentName: "Books", report: { title: "Something broke" } }],
  });
  await h.edge.storeFor(h.t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });
  await h.edge.sweepOnce("one");
  // Four pending (approval, widget, handoff, report) and one answered (the secret).
  for (const row of h.sent) assert.equal(row.badge, 4);
  assert.equal(h.sent.filter((row) => !row.silent).length, 4, "one alert per pending card");
});

test("a vendor saying the device is gone prunes the row permanently, and the next pass writes to nobody", async () => {
  const t = tenantContext();
  const sent = [];
  let visible = true;
  const edge = createPushEdge({
    readBody: async () => "", fail: () => true,
    tenants: () => [t], contextOf: () => t, subOf: () => "", now: () => TEN_AM,
    gatewayCall: async (_t, command) => ({
      status: 200,
      text: JSON.stringify(command === "listAgents"
        ? { agents: [{ id: "agent-1", name: "Books", newestEntryId: visible ? "t10s0" : "t11s0", unreadCount: 1, updatedAt: TEN_AM }] }
        : command === "getAgentTranscriptTail" ? { entries: [approvalEntry()] } : { reports: [] }),
      type: "application/json",
    }),
    senderFor: () => ({ kind: "dead", async send(row) { sent.push(row); return { ok: false, status: 410, reason: "Unregistered" }; } }),
    log: () => {},
  });
  await edge.storeFor(t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });
  await edge.sweepOnce("one");
  assert.equal(sent.length, 1, "it was tried once");
  assert.equal((await edge.storeFor(t).read()).devices.length, 0, "and the row is gone for good");

  visible = false;
  const after = await edge.sweepOnce("two");
  assert.equal(sent.length, 1, "nothing is sent to a pruned device");
  assert.equal(after.swept[0].skipped, "no device is registered", "and the box is not touched again");
});

test("an unreachable box times the sweep out rather than hanging it, and says so", async () => {
  const t = tenantContext();
  const edge = createPushEdge({
    readBody: async () => "", fail: () => true,
    tenants: () => [t], contextOf: () => t, subOf: () => "", now: () => TEN_AM,
    callTimeoutMs: 30,
    // A box that never answers. Without the bound, one of these would stop every other customer's
    // phone forever with no failure and no line in the log.
    gatewayCall: () => new Promise(() => {}),
    senderFor: () => ({ async send() { return { ok: true, status: 200 }; } }),
    log: () => {},
  });
  await edge.storeFor(t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });
  const started = Date.now();
  const answer = await edge.sweepOnce("an unreachable box");
  assert.ok(Date.now() - started < 2000, "it came back");
  assert.equal(answer.swept[0].skipped, "its box did not answer listAgents");
});

test("the stub sender records the target, the headers and the whole payload, and never a token", async () => {
  const t = tenantContext();
  const file = t.file(PUSH_STUB_LEDGER_FILE);
  const stub = createStubSender({ file });
  const [card] = cardsFromEntry(approvalEntry(), context);
  const built = buildApnsMessage(card, { badge: 2, bundleId: "bot.titanium.app", host: "console.titanium.bot", nowMs: context.nowMs });
  await stub.send({ platform: "ios", token: "a-secret-looking-device-token-value", headers: built.headers, payload: built.payload, target: "https://api.push.apple.com/3/device/…", card, badge: 2, silent: false });

  const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cardKey, card.key);
  assert.equal(rows[0].payload.aps.alert.title, "Send that email to the client");
  assert.equal(rows[0].badge, 2);
  assert.equal(rows[0].tokenHead, "a-secret");
  assert.ok(!readFileSync(file, "utf8").includes("a-secret-looking-device-token-value"),
    "a whole device token is never written down, even though it is an address rather than a credential");
});

test("clipReason keeps the host's own ceiling and collapses whitespace", () => {
  assert.equal(clipReason("  one   two\nthree  "), "one two three");
  const long = clipReason("y".repeat(500));
  assert.equal(long.length, MAX_PUSH_REASON_LENGTH);
  assert.ok(long.endsWith("…"), "the host's own ellipsis");
  assert.equal(clipReason(null), "");
});

test("the sweep reads listAgents in the shape the host actually answers: a bare array", async () => {
  // THIS TEST EXISTS BECAUSE THE OBVIOUS READ WAS WRONG AND IT COST A GATE RUN. Measured on
  // grok-bot-local-vm 2026-09-10: `POST /api/listAgents` answers `[{...}, ...]` with no wrapper, while
  // `listProblemReports` beside it answers `{reports: [...]}` and `getAgentTranscriptTail` answers
  // `{entries, nextBeforeSeq}`. Reading `roster.agents` gave an empty roster on a box with twelve
  // agents, so every pending card went unnoticed and the sweep reported a clean zero -- the worst
  // shape a failure can take, which is not red but absent. Both forms are read from now on, and both
  // are pinned here so a later host adding a wrapper cannot break it the other way.
  for (const [what, roster, reports] of [
    ["the array the host answers today", [{ id: "agent-1", name: "Books", newestEntryId: "t1", unreadCount: 0, updatedAt: 1 }], [{ id: "pr-1", at: "2026-09-10T10:00:00.000Z", agentId: "agent-1", agentName: "Books", report: { title: "Something broke" } }]],
    ["a wrapped form a later host might answer", { agents: [{ id: "agent-1", name: "Books", newestEntryId: "t1", unreadCount: 0, updatedAt: 1 }] }, { reports: [{ id: "pr-1", at: "2026-09-10T10:00:00.000Z", agentId: "agent-1", agentName: "Books", report: { title: "Something broke" } }] }],
  ]) {
    const t = tenantContext(`shape-${what.length}`);
    const sent = [];
    const edge = createPushEdge({
      readBody: async () => "", fail: () => true,
      tenants: () => [t], contextOf: () => t, subOf: () => "", now: () => TEN_AM,
      gatewayCall: async (_t, command) => ({
        status: 200,
        text: JSON.stringify(command === "listAgents" ? roster : command === "listProblemReports" ? reports : { entries: [] }),
        type: "application/json",
      }),
      senderFor: () => ({ async send(row) { sent.push(row); return { ok: true, status: 200 }; } }),
      log: () => {},
    });
    await edge.storeFor(t).register({ deviceId: "phone-1", platform: "ios", token: "apns-one", sub: "" });
    const answer = await edge.sweepOnce(what);
    assert.equal(answer.swept[0].calls, 3, `${what}: the roster was read, the reports were read, and the moved agent earned one tail read`);
    assert.equal(sent.length, 1, `${what}: the report card produced one push`);
    assert.equal(sent[0].card.kind, "report");
  }
});

test("the Android collapse key folds six kinds onto four buckets, because four is all FCM guarantees", () => {
  // THE FIRST CUT OF THIS DESIGN SAID "collapse_key is the card KIND", and that was wrong by two:
  // there are SIX kinds and FCM guarantees at most FOUR different collapse keys at any one time,
  // silently dropping the guarantee at the fifth. So the kinds fold onto exactly four buckets and the
  // per-card replacement stays notification.tag.
  const buckets = new Set(PUSH_CARD_KINDS.map((kind) => FCM_COLLAPSE_BUCKET[kind]));
  assert.equal(buckets.size, MAX_FCM_COLLAPSE_KEYS, `${buckets.size} buckets against Android's ceiling of ${MAX_FCM_COLLAPSE_KEYS}`);
  for (const kind of PUSH_CARD_KINDS) assert.ok(typeof FCM_COLLAPSE_BUCKET[kind] === "string" && FCM_COLLAPSE_BUCKET[kind].length > 0, `${kind} has a bucket`);

  // The fold a person would make: approve-or-deny together, asked-you-something together, the
  // keyboard on its own, a report on its own.
  assert.equal(FCM_COLLAPSE_BUCKET["auto-review"], FCM_COLLAPSE_BUCKET["local-tool"]);
  assert.equal(FCM_COLLAPSE_BUCKET.widget, FCM_COLLAPSE_BUCKET.secret);
  assert.notEqual(FCM_COLLAPSE_BUCKET["box-handoff"], FCM_COLLAPSE_BUCKET.report);

  // On the wire: the bucket on collapse_key, the card's own key on the tag. Two cards of different
  // kinds in the same bucket therefore share a collapse key and still replace each other correctly by
  // tag, which is the whole point of keeping both fields.
  const [approval] = cardsFromEntry(approvalEntry(), context);
  const [ask] = cardsFromEntry(askEntry(), context);
  const one = buildFcmMessage(approval, { badge: 1, token: "t", nowMs: context.nowMs });
  const two = buildFcmMessage(ask, { badge: 2, token: "t", nowMs: context.nowMs });
  assert.equal(one.message.android.collapse_key, "decision");
  assert.equal(two.message.android.collapse_key, "decision", "an approval and an ask share a bucket");
  assert.notEqual(one.message.android.notification.tag, two.message.android.notification.tag, "and are still told apart by tag");
  assert.equal(one.message.android.notification.tag, approval.key);

  // A kind this table has never heard of still gets a key rather than undefined: an undefined
  // collapse_key is a field FCM rejects, and a push refused over a new card kind would be a silence
  // nobody could explain.
  const made = buildFcmMessage({ ...approval, kind: "something-new" }, { badge: 1, token: "t", nowMs: context.nowMs });
  assert.equal(typeof made.message.android.collapse_key, "string");
  assert.ok(made.message.android.collapse_key.length > 0);
});

test("a dead desktop token is pruned the same way a dead iPhone token is", () => {
  // The desktop app is signed by the same Apple account and goes through the same APNs sender, so its
  // 410 has to mean the same thing. Before this was written `prunesDevice` matched only "ios" and a
  // dead Mac token fell through to the Firebase table, where a 410 means nothing: the row stayed and
  // the relay kept addressing a machine that had uninstalled the app.
  for (const platform of ["ios", "desktop"]) {
    assert.ok(prunesDevice({ platform, status: 410, reason: "Unregistered" }).length > 0, `${platform} 410 prunes`);
    assert.ok(prunesDevice({ platform, status: 400, reason: "ExpiredToken" }).length > 0, `${platform} ExpiredToken prunes`);
    assert.equal(prunesDevice({ platform, status: 400, reason: "BadDeviceToken" }), "", `${platform} BadDeviceToken is ours to fix, not the device's fault`);
    assert.equal(prunesDevice({ platform, status: 429, reason: "TooManyRequests" }), "", `${platform} 429 is waited out`);
  }
  // And Android keeps its own table: a 410 means nothing to Firebase, and reading it as a prune would
  // drop a live phone.
  assert.equal(prunesDevice({ platform: "android", status: 410, reason: "Unregistered" }), "");
});

test("a desktop device is sent an APNs payload, not an FCM one", async () => {
  const h = harness({ tail: () => [handoffEntry()], reports: () => [] });
  await h.edge.storeFor(h.t).register({ deviceId: "mac-1", platform: "desktop", token: "apns-desktop", sub: "" });
  await h.edge.sweepOnce("a desktop device");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].platform, "desktop");
  assert.equal(h.sent[0].headers["apns-push-type"], "alert", "the desktop app rides APNs");
  assert.ok(h.sent[0].payload.aps != null, "so the payload has an aps, not an android block");
});
