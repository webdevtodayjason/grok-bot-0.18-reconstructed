// TITAN-CATALOG-1 — the catalog import, against a real box.
//
// The unit tests pin the ORDER of the import against a fake box, which is the only honest place to
// pin an order. This proves the other half: that the order run against a REAL box leaves an agent
// that holds what the catalog row says it holds, and that the console's door and the agent's door
// leave the same agent.
//
// WHAT EACH LEG IS HERE FOR, rather than in the unit test:
//
//   THE BOX'S OWN CATALOG ANSWER DRIVES IT. The row comes from getMarketplaceItem on the box, not
//   from a fixture. The defect this wave fixes was invisible to a fixture: the console read
//   `pluginId`/`description` and every catalog row carries `plugin`/`line`, so on 2026-09-09 the
//   live host's own answer for `account-book` put all eleven of its apps — Slack, Notion, Linear,
//   Gmail included — in the add-your-own bucket and the receipt told a customer we do not carry
//   Slack. A leg below asserts that no app carrying a plugin id is ever reported that way.
//
//   THE TWO DOORS ARE COMPARED ON ONE BOX. The same bot is imported through the gateway verb and
//   through ui/machine-room/bot-setup.js loaded into this process, and the two agents are compared
//   field for field. That is the claim the whole wave rests on and it cannot be made in a fixture.
//
//   WHAT THE BOX HOLDS, NOT WHAT WAS ASKED FOR. addMemory answers null on a duplicate and the
//   automation store answers 200 on a write it dropped, so every claim is read back.
//
//   THE ROSTER AND THE LIBRARY ARE DIFFED, NEVER COUNTED. This box carries dozens of agents and a
//   shared library thick with probe debris, so every leg takes a before-set and an after-set.
//
// It writes to the roster and to the shared library, so run it ALONE, through scripts/on-box.sh.
// Everything it creates is taken back in the finally, whatever happened, and the check is that the
// bots THIS gate made are off the roster — never that the roster count matches. Measured
// 2026-09-09: another wave was driving grok-bot-local-vm at the same time and its scratch agents
// came and went under the run, so a count equality failed on somebody else's work.
//
//   node scripts/verify-titan-catalog.mjs
//   node scripts/verify-titan-catalog.mjs --bot <id>   set the row it uses
//   node scripts/verify-titan-catalog.mjs --keep       leave what it created on the box
//
//   0  every leg passed        1  a leg failed        2  nothing could be measured
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
// SIGNIN-1: every gate says who it is, so the sign-in panel can tell a gate from an attacker.
const USER_AGENT = "titanbot-gate/verify-titan-catalog";

const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const KEEP = process.argv.includes("--keep");
const WANTED_BOT = flag("--bot", "");
// Measured on grok-bot-local-vm: the bot's own words appear roughly 60 s after the import. The
// ceiling is generous rather than tight because a slow first token is not this wave's failure.
const FIRST_MESSAGE_CEILING_MS = Number(flag("--first-message-ms", "110000"));

let failures = 0;
let unmeasured = 0;
class NothingToMeasure extends Error {}
const bail = (why) => { throw new NothingToMeasure(why); };
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); unmeasured += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const step = (name) => console.log(`\n== ${name}`);
const oneLine = (value, width = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, width);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch { /* the next one */ }
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}

let TOKEN;
try { TOKEN = token(); } catch (error) {
  console.error(`nothing could be measured: ${error.message}`);
  process.exit(2);
}

const gw = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};

/**
 * The console's half, loaded the way tests/helpers/bot-setup-console.mjs loads it: the file is an
 * IIFE that attaches window.__botSetup and touches no DOM. Loading the real file rather than
 * re-implementing the call is the point — a copy of it here would pass while the console did
 * something else.
 */
function consoleSetup() {
  const win = {
    fetch: async () => { throw new Error("the setup path must not reach the network directly"); },
    Element: class {},
    document: null,
    __machineRoomLive: true,
  };
  const source = readFileSync(path.join(repoRoot, "ui/machine-room/bot-setup.js"), "utf8");
  const module = new Function("window", `${source}\nreturn window.__botSetup;`)(win);
  if (module == null || typeof module.setUpBot !== "function") throw new Error("bot-setup.js did not export setUpBot");
  return module;
}

const listOf = (value) => (Array.isArray(value) ? value : []);
const names = (rows) => new Set(listOf(rows).map((row) => String(row?.name ?? "")).filter(Boolean));
const workflowNames = (rows) => new Set(listOf(rows).filter((row) => row && row.source !== "automation")
  .map((row) => String(row.name ?? row.id ?? "")).filter(Boolean));

const made = { agents: [], workflows: [] };

async function main() {
  step("the box, and the row this runs against");
  const health = await fetch(`${GATEWAY}/health`, { headers: { authorization: `Bearer ${TOKEN}`, "user-agent": USER_AGENT } })
    .then((res) => res.json()).catch(() => null);
  if (health == null) bail(`no gateway at ${GATEWAY}`);
  info(`gateway ${GATEWAY}, pid ${health.pid}`);

  const catalog = await gw("listMarketplace");
  const cards = listOf(catalog?.bots);
  if (cards.length === 0) bail("the box served no bots");
  info(`the box serves ${cards.length} bots and ${listOf(catalog?.plugins).length} plugins`);

  // A row worth measuring: it carries apps, playbooks, jobs and memories, and at least one app that
  // names a plugin, because the app bucketing is what this wave fixed.
  const wanted = WANTED_BOT
    ? cards.find((card) => card.id === WANTED_BOT)
    : cards.find((card) => card.counts?.apps > 0 && card.counts?.skills > 0 && card.counts?.routines > 0 && card.counts?.memories > 0 && !card.members);
  if (wanted == null) bail(WANTED_BOT ? `the box has no bot "${WANTED_BOT}"` : "no single bot on this box carries apps, playbooks, jobs and memories");
  const row = await gw("getMarketplaceItem", { kind: "bot", id: wanted.id });
  const withPlugin = listOf(row.apps).filter((app) => String(app.plugin ?? app.pluginId ?? "").length > 0);
  info(`row ${row.id} "${row.name}": ${listOf(row.memories).length} memories, ${listOf(row.skills).length} playbooks, ${listOf(row.routines).length} jobs, ${listOf(row.apps).length} apps (${withPlugin.length} naming a plugin we carry)`);
  if (withPlugin.length === 0) skip("the app buckets", "this row names no plugin, so the bucketing has nothing to get wrong");

  const capacity = await gw("getAgentCapacity").catch(() => null);
  if (capacity != null) {
    info(`roster ${capacity.bots} of ${capacity.maxAgents}`);
    if (capacity.remaining < 2) bail(`this box has room for ${capacity.remaining} more bots and this needs 2`);
  }

  const rosterBefore = listOf(await gw("listAgents"));
  const libraryBefore = workflowNames(await gw("getAgentWorkflows", { id: String(rosterBefore[0]?.id ?? "") }).catch(() => []));
  const takenNames = new Set(rosterBefore.map((agent) => String(agent.name ?? "")));
  if (takenNames.has(row.name)) bail(`"${row.name}" is already on this box's roster; run with --bot <another id>`);
  info(`roster ${rosterBefore.length} agents, shared library ${libraryBefore.size} documents`);

  // ---------------------------------------------------------------- the verb
  step("the import, through the gateway verb");
  const startedAt = Date.now();
  const first = await gw("importMarketplaceBot", { id: row.id });
  info(`${Date.now() - startedAt} ms — ${oneLine(first.message)}`);
  check(first.state === "done", "the verb set the bot up", `state ${first.state}`);
  if (first.state !== "done") bail(`the import did not run: ${oneLine(first.message)}`);
  made.agents.push(first.agentId);
  for (const name of listOf(first.skills?.imported)) made.workflows.push(name);
  check(first.alreadyExisted === false, "it was reported as new rather than found");
  check(String(first.agent?.name) === row.name, "the agent carries the row's name", String(first.agent?.name));

  step("what the box actually holds for it");
  const [memoryRows, workflowRows, automationRows] = await Promise.all([
    gw("getAgentMemories", { id: first.agentId }),
    gw("getAgentWorkflows", { id: first.agentId }),
    gw("getAgentAutomations", { id: first.agentId }),
  ]);
  // Every fact the row carries, character for character. The store slices anything over its cap and
  // says nothing, so a fact that came back shortened is a fact the person never got.
  const held = new Set(listOf(memoryRows).map((r) => String(r.content ?? "").replace(/\s+/g, " ").trim()));
  const rowFacts = listOf(row.memories).flatMap((m) => (listOf(m.facts).length > 0 ? listOf(m.facts) : [m.text]))
    .map((fact) => String(fact ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const missingFacts = rowFacts.filter((fact) => !held.has(fact));
  check(missingFacts.length === 0, `all ${rowFacts.length} of the row's facts are stored whole`,
    missingFacts.length ? `${missingFacts.length} missing, first: ${oneLine(missingFacts[0], 90)}` : "");
  check(first.memories.added === rowFacts.length, "the receipt counts what the box holds",
    `${first.memories.added} of ${rowFacts.length}`);

  // The library is box-wide, so the bot's own documents are the diff, never the count.
  const heldDocuments = workflowNames(workflowRows);
  const wantedDocuments = [...listOf(first.skills?.imported), ...listOf(first.skills?.reused)];
  const absent = wantedDocuments.filter((name) => !heldDocuments.has(name));
  check(wantedDocuments.length === listOf(row.skills).length,
    `all ${listOf(row.skills).length} of the row's playbooks are accounted for`, `${wantedDocuments.length} named`);
  check(absent.length === 0, "every playbook the receipt names is in the library", absent.join(", "));

  const heldJobs = listOf(automationRows);
  const rowCrons = listOf(row.routines).filter((r) => /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(String(r.schedule ?? "")));
  check(heldJobs.length === rowCrons.length, `all ${rowCrons.length} of the row's jobs on a clock were created`, `${heldJobs.length} on the box`);
  check(heldJobs.length > 0 && heldJobs.every((job) => job.isEnabled !== true), "every job is switched off",
    heldJobs.filter((job) => job.isEnabled === true).map((job) => job.name).join(", "));
  check(listOf(row.routines).length - rowCrons.length === listOf(first.routines?.notCreated).length,
    "every job that names no clock is reported with its reason in plain words");

  // ---------------------------------------------------------------- the app buckets, the defect
  step("the apps the receipt names");
  if (withPlugin.length > 0) {
    const unavailable = new Set(listOf(first.integrations?.unavailable));
    const wrong = withPlugin.map((app) => String(app.label ?? app.name)).filter((label) => unavailable.has(label));
    check(wrong.length === 0, "no app this box carries a plugin for is called one we do not carry", wrong.join(", "));
    const placed = new Set([...listOf(first.integrations?.connected), ...listOf(first.integrations?.offered), ...listOf(first.integrations?.informational)]);
    const lost = withPlugin.map((app) => String(app.label ?? app.name)).filter((label) => !placed.has(label));
    check(lost.length === 0, "every app naming a plugin is either connected or offered", lost.join(", "));
    const slack = withPlugin.find((app) => /slack/i.test(String(app.label ?? app.name)));
    if (slack != null) {
      const label = String(slack.label ?? slack.name);
      check(!unavailable.has(label), "Slack is not reported as something we do not carry");
    } else info("this row does not use Slack; the same claim is made above for every app that names a plugin");
    check(!/is not something we carry yet/.test(first.message) || listOf(first.integrations?.unavailable).length > 0,
      "the receipt only says we carry nothing for an app when that is true");
    info(`connected ${JSON.stringify(first.integrations.connected)} offered ${JSON.stringify(first.integrations.offered)} unavailable ${JSON.stringify(first.integrations.unavailable)}`);
  }

  // ---------------------------------------------------------------- the second door
  step("the same bot, through the console's own file");
  const setup = consoleSetup();
  const before = new Set(listOf(await gw("listAgents")).map((agent) => String(agent.id)));
  const phases = [];
  const second = await setup.setUpBot({ call: gw }, row, { duplicate: true, onProgress: (p) => phases.push(p.phase) });
  check(second.state === "done", "the console's press set the bot up too", `state ${second.state}`);
  if (second.state !== "done") bail(`the console door did not run: ${oneLine(second.message)}`);
  made.agents.push(second.agentId);
  for (const name of listOf(second.skills?.imported)) made.workflows.push(name);
  check(phases.length === 2, "the card was given a progress phase at each end", phases.join(", "));
  const after = listOf(await gw("listAgents"));
  const minted = after.filter((agent) => !before.has(String(agent.id)));
  check(minted.length === 1, "the console's press made exactly one bot", `${minted.length}`);

  step("the two doors leave the same agent");
  const [m2, w2, a2] = await Promise.all([
    gw("getAgentMemories", { id: second.agentId }),
    gw("getAgentWorkflows", { id: second.agentId }),
    gw("getAgentAutomations", { id: second.agentId }),
  ]);
  const factsOf = (rows) => [...new Set(listOf(rows).map((r) => String(r.content ?? "").replace(/\s+/g, " ").trim()))].sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(same(factsOf(memoryRows), factsOf(m2)), "both agents remember the same facts");
  const documentsOf = (report) => [...listOf(report.skills?.imported), ...listOf(report.skills?.reused)].sort();
  check(same(documentsOf(first), documentsOf(second)), "both agents hold the same playbooks",
    `${documentsOf(first).length} vs ${documentsOf(second).length}`);
  const jobsOf = (rows) => [...names(rows)].sort();
  check(same(jobsOf(automationRows), jobsOf(a2)), "both agents carry the same jobs");
  check(listOf(a2).every((job) => job.isEnabled !== true), "the console's bot has its jobs switched off too");
  const buckets = (report) => JSON.stringify({
    connected: [...listOf(report.integrations?.connected)].sort(),
    offered: [...listOf(report.integrations?.offered)].sort(),
    informational: [...listOf(report.integrations?.informational)].sort(),
    unavailable: [...listOf(report.integrations?.unavailable)].sort(),
  });
  check(buckets(first) === buckets(second), "both receipts say the same thing about its apps");
  // The console holds the second copy of nothing: its documents were REUSED, because the box's
  // library already held them from the first import.
  check(listOf(second.skills?.imported).length === 0 && listOf(second.skills?.reused).length === wantedDocuments.length,
    "the second import reused the library rather than doubling it",
    `${listOf(second.skills?.imported).length} written, ${listOf(second.skills?.reused).length} reused`);
  check(workflowNames(w2).size >= wantedDocuments.length, "the shared library did not shrink under the second import");

  // ---------------------------------------------------------------- a third press
  step("a second press writes nothing");
  const third = await gw("importMarketplaceBot", { id: row.id });
  check(third.state === "already" && third.alreadyExisted === true, "it says it is already there", `state ${third.state}`);
  check(String(third.agentId) === String(first.agentId), "and points at the bot that is already there");
  const rosterNow = listOf(await gw("listAgents"));
  const mineOnRoster = rosterNow.filter((agent) => made.agents.includes(String(agent.id))).length;
  check(mineOnRoster === 2, "the two this gate made are on the roster and the press added no third", `${mineOnRoster}`);
  info(`the roster is ${rosterNow.length}, ${rosterBefore.length} before this gate; the difference is not this gate's to assert on a box other work shares`);

  // ---------------------------------------------------------------- the bot's own words
  step("the bot's own introduction");
  // WHAT THIS LEG OWNS, and what it does not. The wave's claim is that the introduction is asked
  // for LAST, after everything is seeded, and that the box took the request; that is checked. The
  // WORDS then depend on the model behind the box, which this wave neither owns nor changed, and
  // BOX-7 records that some boxes start no introduction at all. So the words are reported when they
  // come and named as unmeasured when they do not, rather than turning a slow endpoint into a red
  // gate for a defect that is not here.
  check(first.introduction?.started === true, "the box took the request to write the bot's first message",
    `isIntroductionInFlight ${first.introduction?.started}`);
  if (first.introduction?.started !== true) {
    skip("the bot's own words", "this box starts no introduction for a new agent (BOX-7's shape); nothing was waited for");
    return;
  }
  const startedWaiting = Date.now();
  let said = "";
  while (Date.now() - startedWaiting < FIRST_MESSAGE_CEILING_MS) {
    const tail = await gw("getAgentTranscriptTail", { id: first.agentId, limit: 20 }).catch(() => null);
    // MEASURED on grok-bot-local-vm 2026-09-09: the agent's own words are an entry of kind
    // "send-message" carrying `message.content`. They are NOT a role of "assistant" — the transcript
    // has no such role — and a gate that looked for one timed out for its full ceiling against a box
    // that had already spoken, which is a gate measuring itself.
    const entries = listOf(tail?.entries ?? tail);
    const spoken = entries.filter((entry) => String(entry?.kind ?? "") === "send-message");
    const body = spoken.map((entry) => String(entry?.message?.content ?? entry?.text ?? "")).filter(Boolean).join(" ");
    if (body.trim().length > 0) { said = body; break; }
    await sleep(5000);
  }
  if (said) {
    check(true, `it introduced itself after ${Math.round((Date.now() - startedWaiting) / 1000)} s`, oneLine(said, 140));
  } else {
    skip("the bot's own words", `the box took the request and wrote nothing in ${Math.round(FIRST_MESSAGE_CEILING_MS / 1000)} s; that is the endpoint behind this box, not the import — raise --first-message-ms, or read the box's model settings`);
  }
}

async function cleanUp(rosterCount) {
  if (KEEP) { info(`--keep: left ${made.agents.length} bots and ${made.workflows.length} documents on the box`); return; }
  step("taking back what this gate made");
  // Documents first, while an agent to ask through is still alive.
  const survivor = made.agents.find(Boolean);
  if (survivor != null && made.workflows.length > 0) {
    const library = listOf(await gw("getAgentWorkflows", { id: survivor }).catch(() => []));
    for (const document of library) {
      if (!made.workflows.includes(String(document.name))) continue;
      await gw("deleteAgentWorkflow", { id: survivor, workflowId: String(document.id) }).catch(() => null);
    }
  }
  // An agent with a turn in flight — which is exactly what an agent that was just asked for its
  // introduction has — can refuse to be deleted. One swallowed refusal leaves a bot on somebody
  // else's roster, so this asks twice and then says plainly which one it could not take back.
  for (const id of made.agents) {
    if (!id) continue;
    let gone = await gw("deleteAgent", { id }).then(() => true).catch(() => false);
    if (!gone) { await sleep(5000); gone = await gw("deleteAgent", { id }).then(() => true).catch(() => false); }
    if (!gone) info(`could not take back ${id}; delete it by hand`);
  }
  const roster = listOf(await gw("listAgents").catch(() => []));
  const left = roster.filter((agent) => made.agents.includes(String(agent.id))).map((agent) => String(agent.id));
  check(left.length === 0, "every bot this gate made is off the roster", left.join(", "));
  // Never an equality on the count: this box is shared, and a roster that moved under the run is
  // somebody else's work, not this gate's leak.
  info(`the roster is ${roster.length}, ${rosterCount} when this gate started`);
}

let rosterAtStart = null;
try {
  rosterAtStart = listOf(await gw("listAgents")).length;
} catch { /* main will bail with a better sentence */ }

try {
  await main();
} catch (error) {
  if (error instanceof NothingToMeasure) {
    console.error(`\nnothing could be measured: ${error.message}`);
    if (rosterAtStart != null) await cleanUp(rosterAtStart).catch(() => null);
    process.exit(2);
  }
  console.error(`\nFAIL  ${error?.stack ?? error}`);
  failures += 1;
} finally {
  if (rosterAtStart != null) await cleanUp(rosterAtStart).catch((error) => console.error(`  cleanup: ${error?.message ?? error}`));
}

console.log(`\n${failures === 0 ? "every leg passed" : `${failures} leg${failures === 1 ? "" : "s"} failed`}${unmeasured ? `, ${unmeasured} unmeasured` : ""}`);
process.exit(failures === 0 ? 0 : 1);
