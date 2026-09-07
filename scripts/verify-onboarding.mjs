#!/usr/bin/env node
// verify-onboarding.mjs -- ONBOARD-1 and AGENTS-CAP-1, measured rather than described.
//
// Three arms, and they answer three different questions.
//
//   --offline  Does the console DRAW the first-run modal? No box, no relay: a static server over
//              ui/machine-room and a fixture behind /api. The page hydrates and believes it is
//              live, because every call it needs is answered from the fixture and every call it
//              does not is answered the way an older host answers one, with
//              {"error":"unknown gateway method"} and a 404. What is measured: the dialog opens
//              below the top bar at the width of the stage, the chat behind it is dimmed, Titan's
//              live face is in it, the five questions are on a strip, Skip for now is there, a
//              strip with two answers already saved shows two of five done, and a box that
//              reports done:true gets no modal at all.
//
//   --live     Does the whole loop RUN on the box? The flag is put back to first-run through the
//              test-only command, the box is pointed at a stub model on this Mac the way
//              verify-loop.mjs points it, the console is opened headless, and then: the modal is
//              there, the console sent Titan's opening message itself, the setup recipe's own
//              words are in the user half of that turn, the model is handed
//              save_onboarding_answer, an answer typed into the modal reaches it, the strip
//              fills, Skip closes it, and the flag reads done with the answer still in it.
//              Then the ending: the flag goes back, the page is reloaded and the box refuses to
//              say Titan's opening a second time, the stub calls finish_onboarding the way the
//              recipe tells him to, the record reads done for the right reason, and the window
//              closes with nobody pressing anything.
//
//   --cap      Is the 13-agent ceiling REAL? The roster is faked by moving the ceiling, not by
//              minting twelve agents: SAND_MAX_AGENTS is set to the box's own non-group count, so
//              the very next createAgent must be refused in plain words, and duplicateAgent with
//              it. Then the ceiling is raised by one and the same create must succeed, which is
//              the only honest way to show that the group on this box is not being counted. The
//              default is read back with the setting removed and has to be 13.
//
// With no flag it runs all three. Every switch it moves is put back in a finally, the probe agent
// it creates is deleted, and the endpoint the box was answering through is pinned back.
//
//   node scripts/verify-onboarding.mjs                     all three arms
//   node scripts/verify-onboarding.mjs --offline           the fixture render, needs nothing running
//   node scripts/verify-onboarding.mjs --live              the box arm on its own
//   node scripts/verify-onboarding.mjs --cap               the ceiling on its own
//   node scripts/verify-onboarding.mjs --self-test         the gate measuring ITSELF, see below
//
// --self-test runs the fixture arm against a stand-in modal built to the DOM contract in
// docs/ONBOARDING.md §5, injected into the real console page. It reports on this file, never on
// the product, and its summary says so. It exists because a gate written before the thing it
// measures can have every selector wrong and still look calm: a check that finds nothing passes
// nothing and fails nothing. Fifteen checks going green against a conforming stand-in is what
// makes "it will run once the console lands" a claim rather than a hope. It is also the shortest
// statement of the contract the console has to meet: read STAND_IN below.
//
// Exit 0 nothing failed, 1 a check failed, 2 nothing could be measured.
//
// NOT LANDED IS NOT A FAILURE. The host half of this wave (getOnboardingState, completeOnboarding,
// resetOnboarding) may not be on the box yet. The gate asks the gateway once, and if the command
// is unknown it says so and exits 2 rather than reporting the product broken. Once the host and
// the console land, the same file measures them: the names it uses are the ones written down in
// docs/ONBOARDING.md, which is the contract both halves are built to.
import { execFile } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONSOLE_DIR = path.join(REPO, "ui", "machine-room");

const RELAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(REPO, ".cache/playwright");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const argv = new Set(process.argv.slice(2));
// --self-test measures the GATE, not the product: the fixture arm runs against a stand-in modal
// built to the DOM contract, so every selector and every geometry read here is shown to be
// satisfiable before the console half lands. It never reports on the box.
const SELF_TEST = argv.has("--self-test");
const only = ["--offline", "--live", "--cap"].filter((f) => argv.has(f));
const want = (arm) => (SELF_TEST ? arm === "--offline" : only.length === 0 || argv.has(arm));
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const STUB_PORT = Number.parseInt(flag("--port", "18781"), 10);
const STATIC_PORT = Number.parseInt(flag("--static-port", "18782"), 10);
// The whole file has to fit the 300s ceiling the gates are run under (docs/PLUMBING-AUDIT.md).
// Measured budget: offline 25s, live 130s, cap 40s.
const TURN_TIMEOUT_MS = Number.parseInt(flag("--turn-timeout-ms", "90000"), 10);
const MODAL_TIMEOUT_MS = 30_000;
const STRIP_TIMEOUT_MS = 60_000;

// The five questions, in the order Titan asks them. These are the state's own field names and the
// values of data-onboarding-step in the console. docs/ONBOARDING.md is where they are written down.
const FIELDS = ["name", "location", "business", "ownsBusiness", "workingStyle"];
// The plain-words refusal. Templated from the ceiling in force, so a box at 13 reads "12 more bots".
const REFUSAL = /This workspace holds Titan and (\d+) more bots\. Remove one to add another\./;
// Words a refusal a business owner reads must never contain.
const JARGON = /\b(409|4\d\d|5\d\d|SandAgentLimitError|MAX_AGENTS_PER_USER|throw|exception|null|undefined)\b/;

let failures = 0;
let passes = 0;
let notMeasured = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (ok) passes += 1; else failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} -- ${why}`); notMeasured += 1; };
const step = (name) => console.log(`\n== ${name}`);
const info = (line) => console.log(`  INFO  ${line}`);

// ------------------------------------------------------------------ the box and the relay

const gw = async (method, args = {}) => {
  const res = await fetch(`${RELAY}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body, text };
};
const must = async (method, args = {}) => {
  const answer = await gw(method, args);
  if (!answer.ok) throw new Error(`${method} -> ${answer.status} ${answer.text.slice(0, 200)}`);
  return answer.body;
};
const relay = async (route, body) => {
  const res = await fetch(`${RELAY}${route}`, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${String(text).slice(0, 200)}`);
  return parsed;
};
const docker = (args) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) => resolve(error && !out ? "" : String(out))));
const sh = (command) => docker(["exec", BOX, "sh", "-c", command]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How many times the console has asked the box for Titan's opening line, counted off the
// conversation itself. SAND_ONBOARDING_START_PROMPT is a real message from the person, so it is in
// the transcript, and two of them means somebody's half-finished interview got restarted.
const ONBOARDING_START_PROMPT = "Let's get set up.";
const openingCount = (answer) => {
  const entries = Array.isArray(answer) ? answer : Array.isArray(answer?.entries) ? answer.entries : [];
  return JSON.stringify(entries).split(ONBOARDING_START_PROMPT).length - 1;
};

// readSandBoxSetting (source/host/sand-box-setting.ts) takes either a flat object or
// { settings: { ... } } and PREFERS the nested one. Both helpers resolve the container the reader
// picks, or a write lands on a key the resolver never consults and the restore invents one.
// Same shape as scripts/verify-teach.mjs and scripts/verify-dashboard.mjs, so they cannot drift.
const settingsContainer = "const c=(d&&typeof d.settings==='object'&&d.settings!=null&&!Array.isArray(d.settings))?d.settings:d;";
const readSetting = async (name) => {
  const raw = await sh(`cat ${SETTINGS} 2>/dev/null || echo '{}'`);
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const nested = parsed.settings;
    const container = nested != null && typeof nested === "object" && !Array.isArray(nested) ? nested : parsed;
    return container[name];
  } catch { return undefined; }
};
const writeSetting = async (name, value) => {
  const mutate = value == null
    ? `delete c[${JSON.stringify(name)}];`
    : `c[${JSON.stringify(name)}]=${JSON.stringify(String(value))};`;
  await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const p=${JSON.stringify(SETTINGS)};`
    + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
    + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
    + settingsContainer
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};

// Has the host half landed? One question, asked once. An unknown command is a wave that has not
// shipped, not a product that is broken, and the difference decides the exit code.
async function hostHalf() {
  let answer;
  try { answer = await gw("getOnboardingState"); }
  catch (error) { return { reachable: false, landed: false, why: String(error?.message ?? error) }; }
  if (answer.status === 404 && /unknown gateway method/i.test(answer.text)) {
    return { reachable: true, landed: false, why: "the box has no getOnboardingState yet" };
  }
  if (!answer.ok) return { reachable: true, landed: false, why: `getOnboardingState -> ${answer.status} ${answer.text.slice(0, 120)}` };
  return { reachable: true, landed: true, state: answer.body };
}

// The test-only reset. docs/ONBOARDING.md names it resetOnboarding; a host that called it
// resetOnboardingForTest is accepted too, and the name that answered is printed, because a gate
// that fails on a synonym teaches nobody anything.
async function resetOnboarding(args = {}) {
  for (const name of ["resetOnboarding", "resetOnboardingForTest"]) {
    const answer = await gw(name, args);
    if (answer.status === 404 && /unknown gateway method/i.test(answer.text)) continue;
    return { name, ...answer };
  }
  return null;
}

const nonGroupAgents = (agents) => (Array.isArray(agents) ? agents : []).filter((a) => a?.isGroup !== true);

// ------------------------------------------------------------------ playwright

async function loadChromium() {
  try {
    const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
    return chromium;
  } catch (error) {
    console.error(`playwright-core is not resolvable in ${PW_DIR}: ${String(error.message).split("\n")[0]}`);
    console.error("Run scripts/setup-gates.sh, or set GROK_BOT_PLAYWRIGHT_DIR at an install that has it.");
    return null;
  }
}

// What the modal is, read off the page rather than out of the source. Everything here is the DOM
// contract in docs/ONBOARDING.md; a console that draws the modal some other way fails, which is
// the point of writing the contract down.
const READ_MODAL = () => {
  const dialog = document.querySelector("#onboarding-dialog, dialog.onboarding-dialog");
  if (!dialog) return { present: false };
  const bar = document.querySelector(".window-bar");
  const stage = document.querySelector("#stage, main.stage");
  const box = dialog.getBoundingClientRect();
  const barBox = bar ? bar.getBoundingClientRect() : null;
  const stageBox = stage ? stage.getBoundingClientRect() : null;
  const steps = [...dialog.querySelectorAll("[data-onboarding-step]")].map((el) => ({
    field: el.dataset.onboardingStep,
    done: el.dataset.done === "true",
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
  }));
  const face = dialog.querySelector("[data-onboarding-face]");
  return {
    present: true,
    open: dialog.open === true || dialog.hasAttribute("open"),
    agentId: dialog.dataset.onboardingAgent ?? null,
    top: Math.round(box.top),
    width: Math.round(box.width),
    barBottom: barBox ? Math.round(barBox.bottom) : null,
    stageWidth: stageBox ? Math.round(stageBox.width) : null,
    steps,
    // showModal() and nothing else makes a dialog match :modal, and only a modal dialog paints a
    // backdrop over the page and makes what is behind it inert. That is the dimming, measured.
    isModal: (() => { try { return dialog.matches(":modal"); } catch { return false; } })(),
    face: Boolean(face),
    // A canvas face, or the still the reduced-motion and no-canvas paths draw instead.
    faceLive: Boolean(face && (face.querySelector("titan-mascot") || face.querySelector("canvas"))),
    faceStill: Boolean(face && face.querySelector("img")),
    faceMood: face?.querySelector("[data-titan-mood]")?.dataset.titanMood
      ?? face?.querySelector("titan-mascot")?.getAttribute("mood") ?? null,
    faceHeight: face ? Math.round(face.getBoundingClientRect().height) : 0,
    skip: (dialog.querySelector("[data-onboarding-skip]")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    hasSkip: Boolean(dialog.querySelector("[data-onboarding-skip]")),
    hasTranscript: Boolean(dialog.querySelector("[data-onboarding-transcript]")),
    hasComposer: Boolean(dialog.querySelector("[data-onboarding-composer] textarea, [data-onboarding-composer] input[type=text]")),
    messages: [...dialog.querySelectorAll("[data-onboarding-transcript] .message-row, [data-onboarding-transcript] [data-message-id]")].length,
    // The chat behind it is dimmed by the dialog's own backdrop, which only a modal dialog paints.
    backdrop: (() => {
      try {
        const style = getComputedStyle(dialog, "::backdrop");
        return { background: style.backgroundColor || style.background || "", blur: style.backdropFilter || "" };
      } catch { return { background: "", blur: "" }; }
    })(),
  };
};

// ------------------------------------------------------------------ the offline arm

const FIXTURE_AGENTS = [
  { id: "fixture-titan", name: "Titan", createdAt: 1_700_000_000_000 },
  { id: "fixture-books", name: "Books", createdAt: 1_700_000_100_000 },
  { id: "fixture-inbox", name: "Inbox", createdAt: 1_700_000_200_000 },
].map((a) => ({
  ...a, description: "", title: "", avatarDataUrl: null, avatarVersion: 0, avatarShape: null,
  avatarColor: null, updatedAt: a.createdAt, path: "", isActive: false, isRunning: false,
  isComposingMessage: false, lastEntry: null, lastMessageId: null, lastMessagePreview: "",
  newestEntryId: null, hasUnread: false, unreadCount: 0, lastViewedAt: a.createdAt,
  lastActivityAt: a.createdAt, awaitingUserResponse: null, notificationsEnabled: false,
  notifyOnUpdatesEnabled: true, isHiddenFromSidebar: false, origin: "user", isGroup: false,
  memberIds: [], conversationPartnerIds: [], snapshotEpoch: "fixture", snapshotSeq: 1,
}));

function fixtureFor(onboarding) {
  return {
    listAgents: FIXTURE_AGENTS,
    countAgents: FIXTURE_AGENTS.length,
    isGlobalSearchEnabled: false,
    getHostStatus: {
      hostVersion: "fixture", latestHostVersion: null, hostUpdateAvailable: null, isBusy: false,
      capabilities: ["orderedReplicasV1", "sendAcceptanceV1", "onboardingV1"],
      maxAgents: 13,
    },
    getOnboardingState: onboarding,
    getAgentTranscript: [],
    getAgentAutomations: [],
    getAgentWorkflows: [],
    getListenerIntegrations: [],
    openAgent: {},
    sendPrompt: { accepted: true },
  };
}

// Everything the relay serves that is not a file. The console degrades on each of these already,
// so an empty answer is the honest one; what matters is that none of them is left hanging.
const RELAY_ROUTES = {
  "/subscriptions": { subscriptions: [] },
  "/endpoints": { endpoints: [], live: null },
  "/model": { model: "fixture-model" },
  "/connectors": { connectors: [] },
  "/auth/state": { required: false, authenticated: true },
  "/job-bus/status": { enabled: false },
  "/mail/settings": { settings: null },
};

function startStaticServer(port) {
  const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
    ".mp4": "video/mp4", ".webm": "video/webm", ".md": "text/markdown; charset=utf-8",
  };
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(CONSOLE_DIR, rel === "" ? "index.html" : rel);
    if (!file.startsWith(CONSOLE_DIR + path.sep) && file !== path.join(CONSOLE_DIR, "index.html")) {
      res.writeHead(403); return res.end("outside the console directory");
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end("not here"); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// The DOM contract of docs/ONBOARDING.md §5, written out as the smallest page that satisfies it.
// It is injected only under --self-test, and only so the gate can be shown to measure something
// satisfiable BEFORE the console lands: a check whose selector is wrong passes nothing and fails
// nothing, and a gate nobody has ever seen go green is a gate nobody should trust. It is never a
// measurement of the product, and the summary of a --self-test run says so.
const STAND_IN = (fields) => `(() => {
  const state = window.__onboardingFixture;
  if (!state || state.done === true) return;
  const bar = document.querySelector(".window-bar");
  const stage = document.querySelector("#stage, main.stage");
  const top = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
  const width = stage ? Math.round(stage.getBoundingClientRect().width) : window.innerWidth;
  const dialog = document.createElement("dialog");
  dialog.id = "onboarding-dialog";
  dialog.className = "onboarding-dialog";
  dialog.dataset.onboardingAgent = state.agentId ?? "";
  dialog.style.cssText = "position:fixed;margin:0;padding:0;border:0;left:" +
    Math.round((window.innerWidth - width) / 2) + "px;top:" + top + "px;width:" + width +
    "px;height:" + (window.innerHeight - top - 20) + "px;background:#10161c;color:#e8eef4";
  const face = document.createElement("div");
  face.setAttribute("data-onboarding-face", "");
  face.style.cssText = "height:220px;display:flex;align-items:center;justify-content:center";
  // mascots.js reads the mood off the record rather than taking one: needsYou is what makes a face
  // curious (mascot-crew.js moodFor). A console that wants Titan curious while he waits sets that,
  // or writes the mood attribute itself; either way the attribute is what this gate reads.
  face.innerHTML = window.titanAvatarMarkup
    ? window.titanAvatarMarkup({ id: state.agentId, name: "Titan", needsYou: true }, "onboarding-face", "Titan")
    : '<span data-titan-mood="curious"><titan-mascot variant="0" mood="curious"></titan-mascot></span>';
  const strip = document.createElement("div");
  strip.className = "onboarding-strip";
  for (const field of ${JSON.stringify(fields)}) {
    const stepEl = document.createElement("span");
    stepEl.setAttribute("data-onboarding-step", field);
    stepEl.dataset.done = String(Object.hasOwn(state.answers ?? {}, field));
    stepEl.textContent = field;
    strip.appendChild(stepEl);
  }
  const transcript = document.createElement("div");
  transcript.setAttribute("data-onboarding-transcript", "");
  const composer = document.createElement("form");
  composer.setAttribute("data-onboarding-composer", "");
  composer.innerHTML = "<textarea></textarea>";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.setAttribute("data-onboarding-skip", "");
  skip.textContent = "Skip for now";
  dialog.append(face, strip, transcript, composer, skip);
  document.body.appendChild(dialog);
  dialog.showModal();
})()`;

// One page, one fixture. Returns what the modal looked like.
async function renderFixture(browser, onboarding, { reducedMotion = false, standIn = false } = {}) {
  const fixture = fixtureFor(onboarding);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const asked = new Set();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/events") {
      // The console holds this open for the session. Answer it as an empty stream rather than
      // aborting: an aborted EventSource reconnects in a tight loop and floods the arm.
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" });
    }
    if (Object.hasOwn(RELAY_ROUTES, url.pathname)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RELAY_ROUTES[url.pathname]) });
    }
    // Anything that is not a gateway call is a file, and the static server has it.
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const method = url.pathname.slice("/api/".length);
    asked.add(method);
    if (Object.hasOwn(fixture, method)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture[method]) });
    }
    // Exactly what a host without the command answers, so the console takes its own degrade path.
    return route.fulfill({
      status: 404, contentType: "application/json",
      body: JSON.stringify({ error: `unknown gateway method: ${method}` }),
    });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__machineRoomLive !== undefined, null, { timeout: 30_000 }).catch(() => {});
  const live = await page.evaluate(() => window.__machineRoomLive === true);
  if (standIn) {
    await page.waitForSelector(".window-bar", { timeout: 15_000 }).catch(() => {});
    await page.evaluate((s) => { window.__onboardingFixture = s; }, onboarding);
    await page.evaluate(STAND_IN(FIELDS));
  }
  await page.waitForSelector("#onboarding-dialog, dialog.onboarding-dialog", { timeout: standIn ? 5_000 : MODAL_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(1200);
  const modal = await page.evaluate(READ_MODAL);
  return { context, page, modal, live, errors, asked };
}

async function offlineArm() {
  step(SELF_TEST
    ? "the gate's own self-test: the same checks against a stand-in built to the DOM contract"
    : "the fixture render: the console draws the first-run modal with no box behind it");
  const chromium = await loadChromium();
  if (chromium == null) { skip("the whole fixture arm", "playwright-core is not installed"); return; }

  let server;
  try { server = await startStaticServer(STATIC_PORT); }
  catch (error) { skip("the whole fixture arm", `the static server could not start on ${STATIC_PORT}: ${error.message}`); return; }
  info(`the console is served from ${CONSOLE_DIR} on 127.0.0.1:${STATIC_PORT}`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  let first = null;
  let saved = null;
  let done = null;
  try {
    // (a) a fresh box: nothing answered yet.
    first = await renderFixture(browser, { done: false, startedAt: null, completedAt: null, agentId: "fixture-titan", answers: {} }, { standIn: SELF_TEST });
    check(first.live, "the page hydrates against the fixture rather than falling back to demo data",
      first.live ? "window.__machineRoomLive === true" : `__machineRoomLive false: ${first.errors[0] ?? "no page error"}`);
    if (!first.modal.present) {
      const landed = await hostHalf();
      const why = landed.landed
        ? "the host reports onboarding state but the console draws no dialog"
        : `nothing to draw yet: ${landed.why}`;
      if (landed.landed) check(false, "the console opens the onboarding dialog on a box reporting done:false", why);
      else skip("every fixture check", why);
      return;
    }
    check(first.modal.open, "the onboarding dialog is open on a box reporting done:false");
    check(first.modal.top >= (first.modal.barBottom ?? 0) - 1,
      "it comes down below the top bar rather than over it",
      `dialog top ${first.modal.top}px, top bar ends at ${first.modal.barBottom}px`);
    // The width of the stage less its gutter, not edge to edge: the dialog is inset 44px each
    // side (onboarding.css), which is what keeps it reading as a sheet over the console rather
    // than a new page. What this measures is that it is nothing like a Settings-sized card.
    check(first.modal.stageWidth != null && first.modal.stageWidth - first.modal.width <= 96,
      "and it runs the width of the stage, not a settings-sized card",
      `dialog ${first.modal.width}px, stage ${first.modal.stageWidth}px`);
    check(first.modal.isModal,
      "the chat behind it is dimmed and inert, because the dialog is a modal one",
      `::backdrop ${first.modal.backdrop.background || "not readable"}${first.modal.backdrop.blur ? ` ${first.modal.backdrop.blur}` : ""}`);
    check(first.modal.face && (first.modal.faceLive || first.modal.faceStill),
      "Titan's face is in the middle of it, canvas or still",
      first.modal.faceLive ? "titan-mascot canvas" : first.modal.faceStill ? "a still image" : "no face element");
    check(first.modal.faceHeight >= 120, "and it is drawn large, not at roster-card size",
      `${first.modal.faceHeight}px tall`);
    check(first.modal.faceMood === "curious", "waiting on the person, the face is curious",
      first.modal.faceMood ?? "no mood attribute");

    const fields = first.modal.steps.map((s) => s.field);
    check(FIELDS.every((f) => fields.includes(f)) && fields.length === FIELDS.length,
      "the strip carries the five questions and nothing else",
      fields.join(", ") || "no steps drawn");
    check(first.modal.steps.every((s) => s.done === false),
      "with none of them ticked before a word is said",
      `${first.modal.steps.filter((s) => s.done).length} already ticked`);
    check(first.modal.hasSkip && /skip for now/i.test(first.modal.skip),
      "Skip for now is on the dialog in the person's own words", first.modal.skip || "no skip control");
    check(first.modal.hasTranscript && first.modal.hasComposer,
      "the conversation and its composer are inside the dialog, not behind it",
      `transcript ${first.modal.hasTranscript}, composer ${first.modal.hasComposer}`);
    check(first.modal.agentId === "fixture-titan",
      "the dialog says which conversation it is bound to", first.modal.agentId ?? "no data-onboarding-agent");

    // The Add button's count. Titan does not spend one of the twelve, so three agents read as two.
    const addLabel = await first.page.evaluate(() => {
      const button = document.querySelector('[data-capability="add"]');
      if (!button) return null;
      return `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`.replace(/\s+/g, " ").trim();
    });
    const counted = addLabel ? /(\d+)\s+of\s+(\d+)/.exec(addLabel) : null;
    if (SELF_TEST) skip("the Add button says how many of the twelve are used", "the stand-in is the modal only; the Add button is the console's own work");
    else check(counted != null && Number(counted[1]) === FIXTURE_AGENTS.length - 1 && Number(counted[2]) === 12,
      "the Add button says how many of the twelve are used",
      addLabel == null ? "no Add button" : addLabel.slice(0, 80));

    // (b) two answers already saved: the strip has to show the work so far.
    saved = await renderFixture(browser, {
      done: false, startedAt: Date.now() - 60_000, completedAt: null, agentId: "fixture-titan",
      answers: { name: "Jason", location: "Fort Worth, Texas", timeZone: "America/Chicago" },
    }, { standIn: SELF_TEST });
    const ticked = saved.modal.steps.filter((s) => s.done).map((s) => s.field);
    check(ticked.length === 2 && ticked.includes("name") && ticked.includes("location"),
      "a state with two answers in it draws two of five as done", ticked.join(", ") || "none ticked");

    // (c) the migration rule's whole purpose: a box that has been used gets no modal at all.
    done = await renderFixture(browser, {
      done: true, startedAt: 1_700_000_000_000, completedAt: 1_700_000_400_000, agentId: "fixture-titan",
      answers: { name: "Jason" },
    }, { standIn: SELF_TEST });
    check(!done.modal.present || done.modal.open === false,
      "a box reporting done:true opens straight into the console with no modal",
      done.modal.open ? "the dialog was opened anyway" : "the dialog element is in the page and was never opened");
  } finally {
    for (const rendered of [first, saved, done]) await rendered?.context?.close().catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }
}

// ------------------------------------------------------------------ the live arm

// The stub model. It answers the first request that offers save_onboarding_answer by calling it
// with the name, and every request after that in plain words, so the turn settles. Standing this
// up is the only way to measure the loop without spending a real provider turn on it, and it is
// the same shape scripts/verify-loop.mjs uses.
function startStubModel(port, state) {
  const MODEL = "probe-onboarding-model";
  const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta, finish = null) => ({
    id: "probe-onboarding", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
    model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", max_model_len: 32_768, context_length: 32_768 }] }));
    }
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch {}
      const tools = (parsed.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean);
      const contentOf = (role) => (parsed.messages ?? []).filter((m) => m?.role === role)
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
      const system = contentOf("system");
      // The recipe does NOT arrive in the system prompt. `startOnboarding` sends a normal turn whose
      // rich text is one workflow-reference node, and expandWorkflowReferences inlines the seed
      // skill's body into the USER content of that turn. So the user half is the only place the
      // interview's instructions can be measured, and it is kept here for the same reason `system`
      // is: the first turn is the one under test and later turns pile more messages on top of it.
      const user = contentOf("user");
      state.requests += 1;
      if (tools.includes("save_onboarding_answer")) state.sawTool = true;
      if (tools.includes("finish_onboarding")) state.sawFinishTool = true;
      if (state.systemPrompt === "" && system.length > 0) state.systemPrompt = system;
      if (state.userPrompt === "" && user.length > 0) state.userPrompt = user;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // The ending, on the gate's cue rather than on a request count. Titan calls finish_onboarding
      // when he has finished talking, and the arm below only wants that to happen at the point it
      // is measuring it: firing it on the first turn that offers the tool would close the interview
      // before the person has typed anything, and the strip would have nothing to fill with.
      const shouldFinish = state.finishWhenAsked && tools.includes("finish_onboarding") && state.finished === 0;
      if (shouldFinish) {
        state.finished += 1;
        sse(res, chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_finish_1", type: "function", function: { name: "finish_onboarding", arguments: "{}" } }] }));
        sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      const shouldSave = tools.includes("save_onboarding_answer") && state.saved === 0;
      if (shouldSave) {
        state.saved += 1;
        const args = JSON.stringify({ field: "name", value: state.answer });
        sse(res, chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_save_1", type: "function", function: { name: "save_onboarding_answer", arguments: args } }] }));
        sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      } else {
        const line = state.saved === 0
          ? "Hello, I'm Titan. I run your crew. What should I call you?"
          : `Good to meet you, ${state.answer}. Where are you based?`;
        sse(res, chunk({ role: "assistant", content: line }));
        sse(res, { ...chunk({}, "stop"), usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve({ server, model: MODEL }));
  });
}

async function liveArm(landed) {
  step("the box arm: the flag is put back to first-run and the whole loop is walked");
  if (!landed.landed) { skip("every live check", landed.why); return; }
  const chromium = await loadChromium();
  if (chromium == null) { skip("every live check", "playwright-core is not installed"); return; }

  const STUB_ID = "probe-onboarding-stub";
  const stubState = {
    requests: 0, saved: 0, finished: 0, sawTool: false, sawFinishTool: false,
    finishWhenAsked: false, systemPrompt: "", userPrompt: "", answer: "Jason",
  };
  let hooksBefore;
  let hooksTouched = false;
  let stub = null;
  let endpointsTouched = false;
  let previousEndpoint = null;
  let browser = null;
  let context = null;
  let scratchTitan = null;
  try {
    hooksBefore = await readSetting("SAND_TEST_HOOKS");
    await writeSetting("SAND_TEST_HOOKS", "1");
    hooksTouched = true;

    // THE MIGRATION RULE, measured on a box that is not fresh, which is the whole reason it exists.
    // Jason's instance and this Mac must never be thrown into onboarding. Clearing the state and
    // reading it once is the only way to see what a box decides about itself: this box has agents
    // and prompted conversations, so the first read has to answer done:true on its own.
    const roster0 = nonGroupAgents(await must("listAgents").catch(() => []));
    const cleared = await resetOnboarding({ clear: true });
    if (cleared == null || cleared.ok !== true) {
      skip("a used box marks itself done at the first read", `${cleared?.name ?? "resetOnboarding"} does not take { clear: true } yet`);
    } else {
      const firstRead = await must("getOnboardingState");
      check(firstRead?.done === true,
        "a box with agents and a prompted conversation marks itself done at the first read",
        `${roster0.length} agents on this box, and it answered ${JSON.stringify(firstRead ?? {}).slice(0, 120)}`);
    }

    const reset = await resetOnboarding();
    if (reset == null) { skip("every live check", "the box has no resetOnboarding, so the flag cannot be put back safely"); return; }
    check(reset.ok, `${reset.name} puts the box back to first-run under SAND_TEST_HOOKS=1`,
      reset.ok ? "" : `${reset.status} ${reset.text.slice(0, 140)}`);
    if (!reset.ok) return;
    const fresh = await must("getOnboardingState");
    check(fresh?.done === false, "and the box now reports done:false", JSON.stringify(fresh ?? {}).slice(0, 160));

    // The hook must not be a way in for anyone else. With it off, the reset has to be refused --
    // and refused as ITSELF. "Any failure counts" passed here on a relay that was answering 502
    // "SAND_HOST_GATEWAY_TOKEN is stale", which is what a broken deployment looks like and would
    // have gone on passing if the guard had been deleted. The guard's own 403 and its own words,
    // or nothing.
    await writeSetting("SAND_TEST_HOOKS", null);
    const guarded = await resetOnboarding();
    check(guarded != null && guarded.status === 403 && /SAND_TEST_HOOKS/.test(guarded.text),
      "with SAND_TEST_HOOKS unset the same command is refused, in the guard's own words",
      guarded == null ? "the command vanished" : `${guarded.status} ${guarded.text.slice(0, 120)}`);
    await writeSetting("SAND_TEST_HOOKS", "1");

    // A Titan of this arm's own. On a real fresh box the first agent IS Titan and his conversation
    // is empty; on THIS box the oldest agent is a working one carrying a quarter of a million
    // tokens, and a turn dispatched into it never reaches a model inside this arm's patience. The
    // console picks the agent named Titan before it falls back to the oldest, so minting one is
    // also the only way to measure that rule. It is deleted in the finally.
    const madeTitan = await gw("createAgent", { name: "Titan", description: "", origin: "user", isKickstartRequested: false });
    scratchTitan = madeTitan.body?.id ?? madeTitan.body?.agent?.id ?? null;
    check(scratchTitan != null, "a scratch Titan can be made to run the interview on",
      madeTitan.ok ? String(scratchTitan) : `${madeTitan.status} ${String(madeTitan.body?.error ?? madeTitan.text).slice(0, 120)}`);
    if (scratchTitan == null) return;

    // The stub, and the box pointed at it.
    const started = await startStubModel(STUB_PORT, stubState);
    stub = started.server;
    const reachable = (await sh(`curl -s -m 5 -o /dev/null -w '%{http_code}' http://host.docker.internal:${STUB_PORT}/v1/models`)).trim();
    check(reachable === "200", "the box reaches the stub model on this Mac", `host.docker.internal:${STUB_PORT} -> ${reachable || "no answer"}`);
    if (reachable !== "200") return;

    const before = await relay("/endpoints");
    previousEndpoint = (before.endpoints ?? []).find((e) => e.baseUrl === before.live?.baseUrl && e.model === before.live?.model)?.id ?? null;
    if (previousEndpoint == null) { skip("every live check after this one", "the live endpoint could not be identified, so it will not be repinned blindly"); return; }
    const kept = (before.endpoints ?? []).filter((e) => e.id !== STUB_ID).map(({ health, ...row }) => ({ ...row, apiKey: "set" }));
    await relay("/endpoints", { endpoints: [...kept, { id: STUB_ID, name: "onboarding gate stub", baseUrl: `http://host.docker.internal:${STUB_PORT}/v1`, model: started.model, apiKey: "" }] });
    endpointsTouched = true;
    await relay("/endpoints/use", { id: STUB_ID });
    info(`the box is answering through the stub; it was on ${previousEndpoint}`);

    // The console, headless, at the real relay.
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await page.goto(`${RELAY}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__machineRoomLive !== undefined, null, { timeout: 30_000 }).catch(() => {});
    const live = await page.evaluate(() => window.__machineRoomLive === true);
    check(live, "the console comes up live against the box", live ? "" : "it fell back to demo data, so nothing below would mean anything");
    if (!live) return;

    await page.waitForSelector("#onboarding-dialog[open], dialog.onboarding-dialog[open]", { timeout: MODAL_TIMEOUT_MS }).catch(() => {});
    const modal = await page.evaluate(READ_MODAL);
    check(modal.present && modal.open, "the modal opens by itself on a box reporting done:false",
      modal.present ? "" : "no onboarding dialog in the page");
    if (!modal.present || !modal.open) return;
    const agentId = modal.agentId;
    check(typeof agentId === "string" && agentId.length > 0, "and it names the conversation it is bound to", agentId ?? "none");
    const roster = nonGroupAgents(await must("listAgents"));
    const bound = roster.find((a) => a.id === agentId) ?? null;
    check(bound != null, "which is a real agent on this box", bound ? `${bound.name} (${agentId})` : `${agentId} is on no roster`);
    check(agentId === scratchTitan, "and it is the agent named Titan, not whichever one is oldest",
      bound ? `${bound.name} (${agentId})` : String(agentId));

    // The console sends Titan's first message itself: createFallbackSession never sets
    // introductionPending, so kickstartAgent does not fire on a fresh box's first agent.
    const opened = Date.now();
    let entries = [];
    while (Date.now() - opened < TURN_TIMEOUT_MS) {
      const answer = await must("getAgentTranscript", { id: agentId }).catch(() => []);
      entries = Array.isArray(answer) ? answer : Array.isArray(answer?.entries) ? answer.entries : [];
      if (stubState.requests > 0) break;
      await sleep(2000);
    }
    check(stubState.requests > 0, "opening the modal starts Titan's first turn without anyone typing",
      `${stubState.requests} model call(s) in ${Math.round((Date.now() - opened) / 1000)}s, ${entries.length} transcript rows`);
    // THE PROMPT, not the flag. `save_onboarding_answer` being on offer says only that the box's
    // settings record reads done:false; it is true whether or not the recipe ever reached the
    // model. The recipe reaches it through expandWorkflowReferences, which is a silent `continue`
    // when the seed skill is not in that agent's workflow store -- the same branch that once
    // swallowed learn-from-demonstration whole. A box in that state ships a Titan who gets
    // "Let's get set up." and nothing else, so the interview's own words are what has to be read
    // off the wire. Two lines of the recipe rather than one, so a stray match cannot carry it.
    const RECIPE_MARKERS = ["# First-time setup", "Ask the five"];
    const carried = RECIPE_MARKERS.filter((marker) => stubState.userPrompt.includes(marker));
    check(carried.length === RECIPE_MARKERS.length,
      "the onboarding recipe is on the turn: the setup skill's own body is inlined into the first prompt",
      carried.length === RECIPE_MARKERS.length
        ? `${stubState.userPrompt.length} characters of user content, carrying ${carried.map((m) => JSON.stringify(m)).join(" and ")}`
        : `${stubState.userPrompt.length} characters of user content, missing ${RECIPE_MARKERS.filter((m) => !carried.includes(m)).map((m) => JSON.stringify(m)).join(" and ")}`);
    check(stubState.sawTool, "and the interview tool is on offer: the model is handed save_onboarding_answer",
      stubState.sawTool ? "" : "the turn ran with no such tool on offer");
    if (stubState.systemPrompt.length > 0) info(`the system prompt on that turn was ${stubState.systemPrompt.length} characters`);

    // The person answers. Typed into the modal's own composer, which is the thing under test.
    const composer = "#onboarding-dialog [data-onboarding-composer] textarea, dialog.onboarding-dialog [data-onboarding-composer] textarea";
    const typed = await page.$(composer);
    check(typed != null, "the modal's composer takes the answer", typed == null ? "no composer inside the dialog" : "");
    if (typed != null) {
      await page.fill(composer, stubState.answer);
      await page.press(composer, "Enter");
      const until = Date.now() + STRIP_TIMEOUT_MS;
      let filled = null;
      while (Date.now() < until) {
        const now = await page.evaluate(READ_MODAL);
        if (now.steps.some((s) => s.field === "name" && s.done)) { filled = now; break; }
        await sleep(2000);
      }
      check(filled != null, "the name lights up on the strip once it is saved",
        filled ? `${filled.steps.filter((s) => s.done).length} of ${filled.steps.length} done` : `nothing lit in ${STRIP_TIMEOUT_MS / 1000}s`);
      const state = await must("getOnboardingState");
      check(state?.answers?.name === stubState.answer,
        "and the answer really is in the box's own state, not only on screen",
        JSON.stringify(state?.answers ?? {}).slice(0, 160));
    }

    // Skip for now: the modal closes and the box is marked done with what was captured.
    await page.click("#onboarding-dialog [data-onboarding-skip], dialog.onboarding-dialog [data-onboarding-skip]").catch(() => {});
    await page.waitForTimeout(2500);
    const after = await page.evaluate(READ_MODAL);
    check(!after.present || after.open === false, "Skip for now closes the modal",
      after.open ? "the dialog is still open" : "");
    const closed = await must("getOnboardingState");
    check(closed?.done === true, "and the box is marked done", JSON.stringify(closed ?? {}).slice(0, 120));
    check(closed?.answers?.name === stubState.answer,
      "with the answer that was given kept rather than thrown away",
      JSON.stringify(closed?.answers ?? {}).slice(0, 120));
    check(closed?.doneReason === "skipped",
      "and the box was told it was a skip rather than a finish",
      `doneReason ${JSON.stringify(closed?.doneReason ?? null)}`);

    // THE ENDING. Everything above measures the way OUT of the dialog; this measures the way it is
    // meant to end, which is Titan closing it himself. The record is put back to first run, the
    // page is reloaded so the modal comes up again on the same half-finished conversation, and then
    // the stub does what the recipe tells Titan to do at the end of section 5: call
    // finish_onboarding. Nobody clicks anything from here on.
    await resetOnboarding();
    const beforeReload = await must("getAgentTranscript", { id: agentId }).catch(() => []);
    const openingsBefore = openingCount(beforeReload);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#onboarding-dialog[open], dialog.onboarding-dialog[open]", { timeout: MODAL_TIMEOUT_MS }).catch(() => {});
    const reopened = await page.evaluate(READ_MODAL);
    check(reopened.present && reopened.open, "the modal comes back on a box put back to first run",
      reopened.open ? "" : "the dialog did not reopen, so the ending cannot be measured here");
    if (reopened.present && reopened.open) {
      // The console asks for Titan's opening every time it opens the modal. On a conversation he has
      // already opened, the box has to refuse to say it twice: a second "Let's get set up." dropped
      // on a half-finished interview restarts it under the person.
      await sleep(4000);
      const afterReload = await must("getAgentTranscript", { id: agentId }).catch(() => []);
      check(openingCount(afterReload) === openingsBefore,
        "and reopening it does not start Titan over: the opening line is asked for once per box",
        `${openingsBefore} opening line(s) before the reload, ${openingCount(afterReload)} after`);

      stubState.finishWhenAsked = true;
      await gw("sendPrompt", { agentId, clientNonce: `onboarding-gate-${Date.now()}`, prompt: "That is everything, thanks." });
      const until = Date.now() + STRIP_TIMEOUT_MS;
      let ended = null;
      while (Date.now() < until) {
        const now = await must("getOnboardingState").catch(() => null);
        if (now?.done === true) { ended = now; break; }
        await sleep(2000);
      }
      check(ended != null, "Titan closes first-time setup himself with finish_onboarding",
        ended ? `doneReason ${JSON.stringify(ended.doneReason)}, ${stubState.finished} call(s)` : `the record still read done:false after ${STRIP_TIMEOUT_MS / 1000}s`);
      check(stubState.sawFinishTool, "which was on offer beside the save tool for the whole interview",
        stubState.sawFinishTool ? "" : "no turn was ever handed finish_onboarding");
      // The reason, not just the flag: a person who sat through the whole interview must not be
      // recorded as having skipped it. The answers are empty here only because resetOnboarding
      // above cleared them; what they do on a real box is measured on the skip path.
      check(ended?.doneReason === "completed",
        "and the record says finished rather than skipped",
        `doneReason ${JSON.stringify(ended?.doneReason ?? null)}, answers ${JSON.stringify(ended?.answers ?? {}).slice(0, 80)}`);
      // The dialog is watching the box, so nobody has to press anything for it to go away.
      await page.waitForTimeout(4000);
      const gone = await page.evaluate(READ_MODAL);
      check(!gone.present || gone.open === false,
        "and the setup window closes on its own, with nobody pressing anything",
        gone.open ? "the dialog is still open after the box said done" : "");
    }

    // One leg this arm does NOT measure, said out loud rather than left to be assumed covered:
    // the stub answers the name only, so nothing here proves the location answer reaches
    // setHostSettings { userTimeZone }. Measuring it would write a time zone onto this Mac's box,
    // which is a real setting the scheduler reads. docs/ONBOARDING.md §7 carries it as open.
    skip("the location answer sets the box's time zone", "this arm answers the name only, on purpose");

    // The console behind it is the ordinary one, with Titan selected.
    const selected = await page.evaluate(() => {
      const active = document.querySelector(".worker-card.is-active, .worker-card[aria-current=true]");
      return active ? (active.querySelector(".worker-name")?.textContent ?? "").trim() : null;
    });
    check(selected != null && (bound == null || selected === bound.name),
      "the console behind it opens on the agent the modal was bound to",
      selected ?? "no card is marked active");

    // The Add button's count, live. Titan does not spend one of the twelve.
    const addLabel = await page.evaluate(() => {
      const button = document.querySelector('[data-capability="add"]');
      if (!button) return null;
      return `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`.replace(/\s+/g, " ").trim();
    });
    const counted = addLabel ? /(\d+)\s+of\s+(\d+)/.exec(addLabel) : null;
    check(counted != null && Number(counted[2]) === 12 && Number(counted[1]) === Math.max(roster.length - 1, 0),
      "the Add button counts this box against the twelve",
      addLabel == null ? "no Add button" : `${addLabel.slice(0, 60)} (roster ${roster.length})`);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (scratchTitan != null) {
      await gw("deleteAgent", { id: scratchTitan }).catch(() => {});
      info(`the scratch Titan ${scratchTitan} was deleted`);
    }
    if (endpointsTouched && previousEndpoint != null) {
      await relay("/endpoints/use", { id: previousEndpoint }).catch(() => {});
      const now = await relay("/endpoints").catch(() => ({ endpoints: [] }));
      const kept = (now.endpoints ?? []).filter((e) => e.id !== STUB_ID).map(({ health, ...row }) => ({ ...row, apiKey: "set" }));
      await relay("/endpoints", { endpoints: kept }).catch(() => {});
      info(`the box is back on ${previousEndpoint}`);
    }
    stub?.close();
    if (hooksTouched) {
      await writeSetting("SAND_TEST_HOOKS", hooksBefore == null ? null : hooksBefore);
      info(`SAND_TEST_HOOKS put back to ${hooksBefore == null ? "unset" : String(hooksBefore)}`);
    }
  }
}

// ------------------------------------------------------------------ the cap arm

async function capArm(landed) {
  step("the ceiling: Titan and twelve, refused in words a business owner reads");
  const chromium = await loadChromium();
  let capBefore;
  let capTouched = false;
  let minted = null;
  let room = null;
  let browser = null;
  let context = null;
  try {
    const roster = nonGroupAgents(await must("listAgents").catch(() => []));
    const inclusive = await must("countAgents").catch(() => null);
    if (roster.length === 0) { skip("every ceiling check", "listAgents answered nothing, so there is no roster to cap"); return; }
    info(`this box holds ${roster.length} agents and ${Number(inclusive) - roster.length} group(s)`);

    capBefore = await readSetting("SAND_MAX_AGENTS");
    capTouched = true;
    // The default, with nothing set. Read where the host publishes it rather than assumed.
    await writeSetting("SAND_MAX_AGENTS", null);
    const status = await must("getHostStatus").catch(() => null);
    const stateCap = landed.landed ? (await must("getOnboardingState").catch(() => null))?.maxAgents : null;
    const published = Number(status?.maxAgents ?? stateCap ?? NaN);
    if (!Number.isFinite(published)) {
      // The console cannot draw "n of 12" from a number nobody publishes, so an absent one means
      // the ceiling half of this wave has not shipped. That is not the same as an unenforced cap,
      // and calling it a failure here would be reporting an unbuilt feature as a broken one.
      skip("every ceiling check", "the box publishes no maxAgents on getHostStatus or getOnboardingState yet");
      return;
    }
    check(published === 13, "with nothing set the box's ceiling is 13, Titan and twelve", String(published));

    // The population the ceiling is actually enforced against, asked of the host rather than
    // counted off listAgents. They are not always the same number: an agent can hold a directory
    // the roster does not draw, and on this box they differ by one. Sizing the fake roster off
    // the console's view instead made the last check below fail against a correct product.
    const capacity = await must("getAgentCapacity").catch(() => null);
    const bots = Number.isFinite(Number(capacity?.bots)) ? Number(capacity.bots) : roster.length;
    if (capacity == null) info("the box has no getAgentCapacity; the roster's own count is standing in");
    else info(`the host counts ${bots} bots where the roster draws ${roster.length} and countAgents says ${inclusive}`);

    // A room is not a bot, measured rather than argued: make one, and the number the ceiling
    // reads must not move while the inclusive count does. Made before the ceiling comes down, so
    // nothing here depends on rooms being exempt from a cap that is already reached.
    const madeRoom = await gw("createGroup", { name: `probe-cap-room-${Math.random().toString(36).slice(2, 6)}`, description: "", memberAgentIds: roster.slice(0, 2).map((a) => a.id) });
    room = madeRoom.body?.id ?? madeRoom.body?.agent?.id ?? null;
    if (room == null) skip("a room does not spend one of the thirteen", `createGroup answered ${madeRoom.status} ${String(madeRoom.body?.error ?? madeRoom.text).slice(0, 100)}`);
    else {
      const withRoom = await must("getAgentCapacity").catch(() => null);
      const inclusiveNow = await must("countAgents").catch(() => null);
      check(Number(withRoom?.bots) === bots && Number(inclusiveNow) === Number(inclusive) + 1,
        "a room does not spend one of the thirteen",
        `bots ${bots} -> ${withRoom?.bots}, countAgents ${inclusive} -> ${inclusiveNow}`);
    }

    // The fake roster: move the ceiling down to what is already here rather than minting twelve.
    await writeSetting("SAND_MAX_AGENTS", String(bots));
    capTouched = true;
    const refused = await gw("createAgent", { name: `probe-cap-${Math.random().toString(36).slice(2, 7)}`, description: "", origin: "user", isKickstartRequested: false });
    const message = typeof refused.body === "string" ? refused.body : (refused.body?.error ?? refused.text);
    check(refused.ok === false, "at the ceiling, createAgent is refused", `${refused.status} ${String(message).slice(0, 140)}`);
    const said = REFUSAL.exec(String(message));
    check(said != null, "in one plain sentence that tells the person what to do", String(message).slice(0, 160));
    check(said != null && Number(said[1]) === bots - 1,
      "counting from the ceiling in force, so a box at 13 reads twelve",
      said ? `${said[1]} with the ceiling at ${bots}` : "no sentence to count");
    check(!JARGON.test(String(message)), "with no status code, class name or machine word in it", String(message).slice(0, 120));
    check(refused.status === 409, "and the wire says refused rather than broken", `HTTP ${refused.status}`);

    const cloned = await gw("duplicateAgent", { id: roster[0].id });
    check(cloned.ok === false && REFUSAL.test(String(cloned.body?.error ?? cloned.text)),
      "duplicateAgent is refused the same way, not just createAgent",
      `${cloned.status} ${String(cloned.body?.error ?? cloned.text).slice(0, 120)}`);

    const after = nonGroupAgents(await must("listAgents"));
    check(after.length === roster.length, "and neither refusal left a half-made agent behind",
      `${after.length} agents, was ${roster.length}`);

    // One place under the ceiling and the same create goes through: the refusal above is a
    // ceiling being read, not a wall the box hit for some other reason.
    await writeSetting("SAND_MAX_AGENTS", String(bots + 1));
    const allowed = await gw("createAgent", { name: `probe-cap-${Math.random().toString(36).slice(2, 7)}`, description: "", origin: "user", isKickstartRequested: false });
    minted = allowed.body?.id ?? allowed.body?.agent?.id ?? null;
    check(allowed.ok && minted != null,
      "one place under the ceiling and the same create goes through",
      allowed.ok ? `made ${minted}` : `${allowed.status} ${String(allowed.body?.error ?? allowed.text).slice(0, 120)}`);

    // The refusal a person actually sees: the toast the console raises on the Add form.
    if (chromium == null) { skip("the refusal as a toast in the console", "playwright-core is not installed"); }
    else if (minted == null) { skip("the refusal as a toast in the console", "the ceiling test could not put the box back at its cap"); }
    else {
      await writeSetting("SAND_MAX_AGENTS", String(bots + 1));
      browser = await chromium.launch({ executablePath: CHROME, headless: true });
      context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const page = await context.newPage();
      await page.goto(`${RELAY}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__machineRoomLive === true, null, { timeout: 30_000 }).catch(() => {});
      // Close the first-run modal if this box happens to be showing one, or the Add button is inert.
      await page.click("#onboarding-dialog [data-onboarding-skip], dialog.onboarding-dialog [data-onboarding-skip]").catch(() => {});
      await page.click('[data-capability="add"]');
      await page.waitForSelector("form[data-add-worker] #worker-name", { timeout: 15_000 });
      await page.fill("form[data-add-worker] #worker-name", `probe-cap-toast-${Math.random().toString(36).slice(2, 6)}`);
      await page.click("form[data-add-worker] button[type=submit]");
      await page.waitForTimeout(3000);
      const toast = await page.evaluate(() => (document.querySelector("#toast")?.textContent ?? "").replace(/\s+/g, " ").trim());
      check(REFUSAL.test(toast), "the console says it in the same words, as a toast", toast.slice(0, 160) || "the toast said nothing");
      check(!JARGON.test(toast), "and the toast carries no machine words either", toast.slice(0, 120));
      const settled = await must("getAgentCapacity").catch(() => null);
      check(Number(settled?.bots) === bots + 1, "and the refused create made nothing",
        `${settled?.bots} bots, expected ${bots + 1}`);
    }
  } finally {
    if (minted != null) {
      await gw("deleteAgent", { id: minted }).catch(() => {});
      info(`the probe agent ${minted} was deleted`);
    }
    if (room != null) {
      await gw("deleteAgent", { id: room }).catch(() => {});
      info(`the probe room ${room} was deleted`);
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (capTouched || capBefore !== undefined) {
      await writeSetting("SAND_MAX_AGENTS", capBefore == null ? null : capBefore);
      info(`SAND_MAX_AGENTS put back to ${capBefore == null ? "unset" : String(capBefore)}`);
    }
  }
}

// ------------------------------------------------------------------ run

const landed = await hostHalf();
if (!landed.reachable) {
  // The fixture arm needs nothing but this repo and a browser, so a relay that is down only
  // takes the two box arms with it.
  console.log(`  INFO  the relay at ${RELAY} did not answer: ${landed.why}`);
  console.log("  INFO  start it the way docs/OPERATOR-RUNBOOK.md says under Start it, or run --offline alone.");
} else if (!landed.landed) {
  console.log(`  INFO  ${landed.why}`);
  console.log("  INFO  the fixture arm still runs; the box arms report themselves unmeasured.");
} else {
  console.log(`  INFO  the box answers getOnboardingState: ${JSON.stringify(landed.state).slice(0, 160)}`);
}

try {
  if (want("--offline")) await offlineArm();
  if (want("--live")) {
    if (!landed.reachable) { step("the box arm"); skip("every live check", "the relay did not answer"); }
    else await liveArm(landed);
  }
  if (want("--cap")) {
    if (!landed.reachable) { step("the ceiling"); skip("every ceiling check", "the relay did not answer"); }
    else await capArm(landed);
  }
} catch (error) {
  console.log(`  FAIL  the run stopped early -- ${String(error?.message ?? error).slice(0, 300)}`);
  failures += 1;
}

if (SELF_TEST) {
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${passes} passed, ${failures} failed, ${notMeasured} not measured`);
  console.log("        this run measured the GATE against a stand-in built to the DOM contract.");
  console.log("        it says nothing about the box or the console. Run without --self-test for that.");
  process.exit(failures === 0 ? 0 : 1);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${passes} passed, ${failures} failed, ${notMeasured} not measured`);
if (failures > 0) process.exit(1);
// A run where the wave itself is not on the box has measured nothing this gate exists to measure,
// whatever else passed along the way. Exit 2 says that out loud rather than reporting green.
if (!landed.landed) {
  console.log("        the onboarding wave is not on this box yet, so this run proves nothing about it.");
  process.exit(2);
}
if (passes === 0) process.exit(2);
process.exit(0);
