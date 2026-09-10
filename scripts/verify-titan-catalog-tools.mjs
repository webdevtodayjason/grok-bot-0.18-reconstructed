// TITAN-CATALOG-1. Does a bot look at the catalog before it builds a bot out of nothing?
//
// THIS IS THE TOOLS HALF OF THE WAVE'S GATE, and it is deliberately a second file rather than more
// legs in `scripts/verify-titan-catalog.mjs`. That one proves the IMPORT: that the host verb and
// the console's Add button leave the same agent on a real box, with the row the box's own catalog
// answer supplied. This one proves the CONVERSATION: that a real agent, asked the sentence in the
// report, looks at the catalog, reads a template and asks the question, instead of building a blank
// agent. The two run against the same box and neither needs the other.
//
// The report this exists for, twice on 2026-09-09. Jason at 17:40: "Titan should be able to see all
// connectors and all the agents as a catalog. When creating a new agent, it should be able to pull
// from those templates and ask, 'Would you like to use this template or would you like me to create
// one from scratch?'" And Titan himself at 17:38: he could create agents blank and read profile
// files, but "a template system where you pick a pre-built role (Instagram Marketer, Scribe,
// Research Agent, etc.) and it comes with a starter persona, memory seeds, and maybe connector
// configs, that's not here yet."
//
// MEASURED BEFORE THE WAVE, grok-bot-local-vm bundle df1300366eb2: asked "create me an Instagram
// marketer" a fresh agent made exactly ONE tool call, CreateAgent, and shipped an agent with a
// model-invented persona, 0 memories, 0 routines and no template. It never looked at the catalog
// and never offered one.
//
// So this gate does not read the prompt. It asks a real agent, on a real box, the sentence the
// report is about, and checks what the TURN DID:
//
//   the catalog was actually read     -> a getAgentStatusToolCall row in the conversation outline
//   a template was actually read      -> a readAgentTranscriptToolCall row in the same turn
//   real rows were offered by name    -> the names in the reply exist in listMarketplace
//   the question was asked            -> "one of those or from scratch", in the reply
//   and ONLY for a bot request         -> "what connectors do you have" is answered, not answered
//                                        with an offer to build a bot
//   no tool name reached the person   -> nothing in the reply names a tool or a proto case
//   from scratch still works          -> answering "from scratch" still puts a bot on the roster
//
// It mints its own scratch agents and deletes every one of them, pass or fail, so the roster ends
// at the count it started (agent-lifecycle-hygiene). Nothing it creates is left behind.
//
// A BOX WITHOUT THE IMPORT VERB IS A FAILURE, NOT A SKIP. This gate used to probe the gateway for
// `importMarketplaceBot` and, when the answer was no, print a NOTE and skip the create-from-template
// leg -- the one leg that proves the feature. Both halves of TITAN-CATALOG-1 ship in one bundle and
// the api declares the command unconditionally, so a box that answers no is a regression, and
// skipping the leg would hide exactly the thing this gate exists to catch. The probe stays; its
// verdict is red.
//
//   timeout 300 ./scripts/on-box.sh node scripts/verify-titan-catalog-tools.mjs --box grok-bot-local-vm
//
// It takes the shared box lock itself unless it is already inside one.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] != null ? argv[at + 1] : fallback;
};
const BOX = argOf("--box", process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm");
const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const AGENT = "titanbot-gate/verify-titan-catalog-tools";

// Gates share this box, its login throttle and its display, so they run one at a time.
if (process.env.VERIFY_TITAN_CATALOG_TOOLS_LOCKED !== "1") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(
    path.join(here, "on-box.sh"),
    [process.execPath, fileURLToPath(import.meta.url), ...argv],
    { stdio: "inherit", env: { ...process.env, VERIFY_TITAN_CATALOG_TOOLS_LOCKED: "1" } },
  );
  child.on("exit", (code, signal) => process.exit(signal != null ? 1 : code ?? 1));
} else {
  await main();
}

async function main() {

// The whole run has to fit the 300 s warden ceiling with the cleanup still inside it, so every wait
// is clamped against one budget rather than given its own.
const TOTAL_BUDGET_MS = 240_000;
const HEADLINE_TIMEOUT_MS = 110_000;
const FOLLOWUP_TIMEOUT_MS = 70_000;

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {}
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}
const TOKEN = token();

// A dropped connection is retried a few times; a box that stays down is said in one line.
const raw = async (method, args = {}, attempts = 4) => {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(`${GATEWAY}/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "user-agent": AGENT,
        },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { ok: res.ok, status: res.status, body, text };
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }
  return { ok: false, status: 0, body: null, unreachable: true,
    text: `${GATEWAY} did not answer ${method}: ${String(last?.message ?? last)}` };
};
const call = async (method, args = {}) => {
  const answer = await raw(method, args);
  if (!answer.ok) throw new Error(`${method} -> ${answer.status} ${answer.text.slice(0, 300)}`);
  return answer.body;
};

const docker = (args, timeoutMs = 60_000) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20, timeout: timeoutMs }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(String(out)))));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VerificationFailed extends Error {}
const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
const remaining = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);
const deadlineFor = (ms) => Date.now() + Math.max(0, Math.min(ms, remaining()));

let failures = 0;
const check = (ok, what, detail = "") => {
  if (ok) console.log(`  PASS  ${what}`);
  else { failures += 1; console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`); }
  return ok;
};
const note = (what) => console.log(`  NOTE  ${what}`);

// ---------------------------------------------------------------- has this wave reached the box?
const probe = await raw("listMarketplace");
if (probe.unreachable === true) {
  console.log(`SKIP - ${BOX}'s gateway is not answering, so nothing was measured.`);
  console.log(`  ${probe.text}`);
  process.exit(3);
}
if (!probe.ok) {
  console.log(`SKIP - ${BOX} did not answer listMarketplace, so there is no catalog to measure against.`);
  console.log(`  gateway answered: ${probe.status} ${probe.text.slice(0, 160)}`);
  process.exit(3);
}

const catalog = probe.body ?? {};
const botCards = Array.isArray(catalog.bots) ? catalog.bots : [];
const pluginCards = Array.isArray(catalog.plugins) ? catalog.plugins : [];
const boxVersion = (await docker(["exec", BOX, "sh", "-c",
  "cat /home/box/sand-host/version 2>/dev/null || echo unknown"]).catch(() => "unknown")).trim();

console.log(`box ${BOX} (bundle ${boxVersion || "unknown"}) at ${new Date().toISOString()}`);
console.log(`  listMarketplace: ${botCards.length} bot(s), ${pluginCards.length} plugin(s)`);

// The other half of this wave, probed rather than assumed.
const importProbe = await raw("importMarketplaceBot", { id: "__gate_probe__" });
const hasImporter = !(importProbe.status === 400 && /unknown/i.test(importProbe.text))
  && !/unknown gateway method/i.test(importProbe.text);
console.log(`  importMarketplaceBot: ${hasImporter ? "on this box" : "NOT on this box"}`);

// -------------------------------------------------------------------------- driving one turn
const said = (transcript) => (Array.isArray(transcript) ? transcript : transcript?.entries ?? [])
  .filter((entry) => entry.kind === "send-message");
const textOf = (entry) => String(entry.kind === "send-message" ? entry.message?.content ?? "" : entry.content ?? "");
const isRunning = async (agentId) =>
  (await call("listAgents").catch(() => [])).find((agent) => agent.id === agentId)?.isRunning === true;

/**
 * One question, and the WHOLE turn it produces. The product's own first rule is reply first and
 * work second, so the acknowledgement arrives as one message and the substance as the next; and
 * this box is shared, so an unrelated message can land mid-question. Wait for idle, send, wait for
 * the first new message, then drain until idle again, and hand back everything the turn said.
 */
const ask = async (agentId, prompt, label, timeoutMs) => {
  const idleBy = deadlineFor(20_000);
  while (Date.now() < idleBy && await isRunning(agentId)) await sleep(2500);
  const before = said(await call("getAgentTranscript", { id: agentId })).length;
  await call("sendPrompt", { agentId, prompt });
  const by = deadlineFor(timeoutMs);
  let replies = [];
  while (Date.now() < by) {
    await sleep(2500);
    const answers = said(await call("getAgentTranscript", { id: agentId }));
    if (answers.length > before) {
      replies = answers.slice(before);
      const joined = () => replies
        .map((entry) => textOf(entry).replace(/\s+/g, " ").trim()).filter(Boolean).join(" ‖ ");
      // MEASURED on this box 2026-09-09, and the reason this is not just "drain while running": the
      // first read of a turn caught the second message HALF WRITTEN -- it ended mid sentence, and
      // the question at the end of it had not arrived yet, so a leg that reads the words was red
      // against an answer that was right. A turn is over when the agent has gone idle AND its words
      // have stopped changing between two reads, not when the first of those happens.
      const drainBy = Math.min(Date.now() + 45_000, by);
      let last = joined();
      let stable = 0;
      while (Date.now() < drainBy) {
        await sleep(2500);
        replies = said(await call("getAgentTranscript", { id: agentId })).slice(before);
        const now = joined();
        if (now === last && !(await isRunning(agentId))) { stable += 1; if (stable >= 2) break; }
        else stable = 0;
        last = now;
      }
      const lines = replies.map((entry) => textOf(entry).replace(/\s+/g, " ").trim()).filter(Boolean);
      console.log(`\n[${label}] ${lines.map((line) => JSON.stringify(line.slice(0, 500))).join("\n         ")}`);
      return lines.join(" ‖ ");
    }
  }
  throw new VerificationFailed(`${label}: no answer within the budget (${elapsed()})`);
};

const toolRows = async (agentId) => {
  const rows = await call("getConversationOutline", { id: agentId }).catch(() => []);
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.kind === "tool-call")
    .map((row) => String(row.name ?? ""));
};

// The names a reply actually put in front of the person, against the rows the box really carries.
// Names, not ids: a person is offered "SEO Desk", never "seo-desk".
const catalogNames = botCards
  .map((card) => String(card?.name ?? "").trim())
  .filter((name) => name.length >= 4);
const namedRows = (reply) => catalogNames.filter((name) => reply.toLowerCase().includes(name.toLowerCase()));

// SearchPlugins and GetPlugin are here because the catalog listing's own text used to NAME them to
// the model ("SearchPlugins lists them", "Full detail on a connector is in GetPlugin"), which is a
// tool name one relay away from a customer's screen with this gate still green.
const NO_TOOL_NAMES = /SearchBotCatalog|GetBotTemplate|CreateAgentFromTemplate|SearchPlugins|GetPlugin|getAgentStatus|readAgentTranscript|createAgentToolCall|ToolCall|listMarketplace|getMarketplaceItem/i;

let probeAgent = null;
let scratchBuilt = [];
const rosterBefore = (await call("listAgents").catch(() => [])).map((agent) => agent.id);
try {
  const created = await call("createAgent", {
    name: `probe-catalog-${Math.random().toString(36).slice(2, 8)}`,
    description: "", origin: "user", isKickstartRequested: false,
  });
  probeAgent = created?.agent ?? created;
  if (probeAgent?.id == null) throw new VerificationFailed("createAgent returned no agent");
  console.log(`\nscratch agent ${probeAgent.id}`);

  // ------------------------------------------------------------------- THE SENTENCE FROM THE REPORT
  const headline = await ask(probeAgent.id, "create me an Instagram marketer", "instagram", HEADLINE_TIMEOUT_MS);
  const rows = await toolRows(probeAgent.id);
  console.log(`  tool rows this turn: ${rows.length === 0 ? "(none)" : rows.join(", ")}`);

  check(rows.includes("getAgentStatusToolCall"),
    "it looked at the catalog before answering",
    `outline rows were ${JSON.stringify(rows)} — before this wave the only row was a CreateAgent`);
  // READING ONE IN FULL IS ASSERTED AT SETUP, NOT AT THE OFFER, and that is a decision rather than
  // a loosening. MEASURED on grok-bot-local-vm 2026-09-10: with the question quoted at the end of
  // the listing, a bot answered straight off the cards -- which carry the name, the one line, the
  // counts of the four blocks and every app the row wants, which is exactly what an offer contains.
  // Pulling all 7,717 characters of a row to write one line about it is the expensive answer the
  // tool's own description warns against. What MUST be read in full is the row it is about to set
  // up, because that is where it tells the person what they are getting, and that is checked below.
  if (rows.includes("readAgentTranscriptToolCall")) {
    note("it also read a row in full before offering");
  } else {
    note("it offered off the cards without pulling a row in full, which the cards carry enough for");
  }

  // The question Jason asked for: the CHOICE has to be put to the person before anything is built.
  // Asserted as substance rather than as a phrase, and the whole reply is printed either way so the
  // wording can be read rather than guessed at. MEASURED, grok-bot-local-vm 2026-09-10: a run that
  // offered three rows by name and asked "want me to set one up, or build a custom one?" is the
  // question Jason asked for in different words, and a gate that only accepted the literal "from
  // scratch" called that broken.
  const ALTERNATIVE = /from scratch|from the ground up|custom(ised|ized)? (one|bot|build)|build (you )?(a |one )?(brand[- ]?)?new|bespoke|something purpose[- ]built|build one just for/i;
  check(/\?/.test(headline) && ALTERNATIVE.test(headline),
    "it asks whether they want one of those or one built for them instead",
    `got ${JSON.stringify(headline)}`);

  // Real rows, by name, against the catalog this box actually serves. NEVER a fixed id: there is
  // no Instagram bot in the catalog and pinning one would pin this gate to BOTS-4's data.
  const named = namedRows(headline);
  check(named.length >= 2,
    `it offers at least two ready-made bots by name (offered: ${named.slice(0, 5).join(", ") || "none"})`,
    `no catalog row name appeared in ${JSON.stringify(headline.slice(0, 300))}`);

  // It must not have quietly built one instead of asking.
  const afterAsk = (await call("listAgents").catch(() => [])).map((agent) => agent.id);
  const madeWhileAsking = afterAsk.filter((id) => !rosterBefore.includes(id) && id !== probeAgent.id);
  scratchBuilt = madeWhileAsking;
  check(madeWhileAsking.length === 0,
    "and it asks before it builds anything",
    `${madeWhileAsking.length} bot(s) appeared on the roster during the question`);

  check(!NO_TOOL_NAMES.test(headline), "no tool name reaches the person",
    `got ${JSON.stringify(headline.slice(0, 300))}`);

  // ------------------------------------------------------------------------------ setting one up
  if (!check(hasImporter, "this box carries the import the setup tool calls",
    `importMarketplaceBot answered ${importProbe.status} ${String(importProbe.text).slice(0, 120)};`
    + " both halves of TITAN-CATALOG-1 ship in one bundle, so this box is behind or broken and the"
    + " leg that proves the feature cannot run")) {
    note("setting a bot up from a template could not be measured on this box. Swap it to a bundle"
      + " built from this tree and run the gate again.");
  } else {
    const setUp = await ask(probeAgent.id,
      "Use the first template you named. Set it up now.", "use-the-template", FOLLOWUP_TIMEOUT_MS);
    const setupRows = await toolRows(probeAgent.id);
    check(setupRows.includes("createAgentToolCall"),
      "answering \"use the template\" sets one up from the catalog",
      `outline rows were ${JSON.stringify(setupRows)}`);
    check(setupRows.includes("readAgentTranscriptToolCall"),
      "and it read that row in full before setting it up, so what it reports is what the row holds",
      `outline rows were ${JSON.stringify(setupRows)}`);
    const roster = await call("listAgents").catch(() => []);
    const made = roster.filter((agent) => !rosterBefore.includes(agent.id) && agent.id !== probeAgent.id);
    scratchBuilt = made.map((agent) => agent.id);
    if (check(made.length >= 1, "and the new bot is on the roster", `roster grew by ${made.length}`)) {
      const built = made[0];
      const memories = await call("getAgentMemories", { id: built.id }).catch(() => []);
      const automations = await call("getAgentAutomations", { id: built.id }).catch(() => []);
      // NOT getAgentWorkflows: that answers the box-wide shared library, measured at 78 rows
      // through three unrelated agents on this box, so it measures the box and not the bot.
      check((Array.isArray(memories) ? memories.length : 0) > 0,
        `the new bot knows its facts (${Array.isArray(memories) ? memories.length : 0} in its own memory)`);
      check(Array.isArray(automations)
        && automations.every((automation) => automation?.isEnabled !== true),
        "and every job it carries is switched off");
      check(!NO_TOOL_NAMES.test(setUp), "the setup report names no tool either",
        `got ${JSON.stringify(setUp.slice(0, 300))}`);
    }
  }

  // ----------------------------------------------------------------- the from-scratch door still opens
  const fromScratch = await ask(probeAgent.id,
    "Forget the templates. Build me one from scratch instead, and call it Gate Scratch Bot.",
    "from-scratch", FOLLOWUP_TIMEOUT_MS);
  const roster = await call("listAgents").catch(() => []);
  const blank = roster.find((agent) => /gate scratch bot/i.test(String(agent.name ?? "")));
  scratchBuilt = roster.filter((agent) => !rosterBefore.includes(agent.id) && agent.id !== probeAgent.id)
    .map((agent) => agent.id);
  check(blank != null, "the from-scratch path still builds a bot",
    `no bot named "Gate Scratch Bot" on the roster after ${JSON.stringify(fromScratch.slice(0, 200))}`);

  // ------------------------------------------- the OTHER half of the sentence, asked on its own
  //
  // "Titan should be able to see all connectors and all the agents as a catalog" is a request in
  // its own right and it is NOT a request for a bot. The question the bot is told to end on was
  // appended to the catalog listing unconditionally, so somebody asking what connectors exist was
  // answered with an offer to build a bot -- and told to set nothing up until they had chosen one,
  // about a question that was never about setting anything up.
  //
  // A SECOND scratch agent, and last, for two reasons: a conversation that has already asked for an
  // Instagram marketer cannot measure this, and the legs above diff the roster against what it held
  // before, so a second probe agent minted earlier would read as a bot one of them had built.
  const asker = await call("createAgent", {
    name: `probe-connectors-${Math.random().toString(36).slice(2, 8)}`,
    description: "", origin: "user", isKickstartRequested: false,
  }).then((made) => made?.agent ?? made).catch(() => null);
  if (check(asker?.id != null, "a second scratch agent for the browse-only question")) {
    scratchBuilt = [...scratchBuilt, asker.id];
    const browsed = await ask(asker.id,
      "What app connectors do you have available? I am not asking you to build anything, I just want"
      + " to know what is there.", "connectors", FOLLOWUP_TIMEOUT_MS);
    check(/slack|notion|linear|gmail|google|github/i.test(browsed),
      "asked what app connectors exist, it answers with connectors",
      `got ${JSON.stringify(browsed.slice(0, 300))}`);
    // The mandated sentence, not every offer of help: a bot that says "want me to build something
    // with one of these?" is being useful. The bug is the question it was told to END on.
    const THE_QUESTION_ASKED_ANYWAY =
      /use one of these,? or would you like me to build one from scratch|one of those or .{0,30}from scratch/i;
    check(!THE_QUESTION_ASKED_ANYWAY.test(browsed),
      "and it does not end a browse with the template-or-from-scratch question",
      `got ${JSON.stringify(browsed.slice(0, 300))}`);
    const afterBrowse = (await call("listAgents").catch(() => [])).map((agent) => agent.id);
    const builtWhileBrowsing = afterBrowse
      .filter((id) => !rosterBefore.includes(id) && !scratchBuilt.includes(id) && id !== probeAgent.id);
    scratchBuilt = [...scratchBuilt, ...builtWhileBrowsing];
    check(builtWhileBrowsing.length === 0, "and it builds nothing for a question about what exists",
      `${builtWhileBrowsing.length} bot(s) appeared: ${builtWhileBrowsing.join(", ")}`);
    check(!NO_TOOL_NAMES.test(browsed), "and the browse names no tool either",
      `got ${JSON.stringify(browsed.slice(0, 300))}`);
  }
} catch (error) {
  failures += 1;
  console.log(`\n  FAIL  ${error instanceof VerificationFailed ? error.message : String(error?.message ?? error)}`);
} finally {
  // Pass or fail, the roster goes back to what it was. A gate that leaves bots behind is the
  // roster-growth bug it is supposed to catch.
  const roster = await call("listAgents").catch(() => []);
  const leftovers = roster
    .filter((agent) => !rosterBefore.includes(agent.id))
    .map((agent) => agent.id);
  for (const id of new Set([...scratchBuilt, ...leftovers, ...(probeAgent?.id ? [probeAgent.id] : [])])) {
    await call("deleteAgent", { id })
      .then(() => console.log(`\ndeleted ${id}`))
      .catch((error) => console.log(`\ncould not delete ${id}: ${error.message}`));
  }
  // MEASURED 2026-09-09 on this box, and the reason this is not `.catch(() => [])`: one delete came
  // back "fetch failed" while the box was busy, and a roster read that ALSO failed would have been
  // read as an empty roster and printed "the roster is back to the 9 it held" over bots still on it.
  // A box that will not answer cannot say a gate left nothing behind, and it must say so.
  const after = await raw("listAgents");
  if (!after.ok) {
    failures += 1;
    console.log(`  FAIL  the box stopped answering before the roster could be read, so this run`
      + ` cannot claim it left nothing behind: ${after.text.slice(0, 160)}`);
  } else {
    const grew = (Array.isArray(after.body) ? after.body : [])
      .map((agent) => agent.id).filter((id) => !rosterBefore.includes(id));
    if (grew.length > 0) {
      failures += 1;
      console.log(`  FAIL  the roster grew by ${grew.length} and this gate could not take it back: ${grew.join(", ")}`);
    } else {
      console.log(`the roster is back to the ${rosterBefore.length} it held`);
    }
  }
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`} on ${BOX} in ${elapsed()}`);
process.exit(failures === 0 ? 0 : 1);
}
