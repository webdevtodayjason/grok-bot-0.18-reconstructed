// Reading a page: what it says, whether it wants a login, whether it is a wall rather than a page.
//
// Everything here is a plain function over an HTML string, so the same code that runs in the box is
// the code the tests run on fixture files. The HTML it is given is document.documentElement.outerHTML
// off the live page, not the server's response body, so it is the rendered DOM serialised: a React
// page that ships an empty shell still arrives here with its text in it.
//
// The extraction is Readability-shaped rather than Readability itself: score the candidate
// containers, drop the furniture, take the winner, and fall back to the page's innerText when
// nothing scores. Readability proper is 2000 lines and a dependency, and this runs where there is
// no npm install.

export const TEXT_CAP = 40000;

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// Their content is never page text.
const DROPPED_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "video", "audio", "map"]);

// Page furniture. Removed from a candidate before it is scored and before it is read.
const FURNITURE_TAGS = new Set(["nav", "header", "footer", "aside", "menu", "dialog"]);

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "li", "main", "nav",
  "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
]);

// An open tag of one of these closes an open one of the same name; the DOM does it, so we do too.
const SELF_CLOSING_SIBLINGS = new Set(["p", "li", "dt", "dd", "option", "td", "th", "tr"]);

const FURNITURE_WORDS = /(^|[^a-z])(nav|navbar|menu|sidebar|side-bar|footer|masthead|breadcrumb|comment|comments|promo|banner|cookie|consent|advert|ad-|-ad|social|share|newsletter|subscribe|related|recirc|paywall|modal|popup|toolbar|skip-link)([^a-z]|$)/i;
const CONTENT_WORDS = /(^|[^a-z])(content|main|article|post|story|entry|body-text|page-body|prose|markdown)([^a-z]|$)/i;

const ENTITIES = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "], ["mdash", "-"],
  ["ndash", "-"], ["hellip", "..."], ["rsquo", "'"], ["lsquo", "'"], ["rdquo", '"'], ["ldquo", '"'], ["copy", "(c)"],
  ["reg", "(r)"], ["trade", "(tm)"], ["middot", "."], ["bull", "-"], ["times", "x"], ["deg", " degrees"],
]);

/** Turn &amp;-style escapes back into characters. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,9});/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = ENTITIES.get(body.toLowerCase());
    return named === undefined ? whole : named;
  });
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const value = match[4] ?? match[5] ?? match[6] ?? "";
    attributes[match[1].toLowerCase()] = decodeEntities(value);
  }
  return attributes;
}

/**
 * A tolerant HTML parser: enough of a tree to score containers and read text out of them, and
 * nothing more. Unclosed tags close when their parent does, which is what a browser does too.
 */
export function parseHtml(html) {
  const root = { tag: "#root", attributes: {}, children: [], parent: null };
  const stack = [root];
  let cursor = 0;

  const addText = (text) => {
    if (text.length === 0) return;
    stack[stack.length - 1].children.push({ text });
  };

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      addText(html.slice(cursor));
      break;
    }
    if (open > cursor) addText(html.slice(cursor, open));

    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
      const end = html.indexOf(">", open);
      cursor = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html[open + 1] === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(open + (closing ? 2 : 1)));
    if (nameMatch === null) {
      addText("<");
      cursor = open + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();

    // Find the end of the tag, honouring quoted attribute values so a ">" inside one does not end it.
    let scan = open + (closing ? 2 : 1) + tag.length;
    let quote = null;
    while (scan < html.length) {
      const character = html[scan];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      scan += 1;
    }
    const tagEnd = scan >= html.length ? html.length : scan;
    const inside = html.slice(open + (closing ? 2 : 1) + tag.length, tagEnd);
    cursor = tagEnd + 1;

    if (closing) {
      const at = stack.findLastIndex((node) => node.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }

    // The whole content of a dropped tag is skipped outright: no scoring, no text, no nested tags.
    if (DROPPED_TAGS.has(tag) && !inside.endsWith("/")) {
      const close = html.toLowerCase().indexOf(`</${tag}`, cursor);
      cursor = close === -1 ? html.length : close;
      continue;
    }

    const node = { tag, attributes: parseAttributes(inside), children: [], parent: stack[stack.length - 1] };
    if (SELF_CLOSING_SIBLINGS.has(tag) && stack[stack.length - 1].tag === tag) stack.pop();
    stack[stack.length - 1].children.push(node);
    node.parent = stack[stack.length - 1];
    if (!VOID_TAGS.has(tag) && !inside.endsWith("/")) stack.push(node);
  }

  return root;
}

function isFurniture(node) {
  if (FURNITURE_TAGS.has(node.tag)) return true;
  const role = node.attributes.role;
  if (role === "navigation" || role === "banner" || role === "contentinfo" || role === "complementary") return true;
  if (node.attributes["aria-hidden"] === "true") return true;
  const label = `${node.attributes.id ?? ""} ${node.attributes.class ?? ""}`;
  if (label.trim().length === 0) return false;
  return FURNITURE_WORDS.test(label) && !CONTENT_WORDS.test(label);
}

/** The text of a node, with block elements and list items broken onto their own lines. */
export function textOf(node, options = {}) {
  const skipFurniture = options.skipFurniture === true;
  const parts = [];
  const walk = (current, inPre) => {
    for (const child of current.children) {
      if (child.text !== undefined) {
        const decoded = decodeEntities(child.text);
        parts.push(inPre ? decoded : decoded.replace(/\s+/g, " "));
        continue;
      }
      if (skipFurniture && isFurniture(child)) continue;
      if (child.tag === "br") {
        parts.push("\n");
        continue;
      }
      const block = BLOCK_TAGS.has(child.tag);
      if (block) parts.push("\n");
      if (child.tag === "li") parts.push("- ");
      walk(child, inPre || child.tag === "pre");
      if (block) parts.push("\n");
    }
  };
  walk(node, node.tag === "pre");
  return parts
    .join("")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findAll(node, predicate, out = []) {
  for (const child of node.children) {
    if (child.text !== undefined) continue;
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}

function linkDensity(node) {
  const total = textOf(node).length;
  if (total === 0) return 1;
  let linked = 0;
  for (const anchor of findAll(node, (n) => n.tag === "a")) linked += textOf(anchor).length;
  return Math.min(1, linked / total);
}

function scoreCandidate(node) {
  if (isFurniture(node)) return -1;
  const text = textOf(node, { skipFurniture: true });
  if (text.length < 100) return -1;
  const paragraphs = findAll(node, (n) => n.tag === "p" || n.tag === "li").length;
  let score = text.length * (1 - linkDensity(node)) + paragraphs * 30;
  if (node.tag === "article") score += 400;
  if (node.tag === "main" || node.attributes.role === "main") score += 300;
  const label = `${node.attributes.id ?? ""} ${node.attributes.class ?? ""}`;
  if (CONTENT_WORDS.test(label)) score += 150;
  return score;
}

function capText(text, cap) {
  if (text.length <= cap) return { text, truncated: false };
  const cut = text.slice(0, cap);
  const boundary = cut.lastIndexOf(" ");
  return { text: boundary > cap - 200 ? cut.slice(0, boundary) : cut, truncated: true };
}

/**
 * The readable main text of a page, capped. `innerText` is the fallback for the pages this cannot
 * read: a canvas app, a PDF viewer, anything whose text is not in the markup.
 */
export function extractReadableText(html, options = {}) {
  const cap = options.cap ?? TEXT_CAP;
  const innerText = typeof options.innerText === "string" ? options.innerText : "";
  const document = options.document ?? parseHtml(html ?? "");

  const candidates = findAll(document, (node) =>
    node.tag === "article" || node.tag === "main" || node.tag === "section" || node.tag === "div" || node.attributes.role === "main");

  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  let source = "main";
  let text = best === null ? "" : textOf(best, { skipFurniture: true });

  if (text.length < 140) {
    const body = findAll(document, (node) => node.tag === "body")[0] ?? document;
    const whole = textOf(body, { skipFurniture: true });
    if (whole.length > text.length) {
      text = whole;
      source = "body";
    }
  }
  if (text.length < 40 && innerText.trim().length > text.length) {
    text = innerText.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    source = "innerText";
  }

  const capped = capText(text, cap);
  return { text: capped.text, truncated: capped.truncated, source, characters: capped.text.length };
}

/**
 * Best effort: does a login form dominate this page? Wrong in both directions sometimes, which is
 * why the answer is a flag and a sentence rather than a decision.
 */
export function detectNeedsLogin(input) {
  const document = input.document ?? parseHtml(input.html ?? "");
  const text = input.text ?? extractReadableText(input.html ?? "", { document }).text;
  const title = (input.title ?? "").toLowerCase();
  const url = (input.url ?? "").toLowerCase();

  const passwords = findAll(document, (n) => n.tag === "input" && (n.attributes.type ?? "").toLowerCase() === "password");
  const inputs = findAll(document, (n) => n.tag === "input" || n.tag === "textarea");
  const bodyText = text.toLowerCase();
  const shortPage = text.length < 4000;

  if (passwords.length > 0 && shortPage) {
    return { needsLogin: true, reason: "the page is mostly a sign-in form asking for a password" };
  }
  if (passwords.length > 0 && (/\b(sign in|log in|login|signin)\b/.test(title) || /(^|[/?#&])(login|signin|sign-in|auth|session)([/?#&]|$)/.test(url))) {
    return { needsLogin: true, reason: "this is the site's sign-in page" };
  }

  const asksPlainly = /(sign in to (continue|view|see|read)|log in to (continue|view|see|read)|you (must|need to) (be )?(sign|log)(ed)? in|please (sign|log) in|members only|sign in to your account|create an account to continue|subscribers only)/.test(bodyText);
  if (asksPlainly && text.length < 2500) {
    return { needsLogin: true, reason: "the page says it needs you signed in before it will show anything" };
  }
  if (passwords.length === 0 && inputs.length > 0 && /\b(sign in|log in)\b/.test(title) && text.length < 1500) {
    return { needsLogin: true, reason: "the page is a sign-in step" };
  }
  return { needsLogin: false, reason: "" };
}

// The families here are the ones source/host/runner/bot-block-detection.ts already classifies for
// the audit ledger. This is a second copy on purpose: that file is TypeScript compiled into the host
// bundle, and this one runs as plain .mjs inside a box with no build step. Keep the two in step.
const BLOCK_SIGNATURES = [
  { family: "google_sorry", host: ["google.com"], hostSuffix: [".google.com"], pathPrefix: ["/sorry"] },
  { family: "google_signin_rejected", host: ["accounts.google.com"], pathIncludes: ["/signin/rejected"] },
  { family: "recaptcha", pathIncludes: ["/recaptcha/api2/", "/recaptcha/enterprise/"] },
  { family: "cloudflare_challenge", pathIncludes: ["/cdn-cgi/challenge-platform/"] },
  { family: "cloudflare_challenge", host: ["challenges.cloudflare.com"] },
  { family: "cloudflare_challenge", titlePrefix: ["Just a moment", "Attention Required! | Cloudflare"] },
  { family: "hcaptcha", host: ["hcaptcha.com"], hostSuffix: [".hcaptcha.com"] },
  { family: "arkose", hostSuffix: [".arkoselabs.com", ".funcaptcha.com"] },
  { family: "linkedin_checkpoint", host: ["linkedin.com"], hostSuffix: [".linkedin.com"], pathPrefix: ["/checkpoint/challenge"] },
  { family: "datadome", host: ["captcha-delivery.com", "captcha.datadome.co"], hostSuffix: [".captcha-delivery.com"] },
  { family: "perimeterx", pathIncludes: ["/px/captcha"] },
  { family: "perimeterx", host: ["captcha.px-cdn.net"], hostSuffix: [".px-cloud.net"] },
  { family: "perimeterx", title: ["Access to this page has been denied"] },
  { family: "imperva", pathIncludes: ["/_Incapsula_Resource"] },
  { family: "distil", title: ["Pardon Our Interruption"] },
  { family: "aws_waf", hostSuffix: [".token.awswaf.com"] },
  { family: "vercel_checkpoint", titlePrefix: ["Vercel Security Checkpoint"] },
  { family: "vercel_checkpoint", pathIncludes: ["/.well-known/vercel/security/"] },
  { family: "generic_access_denied", title: ["Access Denied"] },
];

function signatureMatches(signature, page) {
  if (signature.host !== undefined || signature.hostSuffix !== undefined) {
    const byName = signature.host?.includes(page.hostname) === true;
    const bySuffix = signature.hostSuffix?.some((suffix) => page.hostname.endsWith(suffix)) === true;
    if (!byName && !bySuffix) return false;
  }
  if (signature.pathPrefix !== undefined || signature.pathIncludes !== undefined) {
    const byPrefix = signature.pathPrefix?.some((prefix) => page.pathname.startsWith(prefix)) === true;
    const byIncludes = signature.pathIncludes?.some((part) => page.pathname.includes(part)) === true;
    if (!byPrefix && !byIncludes) return false;
  }
  if (signature.title !== undefined || signature.titlePrefix !== undefined) {
    const byExact = signature.title?.includes(page.title) === true;
    const byPrefix = signature.titlePrefix?.some((prefix) => page.title.startsWith(prefix)) === true;
    if (!byExact && !byPrefix) return false;
  }
  return true;
}

const BLOCK_PHRASES = [
  { phrase: "verify you are human", reason: "the site is asking for a human check" },
  { phrase: "verify you are a human", reason: "the site is asking for a human check" },
  { phrase: "unusual traffic", reason: "the site says the traffic looks unusual and stopped the page" },
  { phrase: "checking your browser", reason: "the site is running a browser check instead of showing the page" },
  { phrase: "enable javascript and cookies to continue", reason: "the site is running a browser check instead of showing the page" },
  { phrase: "access denied", reason: "the site refused the page" },
  { phrase: "request blocked", reason: "the site blocked the request" },
  { phrase: "you don't have permission to access", reason: "the site refused the page" },
  { phrase: "are you a robot", reason: "the site is asking for a human check" },
];

/** Is this a wall rather than a page? Status first, then the known challenge pages, then wording. */
export function detectBlocked(input) {
  const status = typeof input.status === "number" ? input.status : 0;
  const title = (input.title ?? "").trim();
  const text = (input.text ?? "").toLowerCase();

  if (status === 403) return { blocked: true, reason: "the site answered with a refusal (403)", family: "http_403" };
  if (status === 429) return { blocked: true, reason: "the site is rate limiting us (429)", family: "http_429" };
  if (status === 451) return { blocked: true, reason: "the site says the page is blocked for legal reasons (451)", family: "http_451" };

  let parsed = null;
  try {
    parsed = new URL(input.url ?? "");
  } catch {
    parsed = null;
  }
  if (parsed !== null) {
    const page = {
      hostname: parsed.hostname.toLowerCase().replace(/^www\./, ""),
      pathname: parsed.pathname,
      title,
    };
    for (const signature of BLOCK_SIGNATURES) {
      if (signatureMatches(signature, page)) {
        return { blocked: true, reason: "the site put up a challenge page instead of the page we asked for", family: signature.family };
      }
    }
  }

  if (text.length < 3000) {
    for (const candidate of BLOCK_PHRASES) {
      if (text.includes(candidate.phrase)) return { blocked: true, reason: candidate.reason, family: "wording" };
    }
  }
  return { blocked: false, reason: "", family: "" };
}

/* ------------------------------------------------------------------ *
 * CLOUD-BROWSER-1. The third verdict: a page that answered, was not a wall and was not a login,
 * and still gave up nothing worth reading.
 * ------------------------------------------------------------------ */

/**
 * The hole this fills, measured on grok-bot-local-vm 2026-09-09.
 *
 * https://www.instagram.com/titaniumcomputing/ answered HTTP 200 in 3,259 ms through the box's own
 * Chrome with needsLogin false, blocked false, and Meta's footer chrome -- About, Blog, Jobs, Help,
 * API, Privacy, Terms, and the rest -- as its ENTIRE text. No follower count, no bio, no post. No
 * verdict fired, so the model was handed a page it would summarise as though it had read it, and a
 * router keyed on needsLogin||blocked would never escalate to a cloud browser on exactly the pages
 * a cloud browser exists for.
 *
 * The rule is TOOLS-FETCH-2/3's, ported rather than invented: `looksLikeShell` is a big body that
 * reduced to almost nothing, and `looksLikeTitleOnly` is a page whose whole readable text is its
 * own title. The third clause is this driver's own, because this driver reads a RENDERED DOM rather
 * than a server's response body, so the shell it meets is not empty -- it is furniture. A big body
 * whose text survives only as short link-shaped lines is nav and footer and nothing else.
 *
 * Both halves always have to hold, and the big-body half is what keeps a real small page out of it:
 * example.com reduces to 131 characters from a 559-byte body and is a whole page, so it is not a
 * shell and never will be.
 */
export const EMPTY_SHELL_MIN_HTML_BYTES = 50_000;
export const EMPTY_SHELL_MAX_CHARS = 400;
/**
 * How little running text a heavy page can have before it counts as having said nothing.
 *
 * Set from the measurement rather than from taste, and set to leave room on BOTH sides. On
 * grok-bot-local-vm 2026-09-09, instagram.com/titaniumcomputing/ came back with 630 characters of
 * text and, once the language picker is read as the run-together list it is, ZERO characters of
 * running text. So the bar does not need to be high to catch it, and a high bar is what makes this
 * verdict dangerous: telling someone "this page said nothing" about a page that said something
 * short is worse than missing a shell, because they will believe it.
 *
 * A single ordinary sentence is about 120 characters. A page with one of those said something.
 */
export const EMPTY_SHELL_MAX_PROSE_CHARS = 120;
// A line that is short and ends in no sentence punctuation is a link, a menu item or a button
// label. Long lines and lines that end a sentence are prose, and prose means the page said something.
const CHROME_LINE_MAX_CHARS = 30;

/**
 * A LONG LINE IS NOT AUTOMATICALLY PROSE, and this is the clause the real page taught us.
 *
 * Measured on grok-bot-local-vm 2026-09-09, reading instagram.com/titaniumcomputing/ through the
 * box's own Chrome: 630 characters, every one of them footer chrome -- and 411 of those characters
 * were a SINGLE line, the language picker, with its options run together and no separators:
 * "AfrikaansالعربيةČeštinaDanskDeutsch..." A length test alone called that prose, so the verdict
 * did not fire on the exact page it was written for.
 *
 * The rule that tells them apart is the one thing language always has and a concatenated list never
 * does: spaces, at a plausible rate. Running text averages a word every five or six characters. That
 * language picker averages one per forty. So a line whose average "word" is longer than twenty
 * characters is a list that lost its separators, not a sentence, whatever its length.
 */
const PROSE_MAX_AVERAGE_WORD_CHARS = 20;

function looksLikeRunningText(line) {
  const words = line.split(/\s+/).filter((word) => word.length > 0).length;
  return words > 0 && line.length / words <= PROSE_MAX_AVERAGE_WORD_CHARS;
}

function proseCharacters(text) {
  let total = 0;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/^-\s+/, "").trim();
    if (line.length === 0) continue;
    const shortLabel = line.length <= CHROME_LINE_MAX_CHARS && !/[.!?:;]$/.test(line);
    if (shortLabel || !looksLikeRunningText(line)) continue;
    total += line.length;
  }
  return total;
}

/**
 * Did this page load and say nothing? Returns the verdict and a sentence, the same shape the other
 * two detectors use, so a caller reads three answers rather than two answers and a special case.
 */
export function detectEmptyShell(input) {
  const text = String(input.text ?? "").trim();
  const title = String(input.title ?? "").trim();
  const bytes = Number(input.htmlBytes ?? String(input.html ?? "").length);
  const heavy = bytes >= EMPTY_SHELL_MIN_HTML_BYTES;

  if (heavy && text.length < EMPTY_SHELL_MAX_CHARS) {
    return { emptyShell: true, reason: "the page drew itself but left almost no words behind" };
  }
  if (title.length > 0 && text.length > 0 && text === title) {
    return { emptyShell: true, reason: "the page gave up nothing but its own title" };
  }
  if (heavy && proseCharacters(text) < EMPTY_SHELL_MAX_PROSE_CHARS) {
    return { emptyShell: true, reason: "the page gave up its menus and its footer and none of its content" };
  }
  return { emptyShell: false, reason: "" };
}

/** Everything a page read gives back, parsed once. */
export function analyzePage(input) {
  const document = parseHtml(input.html ?? "");
  const extracted = extractReadableText(input.html ?? "", { document, innerText: input.innerText, cap: input.cap });
  const login = detectNeedsLogin({ document, html: input.html, text: extracted.text, title: input.title, url: input.url });
  const blocked = detectBlocked({ url: input.url, title: input.title, text: extracted.text, status: input.status });
  // Asked LAST and only when the other two said no. A sign-in wall and a challenge page are both
  // also short, and telling somebody "the page said nothing" when the truth is "the page wants you
  // signed in" sends them to the wrong place.
  const shell = login.needsLogin || blocked.blocked
    ? { emptyShell: false, reason: "" }
    : detectEmptyShell({ text: extracted.text, title: input.title, html: input.html });
  return {
    text: extracted.text,
    textTruncated: extracted.truncated,
    textSource: extracted.source,
    needsLogin: login.needsLogin,
    needsLoginReason: login.reason,
    blocked: blocked.blocked,
    blockedReason: blocked.reason,
    blockedFamily: blocked.family,
    emptyShell: shell.emptyShell,
    emptyShellReason: shell.reason,
  };
}
