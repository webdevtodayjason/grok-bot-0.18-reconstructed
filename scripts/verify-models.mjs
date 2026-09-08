#!/usr/bin/env node
// verify-models.mjs -- what a customer's own eyes see where a model is named, in a real browser.
//
// PROVIDERS-1, item D. Two things are measured here and neither of them can be measured any other
// way this repo currently has.
//
// THE LABEL PATH. A customer reads the name of the model they are paying for in four places, and
// only one of them is behind a Settings visit:
//
//   the agent context card     always on screen, beside every conversation (app.js agentContextCard)
//   the agent profile panel    one click from it (app.js agentProfilePanel)
//   the endpoint picker        Settings -> Inference -> Endpoint (app.js settingsPanel)
//   the plan card              Settings -> Included with your plan (app.js pluginGroupSection)
//
// All four print the name gateway-adapter.js's endpointModels or includedPlugins built, and until
// this wave all four printed `plan-zai` -- a ROUTING ALIAS, the string the operator's proxy keys a
// pool on. MEASURED ON THE R750 2026-09-08: neither box carried
// SAND_OPENAI_COMPATIBLE_MODEL_LABEL, so demo's and Richard's Titan both told their customer they
// run "plan-zai". The unit suites now pin every one of those builders. What they cannot tell you is
// that the page actually calls them, that the card renders, and that a person can reach it: a card
// that throws in the browser and a card that renders the wrong string both pass `node --test`.
//
// THE MODEL PICKER (MODELS-1). A provider a customer brought themselves gains a model list where
// before there was a free-text field. The list is either that provider's own (health.models, which
// ui/server.mjs's probe() has returned on every catalog row since TENANT-2 and which nothing read
// until this wave) or the curated one ui/subscriptions.mjs ships, and the card must SAY which,
// because "this is what your provider says it has" and "this is the list we shipped" are different
// claims. A `<select>` that renders is not the measurement; the measurement is that choosing from
// it changes what the box will run, which this asks the RELAY about and not the page.
//
// HOW IT STANDS THE ARRANGEMENT UP. A relay from THIS worktree, on its own port, with its own
// scratch state directory, pointed at the real grok-bot-local-vm and its real gateway -- so the
// roster, the workers and the agent context card are the real ones. The plan the console draws
// comes from SAND_UI_TENANTS_FILE, the same documented override the unit suites use, carrying an
// included set for the operator's own row (ui/tenant-registry.mjs merges exactly that one field on
// to the env-seeded operator entry and nothing else). A tiny stub answers /models for it, because
// the point is what the console DRAWS, not whether a proxy is up.
//
// THE ORDER IS LOAD BEARING. The three always-visible surfaces name the endpoint THE BOX IS ON, so
// they are measured only after the box has been moved on to the plan model. Measured before, they
// would truthfully name whatever the box was on already, which is a correct answer to a different
// question and would have read as a pass.
//
// IT MOVES THE LOCAL BOX AND PUTS IT BACK. That move is a real write to grok-bot-local-vm's
// box-secrets.json. The file is snapshotted first, restored in a finally, and the restore is
// verified byte for byte -- a mismatch is itself a failure. Pass --no-move to skip it (the plan
// card and the picker still run) when another gate is mid-turn on the same box.
//
//   node scripts/verify-models.mjs
//   node scripts/verify-models.mjs --no-move
//   node scripts/verify-models.mjs --box some-other-container --keep     (--keep leaves it running)
//
// playwright-core is resolved the way every other browser gate here resolves it:
// GROK_BOT_PLAYWRIGHT_DIR, defaulting to .cache/playwright, which scripts/setup-gates.sh fills.
// In a git worktree that directory is usually only in the main checkout, so the main checkout's
// copy is a documented fallback rather than a reason to fail.
//
// Nothing here prints a key. The box's existing secrets are read into a string, written back
// unread, and compared by sha256 prefix.
//
// Exit 0 no leg failed, 1 a leg failed, 2 nothing could be measured.
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : argv[at + 1] ?? null;
};
const has = (name) => argv.includes(`--${name}`);
const BOX = flag("box") ?? process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const MOVE = !has("no-move");
const KEEP = has("keep");

let failures = 0;
let skipped = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} -- ${why}`); skipped += 1; };
const step = (name) => console.log(`\n== ${name}`);
const die = (why) => { console.error(`nothing could be measured: ${why}`); process.exit(2); };
const sha = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

// THE ALIAS RULE, in one place because it is asserted against four surfaces. `plan-` is the
// operator's routing prefix and a customer must never read it as the name of their model. The check
// runs over TEXT a person can see, never over markup: a data attribute carrying plan:plan-zai is
// how the page keys its own cards and is nobody's model name.
const ALIAS = /plan-[a-z0-9]/i;
const aliasFree = (text, label) => check(!ALIAS.test(text), label,
  ALIAS.test(text) ? `saw "${(text.match(/\S*plan-[a-z0-9]\S*/i) ?? [""])[0]}"` : "");

// ---- the arrangement --------------------------------------------------------------------------

// The plan this console draws. One model NAMED and one deliberately not, because the fallback for
// an unnamed model is a real state (every plan model on the R750 is unnamed today) and the console
// has to show its alias plainly rather than a hole or a guess.
const LABEL = "GLM-5.3";
const PLAN_MODELS = [
  { id: "plan-zai", model: "plan-zai", name: "Z.AI GLM (included with your plan)", modelLabel: LABEL, contextWindow: 200000, servedBy: "Z.AI" },
  { id: "plan-unnamed", model: "plan-unnamed", name: "A model nobody has named (included with your plan)", contextWindow: 64000, servedBy: "Z.AI" },
];

// A proxy that answers /models, so the console's one probe for the whole included set succeeds and
// the cards draw as reachable. It never serves a completion: no leg here sends one.
function startStubProxy() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: PLAN_MODELS.map((row) => ({ id: row.id })) }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    stop: () => new Promise((done) => server.close(done)),
  })));
}

async function waitFor(predicate, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await predicate()) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startRelay({ proxyUrl, gatewayToken }) {
  const scratch = mkdtempSync(path.join(tmpdir(), "verify-models-"));
  const tenants = path.join(scratch, "tenants.json");
  writeFileSync(tenants, JSON.stringify({
    tenants: [{
      slug: "titanium",
      included: { baseUrl: proxyUrl, key: "sk-stub-for-this-gate-only", keyId: "key-gate", enforced: false, models: PLAN_MODELS },
    }],
  }, null, 2));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 39000 + Math.floor(Math.random() * 4000);
    const child = spawn(process.execPath, [path.join(REPO, "ui/server.mjs")], {
      env: {
        ...process.env,
        SAND_UI_PORT: String(port),
        SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_UI_STATE_DIR: scratch,
        // Belt and braces: the subscriptions store is named explicitly as well as by state dir, so
        // there is no path on which this gate can write the operator's own ui/subscriptions.json.
        GROK_BOT_SUBSCRIPTIONS_FILE: path.join(scratch, "subscriptions.json"),
        SAND_UI_TENANTS_FILE: tenants,
        SAND_BOX_CONTAINER: BOX,
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1340",
        SAND_HOST_GATEWAY_TOKEN: gatewayToken,
        CP_URL: "", CP_RELAY_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += String(d); });
    child.stderr.on("data", (d) => { log += String(d); });
    const base = `http://127.0.0.1:${port}`;
    const up = await waitFor(async () => (await fetch(`${base}/endpoints`, { headers: { accept: "application/json" } })).ok, 15000);
    if (up) return { base, scratch, stop: () => child.kill("SIGTERM"), log: () => log };
    child.kill("SIGKILL");
    if (attempt === 4) die(`the relay would not start on 127.0.0.1:${port}: ${log.slice(-600)}`);
  }
  return null;
}

// ---- the box ------------------------------------------------------------------------------------

const SECRETS = "/home/box/sand-data/box-secrets.json";
const boxRead = async (file) => (await exec("docker", ["exec", BOX, "cat", file], { maxBuffer: 4 << 20 })).stdout;
// The same writer ui/server.mjs uses, mode and truncation included, so a restore leaves the file
// exactly as the console would have.
function boxWrite(file, body) {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", ["exec", "-i", BOX, "sh", "-c",
      `umask 077 && cat > ${file} && chmod 600 ${file}`], (err) => (err ? reject(err) : resolve()));
    child.stdin.end(body);
  });
}
const secretsOf = async () => { try { return JSON.parse(await boxRead(SECRETS)).secrets ?? {}; } catch { return {}; } };

// ---- run ----------------------------------------------------------------------------------------

const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
  ?? [path.join(REPO, ".cache/playwright"), "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/playwright"]
    .find((dir) => existsSync(path.join(dir, "node_modules/playwright-core")))
  ?? path.join(REPO, ".cache/playwright");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(path.join(PW_DIR, "node_modules/playwright-core"))) {
  die(`no playwright-core under ${PW_DIR}; run scripts/setup-gates.sh or set GROK_BOT_PLAYWRIGHT_DIR`);
}
if (!existsSync(CHROME)) die(`no Chrome at ${CHROME}`);
const { chromium } = createRequire(`${PW_DIR}/package.json`)("playwright-core");

let gatewayToken = "";
try {
  // Into a variable and never to a log. The gate needs it because the box's gateway answers 401
  // without it, and a console with no roster cannot show an agent context card at all.
  gatewayToken = (await exec("docker", ["exec", BOX, "printenv", "SAND_GATEWAY_TOKEN"])).stdout.trim();
} catch { die(`could not reach the box ${BOX}; is it running?`); }
if (gatewayToken.length === 0) die(`${BOX} carries no SAND_GATEWAY_TOKEN, so its gateway cannot be reached`);

const before = MOVE ? await boxRead(SECRETS).catch(() => null) : null;
if (MOVE && before == null) die(`could not read ${SECRETS} out of ${BOX}`);

// A KILL MUST NOT LEAVE THE BOX ON THE STUB. `timeout 280` is on every gate in this repo by
// standing rule, and SIGTERM does not run an async finally: a run that hits the ceiling mid-leg
// would otherwise leave the operator's own box pointed at a loopback proxy that no longer exists,
// which is a real outage caused by a test. This handler is synchronous on purpose -- one blocking
// docker exec is the whole of it -- and it runs before the default handler exits the process.
// (It happened here on 2026-09-08: `docker exec` against grok-bot-local-vm blocked for minutes
// while the box was busy, the 280 s ceiling fired, and nothing in the finally ran.)
let restoreDone = false;
function restoreNow(why) {
  if (restoreDone || !MOVE || before == null) return;
  restoreDone = true;
  try {
    execFileSync("docker", ["exec", "-i", BOX, "sh", "-c",
      `umask 077 && cat > ${SECRETS} && chmod 600 ${SECRETS}`], { input: before, timeout: 30000 });
    console.log(`\n== ${BOX} box-secrets.json put back after ${why} (sha256 ${sha(before)})`);
  } catch (error) {
    console.log(`\n== ${BOX} box-secrets.json COULD NOT BE PUT BACK after ${why}: ${error.message}`);
    console.log(`   it is pointed at this gate's stub proxy; switch it back in the console, or restore from the snapshot`);
  }
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => { restoreNow(signal); process.exit(2); });
}

const proxy = await startStubProxy();
const relay = await startRelay({ proxyUrl: proxy.url, gatewayToken });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let restored = "not attempted";

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const closePanel = () => page.evaluate(() => document.getElementById("panel-dialog")?.close());
  const openSettings = async () => {
    // The panel is a modal <dialog>, so a second click on the gear lands on the backdrop rather
    // than on the button. Close first, every time.
    await closePanel();
    await page.click("#shelf-settings");
    await page.waitForSelector('[data-plugin-group="Plan"]', { timeout: 20000 });
  };

  await page.goto(`${relay.base}/`, { waitUntil: "domcontentloaded", timeout: 30000 });

  step(`the console at ${relay.base}, box ${BOX}`);
  const roster = await page.waitForSelector(".context-profile", { timeout: 60000 }).then(() => true).catch(() => false);
  check(roster, "the console loaded with a real agent on screen");
  if (!roster) {
    // Almost always a busy box rather than a broken page. MEASURED on this Mac 2026-09-08: while
    // another gate held grok-bot-local-vm, `docker exec` against it blocked for minutes and the
    // gateway answered nothing, so the roster never arrived. That is a machine that cannot be
    // measured right now, not a product that is wrong, and the two must not read the same.
    const alive = await fetch(`${relay.base}/api/listAgents`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }).then((r) => r.ok).catch(() => false);
    throw new Error(alive
      ? `the gateway answers but no agent context card rendered; relay log: ${relay.log().slice(-300)}`
      : `${BOX}'s gateway did not answer, so this box is busy or down; run this gate again when it is idle`);
  }

  // ---- 1. the plan card -------------------------------------------------------------------------
  //
  // Read before anything is switched: a plan card draws from the registry rather than from whatever
  // the box happens to be on, and it has to be right either way.
  step("1. the plan card on Settings");
  await openSettings();
  await page.click('button.plugin-nav-button[data-plugin-id="plan:plan-zai"]');
  await page.waitForSelector('[data-plugin-group="Plan"] .plugin-detail', { timeout: 15000 });
  const planCard = await page.textContent('[data-plugin-group="Plan"] .plugin-detail');
  check(planCard.includes(`${LABEL} · 200k context`), "the plan card names the model and its window",
    `read "${(planCard.match(/[^·\n]*· 200k context[^.]*\./) ?? ["(not found)"])[0].trim()}"`);
  aliasFree(planCard, "the plan card carries no routing alias");
  check(!/\$|budget|titanbot|proxy/i.test(planCard), "and no money and no plumbing on it either");

  // The unnamed model. Its alias is SUPPOSED to be here: it is the visible symptom of a plan model
  // the operator has not named, and the Providers panel is where it gets named. A console that hid
  // it would hide the only evidence anybody has that the naming step was missed.
  await page.click('button.plugin-nav-button[data-plugin-id="plan:plan-unnamed"]');
  await page.waitForTimeout(200);
  const unnamed = await page.textContent('[data-plugin-group="Plan"] .plugin-detail');
  check(unnamed.includes("plan-unnamed · 64k context"),
    "an unnamed plan model shows its alias plainly rather than a hole or a guess",
    `read "${(unnamed.match(/[^·\n]*· 64k context[^.]*\./) ?? ["(not found)"])[0].trim()}"`);

  // ---- 2. and the box actually moves ------------------------------------------------------------
  step(`2. what ${BOX} will answer with on its next turn`);
  let onPlan = false;
  if (!MOVE) skip("the box is moved on to the plan model", "--no-move, so the three always-visible surfaces cannot be measured either");
  else {
    await openSettings();
    await page.click('button.plugin-nav-button[data-plugin-id="plan:plan-zai"]');
    const use = await page.waitForSelector('[data-use-endpoint="plan-zai"]', { timeout: 15000 }).catch(() => null);
    if (use == null) skip("the box is moved on to the plan model", "the card offered no Use button");
    else {
      await use.click();
      onPlan = await waitFor(async () => (await secretsOf()).SAND_OPENAI_COMPATIBLE_MODEL === "plan-zai", 30000);
      check(onPlan, "clicking Use pointed the box at the plan model");
      const secrets = await secretsOf();
      // THE WHOLE POINT OF THE WAVE'S FIRST COMMIT, at the far end of the wire: the box was told
      // what to CALL itself, not just what to route to. The host re-reads this file on every
      // stream, so this is what the customer's Titan says from its next turn, nothing restarted.
      check(secrets.SAND_OPENAI_COMPATIBLE_MODEL_LABEL === LABEL,
        "and told it what to call itself, which is what the customer's Titan reports",
        secrets.SAND_OPENAI_COMPATIBLE_MODEL_LABEL === undefined
          ? "no label reached the box, which is the R750's state before this wave"
          : `wrote ${secrets.SAND_OPENAI_COMPATIBLE_MODEL_LABEL}`);
      check(secrets.SAND_OPENAI_COMPATIBLE_SERVED_BY === "Z.AI", "and who serves it");
    }
  }

  // ---- 3. the surfaces a customer reads without opening anything --------------------------------
  step("3. the surfaces that need no Settings visit");
  if (!onPlan) skip("the always-visible surfaces", "the box was not moved on to the plan model");
  else {
    await closePanel();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".context-profile", { timeout: 30000 });
    // The card is filled from the same catalog read the picker is, so wait for the box's endpoint
    // to have been resolved rather than racing the first paint.
    await waitFor(async () => (await page.textContent(".context-profile")).includes(LABEL), 20000);

    const contextText = await page.textContent(".context-profile");
    check(contextText.includes(LABEL), "the agent context card names the model",
      `read "${(contextText.match(/Endpoint \(box-wide\)([^\n]*)/) ?? ["", "(not found)"])[1].trim().slice(0, 90)}"`);
    aliasFree(contextText, "the agent context card carries no routing alias");

    await page.click('[data-context-action="profile"]');
    await page.waitForSelector(".panel-grid .tag-list", { timeout: 15000 });
    const profileText = await page.textContent(".panel-grid .tag-list");
    check(profileText.includes(LABEL), "the agent profile panel names the model", `read "${profileText.trim().slice(0, 90)}"`);
    aliasFree(profileText, "the agent profile panel carries no routing alias");

    await openSettings();
    // The picker is filled after the catalog read, so "Loading…" is a race and not an answer.
    await waitFor(async () => !(await page.textContent("#endpoint-select")).includes("Loading"), 20000);
    const menu = (await page.textContent("#endpoint-select")).replace(/\s+/g, " ").trim();
    check(menu.includes(LABEL), "the endpoint picker names the model", `read "${menu.slice(0, 140)}"`);
    // The picker lists every endpoint, the unnamed plan model included, whose alias belongs there
    // for the same reason it belongs on its own card. So the alias rule is applied to the ONE entry
    // this box is actually set to, which is the string that also lands on the two cards above.
    const current = (await page.$eval("#endpoint-select", (n) => n.selectedOptions[0]?.textContent ?? "")).trim();
    aliasFree(current, "and the entry it is set to carries no routing alias");

    // "Currently answering", which is the row a person checks when they want to know what the box
    // is on right now. It said the plan's name twice until this wave.
    const answering = (await page.textContent("#endpoint-current")).replace(/\s+/g, " ").trim();
    check(answering.includes(LABEL), "Currently answering names the model", `read "${answering.slice(0, 120)}"`);
    check((answering.match(/included with your plan/g) ?? []).length <= 1,
      "and says it once rather than twice", `read "${answering.slice(0, 120)}"`);
    aliasFree(answering, "and carries no routing alias");
  }

  // ---- 4. the customer's own provider, and its model list ---------------------------------------
  step("4. a provider the customer brought themselves");
  // Adopted through the relay's own door with a throwaway key, into this gate's scratch store. The
  // value never leaves this Mac and is never used for a completion; what is being measured is the
  // picker the card draws once a provider is connected.
  const adopted = await fetch(`${relay.base}/subscriptions/adopt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "zai", apiKey: `gate-only-${Date.now()}` }),
  });
  if (!adopted.ok) {
    skip("the provider card's model picker", `this relay would not adopt a provider (HTTP ${adopted.status})`);
  } else {
    await closePanel();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".context-profile", { timeout: 30000 });
    await openSettings();
    const nav = '[data-plugin-group="Providers"] button.plugin-nav-button[data-plugin-id="sub:zai"]';
    const card = await page.waitForSelector(nav, { timeout: 20000 }).catch(() => null);
    check(card != null, "the adopted provider has a card in Settings");
    if (card != null) {
      await page.click(nav);
      const picker = await page.waitForSelector('select[data-provider-model="sub:zai"]', { timeout: 15000 }).catch(() => null);
      check(picker != null, "a connected provider card offers a model list rather than a free-text field");
      if (picker != null) {
        const ids = await page.$$eval('select[data-provider-model="sub:zai"] option', (nodes) => nodes.map((n) => n.value));
        check(ids.length >= 2, "the list has models in it", `${ids.length}: ${ids.slice(0, 6).join(", ")}`);
        const row = (await page.textContent('[data-model-row="sub:zai"]')).replace(/\s+/g, " ");
        // The source line is the claim being made about the list, and it is the half a person acts
        // on. Either wording is right; a card that says neither is not.
        const live = /own list, read when this page last checked/.test(row);
        const curated = /this is the list we ship for it/.test(row) || /could not be read just now/.test(row);
        check(live || curated, "and the card says where the list came from",
          live ? "live: the provider's own list" : curated ? "curated: the list we ship" : `read "${row.trim().slice(0, 140)}"`);
        // The two clocks, said apart. This box is on the plan, not on this provider, so the card
        // has to say the change waits rather than promise something immediate.
        check(/waits until you pick this provider|from the next turn/.test(row),
          "and which clock a change here runs on", `read "${(row.match(/This box[^.]*\./) ?? ["(not found)"])[0]}"`);

        // Choosing one. The measurement is not that the select changed -- it is that the RELAY's
        // own answer moved, which is what /endpoints/use reads when the box is pointed here.
        const opened = await page.$eval('select[data-provider-model="sub:zai"]', (n) => n.value);
        const target = ids.find((id) => id.length > 0 && id !== opened) ?? ids[1];
        await page.selectOption('select[data-provider-model="sub:zai"]', target);
        const moved = await waitFor(async () => {
          const body = await (await fetch(`${relay.base}/endpoints`, { headers: { accept: "application/json" } })).json();
          return (body.endpoints ?? []).some((e) => e.id === "sub-zai" && e.model === target);
        }, 15000);
        check(moved, `choosing ${target} moved the stored endpoint, asked of the relay and not of the page`);
        // MODELS-1's context-window rule, measured rather than asserted: a model nobody has measured
        // a window for must not inherit the preset's number.
        const body = await (await fetch(`${relay.base}/endpoints`, { headers: { accept: "application/json" } })).json();
        const zai = (body.endpoints ?? []).find((e) => e.id === "sub-zai") ?? {};
        if (target === "glm-5.3") skip("the context window is not guessed", "the default's own window is a measured number");
        else check(zai.contextWindow === undefined, `a model with no measured window inherits no number (${target})`,
          zai.contextWindow === undefined ? "left out, so the host takes its own default" : `wrote ${zai.contextWindow}`);
      }
    }
  }
} catch (error) {
  check(false, "the run itself", String(error?.message ?? error).split("\n")[0]);
} finally {
  await browser.close().catch(() => {});
  if (!KEEP) relay.stop();
  await proxy.stop();
  if (MOVE && before != null && !restoreDone) {
    // Byte for byte, and verified. A gate that leaves the operator's box pointed at a stub is a
    // worse failure than anything it was measuring, so a mismatch counts as a failed leg.
    restoreDone = true;
    try {
      await boxWrite(SECRETS, before);
      const after = await boxRead(SECRETS);
      restored = after === before ? `restored (sha256 ${sha(before)})` : `RESTORE MISMATCH: was ${sha(before)}, is ${sha(after)}`;
      if (after !== before) failures += 1;
    } catch (error) { restored = `RESTORE FAILED: ${error.message}`; failures += 1; }
    console.log(`\n== ${BOX} box-secrets.json: ${restored}`);
  }
}

console.log(`\n${failures === 0 ? "verify-models: every leg passed" : `verify-models: ${failures} leg(s) failed`}`
  + `${skipped > 0 ? `, ${skipped} skipped` : ""} -- measured on this Mac against ${BOX}`);
process.exit(failures === 0 ? 0 : 1);
