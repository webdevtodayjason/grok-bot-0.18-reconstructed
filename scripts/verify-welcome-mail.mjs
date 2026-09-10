#!/usr/bin/env node
// ONBOARD-2. The welcome mail, rendered in a real browser in both schemes and measured.
//
// WHY A BROWSER GATE FOR AN EMAIL. The first draft of this mail rendered the temporary password at
// 1.11:1 in dark mode: the right words, in the right place, invisible. Nothing in a unit test sees
// that, because a unit test reads the string and not the pixels, and the one line in this mail that
// must never be invisible is the password a customer needs to get into their own workspace. So every
// text run is walked against the colour actually painted behind it, in LIGHT and in DARK, and
// anything under 4.5:1 fails this gate.
//
// AND WHY BOTH SCHEMES RATHER THAN ONE. Gmail ignores prefers-color-scheme outright, so the inline
// colour is what most readers get and the media block is the extra. Apple Mail and recent Outlook
// honour it. A mail that is only checked in one of the two is a mail half the recipients cannot read,
// and which half depends on which client they happen to use.
//
// It also holds the two rules that keep the header visible at all: NO <img> and NO <svg>. An <svg> is
// dropped by every major client, a data URI in an <img> is stripped by Gmail, and titanium.bot hosts
// no raster mark (measured 2026-09-10: logo.png 404s). So the mark is drawn in HTML and CSS, and a
// regression that turned it back into an image would be invisible to everybody with images off.
//
// Nothing here sends anything. api.resend.com is not touched and no mail leaves this process.
//
//   node scripts/verify-welcome-mail.mjs [--shots <dir>] [--headed]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { WELCOME_REPLY_TO_DEFAULT, renderWelcome } from "../cp/welcome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] != null ? argv[at + 1] : fallback;
};
if (flag("help")) {
  console.log("verify-welcome-mail — renders the welcome mail at 600 px in light and dark and measures every text run");
  console.log("  --shots <dir>  where the four PNGs go (default the scratchpad)");
  console.log("  --headed       a visible browser");
  process.exit(2);
}

const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const SHOTS = value("shots", process.env.GROK_BOT_SHOT_DIR ?? "/tmp/welcome-mail-shots");
// The gate's own name on every request, so a log anywhere can say which gate was looking.
const USER_AGENT = "titanbot-gate/verify-welcome-mail";
// WCAG AA for body text. Nothing in this mail is large-scale text, so there is no 3:1 tier here.
const FLOOR = 4.5;
// The card asks for 600 px and the frame around it keeps 12 px of gutter each side, so in a 620 px
// viewport it lands at 596 -- measured, not intended, and correct: max-width is what makes the card
// shrink into a narrow phone instead of pushing the page sideways. What this gate holds is that the
// card fills its frame WITHOUT overflowing it, which is the thing that actually breaks.
const CARD_WIDTH = 600;
const VIEWPORT_WIDTH = 620;
const GUTTER = 12;

let passes = 0;
let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1; else failures += 1;
};
const info = (line) => console.log(`  INFO  ${line}`);

// The two shapes that ship, with the same values the R750 measurement will use so the pictures this
// saves are the pictures of the real thing.
const SHAPES = [
  ["invite", {
    firstName: "Jane",
    company: "Acme Roofing",
    email: "jane@acmeroofing.com",
    host: "console.titanium.bot",
    signInUrl: "https://console.titanium.bot/login?sso=v1.eyJzdWIiOiJhY2NvdW50In0.signature",
    // The longest shape a generated password takes: 18 random bytes in base64url is 24 characters.
    temporaryPassword: "k3Rr8xQ2mD7vLpNf4sZt9bWy",
    titanAddress: "agent247758@myagents.email",
    supportAddress: WELCOME_REPLY_TO_DEFAULT,
    shape: "link+password",
  }],
  ["again", {
    firstName: "Jane",
    company: "Acme Roofing",
    email: "jane@acmeroofing.com",
    host: "console.titanium.bot",
    signInUrl: "https://console.titanium.bot/login?sso=v1.eyJzdWIiOiJhY2NvdW50In0.signature",
    temporaryPassword: "",
    titanAddress: "agent247758@myagents.email",
    supportAddress: WELCOME_REPLY_TO_DEFAULT,
    shape: "link",
  }],
];

/**
 * Every text run, its colour, the colour actually painted behind it, and the ratio.
 *
 * Walked in the page rather than reasoned about here, because the thing that matters is what the
 * browser computed after the media query and the inline style fought it out. Only elements with their
 * OWN text are measured, so a container wrapping the whole card is not counted as one giant run, and
 * a hidden element is skipped because a preheader nobody sees has no contrast to fail.
 */
const MEASURE = () => {
  const linear = (channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const channels = (value) => (String(value).match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const transparent = (value) => /rgba?\([^)]*,\s*0(\.0+)?\s*\)/.test(String(value));
  // The first ancestor that actually paints something. A bgcolor attribute and a background style both
  // land in the computed value, so this is the colour a reader sees and not the one in the markup.
  const behind = (element) => {
    let node = element;
    while (node != null && node !== document.documentElement) {
      const painted = getComputedStyle(node).backgroundColor;
      if (painted && !transparent(painted)) {
        const parsed = channels(painted);
        if (parsed.length === 3) return parsed;
      }
      node = node.parentElement;
    }
    const root = getComputedStyle(document.documentElement).backgroundColor;
    const parsed = channels(root);
    return parsed.length === 3 && !transparent(root) ? parsed : [255, 255, 255];
  };
  const ratio = (front, back) => {
    const [lighter, darker] = [luminance(front), luminance(back)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const ownText = (element) => [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  const runs = [];
  for (const element of document.querySelectorAll("body *")) {
    const text = ownText(element);
    if (text.length === 0) continue;
    if (element.getClientRects().length === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const front = channels(style.color);
    if (front.length !== 3) continue;
    const back = behind(element);
    runs.push({
      tag: element.tagName,
      cls: element.className || "",
      text: text.slice(0, 44),
      fg: `rgb(${front.join(",")})`,
      bg: `rgb(${back.join(",")})`,
      size: style.fontSize,
      weight: style.fontWeight,
      ratio: Number(ratio(front, back).toFixed(2)),
    });
  }

  const card = document.querySelector(".card");
  const button = [...document.querySelectorAll("a")].find((a) => (a.textContent ?? "").includes("Open your workspace"));
  const buttonBox = button == null ? null : button.getBoundingClientRect();
  return {
    runs,
    images: document.images.length,
    svgs: document.querySelectorAll("svg").length,
    scripts: document.querySelectorAll("script").length,
    cardWidth: card == null ? 0 : Math.round(card.getBoundingClientRect().width),
    docWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    ground: getComputedStyle(document.body).backgroundColor,
    cardBackground: card == null ? "" : getComputedStyle(card).backgroundColor,
    button: buttonBox == null ? null : {
      width: Math.round(buttonBox.width),
      height: Math.round(buttonBox.height),
      color: getComputedStyle(button).color,
      background: getComputedStyle(button.parentElement).backgroundColor,
    },
  };
};

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
  const browser = await chromium.launch({ headless: !flag("headed") });
  const saved = [];
  try {
    for (const [name, options] of SHAPES) {
      const mail = renderWelcome(options);
      const bytes = Buffer.byteLength(mail.html, "utf8");
      info(`${name}: ${bytes} bytes of page, ${Buffer.byteLength(mail.text, "utf8")} bytes of plain text`);

      // The words, held here as well as in the unit tests, because this gate is the one that runs in
      // front of a person about to press send on a real customer's mail.
      const hasPassword = options.shape === "link+password";
      check(mail.html.includes("Temporary password") === hasPassword,
        `${name}: the password line is ${hasPassword ? "present" : "absent"}`);
      check(mail.text.includes("Temporary password") === hasPassword,
        `${name}: and the plain text agrees`);
      check(mail.text.trim().length > 400 && !/<[a-z!/]/i.test(mail.text),
        `${name}: the plain text alternative is hand written`, `${mail.text.length} characters, no markup`);
      check(!mail.html.includes("—") && !mail.text.includes("—"), `${name}: no em dash anywhere a customer reads`);

      for (const scheme of ["light", "dark"]) {
        const page = await browser.newPage({
          // Short on purpose: a full-page shot grows to the content, so a tall viewport only pads the
          // picture with empty ground and makes the mail look shorter than it is.
          viewport: { width: VIEWPORT_WIDTH, height: 700 },
          colorScheme: scheme,
          userAgent: USER_AGENT,
          deviceScaleFactor: 2,
        });
        await page.setContent(mail.html, { waitUntil: "load" });
        const measured = await page.evaluate(MEASURE);

        const file = path.join(SHOTS, `welcome-${name}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        saved.push(file);
        await page.close();

        const low = measured.runs.filter((run) => run.ratio < FLOOR);
        check(low.length === 0, `${name}/${scheme}: every text run is at least ${FLOOR}:1`,
          `${measured.runs.length} runs measured, ${low.length} below`);
        for (const run of low) {
          console.log(`        ${run.ratio}:1  <${run.tag} class="${run.cls}"> "${run.text}"  ${run.fg} on ${run.bg}`);
        }
        // Named on its own, because this is the line the first draft lost and the one a customer
        // cannot get into their workspace without.
        if (hasPassword) {
          const password = measured.runs.find((run) => run.text.includes(options.temporaryPassword));
          check(password != null && password.ratio >= FLOOR, `${name}/${scheme}: the temporary password is readable`,
            password == null ? "no run carried it" : `${password.ratio}:1 ${password.fg} on ${password.bg}`);
        }

        check(measured.images === 0 && measured.svgs === 0, `${name}/${scheme}: the mark is drawn, not fetched`,
          `${measured.images} img, ${measured.svgs} svg`);
        check(measured.scripts === 0, `${name}/${scheme}: no script in the page`);
        check(measured.cardWidth <= CARD_WIDTH && measured.cardWidth >= VIEWPORT_WIDTH - 2 * GUTTER,
          `${name}/${scheme}: the card fills its frame and never overflows it`,
          `${measured.cardWidth} px of a ${CARD_WIDTH} px ask in a ${VIEWPORT_WIDTH} px viewport`);
        check(measured.docWidth <= VIEWPORT_WIDTH, `${name}/${scheme}: nothing scrolls sideways`,
          `${measured.docWidth} px in a ${VIEWPORT_WIDTH} px viewport`);
        check(measured.button != null && measured.button.height >= 40 && measured.button.width >= 150,
          `${name}/${scheme}: the button is a thumb-sized target`,
          measured.button == null ? "no button found" : `${measured.button.width}x${measured.button.height}`);
        info(`${name}/${scheme}: ground ${measured.ground}, card ${measured.cardBackground}, `
          + `button ${measured.button?.background ?? "?"} under ${measured.button?.color ?? "?"}, page ${measured.docHeight} px tall`);
      }
    }

    // The rendered pages beside the pictures, so a reviewer can open the exact markup that was measured
    // rather than a re-render of it. These carry no real link and no real password: the values above
    // are fixtures.
    for (const [name, options] of SHAPES) {
      const mail = renderWelcome(options);
      writeFileSync(path.join(SHOTS, `welcome-${name}.html`), mail.html);
      writeFileSync(path.join(SHOTS, `welcome-${name}.txt`), mail.text);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log("");
  console.log(`  ${saved.length} screenshot(s) in ${SHOTS}`);
  for (const file of saved) console.log(`    ${file}`);
  check(saved.length === 4, "four pictures: two shapes in two schemes", `${saved.length} saved`);
  console.log("");
  console.log(`verify-welcome-mail: ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`verify-welcome-mail: ${error?.stack ?? error}`);
  process.exit(1);
});
