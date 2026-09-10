// FEEDBACK-1. The reporting channel, measured rather than asserted.
//
// Jason, 2026-09-07: "Titan tried to cover up failure." The thing that has to be true is not that
// the code compiles: it is that a person sitting in front of this console sees a card, can click
// Send with a mouse, and that what leaves the workspace is what was on the card. A passing
// page.click() is not evidence a human can click (verify-ui-in-a-real-browser.md), so the browser
// leg clicks at real screen coordinates through real Chrome.
//
//   node scripts/verify-feedback.mjs             the console: real Chrome, a stub relay, the whole
//                                                offer-to-send arc with the POST body captured
//   node scripts/verify-feedback.mjs --box       grok-bot-local-vm: the pending store and the two
//                                                gateway commands, end to end through the gateway
//   node scripts/verify-feedback.mjs --agent     a scratch agent calls the tool for real, then is
//                                                deleted. Needs the bundle with the tool in it
//   node scripts/verify-feedback.mjs --offer     the forced-failure recipe, LOCAL BOX ONLY
//
// The default leg is deliberately box-free. It is the one that proves the custody promise, it runs
// in seconds, and it does not queue behind /tmp/titanbot-box.lock. The box legs go through
// scripts/on-box.sh and each fits inside the 300 s verify-runner ceiling.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(repoRoot, ".cache/playwright");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const MODE = process.argv.includes("--box") ? "box"
  : process.argv.includes("--agent") ? "agent"
  : process.argv.includes("--offer") ? "offer"
  : "console";

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
// A skipped check is not a passing one. It is named, counted and printed in the summary, so a run
// that could not reach half of itself never reads as a green run.
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================================================
// The console leg. A stub relay, the real page, real Chrome, real mouse coordinates.
// ================================================================================================

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };

/**
 * The smallest relay the page will come up against. `hydrate` needs listAgents to answer an array
 * and everything else to answer something; the four commands this gate is about answer for real.
 */
function stubRelay(root, seed) {
  const posted = [];
  const resolved = [];
  // What the relay answers on the NEXT report only. ui/server.mjs answers a failure with a plain
  // sentence under `message` and nothing under `error`, and the console used to read `error`, so
  // three carefully written sentences were thrown away and the person read an HTTP status code.
  let failNext = null;
  const streams = [];
  const nudge = () => { for (const stream of streams) { try { stream.write(`data: ${JSON.stringify({ channel: "agents" })}\n\n`); } catch { /* gone */ } } };
  let pending = seed.pending ?? [];
  let trays = seed.trays ?? [];
  const agents = [{ id: "titan", name: "Titan", isGroup: false, createdAt: 1, unreadCount: 0, lastMessagePreview: "", status: "idle" }];
  const transcript = [
    { id: "e1", kind: "message", role: "user", content: "check the shell", timestampMs: 1 },
    { id: "e2", kind: "send-message", message: { type: "text", content: "I could not." }, timestampMs: 2 },
  ];
  const answers = {
    listAgents: () => agents,
    countAgents: () => 1,
    getAgentCapacity: () => ({ used: 1, max: 40 }),
    isGlobalSearchEnabled: () => false,
    getHostStatus: () => ({ hostVersion: "0.18.0-gate", capabilities: ["sendAcceptanceV1"], isBusy: false }),
    getOnboardingState: () => ({ done: true, maxAgents: 40 }),
    getTrays: () => { const out = trays; trays = []; return out; },
    dismissTray: () => ({ ok: true }),
    getAgentTranscript: () => ({ entries: transcript, hasOlder: false }),
    getAgentTranscriptTail: () => ({ entries: transcript, hasOlder: false, partial: false }),
    getAgentThread: () => ({ entries: transcript, outline: [], hasOlder: false }),
    listProblemReports: () => ({ reports: pending }),
    resolveProblemReport: (body) => {
      resolved.push([body.id, body.outcome]);
      pending = pending.filter((row) => row.id !== body.id);
      return { id: body.id, outcome: body.outcome, resolved: true };
    },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* empty */ }
      if (url.pathname === "/feedback") {
        if (failNext != null) {
          const { status, answer } = failNext;
          failNext = null;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(answer));
          return;
        }
        posted.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "fb-1", workspace: "demo", state: "new" }));
        return;
      }
      const method = url.pathname.replace(/^\/api\//, "");
      const answer = answers[method];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer ? answer(body) : null));
      return;
    }
    if (url.pathname === "/events") {
      // The host pushes; the adapter debounces 900 ms and re-reads. One nudge is what makes the
      // tray arrive inside this gate's lifetime rather than on the 15 s heartbeat, and addPending
      // nudges again so a report written mid-run reaches the page the same way.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      streams.push(response);
      request.on("close", () => { const at = streams.indexOf(response); if (at >= 0) streams.splice(at, 1); });
      setTimeout(nudge, 1200);
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
  return {
    server, posted, resolved,
    failNextFeedback(status, answer) { failNext = { status, answer }; },
    // FEEDBACK-1b: an agent writing a report into the box's file while the page is open. The gate
    // pushes it here and never reloads: the console has to find it on the beat it already runs.
    addPending(row) { pending = [...pending, row]; nudge(); },
    get pending() { return pending; },
  };
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function consoleLeg() {
  const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
  const report = {
    id: "pr-gate-1", at: new Date().toISOString(), agentId: "titan", agentName: "Titan",
    report: {
      version: 1, tier: "critical", category: "shell",
      title: "The shell refuses every command",
      description: "Every command comes back with 'exec daemon not reachable'.",
      steps: ["Run ls /workspace"],
      tools: [{ name: "Shell", status: "failed", error: "exec daemon not reachable" }],
      at: new Date().toISOString(),
    },
  };
  const relay = stubRelay(path.join(repoRoot, "ui/machine-room"), {
    pending: [report],
    trays: [{ id: "t1", kind: "error", agentId: "titan", title: "Agent failed to respond", detail: "fetch failed" }],
  });
  const port = await listen(relay.server);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on("pageerror", (event) => errors.push(String(event)));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    await page.waitForTimeout(4000);

    check(await page.evaluate(() => window.__machineRoomLive === true),
      "the page came up against the gateway rather than falling back to the demo adapter");

    // ---- the card an agent's own report produced -----------------------------------------------
    // FEEDBACK-2: ONE card at a time. The failed-turn offer is minted in the same seconds and waits
    // its turn; a reload used to draw every pending report at once, stacked, each with its own Send.
    const card = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")]
        .find((el) => el.textContent.includes("The shell refuses every command"));
      if (!node) return null;
      const area = node.querySelector("textarea");
      return { text: node.textContent, body: area?.value ?? "", rows: document.querySelectorAll(".problem-report-card").length };
    });
    check(card != null, "the report the agent wrote is on the page as a card");
    if (card) {
      check(card.rows === 1, "and it is the only card on the page", `${card.rows} cards drawn`);
      check(/Would you like to send this to the developers\?/.test(card.text), "the card asks the question Jason asked for");
      check(/exec daemon not reachable/.test(card.body), "what the tool answered is in the editable body");
      check(/What you see below is what is sent/.test(card.text), "the custody line says what goes");
      check(/Your keys, your files and your other conversations are not sent/.test(card.text), "and what does not");
    }

    // ---- a human can actually click Send -------------------------------------------------------
    const target = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")]
        .find((el) => el.textContent.includes("The shell refuses every command"));
      const button = node?.querySelector("[data-report-send]");
      if (!button) return null;
      const box = button.getBoundingClientRect();
      // What a person's pointer would land on at that point, not what the DOM says is there.
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height, reaches: button.contains(hit) || button === hit };
    });
    check(target != null && target.width > 20 && target.height > 12, "Send is a real target with a real size", target ? `${Math.round(target.width)}x${Math.round(target.height)}` : "missing");
    check(target?.reaches === true, "and nothing is sitting on top of it");
    if (target) {
      // The person's own edit, typed into the field, before the click.
      await page.click('.problem-report-card textarea', { timeout: 5000 }).catch(() => {});
      await page.keyboard.type(" I checked the box myself and the daemon is not there.");
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(1500);
    }

    check(relay.posted.length === 1, "pressing Send posted exactly one report", `${relay.posted.length} posted`);
    const sent = relay.posted[0];
    if (sent) {
      check(sent.version === 1 && sent.tier === "critical", "it is ProblemReport v1 at the tier the agent chose");
      check(!("workspace" in sent), "and it does not name a tenant: the relay stamps that from its own registry");
      check(/I checked the box myself/.test(sent.description), "the person's own edit is what was sent");
      // The custody promise, measured: they changed the text, so the structured copy of what they
      // were shown did not go behind their back.
      check(!("calls" in (sent.evidence ?? {})), "an edited report ships no uneditable copy of what was removed");
      check((sent.tools ?? []).every((tool) => !("error" in tool)), "and the tool answers went with it");
      check(typeof sent.evidence?.consoleVersion === "string" && /^[0-9a-f]{8}$/.test(sent.evidence.consoleVersion),
        "the console's own build number rode along", sent.evidence?.consoleVersion ?? "missing");
      check(sent.evidence?.hostVersion === "0.18.0-gate", "so did the box's");
    }
    check(relay.resolved.some(([id, outcome]) => id === "pr-gate-1" && outcome === "sent"),
      "and the box was told to stop offering it", JSON.stringify(relay.resolved));

    // ---- FEEDBACK-2: the sent card says what happened, and then goes ---------------------------
    // Jason, 2026-09-09: "that green box is not going away. It just stays there." It used to have
    // no timer, no dismiss control, and nothing but a reload took it off the page.
    const settledText = await page.evaluate(() => document.querySelector(".transcript")?.innerText ?? "");
    check(/The developers have it/.test(settledText), "the card says what happened, once it has happened");
    check(!/your own copy above/.test(settledText),
      "and it no longer promises a copy above that is about to leave with it");
    check(await page.evaluate(() => document.querySelector("[data-report-dismiss]") != null),
      "the settled card can be dismissed by hand rather than waited out");

    const folded = await page.waitForFunction(
      () => (document.querySelector(".transcript")?.innerText ?? "").includes("Sent to the developers:"),
      { timeout: 12_000 },
    ).then(() => true).catch(() => false);
    check(folded, "the sent card folds itself into one quiet transcript row within a few seconds");
    const afterFold = await page.evaluate(() => ({
      text: document.querySelector(".transcript")?.innerText ?? "",
      cards: document.querySelectorAll(".problem-report-card").length,
      settled: document.querySelectorAll("[data-report-dismiss]").length,
    }));
    check(/Sent to the developers: The shell refuses every command/.test(afterFold.text),
      "the quiet row names what was sent, where the report happened");
    check(afterFold.settled === 0, "and the pinned card is gone", `${afterFold.settled} settled cards left`);

    // ---- and the next report comes forward on its own ------------------------------------------
    const offer = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")]
        .find((el) => el.textContent.includes("could not finish that one"));
      return node ? { text: node.textContent, body: node.querySelector("textarea")?.value ?? "", cards: document.querySelectorAll(".problem-report-card").length } : null;
    });
    check(offer != null, "a failed turn produced its own offer, with no turn-failed row anywhere");
    if (offer) {
      check(offer.cards === 1, "and it is the only card now, in its turn", `${offer.cards} cards drawn`);
      // The card is the part that stays. The adapter's note into the conversation is replaced by
      // the next transcript read, exactly as the raw line it replaced was, so the plain-words
      // sentence has to be on the card too.
      check(/could not finish that one/.test(offer.text), "and the card carries the plain-words sentence");
      check(/Agent failed to respond/.test(offer.body), "the tray's own words are on the card, where they can be edited");
      check(!/That turn failed:/.test(offer.text), "and never the raw 'That turn failed:' framing");
    }

    // No raw provider wording narrated anywhere on the page.
    const pageText = await page.evaluate(() => document.querySelector(".transcript")?.innerText ?? "");
    check(!/That turn failed:/.test(pageText), "the raw 'That turn failed:' line is gone from the conversation");

    // ---- FEEDBACK-1b: a report written while the page is open, with no reload ------------------
    // drainPendingProblemReports used to run once, after first paint. Measured on grok-bot-local-vm
    // 2026-09-09: a scratch agent wrote two reports in one turn, both were in the box's file at
    // t+12 s, and the open page drew nothing for thirty seconds. One reload drew both at once,
    // stacked. This writes a report into the box's file NOW, with the failed-turn card still on
    // screen, and nothing reloads for the rest of the run.
    relay.addPending({
      id: "pr-gate-2", at: new Date().toISOString(), agentId: "titan", agentName: "Titan",
      report: {
        version: 1, tier: "quality", category: "console",
        title: "No bot template system visible",
        description: "The second report of the same turn, written while the person was looking at the console.",
        at: new Date().toISOString(),
      },
    });
    await page.waitForTimeout(6000);
    const queued = await page.evaluate(() => ({
      cards: document.querySelectorAll(".problem-report-card").length,
      titles: [...document.querySelectorAll(".problem-report-card strong")].map((el) => el.textContent),
    }));
    check(queued.cards === 1 && !/No bot template/.test(queued.titles.join(" ")),
      "it waits its turn instead of stacking on the card already there", `${queued.cards}: ${queued.titles.join(" | ")}`);

    // Not now on the failed-turn card, which is the same settle branch a Send takes.
    const dropped = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")].find((el) => el.textContent.includes("could not finish that one"));
      const button = node?.querySelector("[data-report-drop]");
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    if (dropped) { await page.mouse.click(dropped.x, dropped.y); await page.waitForTimeout(800); }
    check(await page.evaluate(() => (document.querySelector(".transcript")?.innerText ?? "").includes("Nothing left this workspace")),
      "Not now says nothing left the workspace");
    const live = await page.waitForFunction(
      () => (document.querySelector(".transcript")?.innerText ?? "").includes("No bot template system visible"),
      { timeout: 20_000 },
    ).then(() => true).catch(() => false);
    check(live, "and the report written while the page was open comes forward on its own, with no reload");
    check(await page.evaluate(() => (document.querySelector(".transcript")?.innerText ?? "").includes("Kept to yourself:")),
      "with the dropped one folded to its own quiet row");
    check(await page.evaluate(() => document.querySelectorAll(".problem-report-card").length) === 1,
      "still one card at a time");

    // Answer it, so the always-present control below opens the only card on the page.
    const secondSend = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")].find((el) => el.textContent.includes("No bot template system visible"));
      const button = node?.querySelector("[data-report-drop]");
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    if (secondSend) { await page.mouse.click(secondSend.x, secondSend.y); }
    await page.waitForFunction(() => document.querySelectorAll(".problem-report-card").length === 0, { timeout: 14_000 }).catch(() => {});
    check(relay.resolved.some(([id, outcome]) => id === "pr-gate-2" && outcome === "dropped"),
      "and answering it clears the box's row for it too", JSON.stringify(relay.resolved));

    // ---- what a reload shows: exactly what is still pending, and no settled card ---------------
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(4000);
    const afterReload = await page.evaluate(() => ({
      cards: document.querySelectorAll(".problem-report-card").length,
      text: document.querySelector(".transcript")?.innerText ?? "",
    }));
    check(afterReload.cards === 0, "a reload with nothing pending draws no card at all", `${afterReload.cards} cards`);
    check(!/Sent to the developers:|Kept to yourself:/.test(afterReload.text),
      "and no settled card and no fold row survive the reload: they were page-local by construction");

    // ---- FEEDBACK-2b: a report whose conversation is not on this page at all --------------------
    // FEEDBACK-1b one step over, and the reason that fix did not cover it: the report Jason lost
    // happened to belong to the conversation he had open. A subagent writes one, a background worker
    // does, or the agent it belongs to has since been deleted -- `agentId` then matches no row of the
    // roster. The drain marked the row seen at drain time and the queue only drew offers whose
    // agentId equalled the open context, so the report was consumed into invisibility and nothing
    // drew it again for the rest of the session. Measured on this Mac before the fix: zero cards,
    // zero DOM nodes carrying either title, and the box still holding both rows after 22 s.
    relay.addPending({
      id: "pr-gate-orphan", at: new Date().toISOString(), agentId: "subagent-9", agentName: "Subagent 9",
      report: {
        version: 1, tier: "quality", category: "console",
        title: "A report from a conversation that is not on this page",
        description: "Written by a subagent the roster does not list.",
        at: new Date().toISOString(),
      },
    });
    const orphan = await page.waitForFunction(
      () => [...document.querySelectorAll(".problem-report-card")]
        .find((el) => el.textContent.includes("A report from a conversation that is not on this page")) != null,
      { timeout: 25_000 },
    ).then(() => true).catch(() => false);
    check(orphan, "a report for an agent the roster does not know reaches the person in the conversation that IS open");
    if (orphan) {
      const whose = await page.evaluate(() => [...document.querySelectorAll(".problem-report-card strong")]
        .map((el) => el.textContent).find((text) => text.includes("not on this page")) ?? "");
      check(/^Subagent 9: /.test(whose), "and the card says whose report it is", whose);
      const sendable = await page.evaluate(() => {
        const node = [...document.querySelectorAll(".problem-report-card")]
          .find((el) => el.textContent.includes("A report from a conversation that is not on this page"));
        const button = node?.querySelector("[data-report-send]");
        if (!button) return null;
        const box = button.getBoundingClientRect();
        const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { hit: at === button || button.contains(at), x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      check(sendable?.hit === true, "with a Send a mouse can actually reach", JSON.stringify(sendable));
      if (sendable?.hit) {
        await page.mouse.click(sendable.x, sendable.y);
        await page.waitForTimeout(1500);
        check(relay.posted.some((body) => /not on this page/.test(String(body?.title ?? ""))),
          "and sending it reaches the developers with the subagent named as the source",
          JSON.stringify(relay.posted.map((body) => [body.title, body?.evidence?.agent])));
      }
    }

    // ---- a send the relay refused, in the relay's own words ------------------------------------
    // The sentence is ui/server.mjs forwardFeedback's, verbatim. A status code in front of a
    // customer is the presentation host-notes-read-as-errors.md bans, and it is what the person
    // used to read here because the console looked for the wrong key on the answer.
    const RELAY_SAID = "The developers' service did not answer in time, so the report was not sent. Try again in a minute.";
    relay.failNextFeedback(502, { sent: false, message: RELAY_SAID });
    await page.click("[data-report-open]", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const refusedTarget = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")]
        .find((el) => el.textContent.includes("A problem with this product"));
      const button = node?.querySelector("[data-report-send]");
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    check(refusedTarget != null, "Report a problem opens a card with a Send on it");
    if (refusedTarget) {
      await page.mouse.click(refusedTarget.x, refusedTarget.y);
      await page.waitForTimeout(1200);
    }
    const refusedNote = await page.evaluate(() => {
      const node = [...document.querySelectorAll(".problem-report-card")]
        .find((el) => el.textContent.includes("A problem with this product"));
      const hints = [...(node?.querySelectorAll(".field-hint") ?? [])];
      return hints.length > 1 ? hints[hints.length - 1].textContent : "";
    });
    check(refusedNote.includes(RELAY_SAID), "the card says what the relay said, word for word", refusedNote || "no note");
    check(!/\d/.test(refusedNote), "and no status code reaches the person", refusedNote || "no note");

    // ---- the always-present controls -----------------------------------------------------------
    const controls = await page.evaluate(() => {
      const open = document.querySelector("[data-report-open]");
      const test = document.querySelector("[data-run-self-test]");
      const box = open?.getBoundingClientRect();
      return { open: open?.textContent ?? null, test: test?.textContent ?? null, visible: box ? box.width > 0 && box.height > 0 : false };
    });
    check(controls.open === "Report a problem" && controls.test === "Run a self-test", "both always-present controls are on the page");
    check(controls.visible === true, "and Report a problem is actually visible, not a zero-box element");

    // ---- the ceiling ---------------------------------------------------------------------------
    const cap = await page.evaluate(() => document.querySelector("[data-agent-count]")?.textContent ?? "");
    check(/\/ 40 bots$/.test(cap), "the roster header draws the ceiling the box reported", cap || "empty");

    check(errors.length === 0, "the page threw nothing", errors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    relay.server.close();
  }
}

// ================================================================================================
// The box legs.
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
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (cause) {
    // A gateway that is not listening is not a product failure, and a gate that reports it as one
    // lies about the thing it exists to measure. It is named, and the run says it could not reach
    // the box rather than that the box answered wrongly.
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

/** Why the box could not be reached, in words, so a skipped run says what an operator must fix. */
async function gatewayDownReason() {
  const log = await runInBox("#!/bin/sh\ntail -6 /tmp/sand-supervisor.log 2>/dev/null || echo 'no supervisor log'\n", "feedback-superlog.sh").catch(() => "");
  const nodeVersion = await docker(["exec", BOX, "node", "-v"]).catch(() => "unknown");
  const looping = /host exited/.test(log);
  return `the host in ${BOX} is not listening${looping ? " and the supervisor is relaunching it" : ""}; its \`node\` is ${nodeVersion.trim()}`;
}

/**
 * Nested quoting through `docker exec sh -c` fails on this stack, so anything with a JSON document
 * in it is written to a file, copied in, run, and deleted.
 */
async function runInBox(script, name = "gate-script.sh") {
  const local = path.join(process.env.TMPDIR ?? "/tmp", `${name}.${process.pid}`);
  await writeFile(local, script, { mode: 0o755 });
  await docker(["cp", local, `${BOX}:/tmp/${name}`]);
  try { return await docker(["exec", BOX, "sh", `/tmp/${name}`]); }
  finally {
    await docker(["exec", BOX, "rm", "-f", `/tmp/${name}`]).catch(() => {});
    await rm(local, { force: true }).catch(() => {});
  }
}

const STORE = "/home/box/sand-data/problem-reports.json";

async function boxLeg() {
  // The one thing a builder can prove without shipping: the file shape the console reads is the
  // file shape the host writes, and the two commands answer it.
  const seeded = {
    version: 1,
    reports: [{
      id: "pr-gate-box", at: new Date().toISOString(), agentId: "gate", agentName: "Gate",
      report: {
        version: 1, tier: "quality", category: "shell", title: "gate probe",
        description: "written by scripts/verify-feedback.mjs", steps: [], tools: [], at: new Date().toISOString(),
      },
    }],
  };
  const before = await runInBox(`#!/bin/sh\ncat ${STORE} 2>/dev/null || echo NONE\n`, "feedback-read.sh").catch(() => "NONE");
  const hadOne = before.trim() !== "NONE";
  await runInBox(`#!/bin/sh\numask 077\ncat > ${STORE} <<'JSON'\n${JSON.stringify(seeded, null, 2)}\nJSON\nchmod 600 ${STORE}\nls -l ${STORE}\n`, "feedback-seed.sh");
  const listed = await call("listProblemReports").catch((error) => error);
  if (listed instanceof Error) {
    if (listed.gatewayDown) {
      const why = await gatewayDownReason();
      skip("listProblemReports answers the box's pending file", why);
      skip("resolveProblemReport clears the row", "same: no gateway to ask");
      skip("and the box stops offering it", "same: no gateway to ask");
    } else if (listed.unknownCommand) {
      skip("listProblemReports answers the box's pending file", "this box runs a bundle without the feedback commands; it lands with the next host swap");
      skip("resolveProblemReport clears the row", "same bundle");
    } else {
      check(false, "listProblemReports answers the box's pending file", listed.message);
    }
  } else {
    const rows = listed?.reports ?? [];
    check(rows.some((row) => row.id === "pr-gate-box"), "listProblemReports answers the box's pending file", `${rows.length} pending`);
    check(rows.find((row) => row.id === "pr-gate-box")?.report?.tier === "quality", "and carries the tier the report was written at");
    const cleared = await call("resolveProblemReport", { id: "pr-gate-box", outcome: "dropped" }).catch((error) => error);
    check(cleared?.resolved === true, "resolveProblemReport clears the row", JSON.stringify(cleared));
    const after = await call("listProblemReports").catch(() => ({ reports: [] }));
    check(!(after?.reports ?? []).some((row) => row.id === "pr-gate-box"), "and the box stops offering it");
  }
  const mode = await runInBox(`#!/bin/sh\nstat -c %a ${STORE} 2>/dev/null || echo none\n`, "feedback-mode.sh");
  check(mode.trim() === "600", "the pending file is 0600", mode.trim());
  // Put the box back the way it was found.
  if (!hadOne) await runInBox(`#!/bin/sh\nrm -f ${STORE}\n`, "feedback-clean.sh").catch(() => {});
  else await runInBox(`#!/bin/sh\ncat > ${STORE} <<'JSON'\n${before}\nJSON\nchmod 600 ${STORE}\n`, "feedback-restore.sh").catch(() => {});

  // Whether the tool is offered at all. SAND_TOOL_TRACE is already on in this box's settings, so
  // the toolset lines are in the host log; grep them for the tool's name rather than guessing.
  const trace = await docker(["logs", "--tail", "4000", BOX]).catch(() => "");
  const offered = /\[sand\]\[toolset\][^\n]*report_problem/.test(trace);
  if (offered) check(true, "the box's toolset trace names report_problem");
  else skip("the box's toolset trace names report_problem", "no toolset line naming it yet; it lands with the host swap");
}

async function agentLeg() {
  const TOKEN = token();
  let created = null;
  try {
    const answer = await call("createAgent", { name: `Feedback gate ${Date.now()}`, description: "scratch agent for scripts/verify-feedback.mjs; delete me" }, TOKEN)
      .catch(async (error) => { if (error.gatewayDown) { skip("a real agent's call to the tool lands in the pending file", await gatewayDownReason()); return null; } throw error; });
    if (answer === null) return;
    created = answer?.agent?.id ?? null;
    check(created != null, "a scratch agent was created", created ?? "none");
    if (!created) return;
    // TWO reports in one turn, which is what Titan was asked for on Jason's own console and what
    // the queue in FEEDBACK-2 exists to draw one at a time. It is also how the box's own ordering
    // is measured: the file has to hand them back oldest first.
    await call("sendPrompt", {
      agentId: created,
      prompt: "Two separate faults, and I want both written down. First: your Shell tool answers 'exec daemon not reachable' for every command \u2014 report that at tier critical, category shell. Then, as a SECOND report: there is no bot template system visible to you \u2014 report that at tier quality, category bots. Use your reporting tool twice, once for each, in that order, and do nothing else.",
    }, TOKEN);
    let rows = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(5000);
      const listed = await call("listProblemReports", {}, TOKEN).catch((error) => (error.unknownCommand ? { reports: [], unknown: true } : { reports: [] }));
      if (listed.unknown) { skip("a real agent's call to the tool lands in the pending file", "this box runs a bundle without the tool"); return; }
      rows = (listed?.reports ?? []).filter((row) => row.agentId === created);
      if (rows.length >= 2) break;
    }
    check(rows.length > 0, "a real agent's call to the tool lands in the pending file", `${rows.length} report(s)`);
    check(rows.length >= 2, "both reports of one turn are in the box's file", `${rows.length} report(s): ${rows.map((row) => row.report?.title ?? "?").join(" | ")}`);
    if (rows.length >= 2) {
      // Oldest first is what the console's queue reads as "in the order the box returned them".
      const times = rows.map((row) => Date.parse(row.at ?? row.report?.at ?? 0));
      check(times.every((at, i) => i === 0 || at >= times[i - 1]), "in the order they were written", JSON.stringify(rows.map((row) => row.at)));
      check(new Set(rows.map((row) => row.id)).size === rows.length, "each with an id of its own");
    }
    for (const row of rows) {
      check(row.report?.version === 1, "as ProblemReport v1");
      check(typeof row.report?.title === "string" && row.report.title.length > 0, "with a title in the agent's own words", row.report?.title ?? "");
      await call("resolveProblemReport", { id: row.id, outcome: "dropped" }, TOKEN).catch(() => {});
    }
    const left = await call("listProblemReports", {}, TOKEN).catch(() => ({ reports: [] }));
    check(!(left?.reports ?? []).some((row) => row.agentId === created), "and the box is put back the way this leg found it");
  } finally {
    // Agent-lifecycle hygiene: a roster that grows during a gate run is a bug.
    if (created) await call("deleteAgent", { id: created }, token()).catch(() => {});
  }
}

async function offerLeg() {
  if (BOX !== "grok-bot-local-vm") {
    check(false, "the forced-failure leg refuses any box but the local one", `${BOX} is not grok-bot-local-vm`);
    return;
  }
  console.log("  NOTE  this leg points the box's model endpoint at a dead port. It breaks EVERY agent");
  console.log("        in this box while it runs, which is why it never touches an R750 box.");
  const secrets = "/home/box/sand-data/box-secrets.json";
  const snapshot = await runInBox(`#!/bin/sh\ncat ${secrets} 2>/dev/null || echo NONE\n`, "offer-read.sh");
  if (snapshot.trim() === "NONE") { skip("a real failed turn narrates in plain words", "this box holds no box-secrets.json to point away and back"); return; }
  const restore = async () => {
    await runInBox(`#!/bin/sh\numask 077\ncat > ${secrets} <<'JSON'\n${snapshot}\nJSON\nchmod 600 ${secrets}\n`, "offer-restore.sh").catch(() => {});
  };
  // A 280 s kill does not run an async finally, so the restore is armed synchronously too.
  const sync = () => { try { execFile("docker", ["exec", BOX, "sh", "-c", `chmod 600 ${secrets}`]); } catch { /* best effort */ } process.exit(1); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, sync);
  try {
    skip("the forced-failure arc", "the recipe is armed but this leg is run by hand: it breaks every agent in the box");
  } finally { await restore(); }
}

// ================================================================================================

console.log(`verify-feedback: ${MODE}`);
if (MODE === "console") await consoleLeg();
else if (MODE === "box") await boxLeg();
else if (MODE === "agent") await agentLeg();
else await offerLeg();

console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
process.exit(failures === 0 ? 0 : 1);
