#!/usr/bin/env node
// BASELINE-1's acceptance gate: ask a box Kelley's exact question and judge what comes back.
//
//   node scripts/verify-baseline-research.mjs --gateway http://127.0.0.1:1340 [--agent <id>]
//   node scripts/verify-baseline-research.mjs --box titanbot-box-<uuid>            (reaches it by docker)
//   node scripts/verify-baseline-research.mjs --judge <file>                       (no box: score a saved answer)
//   node scripts/verify-baseline-research.mjs --selftest                           (no box: the judge itself)
//
// WHY A GATE AND NOT A READ-THROUGH. The wave ships four things and three of them can be proved with
// no box at all: the seed is in the bundle, the four rules render in the base prompt, the ladder
// carries the soft failure. The fourth cannot. Whether a model with those rules in front of it
// actually produces a store-level answer instead of one retailer's price is a question about a turn,
// and the only honest way to answer it is to run one.
//
// THE QUESTION AND THE TWO VERDICTS ARE JASON'S, out of docs/BASELINE-1.md, quoted rather than
// paraphrased. Pass: a store-level table across Home Depot, Lowe's, Ace and two fastener suppliers,
// a qualifier-match column, stock and date checked, no universal negative, and a COULDN'T ESTABLISH
// section with phone numbers. Fail: one retailer's price with "nobody" anywhere.
//
// THE JUDGE IS PURE AND IS TESTED. `judgeResearchAnswer` does no I/O, so tests/baseline-research-
// gate.test.mjs drives it against the bad run and a good one with no box and no model. A rubric
// nobody has tried to break is a rubric that might be asserting nothing, which is the lesson
// verify-handbook.mjs learned when one 848-character paragraph scored 40 out of 40.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

// --------------------------------------------------------------------------------- the question

/** Kelley's question, exactly as docs/BASELINE-1.md carries it. Never paraphrased by this file. */
export const KELLEY_QUESTION =
  "Who carries 3/8 in. x 8 in. hot-dip galvanized hex bolts in packs of 10 or 25 "
  + "in Leander or Cedar Park, TX, at local stores?";

/** The three the customer named. R5 says every one of them appears in the answer. */
export const NAMED_RETAILERS = [
  { id: "home-depot", label: "Home Depot", pattern: /home\s*depot|\bhd\b/i },
  { id: "lowes", label: "Lowe's", pattern: /lowe'?s/i },
  { id: "ace", label: "Ace", pattern: /\bace\b(?!\s*of)/i },
];

/**
 * Fastener suppliers, the "and your pick" half of the ask. Two or more is what the verdict asks for.
 * A list rather than a shape, because "supplier" has no pattern and a gate that guessed would score
 * a paragraph naming three shops that do not sell fasteners.
 */
export const FASTENER_SUPPLIERS = [
  { id: "grainger", pattern: /grainger/i },
  { id: "fastenal", pattern: /fastenal/i },
  { id: "mcmaster", pattern: /mcmaster/i },
  { id: "bolt-depot", pattern: /bolt\s*depot/i },
  { id: "tractor-supply", pattern: /tractor\s*supply/i },
  { id: "northern-tool", pattern: /northern\s*tool/i },
  { id: "white-cap", pattern: /white\s*cap/i },
  { id: "hd-supply", pattern: /hd\s*supply/i },
  { id: "texas-fasteners", pattern: /fastener\s+(?:supply|specialt|warehouse|house)/i },
];

/**
 * A universal negative, which R2 forbids outright. Anchored on a claim about the WORLD, not on the
 * word "no": an answer is allowed to say it could not find something, and must be able to.
 */
const UNIVERSAL_NEGATIVE = [
  /\bnobody\b/i,
  /\bno\s+one\b/i,
  /\bnone\s+of\s+(?:the|them|these)\b/i,
  /\bnot\s+(?:available|carried|sold)\s+(?:anywhere|by\s+any)\b/i,
  /\bthere\s+(?:is|are)\s+no\b/i,
  /\bno\s+(?:store|retailer|supplier|shop)s?\s+(?:in|near|around|carry|carries|stock|sells?)\b/i,
  /\bdoes\s+not\s+exist\b/i,
];

/** The host's own sentence on a box with no search configured. A reply carrying it is the wave failing. */
const NO_SEARCH_SENTENCE = /no web search service is set up on this machine/i;

const PHONE = /(?:\(\d{3}\)\s*|\b\d{3}[.\-\s])\d{3}[.\-\s]\d{4}\b/;
// A date, in any of the shapes an answer writes one. Bare, because a date is read two ways below:
// beside the word "checked" in prose, and as the value of a Checked column in the findings table,
// which is the shape the skill's own output contract asks for and the one the first draft of this
// gate missed entirely.
const DATE_SHAPE = /\d{4}-\d{2}-\d{2}|\d{1,2}\s+\w{3,9}\s+\d{4}|\w{3,9}\s+\d{1,2},?\s+\d{4}|\b(?:today|yesterday)\b/i;
const DATE_IN_PROSE = new RegExp(`\\b(?:checked|as of|verified|confirmed)\\b[^.\\n|]{0,40}(?:${DATE_SHAPE.source})`, "i");
const DATE_COLUMN = /checked|date|as of/i;
const STOCK = /\b(?:in stock|out of stock|stock|on hand|available at|availability|aisle|bay)\b/i;
const QUALIFIER = /\b(?:pack|qualifier|10[-\s]?pack|25[-\s]?pack|box of|quantity)\b/i;
const COULDNT_ESTABLISH = /couldn'?t establish|could not establish|what i could not (?:pin down|establish)/i;

/** A markdown table's data rows, which is what "store-level table" means concretely. */
function tableRows(text) {
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 3) continue;
    rows.push({ line, cells });
  }
  return rows;
}

/**
 * The verdict, from the answer's text and the tools the turn really called.
 *
 * `toolNames` comes from the conversation outline, which is the only surface outside the box that
 * says which tools a turn reached for. Without it a model answering out of its own memory scores the
 * same as one that went and looked, which is exactly the failure R6 is about.
 */
export function judgeResearchAnswer(text, { toolNames = [] } = {}) {
  const answer = String(text ?? "");
  const rows = tableRows(answer);
  const header = rows.find((row) => row.cells.some((cell) => /source|store|retailer|vendor|where/i.test(cell)));
  const dataRows = header == null ? rows : rows.filter((row) => row !== header);
  const tools = toolNames.map((name) => String(name ?? "").toLowerCase());

  // Anything here fails the run outright, whatever it scored. Each one is a thing the answer says
  // that is worse than saying nothing.
  const hardFails = [];
  if (NO_SEARCH_SENTENCE.test(answer)) {
    hardFails.push("the box still answers that no web search service is set up on this machine");
  }
  const negative = UNIVERSAL_NEGATIVE.find((pattern) => pattern.test(answer));
  if (negative != null) {
    hardFails.push(`the answer asserts a universal negative (${(negative.exec(answer) ?? [""])[0].trim()}), which R2 forbids off any number of failed lookups`);
  }
  if (tools.length > 0 && !tools.some((name) => /websearch|webfetch|web_search|web_fetch|browser_|fetch_content/.test(name))) {
    hardFails.push("the turn called no web tool, so the answer came out of the model rather than off the web");
  }

  // The verdict's five parts, each scored on the thing it names rather than on vocabulary.
  const suppliers = FASTENER_SUPPLIERS.filter((supplier) => supplier.pattern.test(answer)).map((supplier) => supplier.id);
  const retailers = NAMED_RETAILERS.filter((retailer) => retailer.pattern.test(answer)).map((retailer) => retailer.label);
  const rowFor = (pattern) => dataRows.some((row) => pattern.test(row.line));
  const withRows = NAMED_RETAILERS.filter((retailer) => rowFor(retailer.pattern)).map((retailer) => retailer.label);
  const uncertainty = COULDNT_ESTABLISH.test(answer);
  // The date, read both ways. A Checked column with a date in its rows is what the output contract
  // asks for; a sentence saying when it was checked is the same promise in prose.
  const checkedColumn = header == null
    ? -1
    : header.cells.findIndex((cell) => DATE_COLUMN.test(cell));
  const dated = DATE_IN_PROSE.test(answer)
    || (checkedColumn >= 0 && dataRows.some((row) => DATE_SHAPE.test(row.cells[checkedColumn] ?? "")));
  const parts = [
    { id: "table", ok: dataRows.length >= 5, why: `${dataRows.length} data row(s) in a table, and the verdict asks for a store-level one across five sources` },
    { id: "named-retailers", ok: withRows.length === NAMED_RETAILERS.length, why: `rows for ${withRows.join(", ") || "none"} of the three the customer named` },
    { id: "suppliers", ok: suppliers.length >= 2, why: `${suppliers.length} fastener supplier(s) named: ${suppliers.join(", ") || "none"}` },
    { id: "qualifier", ok: QUALIFIER.test(answer), why: "the pack of 10 or 25 is the qualifier the bad run dropped" },
    { id: "stock", ok: STOCK.test(answer), why: "a local question resolves to what each store has, not to a catalogue price" },
    { id: "date", ok: dated, why: "prices and stock are perishable, so the answer says when it was checked" },
    { id: "couldnt-establish", ok: uncertainty, why: "an answer with no uncertainty section usually hid its uncertainty" },
    { id: "phone", ok: uncertainty && PHONE.test(answer), why: "a store that could not be established comes with a way to ring it" },
  ];
  const points = parts.filter((part) => part.ok).length;
  return {
    ok: hardFails.length === 0 && points >= PASS_TOTAL,
    points,
    total: parts.length,
    parts,
    hardFails,
    retailers,
    suppliers,
    rows: dataRows.length,
  };
}

/** Eight parts, and six of them is not a pass: the verdict names five things and they all matter. */
export const PASS_TOTAL = 7;

// ------------------------------------------------------------------------------------ the box

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argOf = (name, fallback = "") => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const docker = (dockerArgs) => new Promise((resolve, reject) =>
  execFile("docker", dockerArgs, { maxBuffer: 32 << 20, timeout: 120_000 }, (error, out) =>
    (error ? reject(new Error(`docker ${dockerArgs.join(" ")}: ${error.message}`)) : resolve(String(out)))));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One gateway command against the box.
 *
 * Two ways in, because the gate is run from two places. With --gateway it dials the host directly,
 * which is what a local box and a tunnel both look like. With --box it goes through `docker exec`
 * and the box's own node, which is the only way in on the R750, where nothing publishes 1340.
 */
function boxCaller() {
  const gateway = argOf("--gateway", "").replace(/\/+$/, "");
  const box = argOf("--box", "");
  if (gateway.length > 0) {
    const token = (process.env.SAND_HOST_GATEWAY_TOKEN ?? "").trim();
    if (token.length === 0) throw new Error("set SAND_HOST_GATEWAY_TOKEN for --gateway");
    return async (command, body = {}) => {
      const response = await fetch(`${gateway}/api/${command}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${command} answered ${response.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch { return text; }
    };
  }
  if (box.length === 0) throw new Error("name a box with --box, or an address with --gateway");
  // The token is the box's own environment. It never reaches this process's command line, which is
  // why the script runs inside the box rather than reading the value out and dialling from here.
  // THE STATUS TRAVELS BACK WITH THE BODY, and it has to. Measured on the R750 demo box
  // 2026-09-15: getWebSearchRoute answers HTTP 404 there, because that host predates the command,
  // and a caller that parsed the body alone got a perfectly good object with none of the fields it
  // wanted. The gate then printed "the box's web search route: undefined, DOES NOT ANSWER", which
  // reads like a measurement of a box and is a measurement of nothing.
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

const said = (entries) => entries.filter((entry) =>
  (entry?.kind === "send-message" && String(entry.message?.content ?? "").trim().length > 0)
  || (entry?.kind === "message" && entry?.role === "assistant" && String(entry.content ?? "").trim().length > 0));
const textOf = (entry) => String(entry?.kind === "send-message" ? entry.message?.content : entry?.content);

async function runOnBox() {
  const call = boxCaller();
  // MEASURED ON THE R750 DEMO BOX 2026-09-15, before this wave shipped anything: Titan was still
  // working on this question after 420 s, and still working after THIRTY MINUTES. Its outline showed
  // why, and it was not a stall: it was driving a browser through a retailer's store picker, typing a
  // location, choosing Cashway Bldg Matls in Leander and pressing Make My Store, which is the rung a
  // per-store availability question really needs. So the budget is half an hour, because a gate whose
  // default always times out measures the gate.
  const timeoutMs = Number(argOf("--timeout-ms", "1800000")) || 1_800_000;
  const roster = await call("listAgents");
  const rows = Array.isArray(roster) ? roster : (Array.isArray(roster?.agents) ? roster.agents : []);
  const people = rows.filter((row) => row?.isGroup !== true && String(row?.id ?? "").length > 0);
  const named = argOf("--agent", "");
  const agent = named.length > 0
    ? people.find((row) => String(row.id) === named || String(row.name ?? "").toLowerCase() === named.toLowerCase())
    : (people.find((row) => String(row.name ?? "").trim().toLowerCase() === "titan") ?? people[0]);
  if (agent == null) throw new Error(named.length > 0 ? `no bot called ${named} on this box` : "this box has no bot to ask");
  console.log(`asking ${agent.name ?? agent.id}`);

  // What the box has BEFORE the turn. A gate that reads this afterwards cannot tell a box that was
  // already set up from one this run configured, and a gate that skips it cannot say why a failure
  // failed.
  const before = await call("getWebSearchRoute").catch((error) => String(error?.message ?? error));
  if (typeof before === "object" && before != null && typeof before.route === "string") {
    console.log(`the box's web search route: ${before.route}, ${before.answers ? "answers" : "DOES NOT ANSWER"}`
      + `, ${before.metered ? "metered" : "not metered"}, key ${before.keyLength} chars ${before.keySha256}`);
  } else {
    // Said plainly rather than skipped. A host without this command is a host from before BASELINE-1,
    // which is the single most useful thing to know when a run of this gate comes back disappointing.
    console.log(`the box could not say what its web search route is (${before}); this host predates BASELINE-1`);
  }

  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  await call("sendPrompt", { agentId: agent.id, prompt: KELLEY_QUESTION });
  const deadline = Date.now() + timeoutMs;
  let running = true;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const now = await call("listAgents").catch(() => []);
    const list = Array.isArray(now) ? now : (Array.isArray(now?.agents) ? now.agents : []);
    running = list.find((row) => String(row?.id) === String(agent.id))?.isRunning === true;
    if (!running) break;
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (running) {
    console.log(`FAIL  the turn was still running after ${elapsed()} s, against a budget of ${Math.round(timeoutMs / 1000)} s`);
    console.log("  raise --timeout-ms, or read the transcript yourself and score it with --judge");
    return 1;
  }
  console.log(`the turn ended after ${elapsed()} s`);
  const transcript = await call("getAgentTranscript", { id: agent.id });
  const entries = Array.isArray(transcript) ? transcript : [];
  const replies = said(entries);
  // The answer is not always the last message: a turn often closes with a short "anything else?".
  // The longest of the final few is the one being judged, and it is printed in full so the verdict
  // can be checked by eye rather than taken on trust.
  const candidates = replies.slice(-4).map(textOf);
  const answer = candidates.sort((a, b) => b.length - a.length)[0] ?? "";
  const outline = await call("getConversationOutline", { id: agent.id }).catch(() => []);
  const items = Array.isArray(outline) ? outline : [];
  const toolNames = items.filter((item) => item?.kind === "tool-call").map((item) => String(item?.name ?? ""));
  console.log(`tools this turn called: ${[...new Set(toolNames)].join(", ") || "none the outline carries"}`);
  console.log("\n---- the answer ----\n");
  console.log(answer);
  console.log("\n---- the verdict ----\n");
  return report(judgeResearchAnswer(answer, { toolNames }));
}

function report(verdict) {
  for (const part of verdict.parts) {
    console.log(`  ${part.ok ? "PASS" : "FAIL"}  ${part.id}: ${part.why}`);
  }
  for (const why of verdict.hardFails) console.log(`  FAIL  ${why}`);
  console.log("");
  console.log(`${verdict.points} of ${verdict.total}, against a pass line of ${PASS_TOTAL}`);
  console.log(verdict.ok ? "OK" : "FAILED");
  return verdict.ok ? 0 : 1;
}

function usage() {
  console.log("usage: node scripts/verify-baseline-research.mjs (--box <container> | --gateway <url> | --judge <file> | --selftest)");
  console.log("  --box       reach the box with docker exec, which is the only way in on the R750");
  console.log("  --gateway   dial the host directly, with SAND_HOST_GATEWAY_TOKEN set");
  console.log("  --judge     score an answer saved to a file, with no box and no turn");
  console.log("  --selftest  run the judge against the bad run and a good one");
  return 2;
}

async function main() {
  if (has("--judge")) {
    const file = argOf("--judge", "");
    if (file.length === 0) return usage();
    return report(judgeResearchAnswer(readFileSync(file, "utf8"), { toolNames: ["WebSearch"] }));
  }
  if (has("--selftest")) {
    const bad = judgeResearchAnswer(
      "The only true 10-pack is at Home Depot ($12.56). Nobody lists a 25-pack.",
      { toolNames: ["WebSearch"] },
    );
    console.log(`the bad run scores ${bad.points}/${bad.total} with ${bad.hardFails.length} hard failure(s)`);
    if (bad.ok) { console.log("FAILED: the rubric passes the run it exists to catch"); return 1; }
    console.log("OK");
    return 0;
  }
  if (has("--box") || has("--gateway")) return await runOnBox();
  return usage();
}

// Imported, nothing happens: the question and the judge are the exports, and
// tests/baseline-research-gate.test.mjs drives them with no box and no turn. The same guard
// verify-handbook.mjs uses, for the same reason.
const isMain = argv[1] != null && fileURLToPath(import.meta.url) === argv[1];
if (isMain) process.exit(await main());
