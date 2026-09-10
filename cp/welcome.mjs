// cp/welcome.mjs -- the welcome mail the product sends a new customer (ONBOARD-2, docs/MAIL.md §6b).
//
// Jason, 2026-09-10 10:54: "Is the welcome email sent out? What does that look like?" It was not.
// The Clients panel's welcome checkbox has been present and DISABLED since ADMIN-2 because the
// control plane sends no mail at all, and the only welcome a real customer ever received -- Richard's
// on 2026-09-07 -- was a script somebody ran by hand on the server that no longer exists anywhere on
// it. This file is the product doing it instead.
//
// WHAT THIS OWNS: the sign-in link, the words, the send, and the row. It holds no Resend key, makes
// no Resend call and knows no sender address. It hands the relay a recipient and some words; the
// relay decides who the mail is FROM and signs it with the key it already stores.
//
// WHY MAIL-3's POST /mail/send COULD NOT BE REUSED, four independent reasons measured against the
// live code before a line of this was written:
//   1. its credential is a BOX's gateway token, which this service does not hold;
//   2. ui/mail-edge.mjs buildFrom forces the From to the bot's own agent<code>@myagents.email and
//      deliberately ignores a caller's, so a product mail would go out as a robot;
//   3. reply_to is hard-wired to that same agent address;
//   4. cp/mail.mjs openSend refuses an empty agentId, which every product mail has, and a send that
//      got past it would charge the new customer's own 30/hour and 200/day caps for their own
//      welcome and put a bot-less row in their own Sent list.
// So the relay grows one more route, POST /mail/product, and this is its only caller.
//
// THE TWO THINGS THAT NEVER TOUCH A ROW, A LOG LINE OR A LEDGER: the temporary password and the
// sign-in link. The password is minted by cp/signup.mjs, shown once on the card, and stored only as
// a scrypt hash nobody can ask back. The link is a bearer credential in a URL (see mintSignInLink),
// so it is handed to the caller exactly once, in the answer, and is written nowhere.

import { createHash, randomUUID } from "node:crypto";

import { SESSION_TTL_MS, mintSessionToken, tenantSessionSecret } from "./session.mjs";

/** The subject, fixed. A customer searching their mail for it should find one string. */
export const WELCOME_SUBJECT = "Your Titanium Bot workspace is ready";

/**
 * Twenty four hours, and it is a CEILING rather than a target.
 *
 * Understand what the link is: a stateless signed bearer in a URL that the relay verifies and never
 * checks for revocation (ui/session-token.mjs says so outright), that works as many times as it is
 * clicked until it expires, and that cannot be cancelled short of rotating CP_SESSION_SECRET, which
 * signs the whole fleet out. That is why click tracking is off for titanium.bot, why the link is
 * never written down, and why this number is not larger.
 *
 * The relay caps the COOKIE it sets from the link at its own SESSION_TTL_MS, so a 24 hour link
 * yields a 12 hour session. Both numbers are right: one is how long the customer may arrive, the
 * other is how long they stay signed in once they have.
 */
export const WELCOME_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where the support address the customer is told to write to comes from, and its default.
 *
 * support@titaniumcomputing.com rather than support@titanium.bot: inbound mail is live on that
 * domain today and is not yet live on titanium.bot, and an address nobody reads is worse than one on
 * the wrong brand. `node cp/cli.mjs setting set mail.welcome.replyTo support@titanium.bot` is the one
 * line that moves it the day inbound is switched on.
 */
export const WELCOME_REPLY_TO_SETTING = "mail.welcome.replyTo";
export const WELCOME_REPLY_TO_DEFAULT = "support@titaniumcomputing.com";

/** The relay route this file is the only caller of. */
export const PRODUCT_MAIL_ROUTE = "/mail/product";

/**
 * The shapes, on two axes: does this mail carry a password, and does it promise a bot address.
 *
 * `link+password` is an invite: the button plus the console address and the temporary password on a
 * quiet second line, because there is NO customer-facing set-your-own-password door anywhere in the
 * product yet (POST /v1/accounts/{id}/password is behind requireAdmin; ONBOARD-3 is filed for the
 * missing door) and a link-only mail locks a customer out at hour 25 with the operator as the only
 * recovery. `link` is a Send again, where the original password is a scrypt hash nobody can ask back
 * and changing it would lock out a customer who has already signed in.
 *
 * The `-no-bot-mail` pair is the SAME mail with the "Your bots have their own email" section left
 * out, for a workspace whose address sweep has not minted anything yet. It exists because of what
 * the R750 did on 2026-09-10: the sweep answered 200 and minted nothing, so there was no address to
 * name, and this file's refusal turned the welcome step red and sent the customer NOTHING -- no
 * password, no link, no way in. The job's own rule is that an addresses amber stops nothing, and
 * only a shape that can be honest without an address makes that rule true. A mail that says less is
 * a mail; a mail that does not go is a customer locked out. The refusal below is kept for the two
 * shapes that DO promise an address, so a caller naming one explicitly still cannot promise a thing
 * that is not there.
 */
export const WELCOME_SHAPES = new Set(["link+password", "link", "link+password-no-bot-mail", "link-no-bot-mail"]);

/** Does this shape carry the temporary password. */
export const shapeCarriesPassword = (shape) => String(shape ?? "").startsWith("link+password");
/** Does this shape promise the customer a bot address, which is the thing that needs one to exist. */
export const shapePromisesBotMail = (shape) => !String(shape ?? "").endsWith("-no-bot-mail");

// ---- the refusals, word for word ---------------------------------------------------------------
//
// Named constants rather than inline strings, for the reason cp/signup.mjs's are: tests/cp-welcome
// reads this file's source and holds each sentence, so a change to one of them is a change somebody
// makes on purpose in one place. Every method below REFUSES -- answers {ok: false, why} -- rather
// than throwing, because the caller is a step in a job whose card has to show a sentence.

export const WELCOME_NO_RECIPIENT = "There is no address to send the welcome to.";
export const WELCOME_BAD_RECIPIENT =
  "The welcome goes to exactly one address, written as a plain email address, and that is not one.";
export const WELCOME_NO_LINK = "The welcome needs a sign-in link and there is none, so nothing was sent.";
export const WELCOME_NO_TITAN_ADDRESS =
  "Titan has no email address yet, so the welcome would promise something that is not there. "
  + "Run the address sweep for this workspace, then send it.";
export const WELCOME_LINK_SHAPE_WITH_PASSWORD =
  "A second welcome never carries a password, so that password was not sent and nothing was sent.";
export const WELCOME_NO_ACCOUNT = "There is no account on that workspace to sign in, so no link could be made.";
export const WELCOME_NO_TENANT = "There is no workspace by that name, so no link could be made.";
export const WELCOME_NO_HOST = "That workspace has no address to sign in at, so no link could be made.";
export const WELCOME_NO_SECRET =
  "This control plane has no session secret, so it cannot mint a sign-in link. Set CP_SESSION_SECRET.";

// ---- the brand, as a mail client will actually render it ----------------------------------------
//
// titanium-bot-brand-system.md. Arial and Helvetica because a web font does not load in mail, and a
// real hex for every colour because a CSS variable does not survive a mail client's sanitizer.
const MIDNIGHT = "#090D14";
const GRAPHITE = "#172232";
const TITANIUM = "#E6EBF2";
const CYAN = "#00C8F0";
const CLOUD = "#F5F7FA";
const INK = "#16181D";
const QUIET = "#5B6472";
const LINE = "#E3E7EC";
// The dark halves, used in the media block AND nowhere else, because every element's readability is
// already settled by its inline colour before the query is read. Gmail ignores
// prefers-color-scheme entirely, so a colour whose only definition is inside the query is a colour
// most readers never get.
const DARK_EDGE = "#26313F";
const DARK_QUIET = "#C3CDDB";
const DARK_PANEL = "#0F1823";

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One recipient, written as a plain address. The same regex ui/mail-edge.mjs uses on a bot's send,
// so the two doors agree about what an address is.
const SEND_ADDRESS_RE = /^[^\s@,<>"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const oneAddress = (value) => {
  const at = typeof value === "string" ? value.trim() : "";
  return SEND_ADDRESS_RE.test(at) ? at : "";
};

/** "Jane", out of a name if there is one and the address if there is not. Never empty. */
export function firstNameOf(name, email) {
  const whole = String(name ?? "").trim();
  if (whole.length > 0) return whole.split(/\s+/)[0];
  const local = String(email ?? "").split("@")[0].trim();
  return local.length > 0 ? local : "there";
}

/**
 * The idempotency key, so a double press inside the hour cannot mail a real human twice.
 *
 * Resend's own 24 hour dedupe answers the same id for a replay, which reads as two rows carrying one
 * provider id -- honest rather than hidden. The recipient is HASHED rather than written in, because
 * this string travels in a header and a header is a thing that gets logged. The hour is in it so a
 * deliberate second send tomorrow, or an hour later, is a send and not a silent no-op.
 */
export function welcomeIdempotencyKey({ slug, to, at = Date.now() } = {}) {
  const when = new Date(Number(at) || 0).toISOString().replace(/[^0-9]/g, "").slice(0, 10);
  const who = createHash("sha256").update(String(to ?? "").trim().toLowerCase(), "utf8").digest("hex").slice(0, 16);
  return `welcome:${String(slug ?? "")}:${who}:${when}`;
}

/**
 * The mail, both shapes, as HTML and as hand written plain text.
 *
 * THE WORDS ARE THE PRODUCT. Plain sentences for a business owner who has never heard of a container,
 * no vendor names, no em dashes, no bullet ceremony. The mark and the wordmark are drawn in HTML and
 * CSS and never as an image: an <svg> is dropped by every major client, a data URI in an <img> is
 * stripped by Gmail, and titanium.bot hosts no raster mark (measured 2026-09-10: logo.png 404s). So
 * an image would be the one element most readers never see, and a reader with images off gets the
 * same header everybody else does.
 *
 * EVERY COLOUR IS INLINE AS WELL AS IN THE MEDIA BLOCK. Gmail ignores prefers-color-scheme, so the
 * query is the extra and the inline value is the floor. The one line that must never be invisible is
 * the temporary password, which the first draft of this rendered at 1.11:1 in dark, and only a
 * two-scheme render proves it: scripts/verify-welcome-mail.mjs walks every text run in both schemes
 * and fails under 4.5:1.
 */
export function renderWelcome({
  firstName = "",
  company = "",
  email = "",
  host = "console.titanium.bot",
  signInUrl = "",
  temporaryPassword = "",
  titanAddress = "",
  supportAddress = WELCOME_REPLY_TO_DEFAULT,
  shape = "link+password",
  linkHours = Math.round(WELCOME_LINK_TTL_MS / 3_600_000),
} = {}) {
  const who = String(firstName ?? "").trim() || "there";
  const business = String(company ?? "").trim() || "your business";
  const consoleUrl = `https://${String(host ?? "").trim()}`;
  const withPassword = shapeCarriesPassword(shape);
  const password = withPassword ? String(temporaryPassword ?? "") : "";
  // A mail that names no bot address says nothing about bot mail at all. It does not say "coming
  // soon" and it does not leave a heading over an empty line: the customer learns about their bots'
  // addresses on the Mail page inside the workspace, which is where they are anyway.
  const withBotMail = shapePromisesBotMail(shape) && String(titanAddress ?? "").trim().length > 0;

  // ---- the plain text alternative, written by hand ---------------------------------------------
  //
  // Hand written and not stripped out of the HTML. A stripped version of a table layout reads as a
  // wall of nothing, and this is what a text-only client, a screen reader on a phone and a spam
  // filter all see.
  const text = [
    `Hi ${who},`,
    "",
    `Your Titanium Bot workspace for ${business} is ready. It is a private computer running a small`,
    "team of bots that work for your business. They have their own machine, they remember what you",
    "tell them, and you can hand them real work.",
    "",
    "Open your workspace:",
    signInUrl,
    "",
    `That link signs you in. It works for the next ${linkHours} hours and it is only for you, so please`,
    withPassword
      ? `do not forward this note. After that, go to ${host} and sign in with:`
      : `do not forward this note. After that, go to ${host} and sign in with the address this note`,
    ...(withPassword
      ? ["", `Email: ${email}`, `Temporary password: ${password}`, "", "Write to us when you want that password changed."]
      : ["was sent to."]),
    "",
    "Meet Titan",
    "Titan is the bot that leads the others. Say hello and tell him about your business. He will ask",
    "a few short questions, then show you what he can take off your hands. It takes about a minute.",
    "",
    ...(withBotMail
      ? [
        "Your bots have their own email",
        `Every bot on your workspace has a real email address. Titan's is ${titanAddress}. Write to him`,
        "from your own mail and he will answer. The rest are on the Mail page inside your workspace.",
        "",
      ]
      : []),
    "Need help?",
    `Write to ${supportAddress} and a person will answer.`,
    "",
    "Titanium Bot",
    "You are getting this because a workspace was set up for you.",
  ].join("\n");

  // ---- the header band: the Ti tile and the wordmark, drawn -------------------------------------
  const mark = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;border:2px solid ${TITANIUM};border-radius:9px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;line-height:17px;color:${TITANIUM};">T<span style="color:${CYAN};">i</span></td>
            <td style="padding-left:10px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;line-height:18px;color:${TITANIUM};letter-spacing:.2px;">Titanium<span style="color:${CYAN};"> Bot</span></td>
          </tr></table>`;

  // ---- the sign-in block, which is where the two shapes differ and nowhere else -----------------
  const afterButton = withPassword
    ? `That button signs you in. It works for the next ${linkHours} hours and it is only for you, so please do not `
      + `forward this note. After that, go to <a href="${esc(consoleUrl)}" style="color:${INK};font-weight:bold;">${esc(host)}</a> and sign in with:`
    : `That button signs you in. It works for the next ${linkHours} hours and it is only for you, so please do not `
      + `forward this note. After that, go to <a href="${esc(consoleUrl)}" style="color:${INK};font-weight:bold;">${esc(host)}</a> `
      + "and sign in with the address this note was sent to.";

  // The whole row comes out, heading included, when there is no address to name.
  const botMail = withBotMail
    ? `<tr><td class="pad" style="padding:20px 32px 0;">
        <h2 class="ink" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:22px;font-weight:bold;color:${INK};">Your bots have their own email</h2>
        <p class="ink" style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${INK};">Every bot on your workspace has a real email address. Titan's is <a href="mailto:${esc(titanAddress)}" style="color:${INK};font-weight:bold;">${esc(titanAddress)}</a>. Write to him from your own mail and he will answer. The rest are on the Mail page inside your workspace.</p>
      </td></tr>`
    : "";

  const credentials = withPassword
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="panel" bgcolor="${CLOUD}" style="background:${CLOUD};border:1px solid ${LINE};border-radius:10px;margin-top:14px;">
          <tr><td style="padding:14px 16px;">
            <p class="quiet" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${QUIET};">Email</p>
            <p class="code" style="margin:2px 0 0;font-family:Consolas,Menlo,Courier,monospace;font-size:14px;line-height:20px;color:${INK};">${esc(email)}</p>
            <p class="quiet" style="margin:10px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${QUIET};">Temporary password</p>
            <p class="code" style="margin:2px 0 0;font-family:Consolas,Menlo,Courier,monospace;font-size:14px;line-height:20px;color:${INK};">${esc(password)}</p>
          </td></tr>
        </table>
        <p class="quiet" style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:${QUIET};">Write to us when you want that password changed.</p>`
    : "";

  const html = `<!doctype html>
<html lang="en" style="margin:0;padding:0;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(WELCOME_SUBJECT)}</title>
<style>
  /* Every rule that matters is inline as well. This block is the extra, not the floor: Gmail does
     not read it at all. */
  @media (prefers-color-scheme: dark) {
    .ground { background:${MIDNIGHT} !important; }
    .card { background:${GRAPHITE} !important; border-color:${DARK_EDGE} !important; }
    .ink, .ink a { color:${TITANIUM} !important; }
    .quiet, .quiet a, .quiet strong { color:${DARK_QUIET} !important; }
    .panel { background:${DARK_PANEL} !important; border-color:${DARK_EDGE} !important; }
    .code { color:${TITANIUM} !important; }
    .rule { border-color:${DARK_EDGE} !important; }
  }
  @media (max-width:620px) {
    .card { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
  }
</style>
</head>
<body class="ground" style="margin:0;padding:0;background:${CLOUD};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Sign in, say hello to Titan, and tell him about your business.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ground" style="background:${CLOUD};">
  <tr><td align="center" style="padding:28px 12px 40px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="card" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid ${LINE};border-radius:14px;">
      <tr><td class="pad" align="left" bgcolor="${MIDNIGHT}" style="padding:20px 32px;background:${MIDNIGHT};border-radius:13px 13px 0 0;">
          ${mark}
      </td></tr>
      <tr><td class="pad" style="padding:30px 32px 0;">
        <h1 class="ink" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:23px;line-height:30px;font-weight:bold;color:${INK};">Hi ${esc(who)},</h1>
        <p class="ink" style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${INK};">Your Titanium Bot workspace for ${esc(business)} is ready. It is a private computer running a small team of bots that work for your business. They have their own machine, they remember what you tell them, and you can hand them real work.</p>
      </td></tr>
      <tr><td class="pad" style="padding:22px 32px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="${CYAN}" style="background:${CYAN};border-radius:8px;">
            <a href="${esc(signInUrl)}" style="display:inline-block;padding:14px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:18px;color:${MIDNIGHT};text-decoration:none;">Open your workspace</a>
          </td>
        </tr></table>
        <p class="quiet" style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:${QUIET};">${afterButton}</p>
        ${credentials}
      </td></tr>
      <tr><td class="pad" style="padding:24px 32px 0;"><div class="rule" style="border-top:1px solid ${LINE};height:1px;line-height:1px;">&nbsp;</div></td></tr>
      <tr><td class="pad" style="padding:20px 32px 0;">
        <h2 class="ink" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:22px;font-weight:bold;color:${INK};">Meet Titan</h2>
        <p class="ink" style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${INK};">Titan is the bot that leads the others. Say hello and tell him about your business. He will ask a few short questions, then show you what he can take off your hands. It takes about a minute.</p>
      </td></tr>
      ${botMail}
      <tr><td class="pad" style="padding:20px 32px 0;">
        <h2 class="ink" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:22px;font-weight:bold;color:${INK};">Need help?</h2>
        <p class="ink" style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${INK};">Write to <a href="mailto:${esc(supportAddress)}" style="color:${INK};font-weight:bold;">${esc(supportAddress)}</a> and a person will answer.</p>
      </td></tr>
      <tr><td class="pad" style="padding:26px 32px 30px;">
        <p class="quiet" style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;color:${QUIET};">Titanium Bot<br>You are getting this because a workspace was set up for you.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject: WELCOME_SUBJECT, html, text };
}

/**
 * The welcome, over a store, a config and the relay.
 *
 * Four methods and every one of them refuses rather than throws, because each is a step in a job
 * whose card shows a sentence and offers one thing to press.
 */
export function createWelcome({
  store,
  config,
  fetchImpl = globalThis.fetch,
  // async (pathname, body) -> {ok: true, body} | {ok: false, why, status}. cp/admin.mjs's own
  // askRelayPost has exactly this shape and passes itself in; the default below is the same call so
  // this file works from the CLI and from a job with nothing wired.
  askRelayPost = null,
  now = () => Date.now(),
  relayTimeoutMs = 20_000,
} = {}) {
  const relayBase = String(config?.relayUrl ?? "").replace(/\/+$/, "");

  const postToRelay = askRelayPost ?? (async (pathname, body) => {
    if (relayBase.length === 0 || String(config?.relayToken ?? "").length === 0) {
      return { ok: false, why: "this control plane has no relay configured (CP_RELAY_URL and CP_RELAY_TOKEN), and only the relay holds the mail key" };
    }
    try {
      const response = await fetchImpl(`${relayBase}${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.relayToken}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(relayTimeoutMs),
      });
      const text = await response.text();
      let parsed = null;
      if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
      if (!response.ok) {
        const said = typeof parsed?.message === "string" ? parsed.message.split("\n")[0].slice(0, 200) : "";
        return { ok: false, status: response.status, why: `the relay answered ${response.status}${said.length > 0 ? `: ${said}` : ""}` };
      }
      return { ok: true, status: response.status, body: parsed ?? {} };
    } catch (error) {
      return { ok: false, why: error?.name === "TimeoutError" ? "the relay did not answer in time" : `the relay did not answer (${String(error?.message ?? error)})` };
    }
  });

  /** The address a reply goes to, and the address the copy tells the customer to write to. */
  const supportAddress = () => {
    const asked = oneAddress(store?.getSetting?.(WELCOME_REPLY_TO_SETTING, "") ?? "");
    return asked.length > 0 ? asked : WELCOME_REPLY_TO_DEFAULT;
  };

  /**
   * A sign-in link for one account on one workspace, good for 24 hours and not one-time.
   *
   * It is ui/session-token.mjs's ordinary session token, minted with that tenant's DERIVED key, and
   * the relay already consumes it at GET /login?sso=<token> (ui/server.mjs handleSso, verified by
   * ssoVerdict against the same derivation). So nothing new is signed and ui/session-token.mjs is
   * not edited: all seven required claims are present on the rows this wave creates.
   *
   * WHAT THIS HANDS OUT. An unrevocable bearer credential in a URL. It works as many times as it is
   * clicked until exp, the relay never checks a revocation list, and the only cancel is rotating
   * CP_SESSION_SECRET, which signs the whole fleet out. Hence the 24 hour ceiling, hence click
   * tracking off for titanium.bot so a scanner does not fetch it, and hence the rule that it is
   * returned to the caller once and written nowhere.
   */
  function mintSignInLink({ account = null, tenant = null, at = now(), ttlMs = WELCOME_LINK_TTL_MS } = {}) {
    const secret = String(config?.sessionSecret ?? "");
    if (secret.length === 0) return { ok: false, why: WELCOME_NO_SECRET };
    if (tenant == null || String(tenant.slug ?? "").length === 0) return { ok: false, why: WELCOME_NO_TENANT };
    if (account == null || String(account.id ?? "").length === 0 || String(account.email ?? "").length === 0) {
      return { ok: false, why: WELCOME_NO_ACCOUNT };
    }
    const host = String(tenant.host ?? "").trim();
    if (host.length === 0) return { ok: false, why: WELCOME_NO_HOST };

    const iat = Number(at);
    const exp = iat + Math.max(60_000, Number(ttlMs) || WELCOME_LINK_TTL_MS);
    let token;
    try {
      token = mintSessionToken({
        sub: String(account.id),
        email: String(account.email),
        tenant: String(tenant.slug),
        host,
        iat,
        exp,
        jti: randomUUID(),
      }, tenantSessionSecret(secret, String(tenant.slug)), iat).token;
    } catch (error) {
      return { ok: false, why: `that sign-in link could not be made (${String(error?.message ?? error)})` };
    }
    return {
      ok: true,
      url: `https://${host}/login?sso=${token}`,
      expiresAt: new Date(exp).toISOString(),
      expiresAtMs: exp,
      // The relay caps the cookie it sets from this link at its own session lifetime, so a customer
      // arriving on hour 23 gets a session that lasts this long and not one minute of the link's
      // remainder. Reported so a card can say it rather than a reader having to know it.
      sessionTtlMs: SESSION_TTL_MS,
    };
  }

  /**
   * The words, refusing anything that would put a secret in the wrong shape or promise a thing that
   * is not there.
   */
  function render({
    firstName = "",
    company = "",
    email = "",
    host = "",
    signInUrl = "",
    temporaryPassword = "",
    titanAddress = "",
    shape = "link+password",
    support = "",
  } = {}) {
    const wanted = WELCOME_SHAPES.has(shape) ? shape : "link+password";
    const link = String(signInUrl ?? "").trim();
    if (link.length === 0) return { ok: false, why: WELCOME_NO_LINK };
    const titan = oneAddress(titanAddress);
    // Only the shapes that PROMISE an address need one. A `-no-bot-mail` shape leaves the whole
    // section out, so there is nothing to be wrong about, and the password still goes.
    if (titan.length === 0 && shapePromisesBotMail(wanted)) return { ok: false, why: WELCOME_NO_TITAN_ADDRESS };
    // A password-less shape carrying a password is a code path drifting, not a caller being helpful.
    // It is refused rather than quietly dropped so the drift is found the first time it happens.
    if (!shapeCarriesPassword(wanted) && String(temporaryPassword ?? "").length > 0) {
      return { ok: false, why: WELCOME_LINK_SHAPE_WITH_PASSWORD };
    }
    const mail = renderWelcome({
      firstName: firstNameOf(firstName, email),
      company,
      email,
      host: String(host ?? "").trim() || String(config?.consoleHost ?? "console.titanium.bot"),
      signInUrl: link,
      temporaryPassword: shapeCarriesPassword(wanted) ? String(temporaryPassword ?? "") : "",
      titanAddress: titan,
      supportAddress: String(support ?? "").trim() || supportAddress(),
      shape: wanted,
    });
    return { ok: true, shape: wanted, ...mail };
  }

  /**
   * Render, post to the relay, write the row, and hand the sign-in link back ONCE.
   *
   * The row carries who, whom, when, the outcome and the provider's id. It carries no password, no
   * link, no subject and no body, which is why it is its own table and not mail_send_log: see
   * cp/store.mjs recordWelcomeSend and docs/MAIL.md's split.
   */
  async function send({
    slug,
    email = "",
    name = "",
    company = "",
    host = "",
    to = "",
    temporaryPassword = "",
    titanAddress = "",
    actor = "",
    shape = "",
    account = null,
    tenant = null,
    at = now(),
  } = {}) {
    const workspace = String(slug ?? "").trim();
    const owner = String(email ?? "").trim();
    const recipient = String(to ?? "").trim().length > 0 ? String(to).trim() : owner;
    if (recipient.length === 0) return { ok: false, sent: false, why: WELCOME_NO_RECIPIENT };
    const one = oneAddress(recipient);
    if (one.length === 0) return { ok: false, sent: false, why: WELCOME_BAD_RECIPIENT };
    // An override is the operator deliberately sending a customer's welcome somewhere else, which is
    // what the R750 measurement does. It is an OVERRIDE and never a copy: a bcc would put a live
    // sign-in link and a password for somebody's workspace in a third party's inbox until the link
    // expires, and the link is a bearer with no revocation.
    const override = one.toLowerCase() !== owner.toLowerCase() ? owner : "";

    const row = tenant ?? store.getTenant(workspace);
    const person = account ?? (owner.length > 0 ? store.getAccountByEmail(owner) : null);
    // THE SHAPE IS DERIVED FROM WHAT THERE ACTUALLY IS, unless the caller named one. The password
    // axis comes from whether a password was handed in; the bot-mail axis from whether there is an
    // address to name. A caller that names a shape gets exactly that shape and the refusals that go
    // with it, which is what keeps "promise an address that exists" enforceable.
    const wanted = WELCOME_SHAPES.has(shape)
      ? shape
      : `${String(temporaryPassword ?? "").length > 0 ? "link+password" : "link"}`
        + `${oneAddress(titanAddress).length === 0 ? "-no-bot-mail" : ""}`;

    const link = mintSignInLink({ account: person, tenant: row, at });
    if (!link.ok) return { ok: false, sent: false, shape: wanted, to: one, override, why: link.why };

    const mail = render({
      firstName: name,
      company: company || String(row?.name ?? ""),
      email: owner,
      host: host || String(row?.host ?? ""),
      signInUrl: link.url,
      temporaryPassword,
      titanAddress,
      shape: wanted,
    });
    if (!mail.ok) return { ok: false, sent: false, shape: wanted, to: one, override, why: mail.why };

    const answer = await postToRelay(PRODUCT_MAIL_ROUTE, {
      kind: "welcome",
      slug: workspace,
      to: one,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      replyTo: supportAddress(),
      // The key is stamped BEFORE the send, on purpose: two presses inside the same window have to
      // collide on it, so it cannot move with the provider's answer.
      idempotencyKey: welcomeIdempotencyKey({ slug: workspace, to: one, at }),
    });

    // THE ROW'S TIME IS WHEN THE PROVIDER ANSWERED and not when this function started. The R750 run
    // on 2026-09-10 stamped 21:40:45.880Z while the relay's own line for the same send reads
    // 21:40:46.194Z: 313 ms of render and one HTTP round trip, reported as the moment the mail left.
    // A time on a receipt that predates the thing it is a receipt for is the kind of number nobody
    // notices until they are matching it against a provider's log.
    const when = new Date(now()).toISOString();
    if (!answer.ok) {
      // The PROVIDER'S OWN WORDS go in the row's detail, because an operator reading this table
      // wants them. They are a status and a sentence the relay wrote, never a body and never the
      // html, and the relay's own route is what keeps a provider body out of this string.
      store.recordWelcomeSend({
        tenant: workspace, email: one, insteadOf: override, at: when, actor,
        outcome: "failed", resendId: "", shape: wanted, detail: String(answer.why ?? "").slice(0, 300),
      });
      return { ok: false, sent: false, shape: wanted, to: one, override, at: when, why: String(answer.why ?? "the relay did not send it") };
    }

    const resendId = String(answer.body?.id ?? "");
    store.recordWelcomeSend({
      tenant: workspace, email: one, insteadOf: override, at: when, actor,
      outcome: "sent", resendId, shape: wanted, detail: String(answer.body?.replyToWhy ?? ""),
    });
    return {
      ok: true,
      sent: true,
      resendId,
      at: when,
      shape: wanted,
      to: one,
      override,
      // ONCE, to this caller, and written nowhere. It is here so the card can offer "Copy a sign-in
      // link" for a customer whose mail bounced without ever minting a second one.
      signInUrl: link.url,
      expiresAt: link.expiresAt,
      from: String(answer.body?.from ?? ""),
      why: "",
    };
  }

  /**
   * What the mail looks like, with the link and the password blanked, sending nothing.
   *
   * This is what a gate screenshots and what an operator can look at before pressing send. The real
   * mail's HTML is never written to disk anywhere in this product.
   */
  function preview({ slug = "", email = "", name = "", company = "", host = "", titanAddress = "", shape = "link+password" } = {}) {
    const row = slug.length > 0 ? store?.getTenant?.(slug) ?? null : null;
    const mail = renderWelcome({
      firstName: firstNameOf(name, email || "jane@example.com"),
      company: company || String(row?.name ?? "") || "your business",
      email: email || "jane@example.com",
      host: host || String(row?.host ?? "") || String(config?.consoleHost ?? "console.titanium.bot"),
      // Blanked rather than omitted, so the preview has the same shape, the same line count and the
      // same contrast as the real thing.
      signInUrl: "https://console.titanium.bot/login?sso=REDACTED",
      temporaryPassword: shapeCarriesPassword(shape) ? "REDACTED" : "",
      // A preview of a shape that promises an address shows one, so the section is on the screen
      // with the right line count. A `-no-bot-mail` preview shows the mail with that section out,
      // which is the point of looking at it.
      titanAddress: shapePromisesBotMail(shape) ? (oneAddress(titanAddress) || "agent000000@myagents.email") : "",
      supportAddress: supportAddress(),
      shape: WELCOME_SHAPES.has(shape) ? shape : "link+password",
    });
    return { ok: true, shape, ...mail };
  }

  return { mintSignInLink, render, send, preview, supportAddress, idempotencyKey: welcomeIdempotencyKey };
}
