// The part of reading a page that needs no browser.
//
// It lives in its own file, and it is plain data in, plain data out, for two reasons. It can be
// unit-tested on a Mac with no Chrome and no box (tests/browser-tools.test.mjs), and it keeps the
// driver beside it about attaching to Chrome and nothing else.
//
// Everything here is a JUDGEMENT, not a fact: whether a page's readable body is worth returning,
// whether a form is a wall or a newsletter box, whether a short page is a challenge. Each rule is
// written so a wrong answer costs a fallback rather than a lie -- the text falls back to innerText,
// needsLogin falls back to "we read what we could", blocked falls back to the host-side classifier
// in source/host/runner/bot-block-detection.ts, which carries the full 21-signature table and is
// the authority. This is the fast path over facts that classifier never sees: the HTTP status, the
// number of password fields, the body itself.

// A whole page of readable text is worth carrying; a whole site is not. 40k characters is roughly
// a long feature article, and it is a cap on what a single tool result can cost a turn's context.
export const READABLE_TEXT_LIMIT = 40_000;

// Under this, the "readable" pass found a nav bar and a footer rather than an article, so the
// innerText fallback is likely to be the better read.
export const MIN_READABLE_CHARS = 200;

// A page with less visible text than this has nothing on it but the thing in the middle -- a form,
// a challenge, an error. It is what makes "a login form DOMINATES the page" measurable.
export const SHORT_PAGE_CHARS = 1_500;

const TRUNCATION_NOTE = "\n\n[This page is longer than I can carry. The rest was left out.]";

const SIGN_IN_WORDS =
  /\b(sign in|signin|sign-in|log in|login|log-in|sign up|signup|create an account|continue with (google|apple|github|facebook|microsoft|x)|forgot (your )?password|enter your password)\b/i;

const SIGN_IN_PATHS =
  /\/(login|signin|sign-in|sign_in|auth|session|users\/sign_in|account[s]?\/(login|signin|sign-in|sign_in))(\/|\?|$)/i;

// Titles a challenge or a refusal puts on the tab. Deliberately short: the long table lives in
// bot-block-detection.ts and the tool layer runs both.
const BLOCKED_TITLES =
  /(just a moment|attention required|access denied|403 forbidden|forbidden|are you a robot|verify you are human|unusual traffic|security check|checking your browser|pardon our interruption|sorry\b)/i;

const BLOCKED_BODY =
  /(captcha|recaptcha|hcaptcha|enable javascript and cookies|unusual traffic from your computer network|automated queries|request (was )?blocked|ray id|your ip has been|rate limit(ed)?)/i;

// HTTP answers that mean "not today": refused, throttled, or a challenge served in place of a page.
const BLOCKED_STATUS = new Set([401, 403, 405, 429, 503]);

/**
 * Collapse a page's whitespace and cap it, with a sentence saying so rather than a silent cut.
 * A truncated read that looks complete is worse than a short one that says it is short.
 */
export function tidyPageText(text, limit = READABLE_TEXT_LIMIT) {
  const collapsed = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0\u200b]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (collapsed.length <= limit) return collapsed;
  const room = Math.max(0, limit - TRUNCATION_NOTE.length);
  return `${collapsed.slice(0, room).trimEnd()}${TRUNCATION_NOTE}`;
}

/**
 * Pick between the Readability-style pass and the whole page's innerText.
 *
 * The readable pass wins when it found enough to be an article. When it found almost nothing --
 * an app shell, a page that renders its body into a canvas, a site whose article markup is wrong --
 * innerText is the honest fallback, junk and all, because some words beat none.
 */
export function chooseReadableText(page = {}, limit = READABLE_TEXT_LIMIT) {
  const readable = tidyPageText(page.readable, limit);
  if (readable.length >= MIN_READABLE_CHARS) return readable;
  const innerText = tidyPageText(page.innerText, limit);
  return innerText.length > readable.length ? innerText : readable;
}

/**
 * Best effort: is this page a wall rather than the thing that was asked for?
 *
 * Three shapes count. A password field with sign-in wording or a sign-in path is the plain case.
 * A password field on a page with nothing else on it is a bare wall even when the wording is odd
 * or in another language. A sign-in path with sign-in wording and no content is the single-page
 * app that has not drawn its form yet.
 *
 * A newsletter box at the foot of a long article is not a wall, and none of the three fires on it:
 * it has no password field, and the page is not short.
 */
export function looksLikeLoginWall(page = {}) {
  const url = String(page.url ?? "");
  const title = String(page.title ?? "");
  const text = String(page.text ?? "");
  const passwordFields = Number(page.passwordFields ?? 0);
  const visible = typeof page.visibleTextLength === "number" ? page.visibleTextLength : text.length;
  const words = SIGN_IN_WORDS.test(`${title}\n${text}`);
  const path = SIGN_IN_PATHS.test(url);
  if (passwordFields > 0 && (words || path)) return true;
  if (passwordFields > 0 && visible <= SHORT_PAGE_CHARS) return true;
  if (path && words && visible <= SHORT_PAGE_CHARS) return true;
  return false;
}

/**
 * Best effort: did something between us and the page refuse us?
 *
 * The status is the strongest signal and the one the host-side classifier cannot see, because it
 * only ever gets a url and a title. The title table catches the challenge pages that answer 200.
 * The body table is held to short pages on purpose: an article ABOUT captchas is not a captcha.
 */
export function looksBlocked(page = {}) {
  const status = Number(page.status ?? 200);
  const title = String(page.title ?? "");
  const text = String(page.text ?? "");
  if (BLOCKED_STATUS.has(status)) return true;
  if (BLOCKED_TITLES.test(title)) return true;
  if (BLOCKED_BODY.test(text) && text.length <= SHORT_PAGE_CHARS) return true;
  return false;
}

/**
 * The one sentence a person reads when a page wants a login. It names the desktop view, because
 * that is the thing they can actually do something with, and it never names a tool.
 */
export function signInHandoffSentence(page = {}) {
  const where = String(page.title ?? "").trim() || String(page.url ?? "").trim() || "this page";
  return `${where} wants a sign-in before it will show anything. You can sign in on the box desktop `
    + "in the console's desktop view, and I will carry on from there.";
}
