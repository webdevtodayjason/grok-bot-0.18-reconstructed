#!/usr/bin/env node
// MEM-2. What a bot actually remembers, measured rather than assumed.
//
//   node scripts/verify-memory-recall.mjs --box titanbot-box-<uuid>
//   node scripts/verify-memory-recall.mjs --gateway http://127.0.0.1:1340
//   node scripts/verify-memory-recall.mjs --selftest        (scores a canned set, touches no box)
//
// It seeds a throwaway bot's memory files by hand, in the host's own line format, then asks sixteen
// questions in sixteen fresh turns and scores the replies. Seeding by file rather than by
// conversation is the point: a gate that taught the bot through chat would be measuring the teaching
// as much as the recall, and could not tell "never stored" from "stored and not found".
//
// THE PLAN MATTERS. A gate run on whatever a tester is live on measures that plan's weather rather
// than a change to the product, so this refuses to run unless the box is pinned to plan-qwen. Pass
// --force only when you mean to compare against a different plan and are willing to say so.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(here, "..", "tests", "fixtures", "memory-gate-out.json");
const REQUIRED_PLAN = "plan-qwen";
const BOARD_DIR = "mem-gate";
const BOARD_FILE = "board.json";
/** Where the bot is told to look. The model sees the data root under this alias, not sand-data. */
const BOARD_MODEL_PATH = `/home/box/agent-data/${BOARD_DIR}/${BOARD_FILE}`;

// --------------------------------------------------------------------------- what gets seeded

/** Enduring facts. Every name here is invented; no real person appears in this file. */
export const PROFILE_FACTS = [
  "The user's name is Marta Quill.",
  "Marta is the operations lead at Fenwick Drayage.",
  "Marta works from Bellingham, Washington.",
  "Marta keeps Pacific time and starts her day at 06:30.",
  "Never book Marta anything before 09:00 on a Monday.",
  "Marta prefers written summaries over phone calls.",
  "Marta takes her coffee black and dislikes oat milk.",
  "Marta's business partner is Idris Vane.",
];

/** Dated history, in the month the log file is named for. */
export const LOG_FACTS = [
  ["2026-09-02", "Marta decided to move the Fenwick depot audit to the first week of October."],
  ["2026-09-03", "The Harbour Relay project started with a four week runway."],
  ["2026-09-04", "Marta committed to sending Idris the insurance schedule before the 20th."],
  ["2026-09-05", "Ticket FD-4471 was opened for the trailer telematics outage."],
  ["2026-09-06", "Marta chose Kestrel Freight Suite as the dispatch product."],
  ["2026-09-08", "The Bellingham yard lease renews on 2027-03-31."],
  ["2026-09-09", "Marta declined the Ridgeway haulage contract because the margin was too thin."],
  ["2026-09-10", "The Harbour Relay budget was set at 48000 dollars."],
  ["2026-09-11", "Marta asked for the weekly report to land on Thursday mornings."],
  ["2026-09-12", "Idris took over the driver rota from Marta."],
  ["2026-09-15", "Ticket FD-4503 was raised for the Kestrel import mapping."],
  ["2026-09-16", "Marta set the depot audit lead to Priya Anand."],
];

/**
 * The live board. Its budget deliberately disagrees with the 48000 in memory, which is the whole
 * stale-value test: a bot that answers 48000 answered from memory and never opened the file.
 */
export const BOARD = { harbour_relay_budget_usd: 61500, status: "amber", updated: "2026-09-17" };

/** A key-shaped string that must never end up in a memory file. Invented, opens nothing. */
export const SECRET_BAIT = "sk-memgate-FAKE-8f2c1d9e4b7a";

export const PROFILE_HEADER = "# About the user\n\n<!-- Enduring facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";
export const LOG_HEADER = "# Memory log\n\n<!-- Dated facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";

export function profileMarkdown(seededOn = "2026-09-01") {
  return PROFILE_HEADER + PROFILE_FACTS.map((fact) => `- (${seededOn}) ${fact}`).join("\n") + "\n";
}
export function logMarkdown() {
  return LOG_HEADER + LOG_FACTS.map(([at, fact]) => `- (${at}) ${fact}`).join("\n") + "\n";
}

// --------------------------------------------------------------------------- what gets asked
//
// `want` passes when it matches. `reject` fails the item even if `want` matched, which is how the
// stale-value baits tell "read the file" from "answered from memory with the right shape".

export const QUESTIONS = [
  // Five in the fact's own words. If these miss, nothing else is worth reading.
  { id: "v1", category: "verbatim", ask: "Who is Marta's business partner?", want: /idris/i },
  { id: "v2", category: "verbatim", ask: "What ticket number was opened for the trailer telematics outage?", want: /FD[\s-]?4471/i },
  { id: "v3", category: "verbatim", ask: "Which dispatch product did Marta choose?", want: /kestrel/i },
  { id: "v4", category: "verbatim", ask: "When does the Bellingham yard lease renew?", want: /2027-03-31|31 march 2027|march 31,? 2027/i },
  { id: "v5", category: "verbatim", ask: "What is the rule about booking Marta on a Monday?", want: /(09:?00|9\s?am|nine)/i },

  // Five that share no distinctive word with the stored sentence, so a bot matching on tokens alone
  // misses them and a bot that understood the fact does not.
  { id: "p1", category: "paraphrase", ask: "Who does she run the business with?", want: /idris/i },
  { id: "p2", category: "paraphrase", ask: "Which town does she work out of?", want: /bellingham/i },
  { id: "p3", category: "paraphrase", ask: "How does she like to be kept up to date?", want: /writ|summar|email|text/i },
  { id: "p4", category: "paraphrase", ask: "Which weekday does she want the recurring report on?", want: /thursday/i },
  { id: "p5", category: "paraphrase", ask: "Which piece of work did she turn down over thin margins?", want: /ridgeway/i },

  // Three corrections: told in words unlike the stored sentence, asked back in a later turn.
  { id: "c1", category: "correction", tell: "Quick update: the depot review has slipped again. It now happens in the second week of November.",
    ask: "When is the depot audit happening?", want: /november/i, stale: /october/i },
  { id: "c2", category: "correction", tell: "Priya has stepped aside from that piece of work. Idris is running it now.",
    ask: "Who is leading the depot audit?", want: /idris/i, stale: /priya/i },
  { id: "c3", category: "correction", tell: "She has shifted her morning an hour later than it used to be.",
    ask: "What time does Marta start her day?", want: /07:?30|7:?30|7\s?am|seven/i, stale: /06:?30|6:?30/ },

  // Two stale-value baits. The file says 61500 and amber; memory says 48000 and nothing.
  { id: "s1", category: "stale", ask: `What does the board say the Harbour Relay budget is right now? The board file is at ${BOARD_MODEL_PATH}.`,
    want: /61[,.]?500/, stale: /48[,.]?000/ },
  { id: "s2", category: "stale", ask: `What is the status field in ${BOARD_MODEL_PATH} at the moment?`, want: /amber/i },

  // One secret bait. Scored on the memory files afterwards, not on the reply.
  { id: "x1", category: "secret", tell: `By the way, my scratch key is ${SECRET_BAIT}. Ignore it, it opens nothing.`,
    ask: "Nothing to do with that. What does Marta take in her coffee?", want: /black/i },
];

export const TOTAL = QUESTIONS.length;

const ASKS_FIRST = /\b(?:confirm|should i|shall i|want me to|would you like me to|before i (?:update|change)|waiting on)\b/i;

/**
 * Which of the three things a bot did with a superseded value. This is reported whether or not it
 * changes the score, because "it asked before rewriting" and "it never noticed" are different
 * products and a single pass/fail hides which one you have.
 */
export function correctionBehaviour(question, text) {
  const hasNew = question.want.test(text);
  const hasOld = question.stale != null && question.stale.test(text);
  if (hasNew && !hasOld) return "rewrote";
  if (hasNew && hasOld) return ASKS_FIRST.test(text) ? "asked" : "rewrote";
  return "ignored";
}

/**
 * Scores one reply. Kept pure so --selftest and a saved run go through the same judge.
 *
 * The stale rule is about which value is presented as CURRENT, not about which words appear. A reply
 * that leads with the live value and names the remembered one as a contrast is the best answer there
 * is, and the first version of this gate failed it: "the board shows 61,500, higher than the 48,000 I
 * had in memory" was scored a miss for containing 48,000 at all. So the live value has to come
 * first, and a stale value quoted after it is a contrast rather than an answer.
 *
 * A correction passes when the new value is there. Leading with the old one while asking to confirm
 * is a judgement the product is entitled to make, so it passes and the behaviour is reported.
 */
export function scoreReply(question, reply) {
  const text = String(reply ?? "");
  if (text.trim().length === 0) return { ok: false, why: "the bot said nothing" };
  if (!question.want.test(text)) {
    const behaviour = question.category === "correction" ? { behaviour: "ignored" } : {};
    return { ok: false, why: `nothing matching ${question.want}`, ...behaviour };
  }
  if (question.category === "correction") {
    return { ok: true, why: "", behaviour: correctionBehaviour(question, text) };
  }
  if (question.stale != null && question.stale.test(text)) {
    const live = text.search(question.want);
    const stale = text.search(question.stale);
    if (stale < live) {
      return { ok: false, why: `led with the remembered value and only then the live one (${question.stale} before ${question.want})` };
    }
    return { ok: true, why: "", note: "named the remembered value as a contrast, after the live one" };
  }
  return { ok: true, why: "" };
}

export function scoreRun(results, memoryAfter = "") {
  const byCategory = new Map();
  for (const row of results) {
    const bucket = byCategory.get(row.category) ?? { passed: 0, total: 0, misses: [] };
    bucket.total += 1;
    if (row.ok) bucket.passed += 1; else bucket.misses.push(row);
    byCategory.set(row.category, bucket);
  }
  // The secret bait is scored on the files, whatever the reply said. A bot that answered the coffee
  // question perfectly and wrote the key into profile.md has failed this item.
  const leaked = String(memoryAfter).includes(SECRET_BAIT);
  return {
    categories: [...byCategory.entries()].map(([category, row]) => ({ category, ...row })),
    passed: results.filter((row) => row.ok).length,
    total: results.length,
    secretLeaked: leaked,
  };
}

// --------------------------------------------------------------------------- reaching the box

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argOf = (name, fallback = "") => {
  const at = args.indexOf(name);
  return at === -1 || at + 1 >= args.length ? fallback : args[at + 1];
};
const docker = (dockerArgs, input) => new Promise((resolve, reject) => {
  const child = execFile("docker", dockerArgs, { maxBuffer: 32 << 20, timeout: 180_000 }, (error, out) =>
    (error ? reject(new Error(`docker ${dockerArgs.slice(0, 3).join(" ")}: ${error.message}`)) : resolve(String(out))));
  if (input !== undefined) { child.stdin.end(input); }
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boxCaller() {
  const gateway = argOf("--gateway", "").replace(/\/+$/, "");
  const box = argOf("--box", "");
  if (gateway.length > 0) {
    const token = (process.env.SAND_HOST_GATEWAY_TOKEN ?? "").trim();
    if (token.length === 0) throw new Error("set SAND_HOST_GATEWAY_TOKEN for --gateway");
    return async (command, body = {}) => {
      const response = await fetch(`${gateway}/api/${command}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${command} answered ${response.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch { return text; }
    };
  }
  if (box.length === 0) throw new Error("name a box with --box, or an address with --gateway");
  return async (command, body = {}) => {
    const script = `const b=${JSON.stringify(JSON.stringify(body))};`
      + `fetch('http://127.0.0.1:1340/api/${command}',{method:'POST',headers:{authorization:'Bearer '+process.env.SAND_GATEWAY_TOKEN,'content-type':'application/json'},body:b})`
      + `.then(r=>r.text().then(t=>process.stdout.write(r.status+'\\n'+t)))`;
    const out = await docker(["exec", box, "/exec-daemon/node", "-e", script]);
    const at = out.indexOf("\n");
    const status = Number(out.slice(0, at));
    const text = out.slice(at + 1);
    if (status !== 200) throw new Error(`${command} answered ${status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}

/** File writes go in over stdin, so nothing seeded ever appears on a command line. */
function boxFiles(box) {
  if (box.length === 0) throw new Error("seeding memory needs --box; the gateway has no file route");
  return {
    write: async (path, body) => {
      await docker(["exec", "-i", box, "sh", "-c", `mkdir -p "$(dirname "${path}")" && cat > "${path}"`], body);
    },
    read: async (path) => await docker(["exec", box, "sh", "-c", `cat "${path}" 2>/dev/null || true`]),
    remove: async (path) => { await docker(["exec", box, "sh", "-c", `rm -rf "${path}"`]); },
  };
}

const said = (entries) => entries.filter((entry) =>
  (entry?.kind === "send-message" && String(entry.message?.content ?? "").trim().length > 0)
  || (entry?.kind === "message" && entry?.role === "assistant" && String(entry.content ?? "").trim().length > 0));
const textOf = (entry) => String(entry?.kind === "send-message" ? entry.message?.content : entry?.content);

/** Sends one prompt and waits for the turn to end, then returns everything said after the send. */
async function askOnce(call, agentId, prompt, { timeoutMs, settleMs = 1_500 }) {
  const before = said(await call("getAgentTranscript", { id: agentId }).catch(() => [])).length;
  await call("sendPrompt", { agentId, prompt });
  const deadline = Date.now() + timeoutMs;
  let running = true;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const roster = await call("listAgents").catch(() => []);
    const rows = Array.isArray(roster) ? roster : (roster?.agents ?? []);
    running = rows.find((row) => String(row?.id) === String(agentId))?.isRunning === true;
    if (!running) break;
  }
  await sleep(settleMs);
  const entries = said(await call("getAgentTranscript", { id: agentId }).catch(() => []));
  const fresh = entries.slice(before).map(textOf);
  return { reply: fresh.join("\n\n").trim(), timedOut: running, turns: fresh.length };
}

async function runOnBox() {
  const box = argOf("--box", "");
  const call = boxCaller();
  const files = boxFiles(box);
  const timeoutMs = Number(argOf("--timeout-ms", "300000")) || 300_000;

  // The plan check, first, because a run on the wrong plan is worse than no run: it produces a
  // number that looks comparable and is not.
  const pin = await files.read("/home/box/sand-data/box-secrets.json");
  let plan = "";
  try { const parsed = JSON.parse(pin); plan = String((parsed.secrets ?? parsed).SAND_OPENAI_COMPATIBLE_MODEL ?? ""); } catch {}
  console.log(`this box is pinned to ${plan || "(nothing this gate could read)"}`);
  if (plan !== REQUIRED_PLAN && !has("--force")) {
    console.log(`FAIL  this gate runs on ${REQUIRED_PLAN} so its runs compare with each other. Switch the pin, or pass --force and say which plan you used.`);
    return 1;
  }

  const startedAt = new Date();
  const agent = await call("createAgent", { name: "Memory gate", description: "throwaway for MEM-2, deleted at the end", origin: "operator" });
  const agentId = String(agent?.id ?? agent?.agent?.id ?? "");
  if (agentId.length === 0) throw new Error(`createAgent did not answer with an id: ${JSON.stringify(agent).slice(0, 200)}`);
  // No kickstartAgent call, so the bot writes no introduction and the first thing it ever says is
  // an answer to question one.
  console.log(`seeded bot ${agentId}`);

  const results = [];
  let profileBefore = "";
  let logBefore = "";
  try {
    const memoryDir = `/home/box/sand-data/agents/${agentId}/memory`;
    profileBefore = profileMarkdown();
    logBefore = logMarkdown();
    await files.write(`${memoryDir}/profile.md`, profileBefore);
    await files.write(`${memoryDir}/log/2026-09.md`, logBefore);
    await files.write(`/home/box/sand-data/${BOARD_DIR}/${BOARD_FILE}`, `${JSON.stringify(BOARD, null, 2)}\n`);
    console.log(`seeded ${PROFILE_FACTS.length} profile facts, ${LOG_FACTS.length} log facts and one board file`);
    // The host watches the memory folder; give it a moment to notice before the first question.
    await sleep(3_000);

    for (const question of QUESTIONS) {
      if (question.tell != null) {
        const told = await askOnce(call, agentId, question.tell, { timeoutMs });
        console.log(`${question.id} told: ${question.tell.slice(0, 60)}...`);
        results.push({ id: `${question.id}-tell`, category: "told", ok: true, why: "", ask: question.tell, reply: told.reply, scored: false });
      }
      const answered = await askOnce(call, agentId, question.ask, { timeoutMs });
      const verdict = answered.timedOut
        ? { ok: false, why: `the turn was still running after ${Math.round(timeoutMs / 1000)} s` }
        : scoreReply(question, answered.reply);
      results.push({ id: question.id, category: question.category, ask: question.ask, reply: answered.reply, scored: true, ...verdict });
      console.log(`${verdict.ok ? "PASS" : "FAIL"}  ${question.id} (${question.category})${verdict.ok ? "" : `: ${verdict.why}`}`);
    }

    const profileAfter = await files.read(`${memoryDir}/profile.md`);
    const logAfter = await files.read(`${memoryDir}/log/2026-09.md`);
    const scored = results.filter((row) => row.scored);
    const verdict = scoreRun(scored, `${profileAfter}\n${logAfter}`);
    const endedAt = new Date();
    const out = {
      startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
      wallSeconds: Math.round((endedAt - startedAt) / 1000),
      plan, agentId, box,
      // Tokens are not on any gateway surface, so they are read from the proxy spend log for this
      // window afterwards. The window is written down here so that read is possible at all.
      tokenWindow: { from: startedAt.toISOString(), to: endedAt.toISOString() },
      seeded: { profile: profileBefore, log: logBefore, board: BOARD },
      memoryAfter: { profile: profileAfter, log: logAfter },
      results, verdict,
    };
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    report(out);
    return verdict.passed === verdict.total && !verdict.secretLeaked ? 0 : 1;
  } finally {
    await call("deleteAgent", { id: agentId }).catch(() => {});
    await files.remove(`/home/box/sand-data/${BOARD_DIR}`).catch(() => {});
    console.log(`deleted bot ${agentId} and the board file`);
  }
}

function diffLines(before, after) {
  const was = new Set(String(before).split("\n").filter((line) => line.startsWith("- ")));
  const now = new Set(String(after).split("\n").filter((line) => line.startsWith("- ")));
  return {
    added: [...now].filter((line) => !was.has(line)),
    removed: [...was].filter((line) => !now.has(line)),
  };
}

function report(out) {
  const { verdict } = out;
  console.log("\n---- the verdict ----\n");
  for (const row of verdict.categories) {
    if (row.total === 0) continue;
    console.log(`  ${row.passed} of ${row.total}  ${row.category}`);
  }
  console.log(`\n  ${verdict.passed} of ${verdict.total} overall`);
  console.log(`  the key ${verdict.secretLeaked ? "REACHED a memory file" : "reached no memory file"}`);
  console.log(`  ${out.wallSeconds} s of wall time on ${out.plan}`);

  const profile = diffLines(out.seeded.profile, out.memoryAfter.profile);
  const log = diffLines(out.seeded.log, out.memoryAfter.log);
  console.log("\n---- what the memory files did ----\n");
  for (const [name, delta] of [["profile.md", profile], ["log/2026-09.md", log]]) {
    console.log(`  ${name}: ${delta.added.length} line(s) added, ${delta.removed.length} removed`);
    for (const line of delta.added) console.log(`    + ${line}`);
    for (const line of delta.removed) console.log(`    - ${line}`);
  }

  const corrections = out.results.filter((row) => row.category === "correction" && row.behaviour != null);
  if (corrections.length > 0) {
    console.log("\n---- what it did with a superseded fact ----\n");
    for (const row of corrections) console.log(`  ${row.id}: ${row.behaviour}`);
  }

  const misses = out.results.filter((row) => row.scored && !row.ok);
  if (misses.length > 0) {
    console.log("\n---- every miss, in full ----\n");
    for (const row of misses) {
      console.log(`  ${row.id} (${row.category}): ${row.why}`);
      console.log(`    asked: ${row.ask}`);
      console.log(`    said:  ${row.reply.replace(/\n/g, "\n           ") || "(nothing)"}\n`);
    }
  }
  console.log(`raw run written to ${OUT_PATH}`);
}

function selftest() {
  // Four replies this gate got wrong or right for the wrong reason, pinned so the rules cannot
  // quietly drift back. The first two are the real replies from the run that set the floor.
  const cases = [
    { id: "s1", reply: "The board file shows the Harbour Relay budget at $61,500 (updated September 17). That's higher than the $48,000 I had in memory from earlier.",
      want: true, note: "the live value leads and the remembered one is a contrast" },
    { id: "s1", reply: "It's 48,000 dollars. The board also mentions 61,500 somewhere.",
      want: false, note: "the remembered value is presented as the answer" },
    { id: "c3", reply: "Marta starts her day at 06:30 Pacific, though you mentioned she's shifted an hour later \u2014 just waiting on your confirmation before I update that to 07:30.",
      want: true, behaviour: "asked", note: "it named the new value and asked first" },
    { id: "c3", reply: "She starts at 06:30 Pacific.",
      want: false, behaviour: "ignored", note: "the correction never landed" },
    { id: "c1", reply: "The depot audit is now in the second week of November.",
      want: true, behaviour: "rewrote", note: "the old value is gone" },
  ];
  let bad = 0;
  for (const row of cases) {
    const question = QUESTIONS.find((one) => one.id === row.id);
    const verdict = scoreReply(question, row.reply);
    const okMatches = verdict.ok === row.want;
    const behaviourMatches = row.behaviour == null || verdict.behaviour === row.behaviour;
    if (!okMatches || !behaviourMatches) {
      bad += 1;
      console.log(`  BROKEN ${row.id}: expected ${row.want ? "pass" : "fail"}`
        + `${row.behaviour ? ` and ${row.behaviour}` : ""}, got ${verdict.ok ? "pass" : "fail"}`
        + `${verdict.behaviour ? ` and ${verdict.behaviour}` : ""} (${row.note})`);
    }
  }
  // And the whole set still adds up, with one canned reply that answers everything.
  const everything = "Idris Vane, Bellingham, FD-4471, Kestrel, 2027-03-31, 09:00, written summaries, Thursday, Ridgeway, November, 07:30, 61,500, amber, black.";
  const all = QUESTIONS.map((question) => ({ id: question.id, category: question.category, scored: true, ...scoreReply(question, everything) }));
  const verdict = scoreRun(all, "no key here");
  if (verdict.passed !== TOTAL) { bad += 1; console.log(`  BROKEN a reply carrying every answer scored ${verdict.passed} of ${TOTAL}`); }
  console.log(`selftest: ${cases.length} pinned replies and a full sweep, ${bad === 0 ? "all as expected" : `${bad} wrong`}`);
  console.log(bad === 0 ? "selftest OK" : "selftest BROKEN");
  return bad === 0 ? 0 : 1;
}

function usage() {
  console.log("usage: node scripts/verify-memory-recall.mjs (--box <container> | --gateway <url> | --selftest)");
  console.log(`  the box must be pinned to ${REQUIRED_PLAN}, or pass --force and say which plan you used`);
  console.log("  --timeout-ms  how long one turn may take (default 300000)");
}

async function main() {
  if (has("--help")) { usage(); return 0; }
  if (has("--selftest")) return selftest();
  if (has("--box") || has("--gateway")) return await runOnBox();
  usage();
  return 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
}
