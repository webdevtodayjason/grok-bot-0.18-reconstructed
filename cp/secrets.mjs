// cp/secrets.mjs -- KEYS-1. The keys the PRODUCT uses, held by the operator and by nobody else.
//
// WHAT MOVED AND WHY. Until this file existed, two vendor keys were typed by a CUSTOMER into their
// own console: the realtime voice key on the Voice card and the mail sending key on the Email card.
// Jason's own words on 2026-09-10, looking at the settings panel: "A user is never going to put a
// resend key in. That's on the backend." He is right, and the reason is not only taste. A key field
// on a customer's screen is a key a customer can get wrong, a key a customer's own agents can be
// talked into reading, and a per-workspace bill nobody can meter. So the two of them come here: the
// super admin pastes each ONCE at api.titanium.bot/admin, this service holds them write-only, and
// the one relay reads them behind CP_RELAY_TOKEN and keeps them in memory.
//
// THREE NAMES AND NO MORE. The allowlist below is closed. A name outside it is 400, so a route that
// grows a fourth key is a change to this file and a change to its test, never a string a caller can
// invent. The voice half is per SERVICE because the service is a per-workspace choice (voice.json's
// `vendor`) and it decides which key dials: a workspace set to a service the operator has no key for
// gets the plain "not switched on" sentence, never somebody else's key aimed at the wrong vendor.
//
// WHAT IS DELIBERATELY NOT HERE: the inbound mail webhook signing secret.
//
// It looks like the third member of this set and it is not. It is not a vendor credential the relay
// fetches; it is a ROUTING DISCRIMINATOR. ui/server.mjs, in the webhook claimants loop, resolves
// "two workspaces claim one mail domain" by handing the message to the one whose signing secret
// verifies THIS body. One global value in front of every edge would make the first claimant able to
// read another customer's mail. So it stays on each workspace's own file, it stays an operator-only
// field, and the claimants loop is never handed a value that came from here. That is a whole class
// of cross-tenant leak removed for nothing the brief asked for. docs/MAIL.md says it too.
//
// PROVED BEFORE STORED, the same rule the GitHub token and the two push credentials already live by
// (cp/admin.mjs): a key the vendor will not take is a feature that fails weeks later on somebody
// else's morning. The proof is one cheap authenticated GET with a ten second timeout; a non-2xx is
// 409 and stores nothing.
//
// NOTHING HERE EVER ANSWERS WITH A VALUE except GET /v1/relay/keys, which is behind the relay's
// own credential and is the only reason any of this exists. Everything else -- the ledger row, the
// admin console's presence line, the POST's own answer -- carries `keyEvidence`: a length and eight
// hex characters of a sha256.

import { createHash } from "node:crypto";

/**
 * A credential proved without being carried: how long it is and the first bytes of its digest.
 *
 * The same one line cp/admin.mjs keeps privately for the GitHub token and the two push credentials.
 * It is copied rather than imported because these routes deliberately do NOT live inside that file
 * (cp/admin.mjs claims every /v1/admin/* path and answers 404 to anything it does not match itself,
 * which is why /v1/code/settings sits outside that prefix too) and that file belongs to another
 * wave's file list this week. Converging the two is one import and one export the day both files
 * are open in the same worktree.
 */
export const keyEvidence = (value) =>
  `${String(value ?? "").length} characters, sha256 ${createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 8)}`;

/** The realtime voice key for the service a workspace dials, per service. */
export const KEY_VOICE_XAI = "keys.voice.xai";
export const KEY_VOICE_OPENAI = "keys.voice.openai";
/** The key the product SENDS mail with. The inbound signing secret is not here; see the top. */
export const KEY_MAIL_SEND = "keys.mail.send";

/**
 * The closed allowlist, in the order the admin console draws them.
 *
 * `label` and `why` are the operator's words, so vendor names are allowed here and nowhere a
 * customer can read. `probe` is the cheap authenticated GET that proves the value.
 */
export const KEY_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: KEY_VOICE_XAI,
    label: "Talking, xAI",
    why: "The realtime key the product talks with when a workspace is set to the first voice service. Without it, pressing Talk on that service says voice is not switched on yet.",
    placeholder: "paste the xAI API key",
    envBase: "CP_XAI_API_URL",
    defaultBase: "https://api.x.ai/v1",
    probePath: "/models",
    vendor: "xAI",
  }),
  Object.freeze({
    name: KEY_VOICE_OPENAI,
    label: "Talking, OpenAI",
    why: "The realtime key for the second voice service. A workspace set to a service with no key here gets the plain refusal rather than a key meant for the other one.",
    placeholder: "paste the OpenAI API key",
    envBase: "CP_OPENAI_API_URL",
    defaultBase: "https://api.openai.com/v1",
    probePath: "/models",
    vendor: "OpenAI",
  }),
  Object.freeze({
    name: KEY_MAIL_SEND,
    label: "Sending mail",
    why: "The key every bot's outgoing mail is sent with. Until this is set the relay keeps using the operator's own file, which is what makes pasting it here a migration with no migration code.",
    placeholder: "paste the Resend API key",
    envBase: "CP_RESEND_API_URL",
    defaultBase: "https://api.resend.com",
    probePath: "/domains",
    vendor: "Resend",
  }),
]);

/** Every name this service will store. Anything else is 400 at the door. */
export const KEY_NAMES = Object.freeze(KEY_DEFINITIONS.map((one) => one.name));

/** The definition for a name, or null. Null is the whole of "that is not a name we hold". */
export function keyDefinition(name) {
  return KEY_DEFINITIONS.find((one) => one.name === String(name ?? "").trim()) ?? null;
}

/**
 * Which key dials for a workspace's chosen voice service.
 *
 * The vendor id is the one in that workspace's own voice.json (`xai`, `openai`). An id nobody has
 * heard of answers "" rather than falling through to the other service's key: dialling a vendor with
 * another vendor's credential is a 401 that reads to the customer as "the service is broken".
 */
export function voiceKeyName(vendorId) {
  const id = String(vendorId ?? "").trim().toLowerCase();
  if (id === "xai") return KEY_VOICE_XAI;
  if (id === "openai") return KEY_VOICE_OPENAI;
  return "";
}

/** The address a proof is made against, overridable for a test the way the GitHub base already is. */
export function probeBase(definition, env = process.env) {
  const raw = String(env?.[definition.envBase] ?? "").trim();
  return (raw.length > 0 ? raw : definition.defaultBase).replace(/\/+$/, "");
}

/**
 * Is this a value at all, before anybody is asked about it.
 *
 * Eight characters is the same floor the GitHub token route uses. It exists so a person who tabbed
 * past the field is told to paste the key rather than being told the vendor refused an empty string.
 */
export function parseKeyValue(body) {
  const value = typeof body?.value === "string" ? body.value.trim() : "";
  if (value.length < 8) return { ok: false, why: "Paste the key." };
  // A pasted .p8 or a JSON blob is not one of these three, and a newline in a bearer header is a
  // header-splitting bug rather than a key. Refused here, before it can reach a vendor.
  if (/[\r\n]/.test(value)) return { ok: false, why: "That has a line break in it, so it is not one of these keys." };
  return { ok: true, value };
}

/**
 * Ask the vendor whether it takes this key, before anything is stored.
 *
 * One authenticated GET, ten seconds, and the answer is only ever a verdict: this function never
 * returns a body, so nothing a vendor says can end up in a ledger row or an answer. A network
 * failure is a refusal too -- storing a key that could not be checked is the same as not checking.
 */
export async function proveKey({ name, value, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 10_000 }) {
  const definition = keyDefinition(name);
  if (definition == null) return { ok: false, why: "That is not a key this product uses." };
  const base = probeBase(definition, env);
  const url = `${base}${definition.probePath}`;
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${value}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, why: `${definition.vendor} would not accept that key.` };
    }
    if (!response.ok) {
      return { ok: false, why: `${definition.vendor} answered ${response.status} when asked about that key, so it was not checked.` };
    }
    return { ok: true, how: `${definition.vendor} at ${base}${definition.probePath}` };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    return { ok: false, why: timedOut ? `${definition.vendor} did not answer in time, so nothing was checked.` : `${definition.vendor} could not be reached, so nothing was checked.` };
  }
}

/**
 * What the super admin's own read answers: presence, evidence, when and who. NEVER a value.
 *
 * Shaped like cp/admin.mjs's pushDoor() for the same reason it is: a panel that can only render
 * this object cannot render more than this object, whatever anybody writes into it later.
 */
export function keysDoor(store) {
  const meta = new Map(store.listSettings().map((row) => [row.name, row]));
  return {
    keys: KEY_DEFINITIONS.map((definition) => {
      const value = store.getSetting(definition.name, "");
      const row = meta.get(definition.name) ?? null;
      return {
        name: definition.name,
        label: definition.label,
        why: definition.why,
        placeholder: definition.placeholder,
        stored: value.length > 0,
        // The same string the ledger keeps forever. No fragment of the value is in it.
        evidence: value.length > 0 ? keyEvidence(value) : "",
        at: value.length > 0 ? Number(row?.at ?? 0) : 0,
        actor: value.length > 0 ? String(row?.actor ?? "") : "",
      };
    }),
  };
}

/**
 * What the RELAY reads. The one place on this service a value leaves, and only to the relay.
 *
 * A name with nothing behind it is OMITTED rather than answered as an empty string, which is the
 * same rule the registry route follows: a caller that sees a name has a key, and a caller that sees
 * no name has nothing to fall back FROM. The relay's fallback to a workspace's own file is decided
 * by absence, so an empty string here would quietly beat a working file.
 */
export function relaySecrets(store) {
  const keys = {};
  for (const definition of KEY_DEFINITIONS) {
    const value = store.getSetting(definition.name, "");
    if (value.length > 0) keys[definition.name] = value;
  }
  return { keys };
}

/**
 * One ledger row for one paste, written BEFORE the store is touched and finished after.
 *
 * The same two-write shape cp/admin.mjs's beginAction uses, and for the same reason: a process that
 * died between the two leaves a row saying a change was STARTED, which is the honest record. It is
 * spelled out here rather than imported because these routes live in cp/server.mjs, which cannot
 * reach that file's closure; `store.recordAdminAction` and `store.finishAdminAction` are the public
 * pair both callers go through.
 *
 * `detail` carries keyEvidence(value) and NOTHING ELSE about the value. A test plants a key and
 * sweeps every row of this table for its bytes and for a ten character prefix of them.
 */
export function beginKeyAction(store, { actor, via, ip, name, value, now = Date.now() }) {
  const definition = keyDefinition(name);
  const id = store.recordAdminAction({
    at: now,
    actor: String(actor ?? "the operator token"),
    via: String(via ?? "console"),
    ip: String(ip ?? ""),
    action: "keys.set",
    target: String(name ?? ""),
    detail: `${definition?.label ?? name} (${keyEvidence(value)})`,
    outcome: "started",
  });
  return {
    id,
    done: (detailAfter = "") => store.finishAdminAction(id, "ok", detailAfter),
    failed: (why) => store.finishAdminAction(id, `failed: ${String(why ?? "").split("\n")[0].slice(0, 300)}`),
  };
}
