// BOX-6b. Repairing a conversation store from the product, measured rather than asserted.
//
// THE FAILURE. Measured on the demo tenant's box `titanbot-box-atonqjq7zx593jsacaccpfau`,
// 2026-09-09, read-only: agent c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5 had failed EVERY turn since
// 2026-09-07 23:00Z, eighteen times in one log, with
//
//   [sand][turn] agent run failed for c63fdce4-… TranscriptJournalCorruptionError:
//   transcript checkpoint must recover before preparing
//
// and each time the console told the person "Titan could not finish that one. Ask again, or send
// the details to the developers." Asking again fails identically for ever. Both of that agent's
// databases passed PRAGMA integrity_check, its store held 115 transcript entries and 5,002
// conversation blobs, and there was no quarantine file anywhere: nothing on disk was corrupt. The
// damage was a durable route marker plus a recovery the turn path never called.
//
// WHAT THIS GATE MEASURES.
//
//   node scripts/verify-transcript-repair.mjs          the console: real Chrome, a stub relay, the
//                                                      whole arc -- the sentence, the pill, the
//                                                      control, a real mouse click on Repair at
//                                                      real screen coordinates, and a turn after it
//   node scripts/verify-transcript-repair.mjs --box     grok-bot-local-vm: the verb itself, and a
//                                                      scratch agent damaged with the marker so the
//                                                      host's own recovery is what fixes it
//   node scripts/verify-transcript-repair.mjs --all     both, console first
//
// The default leg is deliberately box-free. It is the leg that proves what a person sees, it runs
// in seconds, and it does not queue behind /tmp/titanbot-box.lock. The box leg goes through the
// docker CLI and fits inside the 300 s verify-runner ceiling.
//
// A passing page.click() is not evidence a human can click (verify-ui-in-a-real-browser.md), so
// every press below is hit-tested with elementFromPoint first and then made with page.mouse at the
// control's own screen coordinates.
//
// A SKIP is not a PASS. Each one is named, counted and printed in the summary, so a run that could
// not reach the box never reads as a green run.
//
// THE R750 LEG IS NOT HERE, ON PURPOSE. It is run by hand, once, against a real customer-facing
// agent, and it is written up in docs/BOX-STORE.md: back the agent's directory up inside the box
// with `cp -a` FIRST and name the path, repair THROUGH THE PRODUCT (the console's own Repair
// control at https://console.titanium.bot, or the verb through the gateway if the console leg
// cannot reach it), then send the agent one message and read its answer. Richard's box
// `titanbot-box-wepegxhh3fpvr83bubvz5xm5` is a real customer's and this wave never touches it: it
// carries no journal-mode marker and no corruption line in its host log.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A worktree has no .cache of its own; the shared checkout is where playwright-core is installed.
const PW_CANDIDATES = [
  process.env.GROK_BOT_PLAYWRIGHT_DIR,
  path.join(repoRoot, ".cache/playwright"),
  "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/playwright",
].filter(Boolean);
const PW_DIR = PW_CANDIDATES.find((dir) => existsSync(path.join(dir, "package.json"))) ?? PW_CANDIDATES[1];
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
// Every request this gate makes says who it is.
const UA = "titanbot-gate/verify-transcript-repair";
const MODE = process.argv.includes("--all") ? "all" : process.argv.includes("--box") ? "box" : "console";
// The refusal shape adds a fourth model turn, which does not fit the 300 s ceiling beside the
// other three. Run it on its own: `--box --refuse`.
const REFUSE = process.argv.includes("--refuse");

// The demo Titan's own error, word for word out of that box's /tmp/sand-host.log.
const DEMO_TITAN_ERROR = "TranscriptJournalCorruptionError: transcript checkpoint must recover before preparing";
const SENTENCE = "This agent's conversation store needs repair. Repair it from the agent's details panel.";

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pictures, for the operator who reads a report rather than a gate log. Off unless a directory is
// named, so the gate's own cost does not move: BOX6B_SHOT_DIR=<dir> node scripts/verify-transcript-repair.mjs
const SHOT_DIR = process.env.BOX6B_SHOT_DIR?.trim() ?? "";
async function shot(page, name) {
  if (SHOT_DIR === "") return;
  try { await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }); console.log(`  SHOT  ${name}.png`); }
  catch (error) { console.log(`  SHOT  ${name}.png failed: ${error.message}`); }
}

// ================================================================================================
// The console leg. A stub relay, the real page, real Chrome, real mouse coordinates.
// ================================================================================================

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };

/**
 * The smallest relay the page comes up against. Two agents on purpose: Titan fails on a store that
 * needs repairing, Scribe fails the ordinary way. Without the second one a console that painted the
 * repair pill on every failure would pass this gate.
 */
function stubRelay(root) {
  const repairs = [];
  const sent = [];
  // What listAgents says about Titan. The host's own flag is deliberately absent at first: a box
  // whose bundle predates the host half must still show the pill off the failure it just saw.
  let titanFlag = null;
  let trays = [
    { id: "t-titan", kind: "error", agentId: "titan", title: "Agent failed to respond", detail: DEMO_TITAN_ERROR },
    { id: "t-scribe", kind: "error", agentId: "scribe", title: "Agent failed to respond", detail: "fetch failed" },
  ];
  // Scribe is first on purpose, so it is the conversation the page opens on and Titan is the agent
  // the person walks over to. That is the real shape of this failure -- you are reading one agent
  // when another one dies -- and it is the only shape in which the adapter's line into the
  // conversation can be measured at all: for the ACTIVE context, reloadTrays pushes the note and
  // loadContext replaces that record's messages wholesale in the same cycle, before a paint. That
  // is UX-ERR-3, it predates this wave, and it is exactly why the card carries the words too.
  const agents = () => [
    { id: "scribe", name: "Scribe", isGroup: false, createdAt: 1, unreadCount: 0, lastMessagePreview: "" },
    { id: "titan", name: "Titan", isGroup: false, createdAt: 2, unreadCount: 0, lastMessagePreview: "", ...(titanFlag ? { transcriptNeedsRepair: titanFlag } : {}) },
  ];
  const transcripts = {
    titan: [{ id: "e1", kind: "message", role: "user", content: "what is on the box?", timestampMs: 1 }],
    scribe: [{ id: "s1", kind: "message", role: "user", content: "hello", timestampMs: 1 }],
  };
  const answers = {
    listAgents: () => agents(),
    countAgents: () => 2,
    getAgentCapacity: () => ({ used: 2, max: 40 }),
    isGlobalSearchEnabled: () => false,
    getHostStatus: () => ({ hostVersion: "0.18.0-gate", capabilities: ["sendAcceptanceV1"], isBusy: false }),
    getOnboardingState: () => ({ done: true, maxAgents: 40 }),
    getTrays: () => { const out = trays; trays = []; return out; },
    dismissTray: () => ({ ok: true }),
    getAgentTranscript: (body) => ({ entries: transcripts[body?.id] ?? [], hasOlder: false }),
    getAgentTranscriptTail: (body) => ({ entries: transcripts[body?.id] ?? [], hasOlder: false, partial: false }),
    getAgentThread: (body) => ({ entries: transcripts[body?.id] ?? [], outline: [], hasOlder: false }),
    listProblemReports: () => ({ reports: [] }),
    // BOX-6b, the verb. 115 entries is the demo Titan's real count, measured on the R750.
    // `quarantined: null` is the answer the one real case in production gives: both of its
    // databases were healthy and there was nothing to move aside.
    repairAgentTranscript: (body) => {
      repairs.push(body);
      titanFlag = null;
      return { before: 115, after: 115, quarantined: null, outcome: "repaired" };
    },
    // A turn after the repair. The reply lands in the transcript the next read returns, which is
    // how the page shows it.
    sendPrompt: (body) => {
      sent.push(body);
      const id = body?.agentId ?? body?.id ?? "titan";
      transcripts[id] = [
        ...(transcripts[id] ?? []),
        { id: `u-${sent.length}`, kind: "message", role: "user", content: String(body?.prompt ?? ""), timestampMs: Date.now() },
        { id: `a-${sent.length}`, kind: "send-message", message: { type: "text", content: "Everything is back. I can read this conversation again." }, timestampMs: Date.now() + 1 },
      ];
      return { accepted: true, clientNonce: body?.clientNonce ?? null };
    },
    promptAcceptanceStatus: () => ({ accepted: true }),
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* empty */ }
      const method = url.pathname.replace(/^\/api\//, "");
      const answer = answers[method];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer ? answer(body) : null));
      return;
    }
    if (url.pathname === "/events") {
      // The host pushes; the adapter debounces and re-reads. Two nudges: one that brings the trays
      // inside this gate's lifetime, one after the send.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const push = () => { try { response.write(`data: ${JSON.stringify({ channel: "agents" })}\n\n`); } catch { /* gone */ } };
      setTimeout(push, 1200);
      const beat = setInterval(push, 3000);
      request.on("close", () => clearInterval(beat));
      return;
    }
    if (["/subscriptions", "/endpoints", "/model", "/connectors"].includes(url.pathname)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(url.pathname === "/model" ? { model: "gate", endpoint: "gate" } : {}));
      return;
    }
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      const body = await readFile(path.join(root, file.replace(/^\/+/, "")));
      response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch { response.writeHead(404); response.end("no"); }
  });
  return { server, repairs, sent, raiseHostFlag(reason) { titanFlag = reason ? { reason } : true; } };
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** A control's own screen coordinates, and what a person's pointer would actually land on there. */
const targetOf = (page, selector) => page.evaluate((sel) => {
  const button = document.querySelector(sel);
  if (!button) return null;
  const box = button.getBoundingClientRect();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, width: box.width, height: box.height, reaches: button === hit || button.contains(hit), text: button.textContent };
}, selector);

async function consoleLeg() {
  const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
  const relay = stubRelay(path.join(repoRoot, "ui/machine-room"));
  const port = await listen(relay.server);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: UA });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (event) => errors.push(String(event)));
    // Every frame of the conversation this page ever drew. MEASURED by FEEDBACK-1 on
    // grok-bot-local-vm and written up in drainFailedTurnOffers: the note the adapter pushes into
    // the conversation does NOT survive, because reloadTrays runs first and then loadContext
    // replaces that record's messages wholesale. It is on screen for a tick and then it is gone.
    // Reading `.transcript` once, seconds later, would therefore measure the wipe rather than the
    // sentence -- so this records what the person's screen actually showed, over the whole boot.
    await page.addInitScript(() => {
      window.__conversationFrames = [];
      setInterval(() => {
        const node = document.querySelector(".transcript");
        if (!node) return;
        const text = node.innerText;
        if (text && window.__conversationFrames.at(-1) !== text) window.__conversationFrames.push(text);
      }, 120);
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    await page.waitForTimeout(4500);

    check(await page.evaluate(() => window.__machineRoomLive === true),
      "the page came up against the gateway rather than falling back to the demo adapter");

    // ---- the roster, before anything is opened ---------------------------------------------------
    // The pill has to be readable from the sidebar without opening the conversation. That is the
    // whole point of it: the person is looking at another agent when this one stops.
    const roster = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".worker-card")];
      const read = (id) => {
        const node = cards.find((el) => el.dataset.contextId === id);
        const pill = node?.querySelector(".needs-repair-pill");
        return { found: node != null, pill: pill?.textContent ?? null, title: pill?.getAttribute("title") ?? "" };
      };
      const count = document.querySelector("[data-needs-you-count]");
      return { titan: read("titan"), scribe: read("scribe"), needsYou: count?.hidden === false ? count.textContent : "" };
    });
    check(roster.titan.pill === "Needs repair", "the roster row carries the needs-repair pill", roster.titan.pill ?? "no pill");
    check(/Agent details/.test(roster.titan.title), "and the pill says where to go", roster.titan.title || "no title");
    // The control leg. Without it a console that pilled every failure would read green here.
    check(roster.scribe.found && roster.scribe.pill === null,
      "an ordinary failed turn gets no repair pill", roster.scribe.pill ?? "none, correctly");
    check(roster.needsYou === "", "and the 'N need you' count is not inflated by a stopped machine", roster.needsYou || "hidden, correctly");
    await shot(page, "01-roster-needs-repair-pill");

    // ---- the person walks over to the agent that stopped -----------------------------------------
    await page.click('.worker-card[data-context-id="titan"]', { timeout: 8000 });
    await page.waitForTimeout(2500);

    // ---- the sentence, in the conversation -------------------------------------------------------
    // MEASURED HERE, 2026-09-09, and it is why the card below matters more than it looks: every
    // frame this page drew of Titan's conversation is recorded above, and the adapter's own pushed
    // line is in NONE of them. reloadTrays pushes it and loadContext replaces that record's
    // messages wholesale in the same cycle, with no paint in between -- for the active context and
    // for one you walk over to, because opening a conversation loads it. That is UX-ERR-3 and it
    // predates this wave. The line is written, and the unit test pins its words, so the day the
    // note survives or the host's own turn-failed row lands it says the right thing; today the
    // card is the surface a person actually reads. The gap row carries this as owned.
    const frames = await page.evaluate(() => window.__conversationFrames ?? []);
    // `BOX6B_DEBUG=1` prints every frame, which is how the finding above was made and how the next
    // person will check whether it is still true.
    if (process.env.BOX6B_DEBUG) console.log(JSON.stringify(frames, null, 1));
    const titanFrames = frames.filter((frame) => /what is on the box\?/.test(frame));
    check(titanFrames.length > 0, "the agent that stopped is the conversation on screen", `${titanFrames.length} frames of it`);
    check(titanFrames.every((frame) => !/could not finish that one/.test(frame)),
      "and this console never tells this person to ask again, which fails identically every time");
    check(frames.every((frame) => !/transcript checkpoint must recover/.test(frame)),
      "the machine's own spelling stays out of the conversation");

    // ---- the sentence, on the card that stays ---------------------------------------------------
    // UX-ERR-3 measured that the turn-failed row often never lands and the adapter's note is
    // replaced by the next transcript read. The card is the part that survives, so the clause has
    // to be on it too.
    const card = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")]
        .find((el) => /conversation store/.test(el.textContent));
      // The description a person reads AND edits is the textarea's value, not the card's text.
      return node ? { text: node.textContent, body: node.querySelector("textarea")?.value ?? "" } : null;
    });
    check(card != null, "the failure produced a card the person can send on");
    if (card) {
      check(card.text.includes(SENTENCE) || card.body.includes(SENTENCE),
        "and the card leads with the same sentence, not a second wording");
      check(/every turn for Titan will end this way/.test(card.body), "it says the retry is pointless, in plain words");
      // The technical half rides on the card, where it is editable and where the developers need
      // it. MEASURED: the class name itself comes out `Tran…[redacted, 32 chars]` -- the console's
      // secret masker treats any run of 32 or more word characters as a token, and
      // `TranscriptJournalCorruptionError` is exactly 32. That is a false positive in a masker this
      // wave will not loosen: it guards what leaves the workspace, and trading that for a readable
      // class name is the wrong trade. The half that names the failure survives it, so that is what
      // is asserted. The over-match is written up as owned in the gap row.
      check(/transcript checkpoint must recover before preparing/.test(card.body),
        "the technical half is in the editable body, where the developers need it");
    }

    // ---- the header says it too -------------------------------------------------------------------
    const header = await page.evaluate(() => {
      const pill = document.getElementById("header-needs-you");
      return { hidden: pill?.hidden !== false, text: pill?.textContent ?? "", repair: pill?.classList.contains("needs-repair-pill") === true };
    });
    check(header.hidden === false && header.text === "Needs repair" && header.repair,
      "the conversation you are looking at says it is stopped, without a trip back to the sidebar",
      header.hidden ? "hidden" : `${header.text}${header.repair ? "" : " (wrong class)"}`);

    // ---- the control ------------------------------------------------------------------------------
    // The person's own route to it: the Agent details row on the context card, then the panel.
    await page.click('[data-context-action="profile"]', { timeout: 8000 });
    await page.waitForTimeout(900);
    const control = await targetOf(page, '[data-repair-transcript="titan"]');
    check(control != null, "the Repair control is on the agent's details panel");
    check(control != null && control.width > 20 && control.height > 12,
      "it is a real target with a real size", control ? `${Math.round(control.width)}x${Math.round(control.height)}` : "missing");
    check(control?.reaches === true, "and nothing is sitting on top of it");
    const promise = await page.evaluate(() => {
      const section = document.querySelector('[data-repair-for="titan"]');
      return section ? section.textContent : "";
    });
    check(/keeps every entry it can/.test(promise) && /Nothing is deleted/.test(promise),
      "the control promises what the repair actually does");
    await shot(page, "02-repair-control-on-details-panel");

    // ---- a person presses it ----------------------------------------------------------------------
    if (control) {
      await page.mouse.click(control.x, control.y);
      await page.waitForTimeout(1800);
    }
    check(relay.repairs.length === 1, "pressing it asked the box to repair exactly once", `${relay.repairs.length} calls`);
    check(relay.repairs[0]?.id === "titan", "for the agent whose panel it was on", JSON.stringify(relay.repairs[0] ?? {}));
    const note = await page.evaluate(() => document.querySelector("[data-repair-note]")?.textContent ?? "");
    check(/^Repaired, 115 entries kept\./.test(note), "and the panel says what happened, with the count", note || "no note");
    check(!/^\[|^[A-Z]+:/.test(note), "in plain words, with no prefixed verdict line", note || "no note");
    await shot(page, "03-repaired-entries-kept");
    const gone = await page.evaluate(() => document.querySelector('[data-repair-transcript="titan"]') != null);
    check(gone === false, "the control goes, because there is nothing left to repair");

    // ---- and the roster agrees --------------------------------------------------------------------
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".worker-card")].find((el) => el.dataset.contextId === "titan");
      return { pill: node?.querySelector(".needs-repair-pill")?.textContent ?? null };
    });
    check(after.pill === null, "the pill is off the roster row after the repair", after.pill ?? "gone, correctly");

    // ---- the turn after it ------------------------------------------------------------------------
    await page.click("#message-input", { timeout: 8000 }).catch(() => {});
    await page.keyboard.type("are you back?");
    const send = await targetOf(page, "#send-button, [data-send], .composer button[type=submit]");
    if (send) await page.mouse.click(send.x, send.y);
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(5000);
    check(relay.sent.length >= 1, "the composer sent the next turn", `${relay.sent.length} sends`);
    const settled = await page.evaluate(() => document.querySelector(".transcript")?.innerText ?? "");
    check(/Everything is back\./.test(settled), "and the turn after the repair completed, with the answer on the page");

    check(errors.length === 0, "the page threw nothing", errors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    relay.server.close();
  }
}

// ================================================================================================
// The box leg. grok-bot-local-vm, through the gateway and the docker CLI.
// ================================================================================================

const docker = (args, timeoutMs = 60_000) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20, timeout: timeoutMs }, (error, out) =>
    (error ? reject(new Error(`docker ${args.slice(0, 3).join(" ")}: ${error.message}`)) : resolve(out))));

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch { /* next */ }
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}

const UNKNOWN = /unknown gateway method/i;
async function call(method, args = {}, TOKEN = token()) {
  let response;
  try {
    response = await fetch(`${GATEWAY}/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (cause) {
    const error = new Error(`${method}: the gateway at ${GATEWAY} did not answer (${cause?.message ?? cause})`);
    error.gatewayDown = true;
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} -> ${response.status} ${text.slice(0, 200)}`);
    error.unknownCommand = UNKNOWN.test(text);
    throw error;
  }
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Nested quoting through `docker exec sh -c` fails on this stack, so anything with a path or a
 * heredoc in it is written to a file, copied in, run, and deleted.
 */
async function runInBox(script, name = "transcript-repair.sh") {
  const local = path.join(process.env.TMPDIR ?? "/tmp", `${name}.${process.pid}`);
  await writeFile(local, script, { mode: 0o755 });
  await docker(["cp", local, `${BOX}:/tmp/${name}`]);
  try { return await docker(["exec", BOX, "sh", `/tmp/${name}`]); }
  finally {
    await docker(["exec", BOX, "rm", "-f", `/tmp/${name}`]).catch(() => {});
    await rm(local, { force: true }).catch(() => {});
  }
}

const TRANSCRIPTS = "/home/box/sand-data/agent-transcripts";

/**
 * How many transcript entries the host holds for this agent, read through the product's own door.
 *
 * MEASURED on grok-bot-local-vm 2026-09-09: `getAgentTranscript` answers a BARE ARRAY and
 * `getAgentTranscriptTail` answers `{entries}`. Both shapes are accepted, because reading only one
 * of them is how this helper spent its first run returning null and reporting a healthy agent as a
 * failure.
 */
async function entryCount(id, TOKEN) {
  for (const method of ["getAgentTranscript", "getAgentTranscriptTail"]) {
    const answer = await call(method, { id, limit: 1000 }, TOKEN).catch(() => null);
    const entries = Array.isArray(answer) ? answer : answer?.entries;
    if (Array.isArray(entries)) return entries.length;
  }
  return null;
}

/** Ask the agent something and wait for a reply to land, or say it never did. */
async function turnCompletes(id, prompt, TOKEN, waitMs = 70_000) {
  const before = await entryCount(id, TOKEN);
  await call("sendPrompt", { agentId: id, prompt }, TOKEN);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    const now = await entryCount(id, TOKEN);
    // A reply is at least the person's own row plus the agent's. A failed turn grows by one at
    // most, and on this failure it grows by none at all.
    if (now != null && before != null && now >= before + 2) return { ok: true, before, after: now };
  }
  return { ok: false, before, after: await entryCount(id, TOKEN) };
}

async function boxLeg() {
  let TOKEN;
  try { TOKEN = token(); }
  catch (error) { skip("the box leg", error.message); return; }

  // Is the verb even on this box? The host half lands separately, and a box on an older bundle is
  // a box this leg cannot measure -- which is a SKIP with a name, never a pass.
  const probe = await call("repairAgentTranscript", { id: "does-not-exist", agentId: "does-not-exist" }, TOKEN)
    .then(() => ({ present: true }))
    .catch((error) => ({ present: !error.unknownCommand && !error.gatewayDown, error }));
  if (probe.error?.gatewayDown) {
    const log = await runInBox("#!/bin/sh\ntail -6 /tmp/sand-supervisor.log 2>/dev/null || echo 'no supervisor log'\n", "repair-superlog.sh").catch(() => "");
    skip("the box leg", `the host in ${BOX} is not listening${/host exited/.test(log) ? " and the supervisor is relaunching it" : ""}`);
    return;
  }
  if (!probe.present) {
    skip("the host recovers a marker-damaged store on its own", "this box runs a bundle without repairAgentTranscript; it lands with the host half of BOX-6b");
    skip("repairAgentTranscript answers {before, after, quarantined, outcome}", "same bundle");
    skip("a repaired agent completes the next turn", "same bundle");
    return;
  }
  check(true, "this box's host carries repairAgentTranscript");

  let created = null;
  // Agent-lifecycle hygiene, armed BEFORE the agent exists. The first run of this gate was killed
  // by its own 290 s wrapper part way through a model turn, the async `finally` never ran, and it
  // left a scratch agent on the roster -- which is exactly the bug that rule is about. A signal
  // handler cannot await, so it fires the delete and lets the process go.
  const sweep = () => {
    if (!created) process.exit(1);
    execFile("curl", ["-s", "-m", "5", "-X", "POST", `${GATEWAY}/api/deleteAgent`,
      "-H", `authorization: Bearer ${TOKEN}`, "-H", "content-type: application/json",
      "-H", `user-agent: ${UA}`, "-d", JSON.stringify({ id: created })],
    () => process.exit(1));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, sweep);
  try {
    const made = await call("createAgent", {
      name: `Transcript repair gate ${Date.now()}`,
      description: "scratch agent for scripts/verify-transcript-repair.mjs; delete me",
    }, TOKEN);
    created = made?.agent?.id ?? null;
    check(created != null, "a scratch agent was created", created ?? "none");
    if (!created) return;

    // Hold a few turns, so there is something a repair can keep or lose.
    const held = await turnCompletes(created, "Say the single word ready and nothing else.", TOKEN);
    check(held.ok, "the scratch agent holds a turn before anything is damaged", `${held.before} -> ${held.after} entries`);
    const baseline = await entryCount(created, TOKEN);

    // ---- damage one: the demo Titan's own shape --------------------------------------------------
    // NOT "write a stale copy over the store while a WAL exists" -- that is BOX-6's shape and it
    // produces a different error. What stopped the demo Titan was a two-byte `<id>.journal-mode`
    // marker: it pins the conversation to the journal route for ever, and the first prepare of
    // every host process after that throws because nothing on the turn path ever calls recover().
    await runInBox(`#!/bin/sh\nset -e\nmkdir -p ${TRANSCRIPTS}/${created}\nprintf '1\\n' > ${TRANSCRIPTS}/${created}/${created}.journal-mode\nls -l ${TRANSCRIPTS}/${created}\n`, "repair-damage-marker.sh");
    const marked = await runInBox(`#!/bin/sh\nls ${TRANSCRIPTS}/${created} 2>/dev/null\n`, "repair-read-marker.sh");
    check(/journal-mode/.test(marked), "the scratch agent is damaged the way the demo Titan was", marked.trim().split("\n").join(", "));

    // The host's own recovery is what has to fix this: no button, no verb, just the next turn.
    const recovered = await turnCompletes(created, "Say the single word back and nothing else.", TOKEN);
    check(recovered.ok, "the host recovered on its own and the turn completed", `${recovered.before} -> ${recovered.after} entries`);
    const kept = await entryCount(created, TOKEN);
    check(kept != null && baseline != null && kept >= baseline,
      "and it kept the entries it already had", `${baseline} before the damage, ${kept} after the recovery`);

    // ---- damage two: the shape self-recovery must refuse -----------------------------------------
    // A pending write-ahead log whose hashes match nothing. recover() throws on it by design
    // ("pending transcript WAL does not match the durable checkpoint"), so the host must stop, write
    // the needs-repair state, and let a person press the button. Behind its own flag because three
    // model turns and a fourth wait do not fit inside the 300 s verify-runner ceiling together.
    if (REFUSE) {
      await runInBox(`#!/bin/sh\nset -e\nprintf '{"checkpoint":"nothing-that-exists","entries":[]}\\n' > ${TRANSCRIPTS}/${created}/${created}.journal-pending.json\nprintf '1\\n' > ${TRANSCRIPTS}/${created}/${created}.journal-mode\nls ${TRANSCRIPTS}/${created}\n`, "repair-damage-wal.sh");
      const refusedTurn = await turnCompletes(created, "Say the single word again and nothing else.", TOKEN, 60_000);
      if (refusedTurn.ok) {
        // The host recovered from this one too. That is a better product than the brief expected and
        // it is not a failure -- but it is not the refusal path either, so it is named as skipped.
        skip("a store self-recovery refuses reaches the needs-repair state", "the host recovered from the mismatched pending log as well, so the refusal path could not be reached from here");
      } else {
        const roster = await call("listAgents", {}, TOKEN).catch(() => []);
        const row = (Array.isArray(roster) ? roster : []).find((a) => a.id === created);
        check(row?.transcriptNeedsRepair != null,
          "the host puts the agent in the needs-repair state, which is what draws the pill and the control",
          JSON.stringify(row?.transcriptNeedsRepair ?? null));
      }
    }

    // ---- the verb, on demand ----------------------------------------------------------------------
    const repaired = await call("repairAgentTranscript", { id: created, agentId: created }, TOKEN).catch((error) => error);
    if (repaired instanceof Error) {
      check(false, "repairAgentTranscript answers {before, after, quarantined, outcome}", repaired.message);
    } else {
      check(typeof repaired?.outcome === "string" && repaired.outcome.length > 0,
        "repairAgentTranscript answers {before, after, quarantined, outcome}", JSON.stringify(repaired));
      check(Number.isFinite(Number(repaired?.after)),
        "with a count of what it kept", `before ${repaired?.before}, after ${repaired?.after}`);
      // Never deleted, only moved aside. MEASURED: the host sends a LIST of paths, and an empty one
      // is the normal answer when the store was healthy -- which is the shape the one real case in
      // production had, so a gate that demanded a name here would fail on the case it exists for.
      check(Array.isArray(repaired?.quarantined),
        "and says what it set aside, as a list that is empty when there was nothing to set aside",
        JSON.stringify(repaired?.quarantined));
      check((repaired?.quarantined ?? []).every((p) => typeof p === "string" && p.length > 0),
        "each one named, so an operator can find it");
    }

    const back = await turnCompletes(created, "Say the single word fixed and nothing else.", TOKEN);
    check(back.ok, "a repaired agent completes the next turn", `${back.before} -> ${back.after} entries`);

    // The audit row the repair owes.
    const ledger = await call("getAgentActionAudit", { id: created, limit: 25 }, TOKEN).catch(() => null);
    const rows = ledger?.rows ?? [];
    if (ledger == null) skip("the repair wrote an audit row", "this box does not answer getAgentActionAudit");
    else check(rows.some((row) => /repair/i.test(`${row.type ?? ""} ${row.tool ?? ""}`)),
      "the repair wrote an audit row", `${rows.length} rows read`);
  } catch (error) {
    check(false, "the box leg ran to the end", error.message);
  } finally {
    // Agent-lifecycle hygiene: a roster that grows during a gate run is a bug.
    if (created) {
      await call("deleteAgent", { id: created }, TOKEN).catch(() => {});
      await runInBox(`#!/bin/sh\nrm -rf ${TRANSCRIPTS}/${created}\n`, "repair-clean.sh").catch(() => {});
    }
  }
}

// ================================================================================================

console.log(`verify-transcript-repair: ${MODE}`);
if (MODE === "console" || MODE === "all") { console.log("\nthe console"); await consoleLeg(); }
if (MODE === "box" || MODE === "all") { console.log("\nthe box"); await boxLeg(); }

console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
process.exit(failures === 0 ? 0 : 1);
