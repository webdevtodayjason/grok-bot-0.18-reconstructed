// ONBOARD-2. The welcome mail the product sends a new customer: the link, the words, the send, the row.
//
// Jason, 2026-09-10 10:54: "Is the welcome email sent out? What does that look like?" It was not.
// The only real onboarding this product has ever done, Richard's on 2026-09-07, had its welcome sent
// by a script somebody ran by hand on the server, and that script is not anywhere on it any more.
//
// TWO THINGS THIS FILE IS REALLY ABOUT, and both are about what must never end up somewhere.
//
// The sign-in link is an UNREVOCABLE BEARER CREDENTIAL IN A URL. The relay verifies the signature and
// the expiry and checks no revocation list, so the link works as many times as it is clicked until it
// expires and the only cancel is rotating CP_SESSION_SECRET, which signs the whole fleet out. So the
// tests below hold it to a 24 hour ceiling, prove it opens exactly one workspace and no other, and
// prove it is in the answer to the caller and in NO row.
//
// The temporary password is shown once on the card and stored as a scrypt hash nobody can ask back.
// So the tests hold the 'link' shape -- a second welcome -- to carrying no password at all, and hold
// the row to carrying neither it nor the link nor the body.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_MAIL_ROUTE,
  WELCOME_BAD_RECIPIENT,
  WELCOME_LINK_SHAPE_WITH_PASSWORD,
  WELCOME_LINK_TTL_MS,
  WELCOME_NO_ACCOUNT,
  WELCOME_NO_HOST,
  WELCOME_NO_LINK,
  WELCOME_NO_RECIPIENT,
  WELCOME_NO_SECRET,
  WELCOME_NO_TENANT,
  WELCOME_NO_TITAN_ADDRESS,
  WELCOME_REPLY_TO_DEFAULT,
  WELCOME_REPLY_TO_SETTING,
  WELCOME_SUBJECT,
  createWelcome,
  firstNameOf,
  renderWelcome,
  welcomeIdempotencyKey,
} from "../cp/welcome.mjs";
import { openStore } from "../cp/store.mjs";
import { tenantSessionSecret, verifySessionToken } from "../cp/session.mjs";
import { ssoVerdict } from "../ui/tenant-login.mjs";
import { makeTempRoot } from "./cp-support.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTER = "a-master-session-secret-long-enough-to-pass-32";
const TITAN = "agent247758@myagents.email";
const PASSWORD = "k3Rr8xQ2mD7vLpNf4sZt";
const AT = Date.parse("2026-09-10T12:00:00.000Z");

const CONFIG = {
  sessionSecret: MASTER,
  relayUrl: "http://titanbot-relay:7777",
  relayToken: "a-relay-token-long-enough-to-be-real-enough",
  consoleHost: "console.titanium.bot",
};

/**
 * A store with one real tenant and one real account on it, and a relay recorded rather than called.
 *
 * `posted` is every body that reached the relay, which is how a case asserts that a refusal sent
 * NOTHING: a welcome that answered the right sentence after the mail went is not a refusal.
 */
async function withWelcome(run, { relay = null, settings = {}, now = () => AT } = {}) {
  const root = await makeTempRoot("cp-welcome-");
  const store = openStore({ dataDir: root });
  const posted = [];
  try {
    store.createTenant({ slug: "acme-roofing", name: "Acme Roofing", host: "console.titanium.bot", status: "running", ownerEmail: "jane@acmeroofing.com" });
    store.createTenant({ slug: "other-co", name: "Other Co", host: "console.titanium.bot", status: "running", ownerEmail: "sam@other.example" });
    const account = store.createAccount({ email: "jane@acmeroofing.com", password: PASSWORD, name: "Jane Doe", tenant: "acme-roofing" });
    for (const [name, value] of Object.entries(settings)) store.setSetting(name, value, "a-test");
    const welcome = createWelcome({
      store,
      config: CONFIG,
      now,
      askRelayPost: async (pathname, body) => {
        posted.push({ pathname, body });
        return relay == null ? { ok: true, body: { id: "re_0123456789", from: "Titanium Bot <welcome@titanium.bot>" } } : relay(pathname, body);
      },
    });
    await run({ store, welcome, account, posted, root });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

// ---- the sign-in link --------------------------------------------------------------------------

test("the link is that workspace's own session token, signed with that workspace's own key, for 24 hours", async () => {
  await withWelcome(async ({ store, welcome, account }) => {
    const tenant = store.getTenant("acme-roofing");
    const link = welcome.mintSignInLink({ account, tenant, at: AT });
    assert.equal(link.ok, true, link.why);
    assert.equal(link.url.startsWith("https://console.titanium.bot/login?sso="), true, link.url);

    const token = new URL(link.url).searchParams.get("sso");
    const verdict = verifySessionToken(token, tenantSessionSecret(MASTER, "acme-roofing"), AT);
    assert.equal(verdict.ok, true, verdict.reason);

    // All seven required claims, because ui/session-token.mjs refuses a token missing any of them and
    // the whole reason this wave does not edit that file is that the rows it creates already carry
    // every one.
    for (const claim of ["sub", "email", "tenant", "host", "iat", "exp", "jti"]) {
      assert.ok(String(verdict.payload[claim] ?? "").length > 0, `the ${claim} claim is on the token`);
    }
    assert.equal(verdict.payload.sub, account.id);
    assert.equal(verdict.payload.email, "jane@acmeroofing.com");
    assert.equal(verdict.payload.tenant, "acme-roofing");
    assert.equal(verdict.payload.host, "console.titanium.bot");

    // Twenty four hours to the millisecond, and a CEILING rather than a target: this is an
    // unrevocable bearer and the only cancel is rotating the master, which signs the fleet out.
    assert.equal(verdict.payload.iat, AT);
    assert.equal(verdict.payload.exp, AT + WELCOME_LINK_TTL_MS);
    assert.equal(WELCOME_LINK_TTL_MS, 24 * 60 * 60 * 1000);
    assert.equal(link.expiresAt, new Date(AT + WELCOME_LINK_TTL_MS).toISOString());
  });
});

test("the relay's own sso door accepts that link, and refuses the same token under another workspace's key", async () => {
  await withWelcome(async ({ store, welcome, account }) => {
    const link = welcome.mintSignInLink({ account, tenant: store.getTenant("acme-roofing"), at: AT });
    const token = new URL(link.url).searchParams.get("sso");

    // The real verdict function ui/server.mjs handleSso calls, with the real derivation.
    const good = ssoVerdict({ token, keyOf: (slug) => tenantSessionSecret(MASTER, slug), now: AT + 1000 });
    assert.equal(good.kind, "session");
    assert.equal(good.payload.tenant, "acme-roofing");

    // A console that hands back ONE tenant's key for every name: the signature is the thing that
    // proves the workspace, so this has to fail, and failing is what stops a link for one customer
    // opening another customer's box.
    // ssoVerdict answers "bad" for every way a LINK can fail, which is not the same word the password
    // door uses: a link that does not verify is not a person who mistyped a password, and there is
    // nothing useful to tell whoever is holding it about which of the three reasons it was.
    const wrong = ssoVerdict({ token, keyOf: () => tenantSessionSecret(MASTER, "other-co"), now: AT + 1000 });
    assert.equal(wrong.kind, "bad", JSON.stringify(wrong));

    // And it is dead once it expires, which is the only thing that ever cancels it.
    const late = ssoVerdict({ token, keyOf: (slug) => tenantSessionSecret(MASTER, slug), now: AT + WELCOME_LINK_TTL_MS + 1 });
    assert.equal(late.kind, "bad");
    // One millisecond before, it still works, which is what pins the ceiling to exactly 24 hours.
    const justInTime = ssoVerdict({ token, keyOf: (slug) => tenantSessionSecret(MASTER, slug), now: AT + WELCOME_LINK_TTL_MS - 1 });
    assert.equal(justInTime.kind, "session");
  });
});

test("a link cannot be minted without a secret, a workspace, an account or a host, and says which", async () => {
  await withWelcome(async ({ store, welcome, account }) => {
    const tenant = store.getTenant("acme-roofing");
    assert.equal(welcome.mintSignInLink({ account, tenant: null, at: AT }).why, WELCOME_NO_TENANT);
    assert.equal(welcome.mintSignInLink({ account: null, tenant, at: AT }).why, WELCOME_NO_ACCOUNT);
    assert.equal(welcome.mintSignInLink({ account, tenant: { ...tenant, host: "" }, at: AT }).why, WELCOME_NO_HOST);
    const blind = createWelcome({ store, config: { ...CONFIG, sessionSecret: "" }, now: () => AT });
    assert.equal(blind.mintSignInLink({ account, tenant, at: AT }).why, WELCOME_NO_SECRET);
  });
});

// ---- the words ----------------------------------------------------------------------------------

const rendered = (overrides = {}) => renderWelcome({
  firstName: "Jane",
  company: "Acme Roofing",
  email: "jane@acmeroofing.com",
  host: "console.titanium.bot",
  signInUrl: "https://console.titanium.bot/login?sso=v1.payload.signature",
  temporaryPassword: PASSWORD,
  titanAddress: TITAN,
  supportAddress: WELCOME_REPLY_TO_DEFAULT,
  ...overrides,
});

test("an invite carries the button and the password, and the password is in the plain text too", () => {
  const mail = rendered();
  assert.equal(mail.subject, WELCOME_SUBJECT);
  assert.equal(mail.subject, "Your Titanium Bot workspace is ready");

  // The button, with the link on it and nothing else on it.
  assert.match(mail.html, /href="https:\/\/console\.titanium\.bot\/login\?sso=v1\.payload\.signature"/);
  assert.match(mail.html, />Open your workspace</);

  // Both halves ship, which is the design's own decision and not a hedge: there is no
  // customer-facing set-your-own-password door in the product yet (ONBOARD-3), so a link-only mail
  // locks a customer out at hour 25 with the operator as the only recovery.
  assert.ok(mail.html.includes("Temporary password"), "the card's second line names the password");
  assert.ok(mail.html.includes(PASSWORD), "and carries it");
  assert.ok(mail.text.includes(`Temporary password: ${PASSWORD}`), "a text-only client gets it as well");
  assert.ok(mail.text.includes("Email: jane@acmeroofing.com"));

  // Titan's own address, by name, because the mail promises the customer can write to him.
  assert.ok(mail.html.includes(TITAN));
  assert.ok(mail.text.includes(TITAN));
  // And the support address, in words, whatever a mail client does with a Reply-To header.
  assert.ok(mail.html.includes(WELCOME_REPLY_TO_DEFAULT));
  assert.ok(mail.text.includes(WELCOME_REPLY_TO_DEFAULT));
});

test("a second welcome carries no password, and the words 'Temporary password' are nowhere in it", () => {
  const mail = rendered({ shape: "link", temporaryPassword: PASSWORD });
  assert.equal(mail.html.includes("Temporary password"), false);
  assert.equal(mail.text.includes("Temporary password"), false);
  assert.equal(mail.html.includes(PASSWORD), false, "a password in a second welcome is a code path drifting");
  assert.equal(mail.text.includes(PASSWORD), false);
  // It still signs them in, which is the whole point of sending a second one.
  assert.match(mail.html, /href="https:\/\/console\.titanium\.bot\/login\?sso=/);
});

test("the plain text alternative is hand written rather than stripped out of the page", () => {
  const mail = rendered();
  assert.ok(mail.text.length > 400, `the text alternative is ${mail.text.length} characters`);
  // A stripped table layout reads as a wall of nothing, and a tag that survived the stripping is the
  // tell. This is what a text-only client, a screen reader on a phone and a spam filter all see.
  assert.equal(/<[a-z!/]/i.test(mail.text), false, "no markup leaked into the text half");
  assert.equal(mail.text.includes("&nbsp;"), false);
  assert.equal(mail.text.includes("&amp;"), false);
  assert.match(mail.text, /^Hi Jane,/);
  for (const heading of ["Meet Titan", "Your bots have their own email", "Need help?"]) {
    assert.ok(mail.text.includes(heading), `${heading} is in the text half`);
  }
});

test("the mark is drawn rather than fetched: no image and no svg anywhere in the page", () => {
  const mail = rendered();
  assert.equal(/<img\b/i.test(mail.html), false, "a data URI image is stripped by Gmail and a hosted one needs a host");
  assert.equal(/<svg\b/i.test(mail.html), false, "svg is dropped by every major mail client");
  assert.ok(mail.html.includes("Titanium"), "the wordmark is text");
  // The brand's own two colours, which is what makes this recognisable with images off.
  assert.ok(mail.html.includes("#00C8F0"), "Signal Cyan");
  assert.ok(mail.html.includes("#090D14"), "Midnight");
});

test("no em dash anywhere a customer reads, and the copy names no vendor", () => {
  for (const shape of ["link+password", "link", "link+password-no-bot-mail", "link-no-bot-mail"]) {
    const mail = rendered({ shape, temporaryPassword: shape.startsWith("link+password") ? PASSWORD : "" });
    assert.equal(mail.html.includes("—"), false, `an em dash in the ${shape} page`);
    assert.equal(mail.text.includes("—"), false, `an em dash in the ${shape} text`);
    for (const vendor of ["Resend", "Coolify", "Docker", "docker", "xAI", "Anthropic"]) {
      assert.equal(mail.text.includes(vendor), false, `${vendor} is named in the copy`);
    }
  }
});

test("the first name comes from the name, then the address, and is never empty", () => {
  assert.equal(firstNameOf("Jane Doe", "x@y.example"), "Jane");
  assert.equal(firstNameOf("", "jane@y.example"), "jane");
  assert.equal(firstNameOf("", ""), "there");
  assert.equal(firstNameOf("   ", "   "), "there");
});

// ---- render's refusals --------------------------------------------------------------------------

test("render refuses a missing link, a missing Titan address, and a second welcome carrying a password", async () => {
  await withWelcome(async ({ welcome }) => {
    const base = { firstName: "Jane", company: "Acme Roofing", email: "jane@acmeroofing.com", host: "console.titanium.bot", titanAddress: TITAN };
    assert.equal(welcome.render({ ...base, signInUrl: "" }).why, WELCOME_NO_LINK);
    // A promise the product cannot keep is worse than a missing sentence: the mail tells the customer
    // Titan's address outright.
    assert.equal(welcome.render({ ...base, signInUrl: "https://x/login?sso=t", titanAddress: "" }).why, WELCOME_NO_TITAN_ADDRESS);
    assert.equal(welcome.render({ ...base, signInUrl: "https://x/login?sso=t", titanAddress: "not-an-address" }).why, WELCOME_NO_TITAN_ADDRESS);
    assert.equal(
      welcome.render({ ...base, signInUrl: "https://x/login?sso=t", shape: "link", temporaryPassword: PASSWORD }).why,
      WELCOME_LINK_SHAPE_WITH_PASSWORD);
  });
});

// ---- the send, and the row --------------------------------------------------------------------

test("a send reaches the relay's product door with the words and no sender, and the row is a receipt", async () => {
  await withWelcome(async ({ store, welcome, posted }) => {
    const answer = await welcome.send({
      slug: "acme-roofing", email: "jane@acmeroofing.com", name: "Jane Doe", company: "Acme Roofing",
      temporaryPassword: PASSWORD, titanAddress: TITAN, actor: "super@titanium.bot",
    });
    assert.equal(answer.ok, true, answer.why);
    assert.equal(answer.sent, true);
    assert.equal(answer.resendId, "re_0123456789");
    assert.equal(answer.shape, "link+password");
    assert.equal(answer.to, "jane@acmeroofing.com");
    assert.equal(answer.override, "");

    // THE LINK COMES BACK TO THIS CALLER ONCE. That is what lets the card offer "Copy a sign-in link"
    // for a customer whose mail bounced without minting a second one.
    assert.match(answer.signInUrl, /^https:\/\/console\.titanium\.bot\/login\?sso=v1\./);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].pathname, PRODUCT_MAIL_ROUTE);
    assert.equal(posted[0].pathname, "/mail/product");
    const body = posted[0].body;
    assert.equal(body.kind, "welcome");
    assert.equal(body.slug, "acme-roofing");
    assert.equal(body.to, "jane@acmeroofing.com");
    assert.equal(body.subject, WELCOME_SUBJECT);
    // THE CONTROL PLANE SENDS WORDS AND NEVER A SENDER. The relay decides the From, so a wrong value
    // upstream can never make this product send as somebody's personal address.
    for (const field of ["from", "sender", "cc", "bcc", "headers"]) {
      assert.equal(body[field], undefined, `a product send must not carry ${field}`);
    }
    assert.equal(body.replyTo, WELCOME_REPLY_TO_DEFAULT);
    assert.equal(body.idempotencyKey, welcomeIdempotencyKey({ slug: "acme-roofing", to: "jane@acmeroofing.com", at: AT }));

    // THE BUTTON IN THE MAIL THAT WENT CARRIES THE TOKEN THAT WORKS. The two halves are asserted
    // separately above -- a link that verifies, and a page with a button on it -- and this is the
    // join: the href in the html the relay was handed is byte for byte the link this call minted,
    // and the token inside that href signs in on this workspace and no other. Without this a
    // rendering bug could ship a beautiful mail whose button opens nothing.
    const href = /href="(https:\/\/[^"]*\/login\?sso=[^"]+)"/.exec(String(body.html))?.[1];
    assert.equal(href, answer.signInUrl);
    const mailed = new URL(href).searchParams.get("sso");
    const verdict = ssoVerdict({ token: mailed, keyOf: (slug) => tenantSessionSecret(MASTER, slug), now: AT + 1000 });
    assert.equal(verdict.kind, "session");
    assert.equal(verdict.payload.tenant, "acme-roofing");
    assert.equal(verdict.payload.email, "jane@acmeroofing.com");
    // And the words are in the page that went, not only in a render this test made for itself.
    assert.ok(String(body.html).includes(PASSWORD));
    assert.ok(String(body.text).includes(`Temporary password: ${PASSWORD}`));
    assert.ok(String(body.html).includes(TITAN));

    // THE ROW. Who, whom, when, the outcome and the provider's id, and nothing else at all.
    const rows = store.listWelcomeSends("acme-roofing");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "sent");
    assert.equal(rows[0].resendId, "re_0123456789");
    assert.equal(rows[0].email, "jane@acmeroofing.com");
    assert.equal(rows[0].insteadOf, "");
    assert.equal(rows[0].shape, "link+password");
    assert.equal(rows[0].actor, "super@titanium.bot");
    assert.equal(rows[0].at, AT);
    const serialized = JSON.stringify(rows[0]);
    assert.equal(serialized.includes(PASSWORD), false, "a row never holds the password");
    assert.equal(serialized.includes("sso="), false, "a row never holds the sign-in link");
    assert.equal(serialized.includes(WELCOME_SUBJECT), false, "a row never holds the subject");
    assert.equal(serialized.includes("<table"), false, "a row never holds the body");
  });
});

test("the row's columns are the nine a receipt needs and no tenth that could hold a secret", async () => {
  await withWelcome(async ({ store }) => {
    const columns = store.db.prepare("PRAGMA table_info(welcome_sends)").all().map((row) => String(row.name));
    assert.deepEqual(columns.sort(), [
      "actor", "at", "detail", "email", "id", "instead_of", "outcome", "resend_id", "shape", "tenant",
    ]);
    for (const never of ["subject", "body", "html", "text", "link", "url", "password", "token"]) {
      assert.equal(columns.includes(never), false, `welcome_sends must never have a ${never} column`);
    }
  });
});

test("a welcome sent somewhere else is an override on the row, never a copy to a second inbox", async () => {
  await withWelcome(async ({ store, welcome, posted }) => {
    const answer = await welcome.send({
      slug: "acme-roofing", email: "jane@acmeroofing.com", name: "Jane Doe",
      to: "operator@titaniumcomputing.com",
      temporaryPassword: PASSWORD, titanAddress: TITAN, actor: "super@titanium.bot",
    });
    assert.equal(answer.sent, true);
    assert.equal(answer.to, "operator@titaniumcomputing.com");
    // The owner's address is on the row as what this was sent INSTEAD OF, so the card can say it in
    // plain words. One recipient in the body: a bcc would put a live sign-in link and a password for
    // somebody's workspace in a third party's inbox until the link expired.
    assert.equal(answer.override, "jane@acmeroofing.com");
    assert.equal(store.listWelcomeSends("acme-roofing")[0].insteadOf, "jane@acmeroofing.com");
    assert.equal(posted[0].body.to, "operator@titaniumcomputing.com");
    assert.equal(posted[0].body.bcc, undefined);
    assert.equal(posted[0].body.cc, undefined);
  });
});

test("a send with no recipient, or a recipient that is not one address, sends nothing and says which", async () => {
  await withWelcome(async ({ welcome, posted, store }) => {
    const none = await welcome.send({ slug: "acme-roofing", email: "", titanAddress: TITAN });
    assert.equal(none.ok, false);
    assert.equal(none.why, WELCOME_NO_RECIPIENT);
    const two = await welcome.send({ slug: "acme-roofing", email: "jane@acmeroofing.com", to: "a@b.example, c@d.example", titanAddress: TITAN });
    assert.equal(two.ok, false);
    assert.equal(two.why, WELCOME_BAD_RECIPIENT);
    // A refusal that had already sent the mail is not a refusal, and neither is one that wrote a row.
    assert.equal(posted.length, 0);
    assert.equal(store.listWelcomeSends("acme-roofing").length, 0);
  });
});

test("a send with no Titan address still goes, with the bot-mail section left out and the password in", async () => {
  // THE CASE THE R750 ACTUALLY HIT on 2026-09-10: the sweep answered 200 and minted nothing. The old
  // behaviour refused the send, so the customer got no password and no link at all -- the one thing
  // the welcome exists to carry. It says less and it goes.
  await withWelcome(async ({ welcome, posted, store }) => {
    const answer = await welcome.send({
      slug: "acme-roofing", email: "jane@acmeroofing.com", name: "Jane Doe",
      temporaryPassword: PASSWORD, titanAddress: "",
    });
    assert.equal(answer.ok, true, answer.why);
    assert.equal(answer.shape, "link+password-no-bot-mail");
    assert.equal(posted.length, 1);
    const sent = posted[0].body;
    // The password and the link are in it, which is the part that cannot wait for a sweep.
    assert.equal(sent.html.includes(PASSWORD), true, "the temporary password ships");
    assert.match(sent.html, /\/login\?sso=/);
    // And nothing promises an address.
    assert.equal(sent.html.includes("Your bots have their own email"), false, "no heading over an empty line");
    assert.equal(sent.text.includes("Your bots have their own email"), false);
    assert.equal(sent.html.includes("myagents.email"), false, "and no bot address anywhere in it");
    assert.equal(sent.html.includes("Need help?"), true, "the rest of the mail is the same mail");
    // The row says which shape went, so an operator reading the panel knows this one said less.
    assert.equal(store.listWelcomeSends("acme-roofing")[0].shape, "link+password-no-bot-mail");
  });
});

test("a caller that NAMES a shape promising an address, and has none, is still refused", async () => {
  // The guard is kept for the shapes that promise. A caller asking for the full mail without an
  // address to put in it is a code path drifting, and it is refused before the relay.
  await withWelcome(async ({ welcome, posted }) => {
    for (const shape of ["link+password", "link"]) {
      const answer = await welcome.send({
        slug: "acme-roofing", email: "jane@acmeroofing.com", shape, titanAddress: "",
        ...(shape === "link+password" ? { temporaryPassword: PASSWORD } : {}),
      });
      assert.equal(answer.ok, false, shape);
      assert.equal(answer.why, WELCOME_NO_TITAN_ADDRESS);
    }
    assert.equal(posted.length, 0);
  });
});

test("a second welcome with no Titan address carries no password and still goes", async () => {
  await withWelcome(async ({ welcome, posted }) => {
    const answer = await welcome.send({ slug: "acme-roofing", email: "jane@acmeroofing.com", titanAddress: "" });
    assert.equal(answer.ok, true, answer.why);
    assert.equal(answer.shape, "link-no-bot-mail");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.html.includes("Temporary password"), false);
  });
});

test("the row's time is when the provider answered, not when the send started", async () => {
  // The R750 row read 21:40:45.880Z while the relay's own line for the same send reads 21:40:46.194Z.
  // A receipt stamped before the thing it is a receipt for is a number nobody notices until they are
  // matching it against a provider's log.
  let ticks = 0;
  const clock = () => AT + (ticks += 1) * 1000;
  await withWelcome(async ({ welcome, store }) => {
    const answer = await welcome.send({
      slug: "acme-roofing", email: "jane@acmeroofing.com", temporaryPassword: PASSWORD, titanAddress: TITAN, at: AT,
    });
    assert.equal(answer.ok, true, answer.why);
    assert.equal(Date.parse(answer.at) > AT, true, `the row is stamped at ${answer.at}, which is not after the send started`);
    // The store keeps the instant as milliseconds; the row and the answer are the same moment.
    assert.equal(Number(store.listWelcomeSends("acme-roofing")[0].at), Date.parse(answer.at));
    // And the idempotency key is still stamped at the START, so two presses inside the window collide.
    assert.equal(welcome.idempotencyKey({ slug: "acme-roofing", to: "jane@acmeroofing.com", at: AT }).length > 0, true);
  }, { now: clock });
});

test("a provider refusal writes a failed row carrying the status, and never the provider's body", async () => {
  await withWelcome(async ({ store, welcome }) => {
    const answer = await welcome.send({
      slug: "acme-roofing", email: "jane@acmeroofing.com", name: "Jane Doe",
      temporaryPassword: PASSWORD, titanAddress: TITAN, actor: "super@titanium.bot",
    });
    assert.equal(answer.ok, false);
    assert.equal(answer.sent, false);
    assert.match(answer.why, /422/);

    const rows = store.listWelcomeSends("acme-roofing");
    assert.equal(rows.length, 1, "a failure is still a row: an unsent mail is recoverable and an unlogged attempt is not");
    assert.equal(rows[0].outcome, "failed");
    assert.equal(rows[0].resendId, "");
    assert.match(rows[0].detail, /422/, "the status is what an operator acts on");
    assert.equal(rows[0].detail.includes("validation_error"), false, "a provider's own body never lands in a row");
    assert.equal(rows[0].detail.includes(PASSWORD), false);
  }, {
    // What the relay answers when Resend refuses the message: a status and a sentence the relay wrote,
    // and deliberately not the provider's own JSON. See ui/mail-edge.mjs createProductMailRoute.
    relay: async () => ({ ok: false, status: 502, why: "the relay answered 502: The mail service would not accept that message (HTTP 422), so nothing was sent. Check the address it was going to." }),
  });
});

test("a relay that cannot be reached at all is a failed row and a plain sentence", async () => {
  await withWelcome(async ({ store, welcome }) => {
    const answer = await welcome.send({ slug: "acme-roofing", email: "jane@acmeroofing.com", temporaryPassword: PASSWORD, titanAddress: TITAN });
    assert.equal(answer.ok, false);
    assert.match(answer.why, /did not answer/);
    assert.equal(store.listWelcomeSends("acme-roofing")[0].outcome, "failed");
  }, { relay: async () => ({ ok: false, why: "the relay did not answer in time" }) });
});

// ---- the reply-to setting, the key, and the preview --------------------------------------------

test("the reply address defaults to a domain that already receives, and one line moves it", async () => {
  await withWelcome(async ({ welcome }) => {
    // A reply address nobody reads is worse than one on the other brand: inbound mail is live on
    // titaniumcomputing.com and is not live on titanium.bot yet.
    assert.equal(welcome.supportAddress(), WELCOME_REPLY_TO_DEFAULT);
    assert.equal(WELCOME_REPLY_TO_DEFAULT, "support@titaniumcomputing.com");
    assert.equal(WELCOME_REPLY_TO_SETTING, "mail.welcome.replyTo");
  });
  await withWelcome(async ({ welcome, posted }) => {
    assert.equal(welcome.supportAddress(), "help@titanium.bot");
    await welcome.send({ slug: "acme-roofing", email: "jane@acmeroofing.com", temporaryPassword: PASSWORD, titanAddress: TITAN });
    assert.equal(posted[0].body.replyTo, "help@titanium.bot");
    assert.ok(String(posted[0].body.text).includes("help@titanium.bot"), "and the words name it too");
  }, { settings: { [WELCOME_REPLY_TO_SETTING]: "help@titanium.bot" } });
  // A setting somebody typed badly falls back rather than putting a broken header on a real mail.
  await withWelcome(async ({ welcome }) => {
    assert.equal(welcome.supportAddress(), WELCOME_REPLY_TO_DEFAULT);
  }, { settings: { [WELCOME_REPLY_TO_SETTING]: "not an address" } });
});

test("the idempotency key is per workspace, per recipient and per hour, and holds no address", () => {
  const key = welcomeIdempotencyKey({ slug: "acme-roofing", to: "jane@acmeroofing.com", at: AT });
  assert.match(key, /^welcome:acme-roofing:[0-9a-f]{16}:2026091012$/);
  assert.equal(key.includes("jane"), false, "the recipient is hashed, because this string travels in a header");
  assert.ok(key.length <= 256, "Resend's own cap on an idempotency key");
  // The same press twice inside the hour is one mail at the provider; a deliberate one next hour is a
  // second mail.
  assert.equal(welcomeIdempotencyKey({ slug: "acme-roofing", to: "JANE@acmeroofing.com", at: AT + 60_000 }), key);
  assert.notEqual(welcomeIdempotencyKey({ slug: "acme-roofing", to: "jane@acmeroofing.com", at: AT + 3_600_000 }), key);
  assert.notEqual(welcomeIdempotencyKey({ slug: "other-co", to: "jane@acmeroofing.com", at: AT }), key);
});

test("the preview blanks the link and the password and sends nothing", async () => {
  await withWelcome(async ({ welcome, posted }) => {
    const mail = welcome.preview({ slug: "acme-roofing", email: "jane@acmeroofing.com", name: "Jane Doe", titanAddress: TITAN });
    assert.equal(mail.subject, WELCOME_SUBJECT);
    assert.ok(mail.html.includes("sso=REDACTED"));
    assert.ok(mail.html.includes("REDACTED"));
    assert.equal(mail.html.includes(PASSWORD), false);
    // Same shape, same line count, same contrast as the real thing, which is what makes it worth
    // screenshotting. And nothing left this process.
    assert.ok(mail.html.includes("Temporary password"));
    assert.equal(posted.length, 0);
  });
});

// ---- and the sentences themselves, held against this file's own source -------------------------

test("every refusal in this file is a named constant, so two callers cannot drift apart", async () => {
  const source = await readFile(path.join(HERE, "..", "cp", "welcome.mjs"), "utf8");
  for (const sentence of [
    WELCOME_NO_RECIPIENT, WELCOME_BAD_RECIPIENT, WELCOME_NO_LINK, WELCOME_NO_TITAN_ADDRESS,
    WELCOME_LINK_SHAPE_WITH_PASSWORD, WELCOME_NO_ACCOUNT, WELCOME_NO_TENANT, WELCOME_NO_HOST,
    WELCOME_NO_SECRET,
  ]) {
    assert.ok(sentence.length > 0);
    assert.equal(sentence.includes("—"), false, `no em dash in "${sentence}"`);
    // A sentence an operator reads says what to do or what happened, never which rule fired.
    assert.match(sentence, /[.!]$/, `"${sentence}" ends as a sentence`);
  }
  // And the two things that must never be written down are written down nowhere in this file's own
  // calls to the store or the log.
  assert.equal(/recordWelcomeSend\([^)]*password/is.test(source), false);
  assert.equal(/recordWelcomeSend\([^)]*signInUrl/is.test(source), false);
  assert.equal(source.includes("console.log"), false, "this file logs nothing: a log line is a place a link could land");
});
