// api-diet.mjs -- COST-1. What the relay sends back for /api, made small enough for a phone.
//
// THE CEILINGS THIS FILE EXISTS TO HOLD, on DECODED bytes at 390x844 on grok-bot-local-vm:
// 250 KiB of /api on first paint, 100 KiB per idle minute, 600 KiB per WORKING minute. Decoded and
// not wire, because decoded is what the phone parses and what makes a local number comparable to
// an R750 one: production compresses at the edge (br on /login, gzip on /auth/state, measured at
// console.titanium.bot) and the local relay compresses nothing, so the same answer is a very
// different number of wire bytes on the two machines and only the decoded figure is comparable.
//
// MEASURED BASELINE, grok-bot-local-vm, 2026-09-09, 390x844: boot is 254 requests and 3,982.4 KiB,
// of which /api is 538.3 KiB over 47 calls with a 93-message conversation open and 1,512.6 KiB the
// moment the long-lived agent is selected. The bytes live in FOUR methods, not in the call count,
// which is why this is two projections and a digest rather than a new boot-batch verb: a
// relay-composed snapshot would duplicate the adapter's shaping in a second place and save no
// decoded bytes. The round-trip count falls as a side effect of the memo in gateway-adapter.js,
// not as a goal.
//
// HOW THE RELAY REACHES THIS FILE. ui/relay-hooks.mjs loads it once at boot and calls
// shapeApiAnswer(method, args, headers, bytes) from relayCommand, the one funnel every /api answer
// passes through (it already buffers the whole body), and only on a 200 -- a refusal's body is the
// gateway's own sentence and must reach the console whole. The answer is { bytes, headers }: the body
// as a STRING and any headers to add. When this file is ABSENT the hook is the identity:
//
//   const shapeApiAnswer = (method, args, headers, bytes) => ({ bytes, headers: {} });
//
// and the relay behaves exactly as it did before this wave. That absence is a gate leg, not a
// comment: CONSOLE-4 already paid for the lesson when backgrounds.js destructured a missing global
// and took the picker down.
//
// AND THERE IS NO COMPRESSION HERE, which the design had pencilled in as item seven. The seam carries
// a STRING, and a gzip frame is not a string: handing one back would be written out as the UTF-8 of
// its bytes and arrive corrupt. Compression belongs to the edge, which already does it -- br on
// /login and gzip on /auth/state, measured at console.titanium.bot -- and it was never going to move
// the ceiling anyway, because the ceiling is on decoded bytes. Locally the gate's wire figure now
// equals its decoded figure, and that is the honest reading of a relay that compresses nothing.
//
// THREE RULES EVERY PROJECTION HERE IS WRITTEN UNDER.
//
//   A PROJECTION IS OPT-IN, ALWAYS. No request header, no projection: the answer goes back byte for
//   byte. A caller that did not ask to be put on a diet is never put on one -- not a gate, not the
//   phone shell, not a console served from an older deploy. `x-titan-projection: lean` asks;
//   `full`, any other value, and no header at all all mean "unchanged".
//
//   A PROJECTION NEVER GUESSES. An unparseable body, or a shape this file does not recognise (an
//   object where an array was expected, an error envelope that still arrived as a 200) and the answer
//   goes back untouched. The outline projection is the one change in this wave that can silently break the
//   transcript, so it is pinned by a unit test over the real 1,578-item payload asserting the same
//   tool rows land at the same positions with the same keys before and after.
//
//   THE DIGEST IS NOT A CACHE. The relay always asks the box. It replays nothing; it only answers
//   "the bytes you already hold are the bytes I just got" when they are byte-identical. So an
//   unchanged answer cannot go stale, and there is no invalidation to get wrong.
import { createHash } from "node:crypto";

export const PROJECTION_HEADER = "x-titan-projection";
export const IF_DIGEST_HEADER = "x-titan-if-digest";
export const DIGEST_HEADER = "x-titan-digest";

// Deliberately NOT a 304. /api is POST, so there is no conditional-request semantics to argue with
// and no browser cache to interact with; the adapter's own memo is the only reader. 20 bytes.
export const UNCHANGED_BODY = '{"__unchanged":true}';

export const digestOf = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

// `x-titan-projection` is a token list so one header can carry more than one answer's worth of
// intent later without a second header name. Only "lean" means anything today.
export function wantsLean(headerValue) {
  return String(headerValue ?? "")
    .split(/[,\s]+/)
    .some((token) => token.toLowerCase() === "lean");
}

// ---- the outline projection -------------------------------------------------------------------
//
// getConversationOutline is the model's whole turn state: 1,578 items and 1,239,452 bytes on the
// long-lived agent, re-read whenever the transcript tail moves and every 5 s while that agent is
// working (OUTLINE_WORKING_MAX_AGE_MS). The console DISCARDS most of it before the renderer ever
// sees it -- weaveToolRows emits rows only for kind "tool-call", and outlineKey answers null for
// anything that is not "user" or "send-message", so an assistant-text item has no effect on the
// page at all. 559 of the 1,578 items on this payload are assistant-text.
//
// So the paging is a relay-side PROJECTION and needs no host verb. Measured on grok-bot-local-vm:
// {id}, {id,limit:20}, {id,limit:20,offset:0} and {id,afterId:...} all answer exactly 1,239,452
// bytes -- the host ignores all three paging arguments -- and this projection answers 40,707.
//
// The fields kept are exactly the ones the console reads. For a tool-call row that is what
// toolRowText() touches; for an anchor it is ONE FIELD, the outline key, and nothing else -- not
// the kind, not the id, neither of which weaveToolRows ever reads off an anchor.
//
// AND THE KEY IS HASHED, which is the whole difference between a projection that meets the ceiling
// and one that does not. An outline key IS the message text (`u:<the user's words>` or
// `a:<what the agent said>`), so carrying keys verbatim carries the conversation back a second
// time: measured on this payload, 1,239,452 bytes become 416,598 with verbatim keys and 40,707 with
// hashed ones, 8,699 of those gzipped. The key is only ever compared for equality against a key the
// console computes from the transcript it already holds, so a hash is all either side needs.
//
// The cost is the one named cost of this item: there are now two implementations of one hash, here
// and in gateway-adapter.js, and they must agree byte for byte. cyrb64 is chosen because it can:
// Math.imul over UTF-16 code units behaves identically in node and in every browser, with no
// encoding step to disagree about and no crypto.subtle (which is absent on a plain-http LAN origin).
// Measured over every key in both captured payloads: 691 distinct keys, 691 distinct hashes, zero
// collisions. A collision would put one tool row at the wrong anchor, which is cosmetic, not a
// wrong transcript -- and the unit test compares woven output over the real payload rather than
// trusting that sentence.
const TOOL_CALL_FIELDS = ["kind", "id", "name", "status", "summary", "output", "exitCode"];

export function hashOutlineKey(value) {
  const s = String(value);
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// Byte for byte gateway-adapter.js's messageKey/outlineKey. Any drift here shows up as tool rows
// landing in the wrong place, which is why the unit test compares woven output and not strings.
const messageKeyOf = (message) =>
  (message?.type === "text" ? `a:${String(message.content ?? "").trim()}` : `a:${JSON.stringify(message ?? null)}`);

export function outlineKeyOf(item) {
  if (item?.kind === "send-message") return messageKeyOf(item.message);
  if (item?.kind === "user") return `u:${String(item.text ?? "").trim()}`;
  return null;
}

export function projectOutline(items) {
  if (!Array.isArray(items)) return items;
  const out = [];
  for (const item of items) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.kind === "tool-call") {
      const row = {};
      for (const field of TOOL_CALL_FIELDS) if (item[field] !== undefined) row[field] = item[field];
      out.push(row);
      continue;
    }
    const key = outlineKeyOf(item);
    // Everything else -- assistant-text above all -- reaches the renderer as nothing, so it is not
    // sent. Dropping it is not a choice about what matters; it is what the console already does
    // one function after the download.
    if (key == null) continue;
    out.push({ k: hashOutlineKey(key) });
  }
  return out;
}

// ---- the workflows projection -----------------------------------------------------------------
//
// getAgentWorkflows is the same 86-skill catalogue for every agent -- 109,016 bytes, of which each
// skill's whole markdown body is 65,832 -- and loadContext reads it on every tick. Nothing on the
// conversation screen draws a body: skillsSig() in app.js keys on id, enabled, owner and name, and
// the body is read only by the skills panel's <pre> and its editor. So the tick asks lean and the
// panel's own getSkills() asks full. Measured: 109,016 to 42,598 raw.
export function projectWorkflows(list) {
  if (!Array.isArray(list)) return list;
  return list.map((row) => {
    if (row == null || typeof row !== "object" || Array.isArray(row) || !("body" in row)) return row;
    const { body, ...rest } = row;
    return rest;
  });
}

// Only these two, and only these two on purpose: a projection is a promise that the relay knows
// what the console reads out of an answer, and that promise is only true where it has been measured.
const PROJECTIONS = {
  getConversationOutline: projectOutline,
  getAgentWorkflows: projectWorkflows,
};

export const projectionFor = (method) => PROJECTIONS[method] ?? null;

/**
 * The one entry point ui/relay-hooks.mjs calls, from relayCommand, on a 200 only.
 *
 * @param method   the gateway method name out of the /api/<method> path
 * @param args     the arguments the console sent, already parsed by the seam (unused here today: the
 *                 projections depend on the answer's shape, not on which agent was asked about, and
 *                 the parameter is in the signature because a later projection will want it)
 * @param headers  node's req.headers (lowercase keys), where x-titan-projection and x-titan-if-digest
 *                 arrive
 * @param bytes    the upstream answer body, already buffered as a string
 * @returns        { bytes, headers } -- the body as a string, and headers to merge over the relay's
 *                 own. Never throws: the seam catches, but a projection that cannot be trusted to
 *                 return the whole answer on anything unexpected is not worth having.
 */
export function shapeApiAnswer(method, args, headers = {}, bytes = "") {
  const body = String(bytes ?? "");
  const out = {};

  let shaped = body;
  const project = wantsLean(headers[PROJECTION_HEADER]) ? projectionFor(method) : null;
  if (project != null) {
    try {
      const parsed = JSON.parse(body);
      const next = project(parsed);
      // `next === parsed` is how a projection says "not a shape I recognise" without throwing.
      if (next !== parsed) shaped = JSON.stringify(next);
    } catch {
      // Not JSON, or not the shape the projection expects. The answer goes back untouched.
      shaped = body;
    }
  }

  const digest = digestOf(shaped);
  out[DIGEST_HEADER] = digest;

  // The adapter holds the last answer it saw for this method and these arguments and sends its
  // digest back. Identical bytes, and it keeps what it holds: 20 bytes instead of 163 KiB on an
  // idle tick. The box was still asked, so this can never answer something the box no longer says.
  if (typeof headers[IF_DIGEST_HEADER] === "string" && headers[IF_DIGEST_HEADER] === digest) {
    return { bytes: UNCHANGED_BODY, headers: out };
  }
  return { bytes: shaped, headers: out };
}
