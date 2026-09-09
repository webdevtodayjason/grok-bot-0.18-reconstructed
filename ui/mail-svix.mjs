// ui/mail-svix.mjs -- the bytes both services need to agree on about an inbound email (MAIL-2).
//
// MAIL-1 put the Svix verification and the address readers inside ui/mail-edge.mjs, which was the
// right home while the relay was the only thing that touched mail. MAIL-2 adds a second reader:
// the control plane owns the per-bot address directory, and it has to shape and read the same
// addresses the relay routes on. Two copies of "what is a localpart" is how the two halves come to
// disagree about who a message belongs to, so the shared half moved here and ui/mail-edge.mjs
// re-exports every one of them. The relay's behaviour is byte for byte what it was.
//
// The Svix half moved with them even though the control plane has no webhook route today: the
// verification is one function with a written contract, and a fork of it is exactly the fork this
// file exists to prevent. See docs/MAIL.md.
//
// Nothing here imports anything outside node builtins. The relay has no node_modules at all, and
// the control plane's image copies this file in beside ui/session-token.mjs (cp/Dockerfile).
import { createHmac, timingSafeEqual } from "node:crypto";

const asString = (value) => (typeof value === "string" ? value.trim() : "");

// ---- the Svix signature ------------------------------------------------------------------------
// Resend signs inbound webhooks with Svix. Ported from ~/code/titanium-mail/apps/web/lib/svix.ts,
// which is the same three rules written in TypeScript:
//
//   signed content = "{svix-id}.{svix-timestamp}.{raw body}"
//   key            = the base64 bytes of the secret after the "whsec_" prefix
//   expected       = base64( HMAC-SHA256(key, signed content) )
//   header         = svix-signature: space-separated "v1,<base64>" entries; other versions ignored
//   timestamp      = unix seconds, within five minutes either way
//
// The raw request bytes as text, never a re-serialized parse: JSON.stringify of a parsed body is a
// different string and would never verify.

/** Five minutes either way, per the Svix spec. */
export const SVIX_TOLERANCE_S = 300;

/** The three svix-* headers off a node request, or null when any is missing. */
export function svixHeaders(headers) {
  const get = (name) => {
    const value = headers?.[name] ?? headers?.get?.(name);
    return Array.isArray(value) ? value[0] : value;
  };
  const id = asString(get("svix-id"));
  const timestamp = asString(get("svix-timestamp"));
  const signature = asString(get("svix-signature"));
  if (id.length === 0 || timestamp.length === 0 || signature.length === 0) return null;
  return { id, timestamp, signature };
}

const svixKey = (secret) => Buffer.from(
  String(secret ?? "").startsWith("whsec_") ? String(secret).slice("whsec_".length) : String(secret ?? ""),
  "base64",
);

export function verifySvixSignature(secret, headers, rawBody, nowMs = Date.now()) {
  const seconds = Number.parseInt(String(headers?.timestamp ?? ""), 10);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "invalid svix-timestamp" };
  if (Math.abs(nowMs - seconds * 1000) > SVIX_TOLERANCE_S * 1000) {
    return { ok: false, reason: "svix-timestamp outside tolerance" };
  }
  const key = svixKey(secret);
  if (key.length === 0) return { ok: false, reason: "empty webhook secret" };
  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`, "utf8").digest();
  for (const part of String(headers.signature ?? "").split(" ")) {
    const [version, signature] = part.split(",", 2);
    if (version !== "v1" || !signature) continue;
    let candidate;
    try { candidate = Buffer.from(signature, "base64"); } catch { continue; }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching v1 signature" };
}

/** The header value Resend would send. Used by the gate and the tests, never in production. */
export function signSvix(secret, { id, timestamp }, rawBody) {
  return `v1,${createHmac("sha256", svixKey(secret)).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest("base64")}`;
}

// ---- reading an address -------------------------------------------------------------------------

/** "Titan <titan@titanium.bot>" and "titan@titanium.bot" both come out as the address. */
export function bareAddress(value) {
  const raw = String(value ?? "").trim();
  const angled = /<([^>]+)>/.exec(raw);
  return (angled ? angled[1] : raw).trim();
}

/** A to field is a string, a comma list, or an array of either. */
export function toAddressList(value) {
  const out = [];
  const push = (entry) => {
    if (entry == null) return;
    if (Array.isArray(entry)) { for (const item of entry) push(item); return; }
    if (typeof entry === "object") { push(entry.address ?? entry.email ?? null); return; }
    for (const piece of String(entry).split(",")) {
      const address = bareAddress(piece);
      if (address.length > 0) out.push(address);
    }
  };
  push(value);
  return out;
}

/** The localpart, lowercased, with any +tag taken off. */
export const localpartOf = (address) => bareAddress(address).split("@")[0].toLowerCase().split("+")[0].trim();
export const domainOf = (address) => {
  const parts = bareAddress(address).split("@");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase().trim() : "";
};

// ---- the code address (MAIL-2) --------------------------------------------------------------------
//
// agent<code>@<domain>, where <code> is six digits the control plane mints once per (workspace,
// agent) and never reuses. Jason's Scribe and Richard's Scribe are two codes, and NO ADDRESS EVER
// CARRIES A NAME: a name-based address is guessable, is not unique across workspaces, and was the
// reason mail for an unknown localpart used to land in whichever workspace claimed the domain.
//
// Six digits is a million values against a fleet of a few thousand bots, and the address is not a
// secret in the first place -- it is printed on the agent's card and typed into signup forms. What
// it buys is that a stranger cannot guess a WORKING address by knowing a person's name.

/** The one shape a directory localpart may have. The capture group is the code. */
export const MAIL_CODE_RE = /^agent(\d{6})$/;

/** The six digits out of a localpart, or "" when it is not a code at all. */
export const mailCodeOf = (localpart) => MAIL_CODE_RE.exec(String(localpart ?? "").toLowerCase())?.[1] ?? "";

/** agent123456@myagents.email, or "" when either half is missing. */
export const codeAddress = (code, domain) => {
  const digits = String(code ?? "").trim();
  const at = String(domain ?? "").trim().toLowerCase();
  return /^\d{6}$/.test(digits) && at.length > 0 ? `agent${digits}@${at}` : "";
};
