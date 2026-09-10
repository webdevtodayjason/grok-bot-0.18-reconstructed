// Push, the server half (PUSH-1, docs/APPS.md).
//
// A phone app is worth building for exactly one capability: a card that needs a person reaches the
// person. This module is that, and nothing else. It holds the device rows, the decider that turns a
// transcript read into one push per card, the collapse rules, quiet hours, the badge, and the two
// real senders plus the stub every gate measures.
//
// WHERE IT SITS. ui/server.mjs owns the route lines and the sweep start; this file owns the rules.
// Everything it needs is injected, the way ui/mail-edge.mjs's is and for the same reason: the parts
// with rules worth testing have to be reachable without a relay, and the gateway bearers live in
// server.mjs and must stay there. The two hooks server.mjs calls are at the bottom:
//
//   pushRoutes(deps)      -> async (req, res, url, t) => boolean   (true when it answered)
//   pushSweepStart(deps)  -> () => void                            (stops the loop)
//
// With this module absent, ui/relay-hooks.mjs hands back a route that answers nothing and a sweep
// that starts nothing, so the console and the relay behave exactly as they did before this wave.
// That is a gate assertion, not a comment: CONSOLE-4 already paid for the other kind.
//
// FIVE RULES THIS FILE KEEPS, each of them measured before it was written.
//
// 1. THE FIRST ACT OF A SWEEP IS A FILE READ, NEVER A GATEWAY CALL. A workspace with no registered
//    device is skipped before anything reaches its box, so the whole mechanism costs nothing for
//    every customer without a phone. The gate COUNTS the calls to prove it.
//
// 2. THE ROSTER IS THE CHANGE DETECTOR AND THE TAIL IS THE AUTHORITY. listAgents cannot be the
//    trigger: `awaitingUserResponse` is a single slot per agent with first-tab-wins precedence, it
//    carries no card id, it is never raised for a local-tool permission ask or a secret request
//    (turn-runtime.ts:721-725 says so), and the box tab overwrites any other with sink.set. So a
//    roster row that moved earns ONE getAgentTranscriptTail {id, limit: 5} (1,535 bytes measured on
//    grok-bot-local-vm, 9 agents), and that read decides what the card is.
//
// 3. ERROR TRAYS ARE NEVER READ. reloadTrays dismisses each tray as it narrates
//    (gateway-adapter.js:2598), so a server-side reader would race the console and consume the
//    signal. Report offers come from listProblemReports, which is durable, idempotent, stable-id,
//    0600, capped at 50, and cleared only when the person acts (14 bytes empty, measured).
//
// 4. ONE PUSH PER CARD, DEDUPED FROM A LEDGER ON DISK. An in-memory map would re-notify a customer
//    about yesterday's cards on the next redeploy, and a redeploy restarts this relay
//    (ui/auth.mjs:63-68 records exactly that).
//
// 5. A NOTIFICATION BODY IS A FIXED SENTENCE THIS FILE WROTE, NEVER FREE TEXT FROM A TURN. A title,
//    one of the six sentences in CARD_BODY below, the ids, a deep link, under 4096 bytes, nothing
//    else; and no credential in any log line this file writes. This rule was BROKEN until the review
//    pass: the auto-review body was the approval's reason plus `approval.command` verbatim, and
//    auto-review exists precisely because a command is risky, which is the same population of
//    commands that carry credentials. Measured on this Mac 2026-09-10 with a realistic approval, the
//    alert body came back as "Writes to a remote curl -X POST https://api.vendor.io/v1/deploy -H
//    'Authorization: Bearer sk_live_...' -d @build.json" -- a live token on its way to Apple and
//    Google and onto a locked screen. box-handoff carried the box instruction and report carried the
//    model's own description the same way. The card's ids are already in the payload, so the app
//    fetches the detail with its own bearer and draws it inside the app, behind the device unlock.
//
// WHAT THIS FILE DELIBERATELY DOES NOT REUSE. source/shared/os-notification.ts is this exact
// transition diff already solved host-side, dedupe included, and it was read before the decider
// below was written. It is not built on, for two reasons: it works off the ROSTER ONLY, which rule 2
// says cannot carry a card; and its copy says "Open Grok Bot to see what it did", which is the wrong
// product name. That second half is filed as HOST-PUSH-1 rather than fixed here, because the host
// bundle is not this wave's to change.
import { createHash, createPrivateKey, createSign, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ---- the files, beside mail.json in the tenant's own state directory -----------------------------
//
// Through t.file(), the same helper that already splits endpoints.json, subscriptions.json,
// mail.json and the two mail ledgers per tenant (ui/server.mjs:595-624). No control-plane row for a
// device: the control plane holds the two push credentials and nothing else, which is why there is
// no cp/devices.mjs in this wave.
export const PUSH_FILE = "push.json";
export const PUSH_SENT_FILE = "push-sent.json";
export const PUSH_STUB_LEDGER_FILE = "push-sent.jsonl";

/** The host's own body ceiling, so a reason reads the same on a lock screen as in the desktop toast. */
export const MAX_PUSH_REASON_LENGTH = 140;
/** APNs refuses a payload over this, and FCM's own limit is the same order. Asserted before a send. */
export const MAX_PUSH_PAYLOAD_BYTES = 4096;
/** apns-collapse-id is capped at 64 bytes. A 32-character hash is inside it with room to spare. */
export const MAX_COLLAPSE_ID_BYTES = 64;
/**
 * FCM allows at most FOUR different collapse keys per app at any one time and silently drops the
 * guarantee at the fifth, so the Android collapse_key is never per card. The per-card replacement on
 * Android is notification.tag, which is what actually replaces a notification already in the drawer.
 * iOS has no such ceiling, so apns-collapse-id IS per card. Two platforms, two rules.
 */
export const MAX_FCM_COLLAPSE_KEYS = 4;

/**
 * And the collapse key cannot be the KIND either, which is what this design first said: there are SIX
 * kinds and Android allows FOUR keys, so a key per kind would have quietly lost the guarantee on the
 * fifth and sixth. So the six kinds fold onto exactly four buckets, and the fold is the one a person
 * would make rather than an arbitrary pairing:
 *
 *   decision   an approval and a local-tool ask. Both are approve-or-deny and both die in ten minutes.
 *   question   a widget question and a secret request. Both are "the agent asked you something".
 *   keyboard   a box hand-off. Nothing else asks a person to take the computer.
 *   report     an agent-written problem report. Nothing else is the person sending something onward.
 *
 * Four buckets, four keys, the ceiling met with nothing to spare and nothing wasted. The per-card
 * replacement is still notification.tag, so two decisions on the same agent still replace each other
 * correctly; the bucket only decides which of them Android is willing to guarantee.
 */
export const FCM_COLLAPSE_BUCKET = Object.freeze({
  "auto-review": "decision",
  "local-tool": "decision",
  widget: "question",
  secret: "question",
  "box-handoff": "keyboard",
  report: "report",
});

/** How long the two self-expiring kinds live. SAND_AUTO_REVIEW_APPROVAL_TTL_MS and
 *  SAND_LOCAL_TOOL_ASK_TTL_MS are both ten minutes; they are mirrored rather than imported because
 *  source/ is not on this process's module path. */
export const EXPIRING_CARD_TTL_MS = 10 * 60 * 1_000;

/** The six card kinds, and they are the whole list. The seventh thing that looks like a card is the
 *  failed-turn report offer, which is page-local (offer-<seq>, minted at app.js:995 and dead with
 *  the page), so it has no durable id to collapse on and is never pushed. */
export const PUSH_CARD_KINDS = Object.freeze([
  "auto-review", "local-tool", "widget", "secret", "box-handoff", "report",
]);
const KIND_SET = new Set(PUSH_CARD_KINDS);

/** The two kinds that die on their own, so only these two carry an expiry on the wire. */
const EXPIRING_KINDS = new Set(["auto-review", "local-tool"]);

const DEFAULT_SETTINGS = Object.freeze({
  kinds: Object.freeze(Object.fromEntries(PUSH_CARD_KINDS.map((kind) => [kind, true]))),
  quietHours: Object.freeze({ on: false, from: 22, to: 7 }),
  utcOffsetMinutes: 0,
});

const str = (value) => (typeof value === "string" ? value : "");
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const clampHour = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? ((n % 24) + 24) % 24 : 0;
};

/**
 * THE NOTIFICATION BODY, ONE FIXED SENTENCE PER KIND. Rule 5. Nothing a model wrote reaches a lock
 * screen through this file: not the approval's reason, not its command, not the box instruction, not
 * a report's description. Each sentence says what kind of answer is wanted and where to give it, and
 * the detail lives behind the deep link, which the app opens with its own bearer after the device is
 * unlocked. Titles stay as they are: the host already shows the person's own summary line there, and
 * a title with no subject would be unreadable on a phone.
 */
export const CARD_BODY = Object.freeze({
  "auto-review": "Open it to read the command before you allow it.",
  "local-tool": "This runs on the box itself, not in a sandbox.",
  widget: "Open it to answer.",
  secret: "It needs a credential before it can carry on.",
  "box-handoff": "Open it to read what it needs done.",
  report: "Open it to read the report before it goes.",
});

/** One line of prose, collapsed and clipped to the host's own ceiling. The ellipsis is the host's. */
export function clipReason(text) {
  const collapsed = str(text).replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_PUSH_REASON_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_PUSH_REASON_LENGTH - 1).trimEnd()}…`;
}

// ---- the card key, which is also the iOS collapse id --------------------------------------------
//
// tenant + agent + entry, hashed. The entry id is the one stable thing every kind has: a requestId
// exists for three of the six and a report carries neither. Hashed rather than concatenated for two
// reasons: the 64-byte apns-collapse-id ceiling, and a collapse id is echoed in APNs diagnostics, so
// a raw workspace slug in it would be a tenant name on somebody else's wire.
export function cardKey({ tenant, agentId, entryId }) {
  return createHash("sha256")
    .update(`${str(tenant)}\0${str(agentId)}\0${str(entryId)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

// ---- the decider: a transcript tail in, cards out -----------------------------------------------
//
// Pending versus answered is readable from ANY transcript read, because the host rewrites the stamp
// in place rather than appending: respondedValue, widgetDismissed, secretProvided and boxResolution
// land on the entry; approval.status and ask.status land on the message. That is what makes this a
// projection of a read rather than a state machine of its own.
const pendingApproval = (status) => {
  const s = str(status).trim().toLowerCase();
  return s === "" || s === "pending";
};

/**
 * Every card this entry carries, pending or not. One entry can carry two (a hand-off stamp rides an
 * ordinary send-message), so this answers a list.
 */
export function cardsFromEntry(entry, { tenant, agentId, agentName, nowMs }) {
  if (entry == null || typeof entry !== "object") return [];
  const entryId = str(entry.id);
  if (entryId.length === 0) return [];
  const at = num(entry.timestampMs);
  const out = [];
  const base = (kind, extra) => {
    const card = {
      kind,
      tenant: str(tenant),
      agentId: str(agentId),
      agentName: str(agentName),
      entryId,
      requestId: "",
      at,
      pending: true,
      title: "",
      reason: "",
      // Only the two self-expiring kinds get a deadline; everything else waits for a person.
      deadlineMs: EXPIRING_KINDS.has(kind) && at > 0 ? at + EXPIRING_CARD_TTL_MS : 0,
      ...extra,
    };
    card.key = cardKey({ tenant: card.tenant, agentId: card.agentId, entryId: card.entryId });
    card.reason = clipReason(card.reason);
    // An expiring card whose deadline has passed is NOT pending, whatever the stamp says: the host
    // stops accepting an answer at the deadline, so a phone offering one would be lying.
    if (card.pending && card.deadlineMs > 0 && num(nowMs) >= card.deadlineMs) {
      card.pending = false;
      card.expired = true;
    }
    return card;
  };

  const message = entry.message ?? {};

  if (message.type === "auto-review-approval" && message.approval) {
    const approval = message.approval;
    out.push(base("auto-review", {
      requestId: str(approval.requestId),
      pending: pendingApproval(approval.status),
      title: str(approval.summary).trim() || "This action needs your review",
      // Never approval.reason and never approval.command: see rule 5. The command is the reason this
      // card exists and is the likeliest field in the whole transcript to be carrying a credential.
      reason: CARD_BODY["auto-review"],
    }));
  }

  if (message.type === "local-tool-permission" && message.ask) {
    const ask = message.ask;
    out.push(base("local-tool", {
      requestId: str(ask.requestId),
      pending: pendingApproval(ask.status),
      // The console's own title for this card, character for character (gateway-adapter.js:138), so
      // what a person reads on a lock screen is what they then read on the card they open.
      title: `${str(ask.action) || "Run"} · ${str(ask.target) || "a local tool"}`,
      // Never ask.description: a model writes it and it can name a value it is about to use.
      reason: CARD_BODY["local-tool"],
    }));
  }

  if (message.type === "widget" && message.widget) {
    out.push(base("widget", {
      pending: entry.widgetDismissed !== true && entry.respondedValue == null,
      title: str(message.widget.prompt).trim() || "The agent asked you a question",
      reason: CARD_BODY.widget,
    }));
  }

  if (message.type === "secret-request") {
    const request = message.secretRequest ?? message.secret ?? {};
    const label = str(request.label).trim();
    out.push(base("secret", {
      pending: entry.secretProvided !== true,
      title: label.length > 0 ? `The agent asked for ${label}` : "The agent asked for a credential",
      // Never request.description: a model wrote it, and it can name the value it is asking about.
      reason: CARD_BODY.secret,
    }));
  }

  // HANDBACK-1. The durable half of a hand-off is one transcript entry stamped boxRequestId plus
  // boxInstruction, with boxResolution written when it ends. It rides an ordinary send-message, so
  // this is checked on every entry rather than inside the type switch above.
  const boxRequestId = str(entry.boxRequestId);
  if (boxRequestId.length > 0) {
    out.push(base("box-handoff", {
      requestId: boxRequestId,
      pending: str(entry.boxResolution).trim().length === 0,
      title: `Take the keyboard for ${str(agentName).trim() || "your agent"}`,
      // Never entry.boxInstruction: the agent wrote it, and an instruction about a bank or a vendor
      // portal is exactly the sentence that names an account.
      reason: CARD_BODY["box-handoff"],
    }));
  }

  return out;
}

/** Every card in a tail read, newest last. */
export function cardsFromTail(entries, context) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  for (const entry of list) out.push(...cardsFromEntry(entry, context));
  return out;
}

/**
 * The report offers. The row id is the card id: listProblemReports is the durable, stable-id source
 * and the row survives a restart, which is exactly what the page-local offer-<seq> does not.
 */
export function cardsFromReports(reports, { tenant, nowMs } = {}) {
  const list = Array.isArray(reports) ? reports : [];
  const out = [];
  for (const row of list) {
    const id = str(row?.id);
    if (id.length === 0) continue;
    const agentId = str(row?.agentId);
    const card = {
      kind: "report",
      tenant: str(tenant),
      agentId,
      agentName: str(row?.agentName),
      // A report's own row id stands in for an entry id: it is what the collapse key has to be
      // stable on, and the report is not a transcript entry at all.
      entryId: id,
      requestId: "",
      at: Date.parse(str(row?.at)) || num(nowMs),
      pending: true,
      title: str(row?.report?.title).trim() || "Your agent wants to report a problem",
      // Never the report's description: the model wrote it, and a report about a failing tool quotes
      // the command that failed.
      reason: CARD_BODY.report,
      deadlineMs: 0,
    };
    card.key = cardKey({ tenant: card.tenant, agentId: card.agentId, entryId: card.entryId });
    out.push(card);
  }
  return out;
}

// ---- quiet hours --------------------------------------------------------------------------------
//
// One UTC offset per account rather than a zone name: a zone database is a dependency and a phone
// already knows its own offset, so the app uploads it with the registration. The cost is that a
// daylight-saving change is an hour out until the app next opens, which is said in docs/APPS.md
// rather than left for somebody to discover.
//
// Quiet hours hold the ALERT and never the silent badge update: a badge that drops while somebody
// sleeps is the whole point of the silent send, and it makes no sound on any platform.
export function quietHoursHold(settings, nowMs) {
  const quiet = settings?.quietHours ?? {};
  if (quiet.on !== true) return false;
  const from = clampHour(quiet.from);
  const to = clampHour(quiet.to);
  if (from === to) return false;
  const local = new Date(num(nowMs) + num(settings?.utcOffsetMinutes) * 60_000);
  const hour = local.getUTCHours();
  return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

/** When the current quiet window ends, in ms. Used only to say it in words. */
export function quietHoursEndMs(settings, nowMs) {
  if (!quietHoursHold(settings, nowMs)) return 0;
  const to = clampHour(settings?.quietHours?.to);
  const offset = num(settings?.utcOffsetMinutes) * 60_000;
  const local = new Date(num(nowMs) + offset);
  const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), to, 0, 0, 0);
  return (end > local.getTime() ? end : end + 86_400_000) - offset;
}

// ---- the deep link, whose shape this item owns --------------------------------------------------
//
// The app scheme first, the https fallback second, because a card may be tapped on a phone that has
// since had the app removed and a dead custom scheme is a dead end. Both carry the entry, so the
// console's boot parse lands on the card and not merely on the conversation.
export function deepLinks(card, { host = "" } = {}) {
  const q = new URLSearchParams({
    tenant: str(card.tenant), agent: str(card.agentId), entry: str(card.entryId), kind: str(card.kind),
  });
  const web = new URLSearchParams({ agent: str(card.agentId), entry: str(card.entryId) });
  return {
    app: `titaniumbot://card?${q.toString()}`,
    web: host.length > 0 ? `https://${host}/?${web.toString()}` : `/?${web.toString()}`,
  };
}

// ---- the two payload builders -------------------------------------------------------------------

const byteLength = (value) => Buffer.byteLength(value, "utf8");

/**
 * APNs. The custom keys are PEERS of aps and never inside it: anything APNs does not recognise
 * inside aps is undefined behaviour, and the app reads the ids off the top level.
 */
export function buildApnsMessage(card, { badge = 0, bundleId = "", host = "", silent = false, nowMs = 0 } = {}) {
  const link = deepLinks(card, { host });
  const headers = {
    "apns-topic": str(bundleId),
    "apns-push-type": silent ? "background" : "alert",
    "apns-priority": silent ? "5" : "10",
    // Per card on iOS, which merges rather than stacks. 32 hex characters, inside the 64-byte cap.
    "apns-collapse-id": str(card.key),
  };
  // Only the two self-expiring kinds carry a deadline, and it is the card's OWN deadline rather than
  // a guess: a notification that outlives the approval it is about is a tap that lands on nothing.
  if (!silent && num(card.deadlineMs) > 0) headers["apns-expiration"] = String(Math.floor(num(card.deadlineMs) / 1000));
  const payload = silent
    ? { aps: { "content-available": 1, badge: Math.max(0, Math.trunc(num(badge))) }, cardKey: str(card.key), kind: str(card.kind), closed: true }
    : {
      aps: {
        alert: { title: str(card.title), subtitle: str(card.agentName), body: str(card.reason) },
        badge: Math.max(0, Math.trunc(num(badge))),
        sound: "default",
        "thread-id": str(card.agentId),
      },
      cardKey: str(card.key),
      kind: str(card.kind),
      tenant: str(card.tenant),
      agent: str(card.agentId),
      entry: str(card.entryId),
      ...(str(card.requestId).length > 0 ? { request: str(card.requestId) } : {}),
      link: link.app,
      web: link.web,
    };
  const body = JSON.stringify(payload);
  return { headers, payload, body, bytes: byteLength(body), nowMs: num(nowMs) };
}

/**
 * FCM v1. notification.tag replaces a notification already in the drawer and is per card;
 * collapse_key is per KIND, because of the four-keys ceiling above.
 */
export function buildFcmMessage(card, { badge = 0, token = "", host = "", silent = false, nowMs = 0 } = {}) {
  const link = deepLinks(card, { host });
  const data = {
    cardKey: str(card.key),
    kind: str(card.kind),
    tenant: str(card.tenant),
    agent: str(card.agentId),
    entry: str(card.entryId),
    badge: String(Math.max(0, Math.trunc(num(badge)))),
    link: link.app,
    web: link.web,
    ...(str(card.requestId).length > 0 ? { request: str(card.requestId) } : {}),
    ...(silent ? { closed: "1" } : {}),
  };
  const android = {
    priority: silent ? "normal" : "high",
    // The BUCKET, not the kind: six kinds against Android's four-key ceiling. See FCM_COLLAPSE_BUCKET.
    collapse_key: FCM_COLLAPSE_BUCKET[str(card.kind)] ?? "decision",
    ...(silent ? {} : {
      notification: {
        title: str(card.title),
        body: str(card.reason),
        tag: str(card.key),
        click_action: "TITANIUMBOT_CARD",
      },
    }),
  };
  if (!silent && num(card.deadlineMs) > 0) {
    const left = Math.max(0, Math.round((num(card.deadlineMs) - num(nowMs)) / 1000));
    android.ttl = `${left}s`;
  }
  // A silent message must be data-only, or Android draws a notification for it.
  const message = { token: str(token), data, android };
  const body = JSON.stringify({ message });
  return { message, body, bytes: byteLength(body), nowMs: num(nowMs) };
}

// ---- the device and settings store --------------------------------------------------------------

const normalisePlatform = (value) => {
  const p = str(value).trim().toLowerCase();
  return p === "ios" || p === "android" || p === "desktop" ? p : "";
};

const normaliseEnv = (value) => (str(value).trim().toLowerCase() === "sandbox" ? "sandbox" : "production");

function normaliseSettings(raw) {
  const kinds = {};
  for (const kind of PUSH_CARD_KINDS) kinds[kind] = raw?.kinds?.[kind] !== false;
  const quiet = raw?.quietHours ?? {};
  return {
    kinds,
    quietHours: { on: quiet.on === true, from: clampHour(quiet.from ?? DEFAULT_SETTINGS.quietHours.from), to: clampHour(quiet.to ?? DEFAULT_SETTINGS.quietHours.to) },
    utcOffsetMinutes: Math.max(-840, Math.min(840, Math.trunc(num(raw?.utcOffsetMinutes)))),
  };
}

function normaliseDevice(raw) {
  const deviceId = str(raw?.deviceId).trim().slice(0, 128);
  const platform = normalisePlatform(raw?.platform);
  const token = str(raw?.token).trim().slice(0, 4096);
  if (deviceId.length === 0 || platform.length === 0 || token.length === 0) return null;
  return {
    deviceId,
    platform,
    // FCM's registration field `token` is deprecated in favour of `fid`, and `fid` accepts a
    // registration token through the transition. So whatever the client hands back is stored
    // VERBATIM with a timestamp and the timestamp is refreshed on every upload: this relay does not
    // get to have an opinion about which of the two forms a vendor's SDK is on this month.
    token,
    tokenAt: num(raw?.tokenAt) || Date.now(),
    sub: str(raw?.sub),
    name: str(raw?.name).replace(/[\r\n\t]+/g, " ").trim().slice(0, 120),
    env: normaliseEnv(raw?.env),
    createdAt: num(raw?.createdAt) || Date.now(),
    updatedAt: num(raw?.updatedAt) || Date.now(),
  };
}

/**
 * Whose row this is, and the ONE predicate the list and the delete both use, so a person can remove
 * exactly what they can see and nothing else. undefined means the caller is not a person at all (a
 * vendor prune, a test); "" is the instance-password door, which is the workspace and sees every row.
 */
export function ownedBy(device, sub) {
  if (sub === undefined || sub === null) return true;
  const want = str(sub);
  if (want.length === 0) return true;
  return str(device?.sub) === want;
}

/**
 * The tenant's own push.json, read through an mtime-free cache of one object per file: this store is
 * written far less often than it is read, and every read is already inside a request or a sweep pass
 * that is doing other IO anyway, so it is read fresh and kept simple.
 */
export function createPushStore({ file, now = () => Date.now() }) {
  const empty = () => ({ version: 1, devices: [], settings: {} });

  async function read() {
    let parsed = null;
    try { parsed = JSON.parse(await readFile(file, "utf8")); } catch { parsed = null; }
    const devices = Array.isArray(parsed?.devices)
      ? parsed.devices.map((row) => normaliseDevice(row)).filter((row) => row != null)
      : [];
    const settings = {};
    for (const [key, value] of Object.entries(parsed?.settings ?? {})) settings[key] = normaliseSettings(value);
    return { version: 1, devices, settings };
  }

  async function write(state) {
    await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await writeFile(file, `${JSON.stringify({ version: 1, devices: state.devices, settings: state.settings }, null, 2)}\n`, { mode: 0o600 });
    return state;
  }

  return {
    file,
    read,
    /**
     * Idempotent per (SUB, deviceId): a second registration of the same device by the same person
     * UPDATES it, and a registration of the same deviceId by ANOTHER person is another row.
     *
     * The sub is half the key, and it was not until the review pass. A deviceId is chosen by the app
     * and is visible to anybody signed into the workspace through GET /push/devices, and two accounts
     * share a workspace -- which is the whole reason subOf exists. Measured on this Mac 2026-09-10
     * against the old shape: Richard POSTing deviceId "iphone-of-jason" rewrote Jason's row to his own
     * sub and his own token, so Jason's phone stopped being notified and vanished from his own list,
     * and his DELETE of that id answered {"removed":true} on a row that was never his.
     *
     * Two rows for one physical phone signed into two accounts is the CORRECT outcome, not a
     * duplicate: each row carries that account's cards and each account revokes only its own.
     */
    async register(row) {
      const device = normaliseDevice({ ...row, tokenAt: num(now()) || Date.now() });
      if (device == null) return { ok: false, error: "bad_request" };
      const state = await read();
      const found = state.devices.findIndex((d) => d.deviceId === device.deviceId && d.sub === device.sub);
      if (found >= 0) {
        const before = state.devices[found];
        state.devices[found] = { ...device, createdAt: before.createdAt, updatedAt: num(now()) || Date.now() };
      } else {
        state.devices.push({ ...device, createdAt: num(now()) || Date.now(), updatedAt: num(now()) || Date.now() });
      }
      await write(state);
      return { ok: true, device: state.devices[found >= 0 ? found : state.devices.length - 1], replaced: found >= 0 };
    },
    /**
     * Removes one device, and answers whether there was one. Revoking its bearer calls this too.
     *
     * `sub` is the person doing it and is part of the match: a named account removes only its own
     * rows. Leaving it out means "whoever owns it", which is the two callers that are not a person --
     * a vendor pruning a dead token, and a test. The INSTANCE-PASSWORD door is sub "" and reaches
     * every row on purpose: that door is the workspace itself, it already lists every row, and the
     * operator holding the instance password is the one person who has to be able to clear a device
     * whose account is gone. docs/APPS.md section 6 says so in those words.
     */
    async forget(deviceId, { sub } = {}) {
      const want = str(deviceId).trim();
      if (want.length === 0) return { ok: false, error: "bad_request" };
      const state = await read();
      const before = state.devices.length;
      state.devices = state.devices.filter((d) => !(d.deviceId === want && ownedBy(d, sub)));
      if (state.devices.length === before) return { ok: true, removed: false };
      await write(state);
      return { ok: true, removed: true };
    },
    /** Prunes a token the vendor told us is dead. Permanent: a 410 is not a retry. */
    async prune(deviceId, why, { sub } = {}) {
      const out = await this.forget(deviceId, { sub });
      return { ...out, why: str(why) };
    },
    /** Per person, keyed on the session's sub. "" means the workspace, which is the instance door. */
    async settingsFor(sub) {
      const state = await read();
      return normaliseSettings(state.settings[str(sub)] ?? {});
    },
    async saveSettings(sub, raw) {
      const state = await read();
      state.settings[str(sub)] = normaliseSettings(raw);
      await write(state);
      return state.settings[str(sub)];
    },
    empty,
  };
}

// ---- the sent ledger, on disk -------------------------------------------------------------------
//
// Keyed on the card key. State is what this relay already did about that card, and the state IS the
// retry policy -- which is why there are five of them and not three. Until the review pass every
// outcome that was not a real send wrote "held", so three different causes shared one state and only
// one of them should ever be retried: measured on this Mac 2026-09-10, a card whose kind the customer
// had switched off stayed "held" with heldUntil 0 over five passes, which at a 15 s sweep is 5,760
// re-decisions and 5,760 getAgentTranscriptTail reads a day for a card nobody will ever be alerted
// to, until somebody answers it.
//
//   alerted   an alert went out. Nothing goes out again (rule 4).
//   held      QUIET HOURS held it, heldUntil says when the window ends, and exactly one catch-up is
//             owed on that key on the first pass after it. Never retried before then.
//   muted     no device wanted it: every device's per-kind switch said no, or there is no device.
//             TERMINAL, never retried, and out of the open set so it stops earning a tail read.
//   failed    a vendor refused it. attempts and retryAt carry an exponential backoff; at
//             PUSH_MAX_ATTEMPTS it gives up, says so in the log, and leaves the open set. Retrying a
//             transient APNs 500 every 15 s for ever is how a sender gets itself rate limited.
//   closed    the card is answered or expired and the silent badge update went out
// Capped at 200 keys or seven days, whichever bites first, so a long-lived workspace does not grow
// this file without bound and a card nobody answered in two hundred others is not the one that
// matters.
export const SENT_LEDGER_CAP = 200;
export const SENT_LEDGER_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** A vendor refusal's backoff: a minute, doubling, capped at half an hour, six attempts and then out. */
export const PUSH_RETRY_BASE_MS = 60_000;
export const PUSH_RETRY_MAX_MS = 30 * 60_000;
export const PUSH_MAX_ATTEMPTS = 6;
export const retryDelayMs = (attempts) =>
  Math.min(PUSH_RETRY_MAX_MS, PUSH_RETRY_BASE_MS * 2 ** Math.max(0, Math.trunc(num(attempts)) - 1));

export function createSentLedger({ file, now = () => Date.now() }) {
  async function read() {
    let parsed = null;
    try { parsed = JSON.parse(await readFile(file, "utf8")); } catch { parsed = null; }
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const at = num(now());
    const kept = rows
      .filter((row) => str(row?.key).length > 0 && at - num(row.at) < SENT_LEDGER_AGE_MS)
      .slice(-SENT_LEDGER_CAP)
      .map((row) => ({
        key: str(row.key),
        kind: str(row.kind),
        state: str(row.state) || "alerted",
        at: num(row.at),
        deadlineMs: num(row.deadlineMs),
        agentId: str(row.agentId),
        entryId: str(row.entryId),
        // The retry policy's own fields. A row written before this ship has none of them, and zero is
        // the right answer for all three: no quiet window to wait out, no attempt spent, retry now.
        heldUntil: num(row.heldUntil),
        attempts: num(row.attempts),
        retryAt: num(row.retryAt),
        gaveUp: row.gaveUp === true,
      }));
    return new Map(kept.map((row) => [row.key, row]));
  }

  async function write(map) {
    const rows = [...map.values()].sort((a, b) => a.at - b.at).slice(-SENT_LEDGER_CAP);
    await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await writeFile(file, `${JSON.stringify({ version: 1, rows }, null, 2)}\n`, { mode: 0o600 });
  }

  return { file, read, write };
}

// ---- the senders --------------------------------------------------------------------------------

/**
 * The stub, and it is what every gate in this wave measures, because this wave holds no Apple or
 * Firebase credential. It records EXACTLY what would have been sent -- the target, the headers and
 * the full payload -- as one JSON line, so an assertion about a push is an assertion about the bytes
 * rather than about a log sentence.
 */
export function createStubSender({ file, log = () => {} }) {
  return {
    kind: "stub",
    async send({ platform, token, headers, payload, target, card, badge, silent }) {
      const row = {
        at: new Date().toISOString(),
        platform,
        // The device token is a routing address, not a credential, and the gate has to be able to
        // tell two devices apart. Eight characters is enough for that and is not the token.
        tokenHead: str(token).slice(0, 8),
        target: str(target),
        headers: headers ?? {},
        payload: payload ?? {},
        cardKey: str(card?.key),
        kind: str(card?.kind),
        badge: num(badge),
        silent: silent === true,
      };
      await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
      await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      log(`push  would have sent ${row.silent ? "a badge update" : "an alert"} to a ${platform} device (${row.kind}, badge ${row.badge})`);
      return { ok: true, status: 200, stub: true };
    },
  };
}

/**
 * The APNs provider token. ES256 over {alg, kid} and {iss, iat}, refreshed on a thirty-minute clock:
 * Apple refuses an iat over an hour old with 403 ExpiredProviderToken and refuses a token minted
 * more often than once every twenty minutes with TooManyProviderTokenUpdates, so thirty is the only
 * number that is safe at both ends.
 */
export const APNS_TOKEN_REFRESH_MS = 30 * 60 * 1_000;

export function createApnsToken({ key, keyId, teamId, now = () => Date.now() }) {
  let cached = null;
  return () => {
    const at = num(now());
    if (cached != null && at - cached.iat < APNS_TOKEN_REFRESH_MS) return cached.token;
    const iat = Math.floor(at / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: str(keyId), typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: str(teamId), iat })).toString("base64url");
    const signer = createSign("SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign({ key: createPrivateKey(str(key)), dsaEncoding: "ieee-p1363" }).toString("base64url");
    cached = { iat: at, token: `${header}.${claims}.${signature}` };
    return cached.token;
  };
}

const APNS_HOST = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };

/**
 * One http2 session per host, reused. A new connection per push is what makes Apple throttle, and
 * node:http2 is in the standard library, so there is no dependency here at all.
 */
export function createApnsSender({ key, keyId, teamId, bundleId, http2, log = () => {}, now = () => Date.now() }) {
  const token = createApnsToken({ key, keyId, teamId, now });
  const sessions = new Map();

  const sessionFor = async (env) => {
    const host = APNS_HOST[env] ?? APNS_HOST.production;
    const held = sessions.get(host);
    if (held != null && !held.closed && !held.destroyed) return held;
    const session = http2.connect(`https://${host}`);
    session.on("error", (error) => { log(`push  the Apple connection faulted: ${str(error?.message)}`); });
    // A GOAWAY reason is logged and the body never is: Apple's reason strings are fine to print and
    // a payload is a person's conversation.
    session.on("goaway", (code, _id, reason) => {
      log(`push  Apple closed the connection (code ${code}${reason?.length ? `, ${Buffer.from(reason).toString("utf8").slice(0, 80)}` : ""})`);
      sessions.delete(host);
    });
    session.on("close", () => { sessions.delete(host); });
    sessions.set(host, session);
    return session;
  };

  return {
    kind: "apns",
    async send({ token: deviceToken, headers, body, env }) {
      const session = await sessionFor(normaliseEnv(env));
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        const request = session.request({
          ":method": "POST",
          ":path": `/3/device/${str(deviceToken)}`,
          "content-type": "application/json",
          authorization: `bearer ${token()}`,
          "apns-id": randomUUID(),
          ...Object.fromEntries(Object.entries(headers ?? {}).filter(([, v]) => str(v).length > 0)),
        });
        let status = 0;
        let text = "";
        request.setTimeout(10_000, () => { request.close(); finish({ ok: false, status: 0, reason: "timed out" }); });
        request.on("response", (response) => { status = Number(response[":status"]) || 0; });
        request.on("data", (chunk) => { if (text.length < 512) text += String(chunk); });
        request.on("error", (error) => finish({ ok: false, status: 0, reason: str(error?.message) }));
        request.on("end", () => {
          let reason = "";
          try { reason = str(JSON.parse(text)?.reason); } catch { reason = ""; }
          finish({ ok: status === 200, status, reason });
        });
        request.end(str(body));
      });
    },
    close() { for (const session of sessions.values()) { try { session.close(); } catch { /* already gone */ } } sessions.clear(); },
  };
}

/**
 * FCM v1. The OAuth token is minted from the service account's client_email and private_key for the
 * one scope firebase.messaging and cached until it expires; the service account JSON never leaves
 * this process and is never written to disk by this file.
 */
export function createFcmSender({ serviceAccount, projectId, fetchImpl = fetch, now = () => Date.now(), log = () => {} }) {
  let access = null;

  async function accessToken() {
    const at = num(now());
    if (access != null && at < access.until - 60_000) return access.token;
    const iat = Math.floor(at / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      iss: str(serviceAccount?.client_email),
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: str(serviceAccount?.token_uri) || "https://oauth2.googleapis.com/token",
      iat, exp: iat + 3600,
    })).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${signer.sign(createPrivateKey(str(serviceAccount?.private_key))).toString("base64url")}`;
    const response = await fetchImpl(str(serviceAccount?.token_uri) || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || typeof body?.access_token !== "string") {
      // The refusal's own words, never the assertion and never the key.
      throw new Error(`Google would not mint a messaging token (HTTP ${response.status} ${str(body?.error)})`);
    }
    access = { token: body.access_token, until: at + (num(body.expires_in) || 3600) * 1000 };
    return access.token;
  }

  return {
    kind: "fcm",
    async send({ body, validateOnly = false }) {
      let bearer;
      try { bearer = await accessToken(); }
      catch (error) { log(`push  ${str(error?.message)}`); return { ok: false, status: 0, reason: "no_access_token" }; }
      const payload = validateOnly ? JSON.stringify({ ...JSON.parse(str(body)), validate_only: true }) : str(body);
      const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(str(projectId))}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      }).catch((error) => ({ status: 0, json: async () => ({ error: { message: str(error?.message) } }) }));
      const answer = await response.json?.().catch(() => null) ?? null;
      const status = Number(response.status) || 0;
      const reason = str(answer?.error?.details?.[0]?.errorCode) || str(answer?.error?.status);
      return { ok: status === 200, status, reason };
    },
  };
}

/**
 * What a vendor answer means for the row on disk. A dead token is pruned PERMANENTLY: a 410 is
 * Apple saying this app is gone from that device, and retrying it forever is how a sender ends up
 * rate limited over a customer who changed phones.
 */
export function prunesDevice({ platform, status, reason }) {
  const why = str(reason).trim().toUpperCase();
  // ios AND desktop, because the desktop app is signed by the same Apple account and goes through the
  // same APNs sender (see `sender` below, which picks APNs for both). Written as `!== "android"` rather
  // than as a list, so a fourth platform added later cannot quietly fall through to the Firebase table
  // and leave a dead token being retried forever.
  if (platform !== "android") {
    if (status === 410) return "Apple says the app is gone from that device";
    if (why === "UNREGISTERED" || why === "EXPIREDTOKEN") return `Apple answered ${why}`;
    return "";
  }
  if (status === 404 && (why === "UNREGISTERED" || why === "")) return "Firebase says that registration is gone";
  // A 400 on a payload we built and already checked against the size ceiling means the TOKEN is
  // malformed, not the message. Firebase says INVALID_ARGUMENT for both, which is why the check
  // above the send has to be ours.
  if (status === 400 && why === "INVALID_ARGUMENT") return "Firebase refused that registration";
  return "";
}

// ---- the edge -----------------------------------------------------------------------------------

const TENANT_KEY = (t) => str(t?.slug);

/**
 * One push edge for the whole relay, holding one sweep loop and one credential copy.
 *
 * Injected, all of it:
 *   readBody, fail            the relay's own helpers, so a refusal here reads like every other one
 *   tenants()                 every tenant context this relay serves, for the sweep
 *   contextOf(slug)           one of them, for a route
 *   subOf(req)                the person behind the session, "" for the instance-password door
 *   gatewayCall(t, cmd, args) the relay's own upstream call, which holds the bearer
 *   credentials()             {apns, fcm} or {}, kept in memory and never written to disk
 *   hostOf(req)              the https host for the fallback deep link
 *   senderFor(platform)       overridden by the gate; absent, the stub or the real sender is chosen
 *   now()                     injected so the clock is a test input and not a race
 */
export function createPushEdge({
  readBody,
  fail,
  tenants = () => [],
  contextOf = () => null,
  subOf = () => "",
  gatewayCall = async () => ({ status: 0, text: "", type: "" }),
  credentials = () => ({}),
  hostOf = () => "",
  senderFor = null,
  http2 = null,
  fetchImpl = fetch,
  now = () => Date.now(),
  sweepMs = 15_000,
  callTimeoutMs = 4_000,
  stub = String(process.env.SAND_PUSH_STUB ?? "") === "1",
  log = () => {},
} = {}) {
  const stores = new Map();
  const ledgers = new Map();
  // What the roster said last pass, per tenant, so a pass can tell a moved agent from a still one.
  const seen = new Map();
  let timer = null;
  let running = false;
  let passes = 0;
  // Every gateway call this edge has ever made, so a gate can assert ZERO for a tenant with no
  // devices rather than take the claim on trust.
  let gatewayCalls = 0;

  const storeFor = (t) => {
    const key = TENANT_KEY(t);
    const held = stores.get(key);
    if (held != null) return held;
    const made = createPushStore({ file: t.file(PUSH_FILE), now });
    stores.set(key, made);
    return made;
  };

  const ledgerFor = (t) => {
    const key = TENANT_KEY(t);
    const held = ledgers.get(key);
    if (held != null) return held;
    const made = createSentLedger({ file: t.file(PUSH_SENT_FILE), now });
    ledgers.set(key, made);
    return made;
  };

  /**
   * Every upstream call this edge makes, bounded. Without a timeout one unreachable box would hang
   * the whole sweep on its first call and every other customer's phone would go quiet with no line
   * in the log saying why.
   */
  async function call(t, command, args) {
    gatewayCalls += 1;
    // The timer is deliberately NOT unref'd: it is the only thing holding the loop while an
    // in-flight call is outstanding, and an unref'd one let Node decide the loop was empty and leave
    // the await pending forever. It IS cleared the moment the call wins, so a fast read does not keep
    // the process awake for the rest of the window.
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 0, text: "", type: "", timedOut: true }), callTimeoutMs); });
    let answer;
    try {
      answer = await Promise.race([
        gatewayCall(t, command, args ?? {}),
        deadline,
      ]);
    } catch (error) {
      answer = { status: 0, text: str(error?.message), type: "" };
    } finally {
      if (timer != null) clearTimeout(timer);
    }
    if (answer?.status !== 200) return null;
    try { return JSON.parse(str(answer.text)); } catch { return null; }
  }

  // ---- the senders, chosen once per platform per credential generation -------------------------
  let senderCache = { generation: "", map: new Map() };
  function sender(platform, t) {
    if (typeof senderFor === "function") return senderFor(platform, t);
    const creds = credentials() ?? {};
    const generation = `${str(creds.apns?.keyId)}:${str(creds.fcm?.projectId)}:${stub ? "stub" : "live"}`;
    if (senderCache.generation !== generation) senderCache = { generation, map: new Map() };
    const held = senderCache.map.get(platform);
    if (held != null) return held;
    let made;
    const stubSender = () => createStubSender({ file: t.file(PUSH_STUB_LEDGER_FILE), log });
    if (stub) made = stubSender();
    else if (platform === "ios" || platform === "desktop") {
      made = creds.apns?.key && http2 != null
        ? createApnsSender({ ...creds.apns, http2, log, now })
        : stubSender();
    } else {
      made = creds.fcm?.serviceAccount
        ? createFcmSender({ ...creds.fcm, fetchImpl, now, log })
        : stubSender();
    }
    senderCache.map.set(platform, made);
    return made;
  }

  // ---- one pass over one tenant ----------------------------------------------------------------

  async function sweepTenant(t, reason) {
    const store = storeFor(t);
    // RULE 1. The first act is a file read. A workspace with no phone reaches no box.
    const state = await store.read();
    if (state.devices.length === 0) return { slug: TENANT_KEY(t), devices: 0, sent: 0, calls: 0, skipped: "no device is registered" };

    const callsBefore = gatewayCalls;
    const ledger = ledgerFor(t);
    const rows = await ledger.read();
    const at = num(now());

    const roster = await call(t, "listAgents", {});
    if (roster == null) return { slug: TENANT_KEY(t), devices: state.devices.length, sent: 0, calls: gatewayCalls - callsBefore, skipped: "its box did not answer listAgents" };
    // listAgents answers a BARE ARRAY, and this cost a gate run to find out. Measured on
    // grok-bot-local-vm 2026-09-10: `POST /api/listAgents` answers `[{...}, ...]` with no wrapper,
    // while listProblemReports beside it answers `{reports: [...]}` and getAgentTranscriptTail answers
    // `{entries, nextBeforeSeq}`. The console reads the array form directly (gateway-adapter.js:2214),
    // so the array is the shape to believe; the object form is read too, because a wrapper is exactly
    // the kind of thing a later host adds and a silently-empty roster is a push nobody gets.
    const agents = Array.isArray(roster) ? roster : (Array.isArray(roster?.agents) ? roster.agents : []);

    const reports = await call(t, "listProblemReports", {});

    // Which agents earn a tail read: the ones whose roster row moved, plus every agent this relay
    // already alerted about and has not closed, because the CLOSE is what drops the badge and a
    // stamp rewritten in place does not always move newestEntryId.
    const before = seen.get(TENANT_KEY(t)) ?? new Map();
    const after = new Map();
    // WHAT STAYS OPEN, and what a row has to be before it stops costing a tail read every pass. Closed
    // is done. Muted is terminal: no device will ever alert on it, so re-reading its agent buys
    // nothing. A refusal that gave up is terminal the same way. What is left -- alerted-and-unanswered,
    // a quiet-hours hold owing a catch-up, a refusal still inside its backoff -- is a real obligation:
    // the CLOSE is what drops the badge, and a stamp rewritten in place does not always move
    // newestEntryId.
    const open = new Set([...rows.values()]
      .filter((row) => row.state !== "closed" && row.state !== "muted" && row.gaveUp !== true && row.kind !== "report")
      .map((row) => row.agentId).filter((id) => id.length > 0));
    const wanted = [];
    for (const agent of agents) {
      const id = str(agent?.id);
      if (id.length === 0) continue;
      const signature = [str(agent.newestEntryId), str(agent.awaitingUserResponse?.reason ?? (agent.awaitingUserResponse ? "1" : "")), num(agent.unreadCount), num(agent.updatedAt)].join("|");
      after.set(id, signature);
      if (before.get(id) !== signature || open.has(id)) wanted.push(agent);
    }
    seen.set(TENANT_KEY(t), after);

    const cards = [];
    for (const agent of wanted) {
      const tail = await call(t, "getAgentTranscriptTail", { id: str(agent.id), limit: 5 });
      if (tail == null) continue;
      cards.push(...cardsFromTail(tail?.entries, {
        tenant: TENANT_KEY(t), agentId: str(agent.id), agentName: str(agent.name), nowMs: at,
      }));
    }
    cards.push(...cardsFromReports(Array.isArray(reports) ? reports : reports?.reports, { tenant: TENANT_KEY(t), nowMs: at }));

    const decided = await decide({ t, store, state, cards, rows, at });
    await ledger.write(rows);
    return {
      slug: TENANT_KEY(t),
      devices: state.devices.length,
      cards: cards.length,
      pending: decided.badge,
      sent: decided.sent,
      held: decided.held,
      muted: decided.muted,
      failed: decided.failed,
      // In words, because "3 held" with no end to it reads as three cards dropped.
      heldUntil: decided.heldUntil > 0 ? new Date(decided.heldUntil).toISOString() : "",
      closed: decided.closed,
      calls: gatewayCalls - callsBefore,
      reason: str(reason),
    };
  }

  /**
   * The whole decision, given the cards a pass read and what this relay already did. Separated so a
   * test can drive it with an injected clock and no relay at all.
   */
  async function decide({ t, store, state, cards, rows, at }) {
    const byKey = new Map();
    for (const card of cards) byKey.set(card.key, card);
    const pending = cards.filter((card) => card.pending === true);
    const badge = pending.length;
    let sent = 0;
    let held = 0;
    let muted = 0;
    let failed = 0;
    let closed = 0;
    let heldUntil = 0;

    // WHY THIS RETURNS FOUR NUMBERS AND NOT A BOOLEAN. "Nothing went out" is three different facts
    // with three different right answers: a switch the customer turned off is terminal, a quiet window
    // is owed one catch-up at a known time, and a vendor refusal wants a backoff. A boolean collapsed
    // all three into one endlessly-retried state.
    const deliver = async (card, { silent }) => {
      const out = { any: false, held: 0, muted: 0, failed: 0, heldUntil: 0 };
      // A copy, because a vendor's "that device is gone" prunes the row mid-loop and the pruned
      // device must not be written to again in this pass.
      for (const device of [...state.devices]) {
        if (!state.devices.includes(device)) continue;
        const settings = normaliseSettings(state.settings[device.sub] ?? {});
        // A per-kind switch turns off the ALERT, never the silent badge update: a badge that stays
        // high for a card the person switched off would be a number they cannot clear.
        if (!silent && settings.kinds[card.kind] === false) { out.muted += 1; continue; }
        if (!silent && quietHoursHold(settings, at)) {
          out.held += 1;
          // When the window ends, so the log and the gate can say WHEN rather than only that something
          // was held. A held card with no end in the line reads as a card that was dropped.
          out.heldUntil = Math.max(out.heldUntil, quietHoursEndMs(settings, at));
          continue;
        }
        const ok = await send({ t, device, card, badge, silent, devices: state.devices });
        if (ok) out.any = true; else out.failed += 1;
      }
      // No device at all, or every device pruned mid-pass: nobody wanted it, which is muted.
      if (!out.any && out.held === 0 && out.failed === 0) out.muted += 1;
      return out;
    };

    /** The outcome of one alert attempt, as the row it writes. The retry policy lives here and nowhere else. */
    const rowAfter = (card, out, before) => {
      const base = { key: card.key, kind: card.kind, at, deadlineMs: num(card.deadlineMs), agentId: card.agentId, entryId: card.entryId, heldUntil: 0, attempts: 0, retryAt: 0, gaveUp: false };
      if (out.any) { sent += 1; return { ...base, state: "alerted" }; }
      if (out.held > 0) {
        held += out.held;
        heldUntil = Math.max(heldUntil, out.heldUntil);
        return { ...base, state: "held", heldUntil: out.heldUntil };
      }
      if (out.failed > 0) {
        const attempts = num(before?.attempts) + 1;
        const gaveUp = attempts >= PUSH_MAX_ATTEMPTS;
        failed += 1;
        if (gaveUp) log(`push  a ${card.kind} card was refused ${attempts} times and will not be tried again (${TENANT_KEY(t)})`);
        return { ...base, state: "failed", attempts, retryAt: gaveUp ? 0 : at + retryDelayMs(attempts), gaveUp };
      }
      muted += 1;
      return { ...base, state: "muted" };
    };

    // New and changed cards.
    for (const card of cards) {
      const row = rows.get(card.key);
      if (card.pending === true) {
        if (row == null) {
          rows.set(card.key, rowAfter(card, await deliver(card, { silent: false })));
          continue;
        }
        // Quiet hours held it, and one catch-up alert is owed on the SAME key when the window ends --
        // on the FIRST pass after it and not on the 240 passes before it.
        if (row.state === "held") {
          if (row.heldUntil > 0 && at < row.heldUntil) { held += 1; heldUntil = Math.max(heldUntil, row.heldUntil); continue; }
          rows.set(card.key, rowAfter(card, await deliver(card, { silent: false }), row));
          continue;
        }
        // A vendor refused it. Retried on a backoff, and after PUSH_MAX_ATTEMPTS not at all.
        if (row.state === "failed") {
          if (row.gaveUp === true || at < row.retryAt) continue;
          rows.set(card.key, rowAfter(card, await deliver(card, { silent: false }), row));
          continue;
        }
        // Already alerted (rule 4), or muted because nobody wanted it. Nothing goes out again, and a
        // muted row is out of the open set above so it stops earning a tail read every 15 s.
        continue;
      }
      // Answered, dismissed or expired. One SILENT badge update, so every other device's number
      // drops without a person touching it, and only for a card somebody was actually alerted to.
      if (row != null && row.state !== "closed") {
        await deliver(card, { silent: true });
        rows.set(card.key, { ...row, state: "closed", at });
        closed += 1;
      }
    }

    // A card that expired and was never read again: the ledger knows the deadline, so this needs no
    // gateway call at all.
    for (const row of [...rows.values()]) {
      if (row.state === "closed") continue;
      if (row.deadlineMs > 0 && at >= row.deadlineMs && !byKey.has(row.key)) {
        await deliver({ key: row.key, kind: row.kind, tenant: TENANT_KEY(t), agentId: row.agentId, entryId: row.entryId, title: "", reason: "", requestId: "", deadlineMs: row.deadlineMs }, { silent: true });
        rows.set(row.key, { ...row, state: "closed", at });
        closed += 1;
      }
    }

    return { badge, sent, held, muted, failed, closed, heldUntil };
  }

  /** One device, one card. Returns whether the vendor took it. */
  async function send({ t, device, card, badge, silent, devices = null }) {
    const host = str(hostOf(t));
    const creds = credentials() ?? {};
    const built = device.platform === "android"
      ? buildFcmMessage(card, { badge, token: device.token, host, silent, nowMs: num(now()) })
      : buildApnsMessage(card, { badge, bundleId: str(creds.apns?.bundleId), host, silent, nowMs: num(now()) });
    if (built.bytes > MAX_PUSH_PAYLOAD_BYTES) {
      log(`push  a ${card.kind} card would not fit a notification (${built.bytes} bytes of ${MAX_PUSH_PAYLOAD_BYTES}); nothing was sent`);
      return false;
    }
    const target = device.platform === "android"
      ? `fcm/v1/projects/${str(creds.fcm?.projectId)}/messages:send`
      : `https://${APNS_HOST[device.env] ?? APNS_HOST.production}/3/device/${str(device.token).slice(0, 8)}…`;
    const answer = await sender(device.platform, t).send({
      platform: device.platform,
      token: device.token,
      env: device.env,
      headers: built.headers ?? {},
      payload: built.payload ?? built.message,
      body: built.body,
      target,
      card,
      badge,
      silent,
    }).catch((error) => ({ ok: false, status: 0, reason: str(error?.message) }));
    if (answer?.ok === true) return true;
    const prune = prunesDevice({ platform: device.platform, status: num(answer?.status), reason: str(answer?.reason) });
    if (prune.length > 0) {
      await storeFor(t).prune(device.deviceId, prune, { sub: device.sub });
      // And out of the in-pass list, so a second card in the same pass does not write to a row that
      // is already off the disk.
      if (Array.isArray(devices)) {
        const found = devices.indexOf(device);
        if (found >= 0) devices.splice(found, 1);
      }
      log(`push  dropped a ${device.platform} device from ${TENANT_KEY(t)}: ${prune}`);
      return false;
    }
    // Every other refusal, with its status and the vendor's reason word and NEVER the body.
    log(`push  a ${device.platform} push was refused (HTTP ${num(answer?.status)}${str(answer?.reason) ? ` ${str(answer.reason)}` : ""})`);
    return false;
  }

  async function sweepOnce(reason = "the timer") {
    if (running) return { ok: false, why: "a pass is already running" };
    running = true;
    passes += 1;
    const swept = [];
    try {
      for (const t of tenants()) {
        try { swept.push(await sweepTenant(t, reason)); }
        catch (error) { log(`push  ${TENANT_KEY(t)}'s pass faulted: ${str(error?.message)}`); }
      }
      return { ok: true, reason: str(reason), swept, gatewayCalls };
    } finally { running = false; }
  }

  function sweepStart() {
    void sweepOnce("this relay started");
    timer = setInterval(() => { void sweepOnce("the timer"); }, sweepMs);
    timer.unref?.();
    return () => { if (timer != null) clearInterval(timer); timer = null; };
  }

  // ---- the routes ------------------------------------------------------------------------------
  //
  // Behind whatever already authenticated the request: the device bearer for an app, the session
  // cookie for the console's own settings panel. This module never checks a credential itself -- the
  // tenant context it is handed IS the answer to that question, which is the same contract
  // mailEdgeFor keeps.

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
    return true;
  };

  async function handle(req, res, url, t) {
    const pathname = str(url?.pathname);
    if (!pathname.startsWith("/push/")) return false;
    if (t == null) return fail(res, 404, "not found") ?? true;
    const sub = str(subOf(req));
    const store = storeFor(t);

    if (pathname === "/push/devices") {
      if (req.method === "GET") {
        const state = await store.read();
        // Never a token. A device list is for recognising your own phone and revoking it, and the
        // token is the one thing on the row that is of no use to a person and of use to anybody else.
        return json(res, 200, {
          devices: state.devices
            .filter((device) => ownedBy(device, sub))
            .map((device) => ({ deviceId: device.deviceId, platform: device.platform, name: device.name, env: device.env, createdAt: device.createdAt, updatedAt: device.updatedAt, tokenAt: device.tokenAt })),
        });
      }
      if (req.method === "POST") {
        let body;
        try { body = JSON.parse(str(await readBody(req)) || "{}"); } catch { return fail(res, 400, "that was not JSON") ?? true; }
        const answer = await store.register({ ...body, sub });
        if (!answer.ok) {
          return json(res, 400, { error: "bad_request", message: "Name the platform as ios, android or desktop, and send a deviceId and a token. Nothing was stored." });
        }
        return json(res, 200, {
          deviceId: answer.device.deviceId,
          platform: answer.device.platform,
          replaced: answer.replaced === true,
          message: answer.replaced ? "That device's token was refreshed." : "That device will be notified from now on.",
        });
      }
      return fail(res, 405, "GET or POST") ?? true;
    }

    if (pathname.startsWith("/push/devices/")) {
      const deviceId = decodeURIComponent(pathname.slice("/push/devices/".length));
      if (req.method !== "DELETE") return fail(res, 405, "DELETE") ?? true;
      // The sub is part of the match. Without it one account removed another's phone by naming an
      // id it could read off its own device list, and was told it worked.
      const answer = await store.forget(deviceId, { sub });
      if (!answer.ok) return json(res, 400, { error: "bad_request", message: "Name the device." });
      return json(res, 200, { deviceId, removed: answer.removed === true, message: answer.removed ? "That device will not be notified again." : "There is no device by that name here." });
    }

    if (pathname === "/push/settings") {
      if (req.method === "GET") {
        return json(res, 200, { settings: await store.settingsFor(sub), kinds: PUSH_CARD_KINDS, scope: sub.length > 0 ? "person" : "workspace" });
      }
      if (req.method === "PUT" || req.method === "POST") {
        let body;
        try { body = JSON.parse(str(await readBody(req)) || "{}"); } catch { return fail(res, 400, "that was not JSON") ?? true; }
        const settings = await store.saveSettings(sub, body);
        // SAVING SETTINGS IS THE ONE EVENT THAT CAN CHANGE A TERMINAL ANSWER, so it is the one event
        // that reopens one. A `muted` row is terminal on purpose -- that is the fix for a card being
        // re-decided every 15 s for ever -- but a person who has just turned a switch back ON means the
        // cards already waiting, not only the next one. So its row is dropped here and decided again on
        // the next pass: if the switch is still off it goes straight back to muted, which costs one
        // decision per save rather than one every fifteen seconds. A quiet-hours row has its deadline
        // cleared for the same reason, so a window somebody just shortened releases its catch-up then
        // rather than at the hour the old window would have ended.
        const ledger = ledgerFor(t);
        const rows = await ledger.read();
        let woke = 0;
        for (const [key, row] of [...rows]) {
          if (row.state === "muted") { rows.delete(key); woke += 1; }
          else if (row.state === "held" && row.heldUntil > 0) { rows.set(key, { ...row, heldUntil: 0 }); woke += 1; }
        }
        if (woke > 0) await ledger.write(rows);
        return json(res, 200, { settings, message: "Saved." });
      }
      return fail(res, 405, "GET or PUT") ?? true;
    }

    return fail(res, 404, `not found: ${req.method} ${pathname}`) ?? true;
  }

  /** Revoking a device bearer removes its push row too, so a revoked phone stops being notified in
   *  the same action rather than on somebody's next sweep. Item A's revoke calls this. */
  async function forgetDevice(slug, deviceId, sub) {
    const t = contextOf(slug);
    if (t == null) return { ok: false, error: "unknown_workspace" };
    return await storeFor(t).forget(deviceId, { sub });
  }

  return {
    handle,
    sweepOnce,
    sweepStart,
    forgetDevice,
    storeFor,
    ledgerFor,
    decide,
    stats: () => ({ passes, gatewayCalls, running }),
    close() { if (timer != null) clearInterval(timer); timer = null; for (const made of senderCache.map.values()) made.close?.(); },
  };
}

// ---- the two hooks ui/server.mjs calls ----------------------------------------------------------
//
// Named so ui/relay-hooks.mjs can load this module or not and the call sites in server.mjs never
// change. Absent, relay-hooks hands back a route that answers nothing and a sweep that starts
// nothing; present, these two.

/** (deps) -> async (req, res, url, t) => boolean. True means this module answered the request. */
export function pushRoutes(deps) {
  const edge = createPushEdge(deps);
  const handler = (req, res, url, t) => edge.handle(req, res, url, t);
  handler.edge = edge;
  return handler;
}

/** (deps) -> () => void, the stop. One pass at start and one every fifteen seconds after. */
export function pushSweepStart(deps) {
  const edge = deps?.edge ?? createPushEdge(deps);
  return edge.sweepStart();
}

/**
 * The relay's copy of the two credentials, refreshed from the control plane and kept in memory only.
 * A control-plane outage degrades to the last good copy and then to the stub, never to an exception:
 * a customer's phone going quiet for five minutes is a worse day than it needs to be, and a thrown
 * sweep would take mail's loop down with it in the same process.
 */
export function createCredentialReader({ cpUrl, relayToken, fetchImpl = fetch, refreshMs = 5 * 60_000, log = () => {} }) {
  let held = {};
  let timer = null;
  async function refresh() {
    if (!str(cpUrl) || !str(relayToken)) return held;
    try {
      const response = await fetchImpl(`${cpUrl}/v1/relay/push/credentials`, {
        headers: { authorization: `Bearer ${relayToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) {
        log(`push  the control plane would not hand over the push credentials (HTTP ${response.status}); keeping the last copy`);
        return held;
      }
      const body = await response.json();
      held = { apns: body?.apns ?? null, fcm: body?.fcm ?? null };
    } catch (error) {
      log(`push  the push credentials could not be read (${str(error?.message)}); keeping the last copy`);
    }
    return held;
  }
  return {
    current: () => held,
    refresh,
    start() {
      void refresh();
      timer = setInterval(() => { void refresh(); }, refreshMs);
      timer.unref?.();
      return () => { if (timer != null) clearInterval(timer); timer = null; };
    },
  };
}

// ---- create(deps): the shape ui/relay-hooks.mjs actually loads ----------------------------------
//
// FOUND AT MERGE TIME, AND IT IS THE FAILURE THIS SEAM EXISTS TO PREVENT. The seam loads this module
// by name, calls `create(deps)` if it finds one, and then looks for `handle` and `sweepStart` on what
// comes back. This module exported `pushRoutes` and `pushSweepStart` instead. Nothing threw: the seam
// found no `handle`, answered `null` for the routes, and /push 404'd on a relay that had every line of
// push in it. Absent, not red -- the same shape as the bare-array roster this module's own gate caught.
// So the adapter lives here, where the exports are, rather than in the seam, where a reader would have
// to know this module to understand it.
//
// TWO SIGNATURES ARE BRIDGED AND NOTHING ELSE CHANGES. The seam hands `handle` one object
// ({t, req, res, url, sub}); `handle` inside this module takes four positionals and reads `sub`
// through `subOf(req)`. The object's `sub` wins when it carries one, because the relay has already
// resolved the session by the time it dispatches and re-deriving it here would be a second answer to
// a settled question.
//
// WHAT THE RELAY OWES THIS MODULE, and it is only what this module cannot reach: `readBody` and `fail`
// (so /push refuses the way every other route on the relay refuses), `subOf`, the console's public
// host for the https half of a deep link, and the control plane's URL and relay token -- two strings,
// not a credential reader, because importing this module's reader into server.mjs would undo the whole
// point of the module being optional.
export function create(deps = {}) {
  const reader = createCredentialReader({
    cpUrl: str(deps.cpUrl),
    relayToken: str(deps.relayToken),
    log: deps.log ?? (() => {}),
  });
  const stopReader = reader.start();
  const publicHost = str(deps.publicHost) || "console.titanium.bot";
  const given = typeof deps.subOf === "function" ? deps.subOf : () => "";
  const edge = createPushEdge({
    ...deps,
    credentials: () => reader.current(),
    hostOf: deps.hostOf ?? (() => publicHost),
    // The sub the relay stamped on this request first, then whatever the relay's own resolver says.
    // Both, because the sweep reads rows with no request in hand at all and still has to know whose
    // they are.
    subOf: (req) => subFromRequest(req) || str(given(req)),
  });
  return {
    edge,
    handle(one = {}) {
      // Both call shapes, because tests/relay-push-routes.test.mjs drives the four positionals and the
      // relay drives the object. A bridge that only understood one of them would pass its own suite.
      if (one != null && typeof one === "object" && !Array.isArray(one) && one.req !== undefined) {
        const { t, req, res, url, sub } = one;
        return edge.handle(sub === undefined ? req : withSub(req, sub), res, url, t);
      }
      return edge.handle(...arguments);
    },
    sweepStart: () => edge.sweepStart(),
    // Revoking a device bearer has to take its push row with it, or a phone somebody revoked because
    // they lost it goes on being notified. The edge wrote this function for item A's revoke and item
    // A never called it; measured on the R750 2026-09-10, a revoked device's row was still in
    // push.json. The seam carries it now.
    // The sub comes through too: a revoke removes the push row of the account that holds the bearer
    // and never another account's row that happens to carry the same device id.
    forgetDevice: (slug, deviceId, sub) => edge.forgetDevice(slug, deviceId, sub),
    close() { stopReader?.(); edge.close?.(); },
  };
}

// The session's own `sub`, carried on the request the way every other per-person read on this relay
// carries it, so `subOf` inside the edge answers what the relay already decided rather than parsing a
// cookie a second time. A property and not a wrapper object: the edge passes `req` to `readBody`,
// which needs the real stream.
const SUB_ON_REQUEST = Symbol.for("titanbot.push.sub");
function withSub(req, sub) {
  try { req[SUB_ON_REQUEST] = str(sub); } catch { /* a frozen request keeps whatever subOf says */ }
  return req;
}
export const subFromRequest = (req) => str(req?.[SUB_ON_REQUEST]);
