// cp/support.mjs -- mail to support@titanium.bot, and what the control plane does with one.
// SUPPORT-1. docs/SUPPORT.md is the contract: every name below is binding -- the payload's field
// names, the setting names, the relay route, the states and the words a person reads.
//
// Jason, 2026-09-12: "Support@titaniumbot. If something comes in on that, I know we're able to
// receive mail. We've got to do something with that so maybe that goes to a new support page and
// sends me a notification to my Titanium."
//
// WHAT WAS THERE BEFORE: a Cloudflare Email Routing rule forwarding support@titanium.bot to Jason's
// personal mailbox, and nothing else. No record, no state, nothing anybody else on the team could
// see, and no way to tell a message that was answered from one that was missed.
//
// THE SHAPE, AND WHY IT IS THIS ONE. Three pieces, and the seam between them is a credential
// boundary rather than a preference:
//
//   1. the operator's OWN Cloudflare Email Worker, which this repository does not deploy. It holds a
//      bearer this control plane minted and it POSTs one JSON body per message.
//   2. POST /v1/relay/support on this service, behind that bearer and DELIBERATELY NOT
//      CP_RELAY_TOKEN. A Worker is code running in somebody else's datacentre with a secret in its
//      environment; the relay token opens the tenant registry, which hands out every customer's
//      gateway token and every customer's derived session key. Those two things must never be the
//      same secret, whatever it costs in plumbing, and what it costs here is one setting.
//   3. the Support panel on the admin console, plus one notification into the operator's own
//      workspace so a message does not wait for somebody to think of opening a panel.
//
// WHAT THIS FILE NEVER DOES: send a reply. The product has no support mailbox to send from and no
// thread to send into, so the panel says "answer it from your own mail client" and the `replied`
// state is the operator writing down that they did. A Reply button that composed a mail nobody had
// read the delivery rules for would be the same class of failure as a switch wired to nothing.
//
// EVERY VALUE THAT ARRIVES HERE CAME FROM A STRANGER. Anyone on the internet can write to
// support@titanium.bot, so the subject, the body, the html and the sender's own address are hostile
// input that a person is then going to read on a page. normalizeInbound keeps the fields it knows,
// checks each one against its limit, drops the rest, and NAMES THE FIELD in every refusal so the
// operator debugging their Worker is told which key is wrong rather than "bad request". The panel
// renders every one of them as text through the DOM and never as markup.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { SECRET_SETTINGS, SUPPORT_STATES } from "./store.mjs";
import { boxContainerFor, readGatewayTokenFor } from "./provision.mjs";

/**
 * The bearer the operator's Email Worker presents, held write-only.
 *
 * ADDED TO SECRET_SETTINGS AT IMPORT rather than by editing the Set literal in cp/store.mjs, which is
 * the pattern cp/code.mjs's E2B key already uses and for the same two reasons: it keeps this wave out
 * of a file other waves are in, and it gets the whole guarantee -- cp/store.mjs listSettings hands
 * every value back except the names in that Set, so a name left out of it is a live credential in
 * any answer that ever renders the settings.
 */
export const SUPPORT_INBOUND_TOKEN_SETTING = "support.inboundToken";
SECRET_SETTINGS.add(SUPPORT_INBOUND_TOKEN_SETTING);

/**
 * Which workspace gets told, and which bot in it.
 *
 * Both are settings with a DERIVED default rather than a hardcoded slug, because "my Titanium" is a
 * fact about this install and not about this product: the workspace is the one the first super admin
 * account signs in to, and the bot is the one called Titan, read off that box's own roster. An
 * operator who wants it somewhere else names it and neither default is consulted again.
 */
export const SUPPORT_NOTIFY_WORKSPACE_SETTING = "support.notifyWorkspace";
export const SUPPORT_NOTIFY_AGENT_SETTING = "support.notifyAgent";

/** Whether a message arriving announces itself at all. On by default; `0` turns the prompt off. */
export const SUPPORT_NOTIFY_SETTING = "support.notify";

/**
 * Every clamp, in one place, and every one of them is inside the 64 KB this service reads a request
 * body at (cp/server.mjs MAX_BODY_BYTES).
 *
 * That is the reason the text and html numbers are what they are rather than rounder: 32 KB of plain
 * text plus 16 KB of flattened html plus the envelope fits with room to spare, so a Worker that
 * clipped to these numbers always lands and one that did not is refused by this file with the field
 * named rather than by the body reader with nothing useful to say. docs/SUPPORT.md carries the
 * numbers and the Worker in the code block clips to them.
 *
 * A FIELD OVER ITS LIMIT IS REFUSED AND NEVER CUT DOWN, the rule cp/feedback.mjs established: a
 * support message silently truncated reads as a whole one, and the person answering it answers half
 * a question without knowing there was more. The one-liners are the exception and are clamped,
 * because a 9 KB Subject header is a malformed mail rather than evidence, and refusing it would drop
 * a real customer's question over the shape of its header.
 */
export const LIMITS = {
  from: 320,
  to: 320,
  subject: 500,
  text: 32 * 1024,
  html: 64 * 1024,
  htmlText: 16 * 1024,
  messageId: 250,
  notes: 4000,
};

/** How large a support intake body may be. The service's own default; named so the doc can cite it. */
export const INTAKE_BYTES = 64 * 1024;

const oneLine = (value, limit) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
const block = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

/**
 * An address, as a person would write it, out of whatever a mail header held.
 *
 * `Jane Doe <jane@example.com>` is the common form and the part worth keeping is the inside of the
 * angle brackets. A header with no angle brackets is taken whole. It is NOT validated into
 * non-existence: a support message from a malformed sender is still a support message, and an
 * address this cannot parse is stored as the one line it arrived as so the operator can see it.
 */
export function addressOf(value) {
  const raw = oneLine(value, LIMITS.from * 2);
  const angle = /<\s*([^<>\s]+)\s*>/.exec(raw);
  const picked = angle == null ? raw : angle[1];
  return picked.slice(0, LIMITS.from);
}

/**
 * An html mail reduced to the words in it.
 *
 * Deliberately small and deliberately not a parser. Two things matter: a script or a style block's
 * CONTENTS must not survive as text, because a page of CSS pasted into the panel is the message
 * hidden rather than shown; and a tag must become a space rather than nothing, or "Hi</p><p>there"
 * reads as one word. Everything after that is whitespace tidying and the five named entities a mail
 * client actually emits.
 *
 * WHAT THIS IS NOT: a sanitizer. Nothing in this product ever renders this string as html -- the
 * panel writes it through textContent -- so the safety comes from the renderer and not from here.
 */
export function stripHtml(value) {
  return String(value ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The id that makes a retried delivery one row.
 *
 * A sender's own Message-ID when there is one, because that is the thing two copies of one mail
 * share. When there is none -- and a surprising number of automated senders emit none -- one is
 * derived from the parts that would be identical on a retry: the sender, the subject, the time the
 * Worker stamped, and a digest of the body. The last is what stops two different messages from the
 * same sender in the same second colliding into one row.
 *
 * It is a sha256 and not the values themselves, so nothing a stranger wrote ends up inside a
 * database index a developer later greps.
 */
export function messageIdFor({ messageId = "", from = "", subject = "", receivedAt = 0, text = "", html = "" } = {}) {
  const given = oneLine(messageId, LIMITS.messageId);
  if (given.length > 0) return given;
  const digest = createHash("sha256")
    .update(`${String(from)}\n${String(subject)}\n${Number(receivedAt) || 0}\n${String(text)}\n${String(html)}`, "utf8")
    .digest("hex");
  return `derived-${digest.slice(0, 40)}`;
}

/**
 * What the operator's workspace is told, in one line.
 *
 * One line because of what it costs: this is delivered as a prompt into a conversation, so it is a
 * model turn, and a paragraph of quoted mail would be a paragraph of tokens on every message that
 * arrives. The sender and the subject are what decide whether a person opens the panel now or later,
 * and the panel is where the message itself is.
 *
 * Both values came from a stranger, so both are one line and clamped. A subject carrying newlines
 * would otherwise turn one notification into what reads as several.
 */
export function notificationLine(message) {
  const from = oneLine(message?.from, LIMITS.from) || "an address it did not give";
  const subject = oneLine(message?.subject, 200) || "no subject";
  return `Support mail from ${from}: ${subject}`;
}

/**
 * One message from the Worker, kept, checked, and stripped of everything this file does not know.
 *
 * Answers {ok, message} or {ok: false, field, why} with a sentence a person reads and the field
 * named. An unknown key is not an error and is not stored.
 */
export function normalizeInbound(raw, { at = Date.now() } = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field: "body", why: "a support message has to be a JSON object with from, subject and either text or html." };
  }
  const from = addressOf(raw.from);
  if (from.length === 0) {
    return { ok: false, field: "from", why: "a support message needs from, the address it came from, and this one did not have it." };
  }
  const to = addressOf(raw.to);
  const subject = oneLine(raw.subject, LIMITS.subject);

  const text = block(raw.text);
  const html = block(raw.html);
  // Named one by one, so the sentence says which key to fix rather than "too big". The Worker's
  // author is the reader of this message and they are looking at their own code when they get it.
  if (text.length > LIMITS.text) {
    return { ok: false, field: "text", why: `text is ${text.length} characters and at most ${LIMITS.text} are carried, so nothing was stored. Clip it in the worker.` };
  }
  if (html.length > LIMITS.html) {
    return { ok: false, field: "html", why: `html is ${html.length} characters and at most ${LIMITS.html} are carried, so nothing was stored. Clip it in the worker.` };
  }
  if (text.length === 0 && html.length === 0) {
    return { ok: false, field: "text", why: "a support message needs text or html, and this one had neither, so there would be nothing to read." };
  }

  const receivedAt = Number.isFinite(Number(raw.receivedAt)) && Number(raw.receivedAt) > 0
    ? Number(raw.receivedAt)
    : (Date.parse(String(raw.receivedAt ?? "")) || at);
  // The html, flattened, is the message BESIDE the plain text and not instead of it. A mail with a
  // text part keeps it as what the panel shows first; the flattened copy is what makes an html-only
  // mail readable at all. Clamped rather than refused: a 300 KB html newsletter is a real thing that
  // arrives at a support address, and the words in it fit.
  const htmlText = html.length > 0 ? stripHtml(html).slice(0, LIMITS.htmlText) : "";
  if (text.length === 0 && htmlText.length === 0) {
    return { ok: false, field: "html", why: "that html had no words in it at all once the markup was taken out, so there would be nothing to read." };
  }

  return {
    ok: true,
    message: {
      receivedAt,
      from,
      to,
      subject,
      text,
      htmlText,
      messageId: messageIdFor({ messageId: raw.messageId, from, subject, receivedAt, text, html }),
      state: "new",
    },
  };
}

/**
 * The same compare cp/server.mjs secretsMatch is, copied rather than imported: this module must not
 * depend on the route file that mounts it.
 *
 * Both sides hashed to a fixed width FIRST, so the compare is constant time over the length as well
 * as over the bytes. Comparing the raw strings would answer "wrong length" instantly and hand an
 * attacker the token's length for free.
 */
function secretMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const BOX_CALL_TIMEOUT_MS = 10_000;

/**
 * The support desk: the intake, the panel's answer, the state move, and the one notification.
 *
 * Built per call site rather than once in the process, the way cp/admin.mjs builds its mail
 * directory: it closes over the store and holds no state of its own, so two of them cannot disagree.
 */
export function createSupport({
  store,
  config = {},
  now = () => Date.now(),
  // What talks to a BOX, which is not what talks to Coolify. The same fetch in production, because
  // the control plane is on titanbot-net for exactly this; separate so a test can stand a stub box up
  // in its own process. cp/onboard.mjs takes it the same way and for the same reason.
  probeImpl = globalThis.fetch,
  // async (slug, command, args) -> {ok, body} | {ok: false, why}. Defaulted below out of probeImpl;
  // overridable so a test can count the calls a notification makes.
  boxCall = null,
  log = () => {},
  randomImpl = randomBytes,
} = {}) {
  const tokenHeld = () => String(store.getSetting(SUPPORT_INBOUND_TOKEN_SETTING, "") ?? "");

  /**
   * Where a box answers. `http://titanbot-box-<uuid>:1340` on the docker bridge, the same address
   * cp/onboard.mjs reads a box at, with the same one override for a gate that cannot resolve a
   * container name. A production value for the override would send every box call for every customer
   * to one address, which is why it is never set on the R750.
   */
  const boxBase = (container) => {
    const override = String(config?.boxUrlOverride ?? "").trim().replace(/\/+$/, "");
    return override.length > 0 ? override : `http://${container}:1340`;
  };

  const callBox = boxCall ?? (async (slug, command, args = {}) => {
    const tenant = store.getTenant(slug);
    if (tenant == null) return { ok: false, why: `there is no workspace called ${slug} on this control plane` };
    // SUPPORT-1d. One helper, shared with the registry, the removal, the onboarding sequence and the
    // Box health panel: the written column wins, and a row with only a Coolify service uuid on it
    // derives the name rather than reading as a workspace with no box. The first three support mails
    // ever to reach this product told nobody because this read the column alone.
    const container = boxContainerFor(tenant);
    if (container.length === 0) return { ok: false, why: `${slug} has no container name on its row, so its box cannot be asked anything` };
    // ADOPTION-AWARE, for the same measured reason: `titanium` keeps its profile directory under the
    // release root, and the tenant-root read answered "could not be read" for a token that was there.
    const token = readGatewayTokenFor(store, slug, config) ?? "";
    if (token.length === 0) return { ok: false, why: `${slug}'s gateway token could not be read, so its box cannot be asked anything` };
    try {
      const answer = await probeImpl(`${boxBase(container)}/api/${command}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(BOX_CALL_TIMEOUT_MS),
      });
      const text = await answer.text();
      if (Number(answer.status) !== 200) return { ok: false, why: `${command} answered HTTP ${answer.status}` };
      try { return { ok: true, body: text.length > 0 ? JSON.parse(text) : {} }; }
      catch { return { ok: false, why: `${command} answered something that is not json` }; }
    } catch (error) {
      return { ok: false, why: `${command} did not answer (${String(error?.message ?? error)})` };
    }
  });

  /**
   * Which workspace is told. The setting, or the workspace the first super admin signs in to.
   *
   * Derived rather than hardcoded because "my Titanium" names this install's own operator workspace,
   * and a slug compiled into the product would be wrong on every other install of it. A control plane
   * with no super admin yet has nobody to tell, and that is a sentence rather than a crash.
   */
  function notifyTarget() {
    const named = String(store.getSetting(SUPPORT_NOTIFY_WORKSPACE_SETTING, "") ?? "").trim().toLowerCase();
    if (named.length > 0) {
      return store.getTenant(named) == null
        ? { ok: false, why: `${SUPPORT_NOTIFY_WORKSPACE_SETTING} names ${named} and there is no workspace by that name` }
        : { ok: true, slug: named, how: `${SUPPORT_NOTIFY_WORKSPACE_SETTING} names it` };
    }
    const admins = (store.listAccounts() ?? []).filter((row) => row.superAdmin === true && row.disabled !== true);
    const first = admins.find((row) => String(row.tenant ?? "").length > 0 && store.getTenant(String(row.tenant)) != null);
    if (first == null) {
      return { ok: false, why: `no workspace is named in ${SUPPORT_NOTIFY_WORKSPACE_SETTING} and no super admin account has one, so there is nobody to tell` };
    }
    return { ok: true, slug: String(first.tenant), how: `the workspace ${first.email} signs in to` };
  }

  /**
   * Which bot is told. The setting, or the one called Titan on that box's own roster.
   *
   * listAgents answers a BARE ARRAY on some host builds and `{agents: [...]}` on others -- that
   * exact disagreement is what made a PUSH-1 sweep report a clean zero on a box with twelve bots --
   * so both shapes are read here and neither is assumed.
   */
  async function notifyAgent(slug) {
    const named = String(store.getSetting(SUPPORT_NOTIFY_AGENT_SETTING, "") ?? "").trim();
    if (named.length > 0) return { ok: true, agentId: named, agentName: named, how: `${SUPPORT_NOTIFY_AGENT_SETTING} names it` };
    const roster = await callBox(slug, "listAgents", {});
    if (!roster.ok) return { ok: false, why: `${slug}'s roster could not be read, so there is no bot to tell (${roster.why})` };
    const rows = Array.isArray(roster.body) ? roster.body : (Array.isArray(roster.body?.agents) ? roster.body.agents : []);
    const people = rows.filter((row) => row?.isGroup !== true && String(row?.id ?? "").length > 0);
    if (people.length === 0) return { ok: false, why: `${slug} has no bot on its roster to tell` };
    const titan = people.find((row) => String(row?.name ?? "").trim().toLowerCase() === "titan");
    const picked = titan ?? people[0];
    return {
      ok: true,
      agentId: String(picked.id),
      agentName: String(picked.name ?? picked.id),
      how: titan == null ? "the first bot on the roster, because none of them is called Titan" : "the bot called Titan",
    };
  }

  /**
   * One message announced in the operator's own workspace. Answers {ok, why, detail} and NEVER
   * throws: the message is already on the disk and a notification that could not be made must not
   * turn a stored message into a 500 the Worker retries for ever.
   *
   * WHAT IT COSTS, said plainly because it is the one cost this feature has: one prompt, which is one
   * model turn in the operator's own workspace, per support message that arrives. Plus one listAgents
   * read, which costs nothing, unless the bot is named in a setting. docs/SUPPORT.md §4 says why this
   * is the cheapest path that exists today and what the alternatives would have needed.
   */
  async function notify(message) {
    if (String(store.getSetting(SUPPORT_NOTIFY_SETTING, "1") ?? "1") === "0") {
      return { ok: false, why: `${SUPPORT_NOTIFY_SETTING} is off, so nothing was announced` };
    }
    const target = notifyTarget();
    if (!target.ok) return { ok: false, why: target.why };
    const bot = await notifyAgent(target.slug);
    if (!bot.ok) return { ok: false, why: bot.why };
    const line = notificationLine(message);
    // The nonce is the message id, so the HOST's own duplicate check is the second line of defence
    // behind the unique index: two deliveries of one mail cannot become two turns even if they
    // somehow got past the store.
    const sent = await callBox(target.slug, "sendPrompt", {
      agentId: bot.agentId,
      prompt: line,
      clientNonce: `support:${message.messageId}`,
    });
    if (!sent.ok) return { ok: false, why: `${bot.agentName} in ${target.slug} was not told (${sent.why})` };
    return { ok: true, why: "", detail: `${bot.agentName} in ${target.slug} was told`, slug: target.slug, agentId: bot.agentId };
  }

  /**
   * Whether a bearer has been minted, for the panel. A length and eight hex characters of a digest,
   * which is enough to prove a specific token is the one stored and not enough to be one. The same
   * evidence shape the repository token and the two push credentials answer with.
   */
  const tokenDoor = () => {
    const held = tokenHeld();
    return held.length === 0
      ? { stored: false, why: "no inbound token has been minted yet, so the email worker has nothing to present and every delivery is refused." }
      : {
        stored: true,
        evidence: `${held.length} characters, sha256 ${createHash("sha256").update(held, "utf8").digest("hex").slice(0, 8)}`,
      };
  };

  return {
    tokenDoor,

    /**
     * A new bearer, answered ONCE and written nowhere else.
     *
     * It is minted here rather than typed, for the reason a password is: a secret passed as a command
     * line argument is in a shell history file, and a secret somebody invents is as good as the
     * afternoon they invented it. Minting replaces whatever was held, so the old Worker stops being
     * able to deliver the moment the operator presses this -- which is what makes it a rotation and
     * is why the panel says so before they press it.
     */
    mintInboundToken(actor = "") {
      const value = `sup_${randomImpl(32).toString("hex")}`;
      store.setSetting(SUPPORT_INBOUND_TOKEN_SETTING, value, String(actor ?? ""));
      return { token: value, evidence: tokenDoor().evidence };
    },

    /**
     * The Worker's delivery. Answers {status, answer} for the route to write out.
     *
     * The order of the refusals is the order every other door on this service uses: the credential
     * first, so a malformed body from a stranger with no bearer learns nothing about our field names,
     * then the body with the field named.
     */
    async receive({ presented = "", body = null } = {}) {
      const expected = tokenHeld();
      if (expected.length === 0) {
        // Not 401: there is nothing wrong with the caller. This service has not been set up for this
        // yet, and telling the operator that is the difference between a ten minute fix and an hour.
        return { status: 503, answer: { error: "not_configured", message: `no ${SUPPORT_INBOUND_TOKEN_SETTING} is stored, so nothing could be accepted. Mint one on the admin console's Support panel.` } };
      }
      if (!secretMatches(presented, expected)) {
        return { status: 401, answer: { error: "unauthorized", message: "that credential does not open this door, so nothing was stored" } };
      }
      const normalized = normalizeInbound(body, { at: now() });
      if (!normalized.ok) {
        return { status: 400, answer: { error: "bad_request", field: normalized.field, message: normalized.why } };
      }
      const message = normalized.message;
      let stored;
      try { stored = store.recordSupportMessage(message); }
      catch (error) {
        const code = error?.code === "too_large" ? 413 : 400;
        return { status: code, answer: { error: error?.code ?? "bad_request", field: "text", message: String(error?.message ?? "that message could not be stored") } };
      }
      if (!stored.stored) {
        // The retry case, and it answers 200 rather than 409: a Worker that sees anything but a 2xx
        // tries again, and this delivery has in fact already succeeded. Nothing is notified twice.
        log(`support  ${message.messageId} was already stored as ${stored.row.id}, so nothing was stored or announced again`);
        return { status: 200, answer: { id: stored.row.id, state: stored.row.state, duplicate: true, notified: stored.row.notifiedAt > 0, message: "that message was already here, so nothing was stored or announced again" } };
      }

      const told = await notify(stored.row);
      const at = told.ok ? now() : 0;
      store.markSupportNotified(stored.row.id, { at, detail: told.ok ? String(told.detail ?? "") : String(told.why ?? "") });
      log(told.ok
        ? `support  ${message.from} -> message ${stored.row.id}; ${told.detail}`
        : `support  ${message.from} -> message ${stored.row.id}; nobody was told: ${told.why}`);
      return {
        status: 201,
        answer: {
          id: stored.row.id,
          state: stored.row.state,
          duplicate: false,
          notified: told.ok,
          // The reason, when there is one. A Worker's author never needs it and the operator reading
          // the panel does, which is why it is also on the row.
          notifyWhy: told.ok ? "" : String(told.why ?? ""),
        },
      };
    },

    /** One message's state, and the operator's note beside it. */
    setState(id, { state = "", notes = undefined, actor = "" } = {}) {
      const row = store.getSupportMessage(Number(id));
      if (row == null) return { ok: false, error: "not_found", message: "There is no support message by that number." };
      if (!SUPPORT_STATES.includes(String(state))) {
        return { ok: false, error: "bad_request", field: "state", message: `A support message's state has to be one of ${SUPPORT_STATES.join(", ")}. Nothing was changed.` };
      }
      if (notes !== undefined && String(notes).length > LIMITS.notes) {
        return { ok: false, error: "bad_request", field: "notes", message: `A note is at most ${LIMITS.notes} characters and that one is ${String(notes).length}. Nothing was changed.` };
      }
      let updated;
      try {
        updated = store.updateSupportMessage(Number(id), {
          state: String(state),
          ...(notes === undefined ? {} : { notes: String(notes) }),
          decidedBy: String(actor ?? ""),
        });
      } catch (error) {
        return { ok: false, error: error?.code ?? "bad_request", message: String(error?.message ?? error) };
      }
      return {
        ok: true,
        row: view(updated),
        // The sentence the panel shows. `replied` says out loud that this product sent nothing,
        // because the alternative is an operator who thinks pressing a button answered a customer.
        note: state === "replied"
          ? `Message ${id} is marked replied. Nothing was sent from here: this is your own record that you answered it from your mail client.`
          : state === "closed"
            ? `Message ${id} is closed. It stays on the record with your name on the decision.`
            : `Message ${id} is open again.`,
      };
    },

    /**
     * The panel's own answer.
     *
     * The filter is applied in the store and the COUNTS are over everything, the shape the Feedback
     * panel uses and for the same reason: the number an operator needs is "how many are unanswered",
     * and a filter is exactly what hides that.
     */
    panel({ state = "", sinceMs = 0, limit = 200 } = {}) {
      const rows = store.listSupportMessages({ state, sinceMs, limit });
      const counts = store.countSupportByState();
      const door = tokenDoor();
      const target = notifyTarget();
      return {
        rows: rows.map(view),
        total: store.countSupportMessages(),
        counts,
        states: SUPPORT_STATES,
        token: door,
        notify: {
          on: String(store.getSetting(SUPPORT_NOTIFY_SETTING, "1") ?? "1") !== "0",
          workspace: target.ok ? target.slug : "",
          how: target.ok ? target.how : "",
          why: target.ok ? "" : target.why,
          agent: String(store.getSetting(SUPPORT_NOTIFY_AGENT_SETTING, "") ?? ""),
        },
        // What the panel prints under its heading, so the one thing this feature does not do is on
        // the screen rather than only in a document.
        gates: "Mail to your support address is forwarded here by your own Cloudflare Email Worker"
          + " and announced once in your workspace. Nothing is ever sent from here: answer a message"
          + " from your own mail client, then mark it replied.",
        retention: "these rows are never pruned",
        measuredAt: new Date(now()).toISOString(),
      };
    },

    // Exposed for the route and for a gate; the panel above is what the console reads.
    notify,
    notifyTarget,
    notifyAgent,
  };
}

/**
 * One row as a route answers it: the times as ISO strings, everything else as it was stored.
 *
 * Separate from the store's own row shape because the store deals in numbers and a screen deals in
 * strings, and a 0 for "never notified" would render as 1970.
 */
export function view(row) {
  if (row == null) return null;
  return {
    ...row,
    receivedAt: new Date(Number(row.receivedAt)).toISOString(),
    notifiedAt: Number(row.notifiedAt) > 0 ? new Date(Number(row.notifiedAt)).toISOString() : "",
    decidedAt: Number(row.decidedAt) > 0 ? new Date(Number(row.decidedAt)).toISOString() : "",
  };
}
